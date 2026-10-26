import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = (process.env.TABLEWALK_INVITATION_PROBE_OUTPUT ??= mkdtempSync(join(tmpdir(), 'tablewalk-invitation-artifacts-')));
export default defineConfig({
  testDir: '.',
  testMatch: 'artifact-probe.pw.ts',
  outputDir: output,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 15_000,
  // Deliberately enable defaults: the imported secret-bearing fixture must
  // override them even when a caller selects a diagnostic-heavy config.
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
