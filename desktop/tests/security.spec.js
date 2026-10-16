import { test, expect, _electron as electron } from '@playwright/test';
import http from 'node:http';
import { launch, mainWindow, windowFor, share, viewer, overlayState, overlayLaser, pointAt, server } from './app.js';
import { fileURLToPath } from 'node:url';

const stubShell = (app) => app.evaluate(({ shell }) => {
  globalThis.opened = [];
  shell.openExternal = async (url) => { globalThis.opened.push(url); };
});
const opened = (app) => app.evaluate(() => globalThis.opened);

test('the window never leaves screenpeek: other sites open in the browser, popups are refused', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  try {
    await stubShell(app);
    const page = await mainWindow(app);
    await page.evaluate(() => { location.href = 'https://example.com/elsewhere'; });
    await expect.poll(() => opened(app)).toEqual(['https://example.com/elsewhere']);
    expect(page.url()).toBe(server + '/');
    expect(await page.evaluate(() => window.open('https://example.com/popup'))).toBeNull();
    expect(await page.evaluate(() => window.open('file:///etc/passwd'))).toBeNull();
    expect(await page.evaluate(() => window.open('javascript:alert(1)'))).toBeNull();
    await expect.poll(() => opened(app)).toEqual(['https://example.com/elsewhere', 'https://example.com/popup']);
    expect(app.windows().filter((item) => !item.isClosed()).length).toBe(1);
    // The site gets only its own small API: none of the app's internal ones.
    expect(await page.evaluate(() => [typeof window.picker, typeof window.setup, typeof window.overlay])).toEqual(['undefined', 'undefined', 'undefined']);
    // Microphone, camera, location and notifications are refused outright.
    expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (error) => error.name))).toBe('NotAllowedError');
    expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (error) => error.name))).toBe('NotAllowedError');
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied');
    expect(await page.evaluate(() => new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error) => resolve(error.code))))).toBe(1);
    // The only errors are the refusals this test asked for.
    expect(errors.filter((error) => !/Not allowed to load local resource: file:\/\/\/etc\/passwd/.test(error))).toEqual([]);
  } finally { await close(); }
});

test('the app’s own pages serve only their files', async () => {
  const errors = [];
  const { app, close } = await launch({ errors, settings: null });
  try {
    const setup = await windowFor(app, 'setup.html');
    // Asked from the main process: the pages themselves aren't even allowed to fetch.
    const status = (path) => app.evaluate(({ session }, path) => session.defaultSession.fetch(path).then((response) => response.status, () => 'blocked'), path);
    expect(await setup.evaluate(() => fetch('./pages.css').then(() => 'fetched', () => 'blocked'))).toBe('blocked');
    expect(await status('screenpeek://app/vendor/laser.js')).toBe(200);
    for (const path of ['screenpeek://app/main.js', 'screenpeek://app/preload.cjs', 'screenpeek://app/../package.json',
      'screenpeek://app/%2e%2e/package.json', 'screenpeek://app/vendor/../main.js', 'screenpeek://other/setup.html', 'screenpeek://app/nope.html']) {
      expect(await status(path), path).not.toBe(200);
    }
    // Local pages have no Node access either.
    expect(await setup.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined')).toBe(true);
    // The only errors are the page's own policy refusing the fetch this test tried.
    expect(errors.filter((error) => !/pages\.css/.test(error))).toEqual([]);
  } finally { await close(); }
});

test('forged or malformed laser messages never reach the screen', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    // Nothing shared yet: asking for an overlay on any display does nothing.
    for (const value of [{ displayId: '999999' }, { displayId: {} }, { displayId: null }, 'x', 42, [], null]) {
      await page.evaluate((value) => window.screenpeekDesktop.overlay(value), value);
    }
    await page.waitForTimeout(300);
    expect((await overlayState(app))?.visible || false).toBe(false);
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect.poll(async () => (await overlayState(app))?.visible).toBe(true);
    for (const message of [null, 'x', 42, { type: 'apply' }, { type: 'apply', id: 'a'.repeat(500), point: { x: 0.5, y: 0.5 } },
      { type: 'apply', id: 'z', point: { x: 'a', y: 0.5 } }, { type: 'apply', id: 'z', point: { x: NaN, y: Infinity } },
      { type: 'apply', id: '__proto__', point: null }, { type: 'nope', id: 'z' }, { type: 'clear', id: { toString: 1 } }]) {
      await page.evaluate((message) => window.screenpeekDesktop.laser(message), message);
    }
    await page.waitForTimeout(300);
    expect(await overlayLaser(app, 0.5, 0.5)).toBe(0);
    // Out-of-range points are pinned to the screen edge.
    await page.evaluate(() => window.screenpeekDesktop.laser({ type: 'apply', id: 'edge', point: { x: 9, y: -9 }, look: { style: 'blue', label: 'x'.repeat(5000) } }));
    await expect.poll(() => overlayLaser(app, 1, 0)).toBeGreaterThan(100);
    // The real thing still works afterwards.
    await watcher.page.locator('#laserBtn').click();
    await pointAt(watcher.page, 0.4, 0.6);
    await expect.poll(() => overlayLaser(app, 0.4, 0.6)).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});

