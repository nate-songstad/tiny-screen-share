import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 35000,
  expect: { timeout: 12000 },
  use: {
    baseURL: 'http://127.0.0.1:3217',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3217',
    env: { PORT: '3217', RECONNECT_GRACE_MS: '4000', FLIP_TIMEOUT_MS: '5000', LINK_TIMEOUT_MS: '5000' },
    reuseExistingServer: false
  }
});
