import { test, expect } from '@playwright/test';
import { launch, mainWindow, windowFor, pressClosing } from './app.js';

const pickers = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().endsWith('picker.html')).length);
const stubShell = (app) => app.evaluate(({ shell }) => {
  globalThis.opened = [];
  shell.openExternal = async (url) => { globalThis.opened.push(url); };
});
const opened = (app) => app.evaluate(() => globalThis.opened);

test('the picker lists screens and windows; every way of cancelling leaves the page ready to try again', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  try {
    const page = await mainWindow(app);
    for (const how of ['button', 'escape', 'close']) {
      await page.locator('#startBtn').click();
      const picker = await windowFor(app, 'picker.html');
      await expect(picker.locator('#screensTab')).toContainText('Entire screen (');
      await expect(picker.locator('#windowsTab')).toHaveText('Window (1)');
      // The main screen is chosen to start with.
      await expect(picker.locator('.tile[aria-pressed="true"] .tag')).toHaveText('Main');
      await expect(page.locator('#startBtn')).toBeDisabled();
      if (how === 'button') await picker.locator('#cancel').click();
      else if (how === 'escape') await pressClosing(picker, 'Escape');
      else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('picker.html')).close());
      await expect(page.locator('#message')).toContainText('Screen selection cancelled');
      await expect(page.locator('#startBtn')).toBeEnabled();
      await expect.poll(() => pickers(app)).toBe(0);
    }
    expect(await page.evaluate(() => window.screenpeekDesktop.lastSource())).toBeNull();

    // Keyboard: arrows move between choices, Enter shares.
    await page.locator('#startBtn').click();
    const picker = await windowFor(app, 'picker.html');
    await picker.locator('#windowsTab').click();
    await expect(picker.locator('.tile[aria-pressed="true"]')).toContainText('Notes');
    await expect(picker.locator('#tipText')).toContainText('preview instead');
    await picker.locator('#screensTab').click();
    await picker.locator('.tile[aria-pressed="true"]').focus();
    await pressClosing(picker, 'Enter');
    await expect(page.locator('#roomCode')).toHaveText(/^\d{6}$/);
    expect(await page.evaluate(() => window.screenpeekDesktop.lastSource())).toMatchObject({ kind: 'screen' });
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('only one picker at a time: a second request waits its turn instead of stacking', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  try {
    const page = await mainWindow(app);
    await page.locator('#startBtn').click();
    await windowFor(app, 'picker.html');
    // A stray second request (the app itself never makes one) doesn't open another picker.
    await page.evaluate(() => {
      window.second = navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted', (error) => error.name);
    });
    await page.waitForTimeout(800);
    expect(await pickers(app)).toBe(1);
    const first = await windowFor(app, 'picker.html');
    await first.locator('#share').click();
    await expect(page.locator('#roomCode')).toHaveText(/^\d{6}$/);
    // Only now does the stray request get its own picker; cancelling it leaves the share alone.
    const next = await windowFor(app, 'picker.html');
    expect(await pickers(app)).toBe(1);
    await next.locator('#cancel').click();
    expect(await page.evaluate(() => window.second)).toMatch(/NotAllowedError|AbortError/);
    await expect(page.locator('#sessionStatus')).not.toHaveText('Ready to resume');
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('without screen recording permission the picker walks you through it instead of failing', async () => {
  const errors = [];
  const { app, close } = await launch({ errors, env: { SCREENPEEK_FAKE_SCREEN_ACCESS: 'denied' } });
  try {
    await stubShell(app);
    const page = await mainWindow(app);
    await page.locator('#startBtn').click();
    const picker = await windowFor(app, 'picker.html');
    await expect(picker.locator('#permissionTitle')).toHaveText('Allow Screenpeek to share your screen');
    await expect(picker.locator('#share')).toBeHidden();
    await expect(picker.locator('#settings')).toBeFocused();
    await picker.locator('#settings').click();
    await expect.poll(() => opened(app)).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
    // "Walk me through it" opens the setup on the permission step and cancels the share.
    await picker.locator('#setupLink').click();
    await expect(page.locator('#message')).toContainText('Screen selection cancelled');
    const setup = await windowFor(app, 'setup.html');
    await expect(setup.locator('#screenTitle')).toBeVisible();
    await expect(setup.locator('#accessBadge')).toHaveText('Screen recording is off');
    await pressClosing(setup, 'Escape');
    await expect.poll(() => app.windows().some((item) => item.url().includes('setup.html'))).toBe(false);
    // A profile-blocked Mac says so.
    await app.evaluate(() => { process.env.SCREENPEEK_FAKE_SCREEN_ACCESS = 'restricted'; });
    await page.locator('#startBtn').click();
    const blocked = await windowFor(app, 'picker.html');
    await expect(blocked.locator('#restricted')).toBeVisible();
    await blocked.locator('#cancel').click();
    await expect(page.locator('#startBtn')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('accepting a flip in the app goes through the picker; cancelling it keeps the other person sharing', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  let watcher;
  try {
    const page = await mainWindow(app);
    // The browser starts the room; the app joins.
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const host = await browser.newPage();
    watcher = { close: () => browser.close() };
    await host.goto('http://127.0.0.1:3218/');
    await host.locator('#startBtn').click();
    await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
    await page.goto(`http://127.0.0.1:3218/?room=${await host.locator('#roomCode').textContent()}`);
    await expect(page.locator('#sessionStatus')).toHaveText('Live', { timeout: 20000 });
    await host.locator('#flipBtn').click();
    await page.locator('#acceptFlipBtn').click();
    const picker = await windowFor(app, 'picker.html');
    await picker.locator('#cancel').click();
    await expect(page.locator('#message')).toContainText('cancelled');
    await expect(host.locator('#flipBtn')).toBeEnabled();
    await expect(page.locator('#sessionStatus')).toHaveText('Live');
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});
