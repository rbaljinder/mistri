/**
 * `mistri check` and a store the App's database lacks (docs/bootstrap-plan.md, decision D5): exit 8 and a
 * `store-pending` finding whose fix is the migrate command with this run's own flags, and validation goes on beside
 * it, so a real fault shows in the same run. A field report's check stopped at the first absent store and called it
 * "validation failed" (exit 4); with the store made, a `command-and-edit` fault it had hidden came out next. And a
 * check that never loaded the jobs module said nothing of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';

const quiet = (dir: string) => ({ XDG_CONFIG_HOME: join(dir, '.config') });

test('a store the App uses and its database lacks is store-pending: exit 8, the fix carries --jobs', (t) => {
  /* The migrations, with nothing else: what `migrate up` alone did before this plan. */
  const fresh = bootstrapApp(t);
  const config = mistri(['migrate', 'up', '--config', 'mistri.json'], fresh.app, quiet(fresh.dir));
  assert.equal(config.code, 0, config.said);
  const run = mistri(['check', '--app', '.', '--jobs', 'jobs.mjs', '--json'], fresh.app, quiet(fresh.dir));
  /* Before: exit 4, validation failed on "The command journal on connection "desk" is unavailable". */
  assert.equal(run.code, 8, run.said);
  const report = JSON.parse(run.stdout) as {
    ok: boolean;
    exit: number;
    steps: { step: string; status: string }[];
    problems: { code: string; step: string; fix?: string; message: string }[];
  };
  assert.equal(report.ok, false);
  assert.equal(report.exit, 8);
  assert.deepEqual(
    report.steps.filter((step) => step.step === 'validation' || step.step === 'stores').map((step) => `${step.step}:${step.status}`),
    ['validation:passed', 'stores:pending'],
  );
  const pending = report.problems.find((found) => found.code === 'store-pending');
  assert.ok(pending, run.stdout);
  assert.equal(pending.step, 'stores');
  assert.match(pending.message, /desk: command journal, event store, job store, event delivery/);
  assert.equal(pending.fix, 'mistri migrate up --app . --jobs jobs.mjs');
});

test('validation goes on beside a pending store: a real fault exits 4 in the same run', (t) => {
  const { dir, app } = bootstrapApp(t, { fault: true });
  assert.equal(mistri(['migrate', 'up', '--config', 'mistri.json'], app, quiet(dir)).code, 0);
  const run = mistri(['check', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(run.code, 4, run.said);
  /* Before: the run stopped at the absent store, and command-and-edit came out only once it was made. */
  assert.match(run.stdout, /\[command-and-edit\]/);
  assert.match(run.stdout, /stores\s+pending\s+desk: command journal, event store, job store, event delivery/);
  assert.match(run.stdout, /made by: mistri migrate up --app \. --jobs jobs\.mjs/);
  assert.match(run.stdout, /validation failed, and stores pending/);
});

test('a check without --jobs says which declared parts it did not load', (t) => {
  const { dir, app } = bootstrapApp(t);
  assert.equal(mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir)).code, 0);
  const run = mistri(['check', '--app', '.'], app, quiet(dir));
  /* Before: exit 0 and not a word of the jobs it never read. It still passes: info is not a problem. */
  assert.equal(run.code, 0, run.said);
  assert.match(
    run.stdout,
    /not loaded: jobs: command close records events, and nothing that acts on them was checked; jobs\.mjs beside the App was not read\. Give --jobs jobs\.mjs, or name it once in mistri\.json/,
  );
  const brief = mistri(['check', '--app', '.', '--brief'], app, quiet(dir));
  assert.equal(brief.code, 0, brief.said);
  assert.match(brief.stdout, /^not-loaded \(info\) jobs: command close records events/m);
  /* With the jobs given, there is nothing to say. */
  const given = mistri(['check', '--app', '.', '--jobs', 'jobs.mjs'], app, quiet(dir));
  assert.equal(given.code, 0, given.said);
  assert.doesNotMatch(given.stdout, /not loaded/);
});
