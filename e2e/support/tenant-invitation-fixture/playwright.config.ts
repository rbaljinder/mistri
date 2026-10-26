import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No import of the ordinary config: it provisions shared e2e/.tmp fixtures.
const output = (process.env.TABLEWALK_INVITATION_PLAYWRIGHT_OUTPUT ??= mkdtempSync(join(tmpdir(), 'tablewalk-invitation-playwright-')));
export default defineConfig({
  testDir: '../..',
  testMatch: 'tenant-invitations*.spec.ts',
  outputDir: output,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: 'off', screenshot: 'off', video: 'off', viewport: { width: 1280, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
