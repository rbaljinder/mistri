/**
 * The bootstrap plan (docs/bootstrap-plan.md): `mistri migrate status --app` prints it and changes nothing, and
 * `mistri migrate up --app` carries it out: migrations, the stores the App uses, the sign-in store, a word on seed
 * data, then the check. A field report took ten steps and three dead ends to bring up one App with events and jobs:
 * `up --jobs` was refused, `up` stopped at the migrations, and a missing store was said as "the App no longer fits
 * the schema they made".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';

const quiet = (dir: string) => ({ XDG_CONFIG_HOME: join(dir, '.config') });

test('status --app plans the whole bootstrap and changes nothing', (t) => {
  const { dir, app, db } = bootstrapApp(t);
  const run = mistri(['migrate', 'status', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  /* A plan is a report: status keeps its own exit, 2 while nothing was ever applied. */
  assert.equal(run.code, 2, run.said);
  assert.match(run.stdout, /1 migrations\s+pending\s+V1__item\.sql/);
  assert.match(run.stdout, /2 stores\s+pending\s+live sync, command journal, event store, job store, event delivery/);
  assert.match(run.stdout, /3 sign-in store\s+at start\s+a SQLite file the first start makes/);
  assert.match(run.stdout, /4 seed\s+—\s+item is empty: mistri seed --app \./);
  assert.match(run.stdout, /5 check\s+waiting\s+runs after 1 and 2/);
  assert.match(run.stdout, /Nothing changed\. mistri migrate up --app \. --jobs jobs\.mjs applies 1 and 2, then checks\./);
  assert.equal(existsSync(db), false, 'a status never makes the database');
});

test('up --app --jobs applies the migrations and the stores, then checks; a second run changes nothing', (t) => {
  const { dir, app } = bootstrapApp(t);
  /* Before: "--jobs is for stores.", exit 1. */
  const first = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(first.code, 0, first.said);
  assert.match(first.stdout, /1 migrations\s+applied\s+V1__item\.sql/);
  assert.match(first.stdout, /2 stores\s+applied\s+live sync, command journal, event store, job store, event delivery/);
  assert.match(first.stdout, /5 check\s+passed/);
  assert.match(first.stdout, /Changed: 1 migration, 5 stores\./);
  assert.doesNotMatch(first.said, /no longer fits/);

  const again = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(again.code, 0, again.said);
  assert.match(again.stdout, /2 stores\s+done/);
  assert.match(again.stdout, /\nNothing changed\.\n/);

  /* The plan as data: one document on stdout. */
  const json = mistri(['migrate', 'status', '--app', '.', '--jobs', 'jobs.mjs', '--json'], app, quiet(dir));
  assert.equal(json.code, 0, json.said);
  const plan = JSON.parse(json.stdout) as { phases: { phase: string; status: string }[]; changed: boolean; exit: number };
  assert.deepEqual(
    plan.phases.map((phase) => `${phase.phase}:${phase.status}`),
    ['migrations:done', 'stores:done', 'sign-in store:at start', 'seed:—', 'check:—'],
  );
  assert.equal(plan.changed, false);
});

test('a failing migration stops the run: V1 applied, V2 named, the stores wait, exit 3', (t) => {
  const { dir, app } = bootstrapApp(t);
  writeFileSync(join(app, 'migrations', 'V2__bad.sql'), 'INSERT INTO nowhere VALUES (1);\n');
  const run = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(run.code, 3, run.said);
  assert.match(run.stdout, /1 migrations\s+failed\s+V2__bad\.sql failed and was rolled back; applied before it: V1__item\.sql/);
  assert.match(run.stdout, /2 stores\s+waiting\s+runs after 1/);
  assert.match(run.stdout, /5 check\s+waiting/);
  assert.match(run.stdout, /Changed: V1__item\.sql\. Not changed: migrations \(failed\), stores \(waiting\), check \(waiting\)\./);
});

test('a store in a layout up will not touch fails the stores step: exit 5, never "no longer fits"', (t) => {
  const { dir, app, db } = bootstrapApp(t);
  assert.equal(mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir)).code, 0);
  const sqlite = new DatabaseSync(db);
  sqlite.exec(
    'DROP TABLE __mistri_live_meta; CREATE TABLE __mistri_live_meta (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO __mistri_live_meta VALUES (1, 99)',
  );
  sqlite.close();
  const run = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(run.code, 5, run.said);
  assert.match(run.stdout, /2 stores\s+failed\s+not made: live sync \(refused: version 99 is newer than this mistri's 1\)/);
  assert.match(run.stdout, /5 check\s+waiting\s+runs after 2/);
  assert.doesNotMatch(run.said, /no longer fits/);
});

test('a store up did not make is named by the check, not said as a schema misfit (the closing sentence)', (t) => {
  const { dir, app } = bootstrapApp(t);
  /* up without --jobs makes the command stores; the check given --jobs needs the job store as well. */
  assert.equal(mistri(['migrate', 'up', '--app', '.'], app, quiet(dir)).code, 0);
  const check = mistri(['check', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(check.code, 8, check.said);
  assert.match(check.stdout, /stores\s+pending\s+desk: job store, event delivery/);
  /* Before: exit 4, "The migrations are applied, and the App no longer fits the schema they made". */
  assert.doesNotMatch(check.said, /no longer fits/);
});

test('validate --app exits 2 while any phase is pending, and 0 once the database is ready for the App', (t) => {
  const { dir, app } = bootstrapApp(t);
  assert.equal(mistri(['migrate', 'up', '--app', '.'], app, quiet(dir)).code, 0);
  /* The migrations are applied; the job store is not. */
  const pending = mistri(['migrate', 'validate', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(pending.code, 2, pending.said);
  assert.match(pending.stdout, /Valid: 1 migration applied/);
  assert.match(pending.stdout, /2 stores\s+pending\s+job store, event delivery/);
  assert.equal(mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir)).code, 0);
  const ready = mistri(['migrate', 'validate', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(ready.code, 0, ready.said);
  assert.match(ready.stdout, /nothing is pending: the database is ready for this App/);
});

test('--json is for the plan alone', (t) => {
  const { dir, app } = bootstrapApp(t);
  const run = mistri(['migrate', 'status', '--json'], app, quiet(dir));
  assert.equal(run.code, 1);
  assert.match(run.stderr, /--json is for status, up and validate with --app/);
});

test('a type error in the App is said as one, with its first line, not as a schema the App no longer fits', (t) => {
  const { dir, app } = bootstrapApp(t);
  // The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
  mkdirSync(join(app, 'node_modules'));
  symlinkSync(join(process.cwd(), 'node_modules', 'typescript'), join(app, 'node_modules', 'typescript'), 'dir');
  writeFileSync(join(app, 'broken.ts'), "export const wrong: number = 'x';\n");
  const run = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.notEqual(run.code, 0, run.said);
  assert.match(run.said, /the App's typecheck failed \(first error: \S+:\d+:\d+\s+TS\d+/);
  assert.doesNotMatch(run.said, /no longer fits the schema/);
});
