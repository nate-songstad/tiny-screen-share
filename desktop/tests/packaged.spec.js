import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { windowFor, mainWindow, share, viewer, overlayState, overlayLaser, pointAt, server } from './app.js';

// The built app, straight from its disk image: npm run dist, then
//   PACKAGED=1 npx playwright test packaged
test.skip(process.env.PACKAGED !== '1', 'Set PACKAGED=1 after npm run dist.');

test('the built app runs from the disk image: setup offers the move, sharing and the on-screen laser work', async () => {
  test.setTimeout(120000);
  const dmg = new URL('../dist/Screenpeek.dmg', import.meta.url).pathname;
  const attached = execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', dmg]).toString();
  const volume = attached.trim().split('\n').at(-1).split('\t').at(-1);
  const userData = mkdtempSync(join(tmpdir(), 'screenpeek-packaged-'));
  const environment = { ...process.env, SCREENPEEK_URL: server + '/', SCREENPEEK_FAKE_CAPTURE: '1', SCREENPEEK_FAKE_SCREEN_ACCESS: 'granted', SCREENPEEK_USER_DATA: userData };
  delete environment.ELECTRON_RUN_AS_NODE;
  const errors = [];
  const app = await electron.launch({ executablePath: `${volume}/Screenpeek.app/Contents/MacOS/Screenpeek`, env: environment });
  app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  let watcher;
  try {
    expect(await app.evaluate(({ app: electronApp }) => [electronApp.isPackaged, electronApp.getName(), electronApp.isInApplicationsFolder()])).toEqual([true, 'Screenpeek', false]);
    // Running from the disk image: setup asks to move it to Applications first.
    const setup = await windowFor(app, 'setup.html');
    await setup.locator('#primary').click();
    await expect(setup.locator('#moveTitle')).toBeVisible();
    await setup.locator('#skip').click();
    await expect(setup.locator('#screenEyebrow')).toHaveText('Step 2');
    await setup.locator('#primary').click();
    await setup.locator('#primary').click();
    const page = await mainWindow(app);
    // No developer tools in the shipped menu.
    expect(await app.evaluate(({ Menu }) => JSON.stringify(Menu.getApplicationMenu().items.map((item) => item.submenu?.items.map((entry) => entry.role || entry.label))))).not.toContain('toggledevtools');
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await expect.poll(async () => (await overlayState(app))?.visible).toBe(true);
    await watcher.page.locator('#laserBtn').click();
    await pointAt(watcher.page, 0.6, 0.35);
    await expect.poll(() => overlayLaser(app, 0.6, 0.35)).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    execFileSync('hdiutil', ['detach', volume, '-quiet']);
  }
});
