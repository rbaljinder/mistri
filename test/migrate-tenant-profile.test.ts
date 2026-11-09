/**
 * A tenant App configured through the `app` block of mistri.json (its dir and policy named once, no flag) is
 * migrated and then checked, and the follow-up check, a start of its own, is given the policy the migrations were
 * run beside: `migrate up` ends clean, never applying the migration and then failing on "Tenant startup requires
 * --policy and one explicit --app".
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEPOT_TABLE, writeDepotApp } from './appApiCli.js';

function migrateUp(directory: string, config: string) {
  return new Promise<{ code: number; out: string }>((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'migrate', 'up', '--config', config],
      {
        timeout: 60_000,
        env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', BETTER_AUTH_SECRET: 'x'.repeat(40) },
      },
      (error, out, err) => done({ code: Number(error?.code ?? 0), out: `${out}${err}` }),
    );
  });
}

test('migrate up on a tenant App named by mistri.json ends with a clean follow-up check', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-migrate-tenant-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const written = writeDepotApp(directory, { business, authStore: join(directory, 'auth.db'), physical: 'physical_item' });
  mkdirSync(join(written.appDir, 'migrations'));
  writeFileSync(join(written.appDir, 'migrations', 'V1__item.sql'), `${DEPOT_TABLE('physical_item')};`);
  const config = join(directory, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      app: { dir: written.appDir, policy: written.policy },
      connections: [{ id: 'data', name: 'data', url: business, writable: true }],
    }),
  );
  for (const run of ['the migration applies', 'and a second run, with the stores there']) {
    const result = await migrateUp(directory, config);
    assert.equal(result.code, 0, `${run}: ${result.out}`);
    assert.doesNotMatch(result.out, /Tenant startup requires/);
    assert.match(result.out, /5 check\s+passed/);
  }
});
