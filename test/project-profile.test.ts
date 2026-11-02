/**
 * The project profile (docs/bootstrap-plan.md, Part B): the `app` block of `mistri.json` names the App and the
 * modules that carry its authority once, every App command finds the file by one rule, and each run says where each
 * entry came from. A field report found `dev scratch` and `check --app scratch` reading different files, a check that
 * passed without the jobs nobody named, and `--policy` repeated on every command of a tenant App.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyProfile,
  contextLines,
  findConfig,
  ProfileRefusal,
  projectContext,
  readProfile,
} from '../packages/engine/src/server/config/profile.js';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';

const quiet = (dir: string) => ({ XDG_CONFIG_HOME: join(dir, '.config') });
const IGNITION = resolve('test/fixtures/apps/ignition');

function scratch(t: { after(fn: () => void): void }): string {
  /* Real, as the working directory a run reads is (macOS's tmpdir is a link). */
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mistri-profile-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a profile beside the App is found from the folder above, and its jobs are loaded: from mistri.json', (t) => {
  const { dir, app: made } = bootstrapApp(t, { profile: { dir: '.', jobs: 'jobs.mjs' } });
  const app = realpathSync(made);
  /* Before: from the folder above, neither command found app/mistri.json, and `migrate up` had no database. */
  const up = mistri(['migrate', 'up', '--app', 'app'], dir, quiet(dir));
  assert.equal(up.code, 0, up.said);
  assert.match(up.stdout, /Changed: 1 migration, 5 stores\./);
  assert.match(up.stdout, /Context: app\/mistri\.json \(beside the App\)/);
  assert.match(up.stdout, /jobs\s+app\/jobs\.mjs\s+mistri\.json/);

  const run = mistri(['check', '--app', 'app', '--json'], dir, quiet(dir));
  assert.equal(run.code, 0, run.said);
  const report = JSON.parse(run.stdout) as {
    problems: { code: string }[];
    context: {
      config: { path: string; from: string };
      app: { from: string };
      entries: Record<string, { path: string; from: string } | null>;
    };
  };
  assert.deepEqual(report.context.config, { path: join(app, 'mistri.json'), from: 'app' });
  assert.equal(report.context.app.from, 'flag');
  assert.deepEqual(report.context.entries.jobs, { path: join(app, 'jobs.mjs'), from: 'profile' });
  assert.deepEqual(report.context.entries.commands, { path: join(app, 'commands.ts'), from: 'convention' });
  assert.equal(report.context.entries.policy, null);
  /* The jobs were read, so nothing is said of a module left out. */
  assert.ok(!report.problems.some((found) => found.code === 'not-loaded'), run.stdout);

  /* Without --app the profile names the App; a flag beats the profile, and the run says over what. */
  writeFileSync(join(app, 'other.mjs'), "export { default } from './jobs.mjs';\n");
  const over = mistri(['check', '--jobs', 'other.mjs'], app, quiet(dir));
  assert.equal(over.code, 0, over.said);
  assert.match(over.stdout, /Context: mistri\.json \(the working directory\)/);
  assert.match(over.stdout, /app\s+\.\s+mistri\.json/);
  assert.match(over.stdout, /jobs\s+other\.mjs\s+flag, over mistri\.json's jobs\.mjs/);
  assert.match(over.stdout, /commands\s+commands\.ts\s+convention/);
});

test('an app block is paths only: an unknown key and a ${NAME} are refused by name, before anything loads', (t) => {
  const { dir, app } = bootstrapApp(t, { profile: { dir: '.', jobz: 'jobs.mjs' } });
  const typo = mistri(['check', '--app', '.'], app, quiet(dir));
  assert.equal(typo.code, 2, typo.said);
  assert.match(typo.stderr, /mistri\.json: app\.jobz is not a key of the app block\. It takes dir, commands, jobs, policy and entry/);

  const folder = scratch(t);
  writeFileSync(join(folder, 'mistri.json'), JSON.stringify({ app: { dir: '.', policy: '${POLICY_FILE}' } }));
  assert.throws(() => readProfile(join(folder, 'mistri.json')), /app\.policy names "\$\{POLICY_FILE\}"\. The app block takes paths only/);
  writeFileSync(join(folder, 'mistri.json'), JSON.stringify({ app: { dir: '.', jobs: 'jobs.ts' } }));
  assert.throws(() => readProfile(join(folder, 'mistri.json')), /app\.jobs names jobs\.ts, which is not there/);
  writeFileSync(join(folder, 'mistri.json'), JSON.stringify({ app: { dir: '.' }, apps: [] }));
  assert.throws(() => readProfile(join(folder, 'mistri.json')), ProfileRefusal);
});

