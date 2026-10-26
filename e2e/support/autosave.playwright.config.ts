import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Main schedules this standalone run; importing the root config rebuilds shared fixtures.
export default defineConfig({
  testDir: '..',
  testMatch: 'record-autosave.spec.ts',
  outputDir: join(tmpdir(), 'tablewalk-autosave-browser-results'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7000 },
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { actionTimeout: 7000, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
});
