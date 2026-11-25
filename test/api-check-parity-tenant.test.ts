/**
 * `mistri check` judges a tenant App's `api` as its export and its serving do (test/api-check-parity.test.ts is an
 * ordinary App's). A field report's App was a tenant App: the check that had learned to render an ordinary App's
 * document passed over a tenant's, so a sort by a timestamp still passed the check and failed `--export openapi`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { writeDepotApp } from './appApiCli.js';
import { mistri } from './support/bootstrapApp.js';

function depot(t: { after(fn: () => void): void }, api: Record<string, unknown>, roles?: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-api-check-tenant-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const written = writeDepotApp(directory, {
    business,
    authStore: join(directory, 'auth.db'),
    physical: 'physical_item',
    api,
    commands: true,
    ...(roles ? { roles } : {}),
  });
  const db = new DatabaseSync(business);
  db.exec(
    'CREATE TABLE physical_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, ' +
      'version INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP)',
  );
  db.close();
  const env = { XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', BETTER_AUTH_SECRET: 'x'.repeat(40) };
  const base = ['--config', written.config, '--app', written.appDir, '--policy', written.policy, '--commands', written.commands!];
  return {
    check: () => mistri(['check', ...base], directory, env),
    exported: () => mistri([...base, '--export', 'openapi', '--api-integers', 'decimal-string'], directory, env),
  };
}

test("a tenant App's sort by a timestamp column is a check problem [api-sort-type], as its export refuses it", (t) => {
  const f = depot(t, {
    version: 1,
    roles: ['member'],
    resources: { item: { fields: ['id', 'name', 'created_at'], sorts: ['created_at'] } },
  });
  const exported = f.exported();
  assert.notEqual(exported.code, 0);
  assert.match(exported.stderr, /\[api-sort-type\]/);
  const checked = f.check();
  assert.equal(checked.code, 4, checked.said);
  assert.match(checked.said, /\[api-sort-type\]/);
});

test('one run says a refusal of the reads and a refusal of the commands, not the first alone', (t) => {
  // `reader` reads and runs nothing: the command the API exposes is held whole by no API role.
  const f = depot(
    t,
    {
      version: 1,
      roles: ['reader'],
      resources: { item: { fields: ['id', 'name', 'created_at'], sorts: ['created_at'] } },
      commands: ['touch'],
    },
    { reader: { read: true } },
  );
  const checked = f.check();
  assert.equal(checked.code, 4, checked.said);
  assert.match(checked.said, /\[api-sort-type\]/);
  assert.match(checked.said, /\[api-command-unheld\]/);
});

test("a tenant App's API with nothing wrong adds no problem to its check", (t) => {
  const f = depot(t, { version: 1, roles: ['member'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } });
  assert.equal(f.exported().code, 0);
  const checked = f.check();
  // The stores are not made in this fixture: that is the check's only finding (exit 8), and no API refusal beside it.
  assert.equal(checked.code, 8, checked.said);
  assert.doesNotMatch(checked.said, /\[api-/);
});
