import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, windowFor, mainWindow, pressClosing } from './app.js';

const mainOpen = (app) => app.windows().some((page) => !page.isClosed() && page.url().startsWith('http://127.0.0.1:3218'));
const saved = (userData) => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));

test('first launch walks through setup, then opens Screenpeek; later launches skip it', async () => {
  const errors = [];
  const { app, userData, close } = await launch({ errors, settings: null, env: { SCREENPEEK_FAKE_SCREEN_ACCESS: 'granted' } });
  try {
    const setup = await windowFor(app, 'setup.html');
    await expect(setup.locator('#welcomeTitle')).toBeVisible();
    expect(mainOpen(app)).toBe(false);
    await expect(setup.locator('#primary')).toBeFocused();
    await setup.locator('#primary').click();
    // Not running from Downloads, so no move step: straight to screen recording, already on.
    await expect(setup.locator('#screenTitle')).toBeVisible();
    await expect(setup.locator('#screenEyebrow')).toHaveText('Step 1');
    await expect(setup.locator('#accessBadge')).toHaveText('Screen recording is on');
    await expect(setup.locator('#primary')).toHaveText('Continue');
    await setup.locator('#primary').click();
    await expect(setup.locator('#doneTitle')).toBeVisible();
    await setup.locator('#primary').click();
    const page = await mainWindow(app);
    await expect(page.locator('#startBtn')).toBeVisible();
    expect(saved(userData).setupDone).toBe(true);
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('turning on screen recording mid-setup asks for the relaunch macOS needs', async () => {
  const errors = [];
  const { app, userData, close } = await launch({ errors, settings: null, env: { SCREENPEEK_FAKE_SCREEN_ACCESS: 'not-determined' } });
  try {
    await app.evaluate(({ app: electronApp, shell }) => {
      globalThis.opened = [];
      shell.openExternal = async (url) => { globalThis.opened.push(url); };
      electronApp.relaunch = () => { globalThis.relaunched = true; };
      electronApp.exit = () => { globalThis.exited = true; };
    });
    const setup = await windowFor(app, 'setup.html');
    await setup.locator('#primary').click();
    await expect(setup.locator('#accessBadge')).toHaveText('Screen recording is off');
    await expect(setup.locator('#skip')).toHaveText('Skip — I’ll only watch for now');
    await setup.locator('#primary').click();
    await expect.poll(() => app.evaluate(() => globalThis.opened)).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
    // The person flips the switch in System Settings; setup notices by itself.
    await app.evaluate(() => { process.env.SCREENPEEK_FAKE_SCREEN_ACCESS = 'granted'; });
    await expect(setup.locator('#accessBadge')).toHaveText('Screen recording is on. Relaunch to finish.');
    await expect(setup.locator('#primary')).toHaveText('Relaunch Screenpeek');
    await expect(setup.locator('#skip')).toBeHidden();
    await setup.locator('#primary').click();
    await expect.poll(() => app.evaluate(() => [globalThis.relaunched, globalThis.exited])).toEqual([true, true]);
    expect(saved(userData).setupDone).toBe(true);
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('setup can be skipped or closed at any point, and opened again from the menu', async () => {
  const errors = [];
  const { app, close } = await launch({ errors, settings: null, env: { SCREENPEEK_FAKE_SCREEN_ACCESS: 'denied' } });
  try {
    let setup = await windowFor(app, 'setup.html');
    await setup.locator('#primary').click();
    await setup.locator('#skip').click();
    await expect(setup.locator('#doneTitle')).toBeVisible();
    await pressClosing(setup, 'Escape');
    const page = await mainWindow(app);
    await expect(page.locator('#startBtn')).toBeVisible();
    // Screenpeek → Set Up Screen Sharing… opens straight on that step.
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items[0].submenu.items.find((entry) => entry.label === 'Set Up Screen Sharing…');
      item.click();
    });
    setup = await windowFor(app, 'setup.html');
    await expect(setup.locator('#screenTitle')).toBeVisible();
    // Asking twice focuses the same window rather than opening another.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((entry) => entry.label === 'Set Up Screen Sharing…').click());
    expect(app.windows().filter((item) => !item.isClosed() && item.url().includes('setup.html')).length).toBe(1);
    await pressClosing(setup, 'Escape');
    await expect.poll(() => app.windows().some((item) => !item.isClosed() && item.url().includes('setup.html'))).toBe(false);
    // Closing setup when the main window is already open doesn't open a second one.
    expect(app.windows().filter((item) => !item.isClosed() && item.url().startsWith('http://127.0.0.1:3218')).length).toBe(1);
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('running from Downloads offers to move to Applications, and explains if that fails', async () => {
  const errors = [];
  const { app, close } = await launch({ errors, settings: null, env: { SCREENPEEK_FAKE_OUTSIDE_APPLICATIONS: '1', SCREENPEEK_FAKE_SCREEN_ACCESS: 'granted' } });
  try {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.moveToApplicationsFolder = () => { globalThis.moveAsked = true; return false; };
    });
    const setup = await windowFor(app, 'setup.html');
    await setup.locator('#primary').click();
    await expect(setup.locator('#moveTitle')).toBeVisible();
    await expect(setup.locator('#primary')).toHaveText('Move to Applications');
    await setup.locator('#primary').click();
    await expect.poll(() => app.evaluate(() => globalThis.moveAsked)).toBe(true);
    await expect(setup.locator('#moveFailed')).toBeVisible();
    // Not now moves on; the screen step is Step 2 after the move step.
    await setup.locator('#skip').click();
    await expect(setup.locator('#screenEyebrow')).toHaveText('Step 2');
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('quitting during setup really quits, and doesn’t open the main window on the way out', async () => {
  const { app, close } = await launch({ settings: null });
  try {
    await windowFor(app, 'setup.html');
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect(Promise.race([exited.then(() => 'quit'), new Promise((resolve) => setTimeout(() => resolve('still running'), 8000))])).resolves.toBe('quit');
  } finally { await close(); }
});
