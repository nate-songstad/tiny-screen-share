import { test, expect } from '@playwright/test';
import { launch, mainWindow } from './app.js';

test('the app starts, loads the site, and exposes only its small API', async () => {
  const errors = [];
  const { app, close } = await launch({ errors });
  try {
    const page = await mainWindow(app);
    await expect(page.locator('#startBtn')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('is-desktop'))).toBe(true);
    await expect(page.locator('.download-link')).toBeHidden();
    expect(await page.evaluate(() => Object.keys(window.screenpeekDesktop).sort())).toEqual(['apiVersion', 'laser', 'lastSource', 'overlay', 'retry']);
    expect(await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined')).toBe(true);
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test('the app’s copy of the laser drawing code matches the website’s', async () => {
  const { readFileSync } = await import('node:fs');
  const site = readFileSync(new URL('../../public/laser.js', import.meta.url), 'utf8');
  const bundled = readFileSync(new URL('../src/vendor/laser.js', import.meta.url), 'utf8');
  expect(bundled, 'run npm run sync').toBe(site);
});
