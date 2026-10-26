import { defineConfig, devices } from '@playwright/test';

// A focused run does not start unrelated Apps or rebuild shared e2e/.tmp.
export default defineConfig({
  testDir: '../..',
  testMatch: 'tenant-administration.spec.ts',
  outputDir: '/tmp/tablewalk-administration-browser-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 7000 },
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], trace: 'off', screenshot: 'off', video: 'off' },
});