test('one discovery rule: dev <dir> and check --app <dir> find the same file, and paths are from its folder', (t) => {
  const folder = scratch(t);
  const app = join(folder, 'scratch');
  mkdirSync(join(app, 'server'), { recursive: true });
  writeFileSync(join(app, 'server', 'jobs.ts'), '');
  writeFileSync(join(app, 'mistri.json'), JSON.stringify({ app: { jobs: 'server/jobs.ts' }, connections: [] }));
  /* The folder above has a file of its own, which a plain read would have found first. */
  writeFileSync(join(folder, 'mistri.json'), JSON.stringify({ connections: [] }));
  const here = process.cwd();
  process.chdir(folder);
  t.after(() => process.chdir(here));
  const env = { XDG_CONFIG_HOME: join(folder, '.config') };
  const dev = applyProfile(['scratch', '--port', '0'], { entries: ['commands', 'jobs', 'policy'], positional: true }, env);
  const devConfig = projectContext()?.config;
  const check = applyProfile(['--app', 'scratch'], { entries: ['commands', 'jobs', 'policy', 'entry'] }, env);
  assert.deepEqual(projectContext()?.config, devConfig);
  assert.equal(devConfig?.path, join(app, 'mistri.json'));
  assert.deepEqual(findConfig({ app: 'scratch' }, env), devConfig);
  for (const argv of [dev, check]) {
    assert.deepEqual(argv.slice(argv.indexOf('--jobs'), argv.indexOf('--jobs') + 2), ['--jobs', join('scratch', 'server', 'jobs.ts')]);
    assert.deepEqual(argv.slice(-2), ['--config', join('scratch', 'mistri.json')]);
  }
  /* Without --app, the working directory's file names the App, or nothing does: no walking up. */
  process.chdir(app);
  const bare = applyProfile([], { entries: ['jobs'] }, env);
  assert.deepEqual(bare, ['--jobs', join('server', 'jobs.ts')]);
  assert.equal(projectContext()?.app, undefined);
  assert.deepEqual(contextLines(projectContext()), [
    'Context: mistri.json (the working directory)',
    '  commands  —             not named',
    '  jobs      server/jobs.ts mistri.json',
    '  policy    —             not named',
  ]);
});

test("a tenant App's policy named in the profile is its enrollment, and a profile without one is refused as before", (t) => {
  const folder = scratch(t);
  const without = join(folder, 'without');
  const named = join(folder, 'named');
  mkdirSync(without);
  mkdirSync(named);
  writeFileSync(join(without, 'mistri.json'), JSON.stringify({ app: { dir: IGNITION }, connections: [] }));
  writeFileSync(
    join(named, 'mistri.json'),
    JSON.stringify({ app: { dir: IGNITION, policy: join(IGNITION, 'tenant-policy.ts') }, connections: [] }),
  );
  const refused = mistri(['--port', '0'], without, quiet(folder));
  assert.equal(refused.code, 1, refused.said);
  assert.match(refused.stderr, /Tenant applications are not enabled without explicit --policy enrollment/);
  /* Past enrollment, the start stops at the connection this config does not have, and says where the policy came from. */
  const enrolled = mistri(['--port', '0'], named, quiet(folder));
  assert.equal(enrolled.code, 1, enrolled.said);
  assert.doesNotMatch(enrolled.said, /explicit --policy enrollment/);
  assert.match(enrolled.stdout, /policy\s+\S*tenant-policy\.ts mistri\.json/);
  assert.match(enrolled.stderr, /Tenant startup requires one matching, row-readable connection/);
});
