/**
 * `mistri migrate up --app` on an App with row policies (a field report): the check after up ran without the
 * policy, which check refuses before reading anything, so a migration that had applied cleanly printed "Policy
 * startup error", "validation failed" and exited 4. Without --policy the check is now named as skipped and the run
 * exits 0; with --policy it is run, and a real misfit still exits 4.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const ENTRY = resolve('packages/mistri/src/server/index.ts');

function project(t: { after(fn: () => void): void }, show = 'title') {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-migrate-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'ops', url: join(dir, 'ops.db') }] }));
  mkdirSync(join(dir, 'app', 'migrations'), { recursive: true });
  writeFileSync(
    join(dir, 'app', 'app.json'),
    JSON.stringify({
      id: 'spoke',
      name: 'Spoke',
      connection: 'ops',
      auth: { rows: 'policy', roles: { admin: { label: 'Admin', read: true } } },
      resources: { job: {} },
      views: { jobs: { kind: 'list', from: 'job', show: [show] } },
      home: 'jobs',
      nav: ['jobs'],
    }),
  );
  writeFileSync(join(dir, 'app', 'migrations', 'V1__job.sql'), 'CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n');
  writeFileSync(join(dir, 'policy.mjs'), `export default { appId: 'spoke', resolveRows() { return { job: true }; } };\n`);
  return dir;
}

const migrateUp = (dir: string, ...extra: string[]) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', ENTRY, 'migrate', 'up', '--app', join(dir, 'app'), '--config', join(dir, 'mistri.json'), ...extra],
    { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } },
  );

const applied = (dir: string) => {
  const db = new DatabaseSync(join(dir, 'ops.db'));
  try {
    return db.prepare('SELECT script, success FROM __mistri_schema_history WHERE version IS NOT NULL').all();
  } finally {
    db.close();
  }
};

test('migrate up on a row-policy App without --policy applies, names the check it skipped, and exits 0', { timeout: 60_000 }, (t) => {
  const dir = project(t);
  const run = migrateUp(dir);
  const said = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, said);
  assert.match(said, /applied V1__job\.sql/);
  assert.doesNotMatch(said, /Policy startup error|validation\s+failed|no longer fits/, said);
  assert.match(said, /check\s+skipped\s+an App with row policies is checked beside its policy[^\n]*--policy <file>/, said);
  assert.deepEqual(
    applied(dir).map((row) => ({ ...row })),
    [{ script: 'V1__job.sql', success: 1 }],
  );
});

test('migrate up --policy runs the check beside the policy: a fit passes, a misfit still exits 4', { timeout: 90_000 }, (t) => {
  const fits = project(t);
  const ok = migrateUp(fits, '--policy', join(fits, 'policy.mjs'));
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /validation\s+passed\s+Spoke: ok/);

  // The view shows a column no migration makes: a real failure after a successful migration.
  const misfit = project(t, 'due_on');
  const bad = migrateUp(misfit, '--policy', join(misfit, 'policy.mjs'));
  const said = `${bad.stdout}\n${bad.stderr}`;
  assert.equal(bad.status, 4, said);
  assert.match(said, /due_on/);
  assert.match(said, /The migrations are applied, and the App no longer fits the schema they made/);
});
