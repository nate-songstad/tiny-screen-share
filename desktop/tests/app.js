import { _electron as electron, chromium, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const server = 'http://127.0.0.1:3218';
const appDir = fileURLToPath(new URL('..', import.meta.url));

// Starts Screenpeek for Mac with a fresh profile. `settings` seeds settings.json
// (e.g. { setupDone: true } to skip the walkthrough).
export async function launch({ settings = { setupDone: true }, env = {}, errors = [] } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'screenpeek-test-'));
  if (settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings));
  const environment = { ...process.env, SCREENPEEK_URL: server + '/', SCREENPEEK_FAKE_CAPTURE: '1', SCREENPEEK_USER_DATA: userData, ...env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [appDir], env: environment });
  app.process().stderr?.on('data', (chunk) => {
    const text = String(chunk);
    if (/Uncaught|TypeError|ReferenceError|Error invoking remote method/.test(text)) errors.push(text.trim());
  });
  const watch = (page) => {
    page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`); });
  };
  app.on('window', watch);
  for (const page of app.windows()) watch(page);
  const close = async () => {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  };
  return { app, userData, close };
}

// The window showing a given page (by URL fragment), once it exists.
export async function windowFor(app, fragment) {
  const find = () => app.windows().filter((page) => !page.isClosed() && page.url().includes(fragment)).at(-1);
  await expect.poll(() => Boolean(find()), { timeout: 15000 }).toBe(true);
  return find();
}

// Presses a key that closes the window it's pressed in.
export const pressClosing = (page, key) => page.keyboard.press(key).catch((error) => {
  if (!/closed/.test(error.message)) throw error;
});

export async function mainWindow(app) {
  const page = await windowFor(app, server);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

// Shares from the app: Share my screen → picker → (optionally a window) → Share.
export async function share(app, page, { kind = 'screen' } = {}) {
  await page.locator('#startBtn').click();
  const picker = await windowFor(app, 'picker.html');
  await expect(picker.locator('#share')).toBeVisible();
  if (kind === 'window') await picker.locator('#windowsTab').click();
  await expect(picker.locator('.tile[aria-pressed="true"]')).toHaveCount(1);
  await picker.locator('#share').click();
  await expect(page.locator('#roomCode')).toHaveText(/^\d{6}$/);
  return page.locator('#roomCode').textContent();
}

// A browser viewer (plain Chromium), joined to the room and watching.
export async function viewer(code, errors = []) {
  // Chromium's test screen, so this viewer can take the floor without a picker.
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => errors.push(`viewer: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`viewer: ${message.text()}`); });
  await page.goto(`${server}/?room=${code}`);
  await expect(page.locator('#sessionStatus')).toHaveText('Live', { timeout: 20000 });
  await expect.poll(() => page.locator('#remoteVideo').evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  return { page, close: () => browser.close() };
}

// The main process's view of the on-screen overlay window.
export const overlayState = (app) => app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'Screenpeek laser overlay' || item.webContents.getURL().endsWith('overlay.html'));
  if (!win) return null;
  return {
    visible: win.isVisible(), bounds: win.getBounds(), onTop: win.isAlwaysOnTop(), focusable: win.isFocusable(),
    protected: typeof win.isContentProtected === 'function' ? win.isContentProtected() : null,
    allSpaces: win.isVisibleOnAllWorkspaces(),
    displays: screen.getAllDisplays().map((display) => ({ id: String(display.id), bounds: display.bounds })),
    primary: String(screen.getPrimaryDisplay().id)
  };
});

// Strongest strongly coloured pixel near a normalized point of the overlay canvas.
export async function overlayLaser(app, x, y) {
  const page = await windowFor(app, 'overlay.html');
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('#laser');
    if (!canvas.width) return 0;
    const cx = Math.round(x * canvas.width), cy = Math.round(y * canvas.height), r = Math.ceil(6 * devicePixelRatio);
    const data = canvas.getContext('2d').getImageData(Math.max(0, cx - r), Math.max(0, cy - r), r * 2 + 1, r * 2 + 1).data;
    let best = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 60) best = Math.max(best, data[i + 3]);
    }
    return best;
  }, { x, y });
}
export async function overlayAny(app) {
  const page = await windowFor(app, 'overlay.html');
  return page.evaluate(() => {
    const canvas = document.querySelector('#laser');
    if (!canvas.width) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
}

// Moves a browser viewer's pointer to a normalized point on the shared video.
export async function pointAt(viewerPage, x, y, steps = 3) {
  const target = await viewerPage.evaluate(async ({ x, y }) => {
    const { contentRect } = await import('/laser.js');
    const box = document.querySelector('#laserCanvas').getBoundingClientRect();
    const rect = contentRect(document.querySelector('#remoteVideo'), box.width, box.height);
    return { x: box.left + rect.x + x * rect.width, y: box.top + rect.y + y * rect.height };
  }, { x, y });
  await viewerPage.mouse.move(target.x, target.y, { steps });
}
