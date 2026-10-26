/** Lintel's browser layer: each spec owns its host, so they run side by side, on a desk and on a phone. */
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  fullyParallel: true,
  // Each worker serves its own Lintel; two keep a laptop responsive.
  workers: process.env.CI ? undefined : 2,
  // A disposable host loads its client cold from source after the first sign-in.
  timeout: process.env.CI ? 90_000 : 120_000,
  expect: { timeout: process.env.CI ? 15_000 : 20_000 },
  // A failure keeps its evidence; it is not retried until it passes.
  retries: 0,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
