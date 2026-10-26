import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: true,
  // Disposable hosts load the source client cold after sign-in, as the main browser suite does.
  timeout: process.env.CI ? 40_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 7_000 },
  // A failure keeps its evidence; it is not retried until it passes.
  retries: 0,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
