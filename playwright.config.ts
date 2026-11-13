import { defineConfig } from '@playwright/test';

// Runs against an already running stack (`npm run demo`), using the system Chrome.
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 480_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    launchOptions: { executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome' },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