test('no internet: a friendly page that recovers once the site is back', async () => {
  const errors = [];
  // Nothing listens on this port yet.
  const port = 3290;
  const { app, close } = await launch({ errors, env: { SCREENPEEK_URL: `http://127.0.0.1:${port}/` } });
  let proxy;
  try {
    const offline = await windowFor(app, 'offline.html');
    await expect(offline.getByRole('heading', { name: 'Can’t reach Screenpeek' })).toBeVisible();
    await expect(offline.locator('#next')).toContainText('Trying again in');
    await offline.locator('#retry').click();
    await expect(offline.getByRole('heading', { name: 'Can’t reach Screenpeek' })).toBeVisible();
    // The site comes back.
    proxy = http.createServer((request, response) => {
      const upstream = http.request(`${server}${request.url}`, { method: request.method, headers: request.headers }, (reply) => {
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      });
      request.pipe(upstream);
    }).listen(port);
    await (await windowFor(app, 'offline.html')).locator('#retry').click();
    const page = await windowFor(app, `127.0.0.1:${port}`);
    await expect(page.locator('#startBtn')).toBeVisible();
    expect(errors.filter((error) => !/ERR_CONNECTION_REFUSED|Failed to load/.test(error))).toEqual([]);
  } finally {
    proxy?.close();
    await close();
  }
});

test('a second copy hands over to the first; closing while sharing quits cleanly with no overlay left', async () => {
  const errors = [];
  const { app, userData, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect.poll(async () => (await overlayState(app))?.visible).toBe(true);
    // Display changes keep the overlay on its screen.
    const before = (await overlayState(app)).bounds;
    await app.evaluate(({ screen }) => { screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['bounds']); });
    expect((await overlayState(app)).bounds).toEqual(before);

    // Opening Screenpeek again doesn't start a second app.
    const environment = { ...process.env, SCREENPEEK_URL: server + '/', SCREENPEEK_FAKE_CAPTURE: '1', SCREENPEEK_USER_DATA: userData };
    delete environment.ELECTRON_RUN_AS_NODE;
    const second = await electron.launch({ args: [fileURLToPath(new URL('..', import.meta.url))], env: environment }).catch(() => null);
    if (second) {
      await expect.poll(() => second.process().exitCode !== null, { timeout: 10000 }).toBe(true);
    }
    expect((await overlayState(app)).visible).toBe(true);

    // A crashed page takes the laser off the screen.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('http')).webContents.forcefullyCrashRenderer());
    await expect.poll(async () => (await overlayState(app))?.visible || false).toBe(false);
    await page.reload().catch(() => {});

    // Closing the window quits the app, leaving nothing on screen.
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('http')).close());
    await expect(Promise.race([exited.then(() => 'quit'), new Promise((resolve) => setTimeout(() => resolve('still running'), 8000))])).resolves.toBe('quit');
  } finally {
    await watcher?.close();
    await close();
  }
});
