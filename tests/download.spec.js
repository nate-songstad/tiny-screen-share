import { test, expect } from '@playwright/test';
import { newPage, startPair } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

test('the download link sits at the top left and leads to install steps and the Mac download', async ({ browser, request }) => {
  const errors = [];
  const page = await newPage(browser, errors);
  await page.goto('/');
  const link = page.getByRole('link', { name: /Download Screenpeek Desktop/ });
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  const brand = await page.locator('.brand').boundingBox();
  expect(box.x).toBeLessThan(640);
  expect(Math.abs((box.y + box.height / 2) - (brand.y + brand.height / 2))).toBeLessThan(12);
  await link.click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(page.getByRole('heading', { name: 'The laser, right on your screen.' })).toBeVisible();
  await expect(page.getByText('Open Anyway')).toBeVisible();
  await expect(page.locator('#macDownload')).toHaveAttribute('href', '/download/mac');
  // The button redirects to the release's disk image.
  const response = await request.get('/download/mac', { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toMatch(/^https:\/\/github\.com\/.+\/releases\/latest\/download\/Screenpeek\.dmg$/);
  // No horizontal scrolling on phones, and no desktop link there.
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.goto('/');
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole('link', { name: /Download Screenpeek Desktop/ })).toBeHidden();
  expect(errors).toEqual([]);
});

test('in a browser nothing desktop-only appears, and the laser still uses the floating window', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  expect(await host.evaluate(() => document.documentElement.classList.contains('is-desktop'))).toBe(false);
  await host.locator('#laserBtn').click();
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(host.locator('#onScreenBtn')).toBeHidden();
  await expect.poll(() => host.evaluate(() => Boolean(window.documentPictureInPicture?.window))).toBe(true);
  await expect(host.locator('#sessionHint')).toContainText('floating window');
  await expect(viewer.locator('#laserBtn')).toBeVisible();
  expect(errors).toEqual([]);
});
