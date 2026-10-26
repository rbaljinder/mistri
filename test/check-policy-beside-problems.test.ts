/**
 * Skill run: `mistri check` with a row policy that would not start said only the policy's refusal, and every
 * problem the App's validation would have named sat behind it, so each probe looked the same. The refusal is now said
 * beside the App's own problems, after them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const ENTRY = resolve('packages/mistri/src/server/index.ts');

test("check says a policy's refusal beside the App's own problems, not instead of them", { timeout: 60_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-check-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'ops.db'));
  db.exec('CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL);');
  db.close();
  writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'ops', url: join(dir, 'ops.db') }] }));
  mkdirSync(join(dir, 'app'));
  writeFileSync(
    join(dir, 'app', 'app.json'),
    JSON.stringify({
      id: 'spoke',
      name: 'Spoke',
      connection: 'ops',
      auth: { rows: 'policy', roles: { admin: { label: 'Admin', read: true } } },
      // A segment over a column the table lacks: the App's own problem, which the policy's refusal used to hide.
      resources: { job: { segments: { stale: 'nowhere_col = 1' } } },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
    }),
  );
  // A policy with no resolveRows: its own fault.
  writeFileSync(join(dir, 'policy.mjs'), `export default { appId: 'spoke' };\n`);
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      ENTRY,
      'check',
      '--app',
      join(dir, 'app'),
      '--config',
      join(dir, 'mistri.json'),
      '--policy',
      join(dir, 'policy.mjs'),
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } },
  );
  const said = `${run.stdout}\n${run.stderr}`;
  assert.notEqual(run.status, 0, said);
  assert.match(said, /nowhere_col/, said);
  assert.match(said, /The row policy has no resolveRows function/, said);
});
