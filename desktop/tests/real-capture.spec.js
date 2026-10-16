import { test, expect } from '@playwright/test';
import { launch, mainWindow, share, viewer, overlayLaser, pointAt } from './app.js';

// Uses the real screen (needs Screen Recording permission), so it runs only on request:
//   REAL_CAPTURE=1 npx playwright test real-capture
test.skip(process.env.REAL_CAPTURE !== '1', 'Set REAL_CAPTURE=1 to capture the real screen.');

// How many laser-coloured pixels the sharer's own captured video shows near a point.
const capturedLaser = (page, x, y) => page.evaluate(({ x, y }) => {
  const video = document.querySelector('#localVideo');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const r = Math.round(canvas.width * 0.01);
  const data = ctx.getImageData(Math.round(x * canvas.width) - r, Math.round(y * canvas.height) - r, r * 2, r * 2).data;
  let hits = 0;
  // The rainbow laser cycles through saturated colours; nearly nothing on a desktop is that vivid.
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 150) hits++;
  return hits;
}, { x, y });

test('the on-screen laser never appears in the shared video', async () => {
  test.setTimeout(120000);
  const errors = [];
  const { app, close } = await launch({ errors, env: { SCREENPEEK_FAKE_CAPTURE: '0' } });
  let watcher;
  try {
    const page = await mainWindow(app);
    // Keep the app's own window out of the way of the sampled spot.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 420, height: 600 }));
    const code = await share(app, page);
    watcher = await viewer(code, errors);
    await page.locator('#laserBtn').click();
    await watcher.page.locator('#peopleBtn').click();
    await watcher.page.locator('.style-option[data-style="rainbow"]').click();
    await watcher.page.keyboard.press('Escape');
    await watcher.page.locator('#laserBtn').click();
    await pointAt(watcher.page, 0.7, 0.5);
    await expect.poll(() => overlayLaser(app, 0.7, 0.5)).toBeGreaterThan(200);
    const before = await capturedLaser(page, 0.7, 0.5);

    // Control: without protection, the capture does pick the laser up.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('overlay.html')).setContentProtection(false));
    await expect.poll(() => capturedLaser(page, 0.7, 0.5), { timeout: 8000 }).toBeGreaterThan(before + 20);
    // Protected, as the app sets it: gone from the capture again.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('overlay.html')).setContentProtection(true));
    await expect.poll(() => capturedLaser(page, 0.7, 0.5), { timeout: 8000 }).toBeLessThanOrEqual(before);
    // And it is still drawn on the screen itself.
    expect(await overlayLaser(app, 0.7, 0.5)).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  } finally {
    await watcher?.close();
    await close();
  }
});
