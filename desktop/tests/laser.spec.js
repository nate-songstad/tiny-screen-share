import { test, expect } from '@playwright/test';
import { launch, mainWindow, share, viewer, overlayState, overlayLaser, overlayAny, pointAt } from './app.js';

test('desktop sharer: the laser appears right on the shared screen, click-through and hidden from capture', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await expect(page.locator('#sessionStatus')).toHaveText('Viewer connected');
    expect(await page.evaluate(() => window.screenpeekDesktop.lastSource())).toMatchObject({ kind: 'screen' });
    expect(await overlayState(app)).toBeNull();

    await page.locator('#laserBtn').click();
    await expect(page.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
    // On screen by default, with a toggle to turn it off; no floating window.
    await expect(page.locator('#onScreenBtn')).toBeVisible();
    await expect(page.locator('#onScreenBtn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sessionHint')).toContainText('right on your screen');
    await expect(page.locator('#message')).toContainText('Lasers now appear right on your screen');
    await expect.poll(async () => (await overlayState(app))?.visible).toBe(true);
    const state = await overlayState(app);
    const shared = state.displays.find((display) => display.id === state.primary);
    expect(state.bounds).toEqual(shared.bounds);
    expect(state).toMatchObject({ onTop: true, focusable: false, allSpaces: true });
    if (state.protected !== null) expect(state.protected).toBe(true);
    expect(await page.evaluate(() => Boolean(window.documentPictureInPicture?.window))).toBe(false);

    // The viewer points: the orb lands at the same spot on the real screen.
    await watcher.page.locator('#laserBtn').click();
    await expect(watcher.page.locator('#laserCanvas')).toHaveClass(/pointing/);
    await pointAt(watcher.page, 0.3, 0.4);
    await expect.poll(() => overlayLaser(app, 0.3, 0.4)).toBeGreaterThan(200);
    expect(await overlayLaser(app, 0.7, 0.7)).toBe(0);
    await pointAt(watcher.page, 0.75, 0.65, 5);
    await expect.poll(() => overlayLaser(app, 0.75, 0.65)).toBeGreaterThan(200);
    await expect.poll(() => overlayLaser(app, 0.3, 0.4)).toBe(0);
    // Leaving the video hides it on screen too.
    await watcher.page.locator('#leaveBtn').hover();
    await expect.poll(() => overlayAny(app)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});

const visible = async (app) => Boolean((await overlayState(app))?.visible);

test('the on-screen laser follows the laser switch, the toggle, pause, reload and ending', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);
    await watcher.page.locator('#laserBtn').click();
    await pointAt(watcher.page, 0.5, 0.5);
    await expect.poll(() => overlayLaser(app, 0.5, 0.5)).toBeGreaterThan(200);

    // Toggle off: the overlay goes; the laser itself stays on for the viewer.
    await page.locator('#onScreenBtn').click();
    await expect(page.locator('#onScreenBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => visible(app)).toBe(false);
    await expect(watcher.page.locator('#laserBtn')).toBeVisible();
    await expect(page.locator('#message')).toContainText('preview in this window');
    expect(await page.evaluate(() => window.documentPictureInPicture)).toBeUndefined();
    // Back on: the overlay catches up with the pointer that's already there.
    await page.locator('#onScreenBtn').click();
    await expect.poll(() => visible(app)).toBe(true);
    await expect.poll(() => overlayLaser(app, 0.5, 0.5)).toBeGreaterThan(200);

    // Pause hides it and clears it; resume brings it back.
    await page.locator('#pauseBtn').click();
    await expect.poll(() => visible(app)).toBe(false);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(() => visible(app)).toBe(true);
    expect(await overlayAny(app)).toBe(false);
    await pointAt(watcher.page, 0.2, 0.8);
    await expect.poll(() => overlayLaser(app, 0.2, 0.8)).toBeGreaterThan(200);

    // The laser switch turns it all off.
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(false);
    await expect(page.locator('#onScreenBtn')).toBeHidden();
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);

    // A reload (View → Reload) loses the page's state, so the overlay goes too.
    await page.reload();
    await expect.poll(() => visible(app)).toBe(false);
    await expect(page.locator('#resumeBtn')).toBeVisible();
    await page.locator('#resumeBtn').click();
    const picker = await (await import('./app.js')).windowFor(app, 'picker.html');
    await picker.locator('#share').click();
    await expect(page.locator('#sessionStatus')).toHaveText('Viewer connected');
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);

    // Ending the screenpeek takes it off the screen.
    await page.locator('#leaveBtn').click();
    await expect(page.locator('#home')).toBeVisible();
    await expect.poll(() => visible(app)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});

