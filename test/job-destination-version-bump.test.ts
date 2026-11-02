/**
 * F17, end to end: a producing command's version is bumped (`mistri check --bump`), and the job that listens to it no
 * longer matches the destination its store holds. Before, a start said only "could not be opened and attested" and
 * provisioning could not repair it; `check` and `migrate status` said nothing. Now the check names
 * `store-destination-changed` (exit 8) with the migrate command as its fix, a start names the cause, and
 * `migrate up --app` replaces the drained destination so the start succeeds. SQLite always; PostgreSQL when
 * TABLEWALK_TEST_PG names a server (a database of its own, dropped afterwards).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const drops: Array<() => Promise<void>> = [];
after(async () => {
  for (const drop of drops) await drop();
});

/** The validation a start runs, with every store attested (no `check` aside): what the server does before it listens. */
const start = (app: string, env: NodeJS.ProcessEnv) =>
  mistri(['--app', '.', '--jobs', 'jobs.mjs', '--commands', 'commands.ts'], app, { ...env, MISTRI_CHECK_VALIDATION: '1' });

async function scenario(t: TestContext, engine: 'sqlite' | 'postgres') {
  const { dir, app, config } = bootstrapApp(t);
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(dir, '.config') };
  if (engine === 'postgres') {
    const database = await uuidPostgresDatabase('f17_bump');
    drops.push(database.drop);
    writeFileSync(
      config,
      JSON.stringify({ connections: [{ name: 'desk', url: database.url, writable: true, migrations: { dir: 'migrations' } }] }),
    );
  }
  const up = ['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'];
  const check = ['check', '--app', '.', '--jobs', 'jobs.mjs'];

  // A store with a job destination, made for close@1.
  const first = mistri(up, app, env);
  assert.equal(first.code, 0, first.said);
  assert.equal(mistri([...check, '--write-authority'], app, env).code, 0);
  assert.equal(start(app, env).code, 0, 'before the bump a start attests the destination');

  // The producing command's version is bumped: the job's destination keeps its id and loses its policy.
  const bump = mistri([...check, '--bump', 'close', '--write-authority'], app, env);
  assert.equal(bump.code, 0, bump.said);

  // A start names the cause. Before: "could not be opened and attested", with nothing to say which or why.
  const refused = start(app, env);
  assert.notEqual(refused.code, 0, refused.said);
  assert.match(refused.said, /store-destination-changed/);
  assert.match(refused.said, /"job:archiveClosed@1" was made for close@1 and this App now derives close@2/);
  assert.match(refused.said, /bump the version of the job or workflow/);
  assert.match(refused.said, /mistri migrate up --app/);
  assert.doesNotMatch(refused.said, /could not be opened and attested/);

  // The check names it too: exit 8, its own code, the migrate command with this run's flags as the fix.
  const found = mistri([...check, '--json'], app, env);
  assert.equal(found.code, 8, found.said);
  const report = JSON.parse(found.stdout) as { exit: number; problems: { code: string; step: string; fix?: string; message: string }[] };
  const changed = report.problems.find((problem) => problem.code === 'store-destination-changed');
  assert.ok(changed, found.stdout);
  assert.equal(changed.step, 'stores');
  assert.equal(changed.fix, 'mistri migrate up --app . --jobs jobs.mjs');
  assert.match(changed.message, /job:archiveClosed@1 close@1 → close@2/);
  assert.equal(
    report.problems.some((problem) => problem.code === 'store-pending'),
    false,
    'nothing is missing; one destination changed',
  );

  // The plan says so without changing anything.
  const status = mistri(['migrate', 'status', '--app', '.', '--jobs', 'jobs.mjs'], app, env);
  assert.match(
    status.stdout,
    /2 stores\s+pending\s+event delivery \(delivery destination changed: job:archiveClosed@1 close@1 → close@2\)/,
  );

  // `up` drains and replaces it: nothing was undelivered.
  const repaired = mistri(up, app, env);
  assert.equal(repaired.code, 0, repaired.said);
  assert.match(repaired.stdout, /2 stores\s+applied\s+event delivery/);
  assert.match(repaired.stdout, /5 check\s+passed/);

  // The start succeeds, the check is clean, and a second `up` has nothing to do.
  assert.equal(start(app, env).code, 0, start(app, env).said);
  const clean = mistri(check, app, env);
  assert.equal(clean.code, 0, clean.said);
  const again = mistri(up, app, env);
  assert.equal(again.code, 0, again.said);
  assert.match(again.stdout, /\nNothing changed\.\n/);
}

describe('a producing command bumped under a job', () => {
  test('SQLite: named by check and a start, repaired by migrate up --app', { timeout: 240_000 }, async (t) => {
    await scenario(t, 'sqlite');
  });
  test(
    'PostgreSQL: named by check and a start, repaired by migrate up --app',
    { timeout: 240_000, skip: !LIVE && 'TABLEWALK_TEST_PG is not set' },
    async (t) => {
      await scenario(t, 'postgres');
    },
  );
});
