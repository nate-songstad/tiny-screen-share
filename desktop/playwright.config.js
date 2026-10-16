import { defineConfig } from '@playwright/test';

// Drives the real Electron app against a local Screenpeek server, with browser
// viewers alongside. Windows open on screen while these run.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 12000 },
  use: { trace: 'retain-on-failure', screenshot: 'off' },
  webServer: {
    command: 'node ../server.js',
    url: 'http://127.0.0.1:3218',
    env: { PORT: '3218', RECONNECT_GRACE_MS: '4000', FLIP_TIMEOUT_MS: '5000', LINK_TIMEOUT_MS: '5000' },
    reuseExistingServer: false
  }
});