test('the toggle choice is remembered across launches', async () => {
  const errors = [];
  const first = await launch({ errors });
  const userData = first.userData;
  let watcher;
  try {
    const page = await mainWindow(first.app);
    const code = await share(first.app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await page.locator('#onScreenBtn').click();
    await expect(page.locator('#onScreenBtn')).toHaveAttribute('aria-pressed', 'false');
    await watcher.close();
    watcher = null;
    await first.app.close();
    const { _electron: electron } = await import('@playwright/test');
    const environment = { ...process.env, SCREENPEEK_URL: 'http://127.0.0.1:3218/', SCREENPEEK_FAKE_CAPTURE: '1', SCREENPEEK_USER_DATA: userData };
    delete environment.ELECTRON_RUN_AS_NODE;
    const again = await electron.launch({ args: [new URL('..', import.meta.url).pathname], env: environment });
    try {
      const next = await mainWindow(again);
      const code2 = await share(again, next);
      watcher = await viewer(code2, errors);
      await next.locator('#laserBtn').click();
      await expect(next.locator('#onScreenBtn')).toHaveAttribute('aria-pressed', 'false');
      await next.waitForTimeout(500);
      expect(await visible(again)).toBe(false);
      // The first-time explanation isn't repeated either.
      await expect(next.locator('#message')).not.toContainText('Lasers now appear');
    } finally { await again.close(); }
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await first.close();
  }
});

test('sharing a window uses the floating window instead, and says why', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    const code = await share(app, page, { kind: 'window' });
    expect(await page.evaluate(() => window.screenpeekDesktop.lastSource())).toMatchObject({ kind: 'window', displayId: null });
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect(page.locator('#message')).toContainText('sharing a window, so the laser shows in the preview');
    await expect(page.locator('#sessionHint')).toContainText('The preview here shows where');
    await expect(page.locator('#onScreenBtn')).toBeHidden();
    await page.waitForTimeout(500);
    expect(await visible(app)).toBe(false);
    // The laser still works, in the app's own preview.
    await watcher.page.locator('#laserBtn').click();
    await pointAt(watcher.page, 0.5, 0.5);
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector('#laserCanvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 200) return true;
      return false;
    })).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});

test('flipping the floor away turns the overlay off; taking it back starts fresh', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);
    // The browser viewer takes the floor (its capture is Chromium's test source).
    await page.locator('#flipBtn').click();
    await expect(watcher.page.locator('#flipPrompt')).toBeVisible();
    await watcher.page.locator('#acceptFlipBtn').click();
    await expect(page.locator('#sessionStatus')).toHaveText('Live', { timeout: 20000 });
    await expect.poll(() => visible(app)).toBe(false);
    // The app, now watching, can point at the browser's screen.
    await watcher.page.locator('#laserBtn').click();
    await expect(page.locator('#laserBtn')).toBeVisible();
    // Flip back to the app: the picker appears, and the laser starts off.
    await watcher.page.locator('#flipBtn').click();
    await expect(page.locator('#flipPrompt')).toBeVisible();
    await page.locator('#acceptFlipBtn').click();
    const picker = await (await import('./app.js')).windowFor(app, 'picker.html');
    await picker.locator('#share').click();
    await expect(page.locator('#sessionStatus')).toHaveText('Viewer connected', { timeout: 20000 });
    await expect(page.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
    expect(await visible(app)).toBe(false);
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});

test('several viewers point at once, each in their own colour, and leaving takes theirs away', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  const watchers = [];
  try {
    const page = await mainWindow(app);
    const code = await share(app, page);
    for (let i = 0; i < 2; i++) watchers.push(await viewer(code, errors));
    await expect(page.locator('#sessionStatus')).toHaveText('2 viewers connected');
    await page.locator('#laserBtn').click();
    await expect.poll(() => visible(app)).toBe(true);
    for (const watcher of watchers) await watcher.page.locator('#laserBtn').click();
    await pointAt(watchers[0].page, 0.25, 0.3);
    await pointAt(watchers[1].page, 0.75, 0.7);
    await expect.poll(() => overlayLaser(app, 0.25, 0.3)).toBeGreaterThan(200);
    await expect.poll(() => overlayLaser(app, 0.75, 0.7)).toBeGreaterThan(200);
    // Different colours on screen, matching each person's laser.
    const hue = (x, y) => (async () => {
      const { windowFor } = await import('./app.js');
      const overlay = await windowFor(app, 'overlay.html');
      return overlay.evaluate(({ x, y }) => {
        const canvas = document.querySelector('#laser');
        const d = canvas.getContext('2d').getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data;
        return [d[0], d[1], d[2]];
      }, { x, y });
    })();
    const [first, second] = [await hue(0.25, 0.3), await hue(0.75, 0.7)];
    expect(first).not.toEqual(second);
    await watchers[1].page.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect.poll(() => overlayLaser(app, 0.75, 0.7)).toBe(0);
    expect(await overlayLaser(app, 0.25, 0.3)).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  } finally {
    for (const watcher of watchers) await watcher.close();
    await close();
  }
});
