/**
 * A component run leaves nothing in the temp directory. Vitest 5 copies the
 * modules it transforms into a 21-character folder there and never removed
 * the run's own; test/components.globalSetup.ts does. The run here points
 * TMPDIR at a fresh folder, so it sees only what this run left, and nobody
 * else's.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a component run removes the temp folder Vitest makes for it', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'tw-vitest-temp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const run = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'packages/kit/src/client/components/dashboardModel.test.ts', '--maxWorkers=1'],
    { env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, CI: '1' }, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(
    readdirSync(temp).filter((name) => /^[A-Za-z0-9_-]{21}$/.test(name)),
    [],
  );
});
