/**
 * What an App's definition may read of the environment, and where its
 * manifest may live.
 *
 * The worker that evaluates app.ts once had an empty environment and said
 * nothing about it: `process.env.REGION ?? 'us'` served 'us' on every
 * machine. mistri.json's `apps[].env` passes named variables, authority.lock
 * records each name, and a read of any other name from the App's own modules
 * throws with the fix. `--app-entry` names a manifest kept outside the
 * directory's one app.ts, and the directory stays the root that components,
 * pages/ and the lock are read from.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppEnv, readStartupConfig } from '../packages/engine/src/server/cli/config.js';
import { startupTargets } from '../packages/mistri/src/server/cli/apps.js';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

const work = mkdtempSync(join(tmpdir(), 'tablewalk-app-env-'));
after(() => rmSync(work, { recursive: true, force: true }));

function dir(name: string, files: Record<string, string>): string {
  const at = join(work, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(at, file, '..'), { recursive: true });
    writeFileSync(join(at, file), text);
  }
  return at;
}

/* A definition that says what it read: the App's name carries it. */
const reads = (expression: string) =>
  `export default { name: String(${expression}), resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n`;

describe('the environment of a definition', () => {
  process.env.TABLEWALK_TEST_REGION = 'east';
  process.env.TABLEWALK_TEST_OTHER = 'not for the App';

  test('a name mistri.json does not pass throws, naming it and the fix', async () => {
    const app = dir('unlisted', { 'app.mjs': reads("process.env.TABLEWALK_TEST_OTHER ?? 'nowhere'") });
    await assert.rejects(
      loadApp(app, { lock: 'report' }),
      /read process\.env\.TABLEWALK_TEST_OTHER, which mistri\.json does not pass to it[\s\S]*"env": \["TABLEWALK_TEST_OTHER"\][\s\S]*mistri docs secrets/,
    );
  });

  test('a listed name reads its value, and only it reaches the worker', async () => {
    const app = dir('listed', {
      'app.mjs': reads(
        "`${process.env.TABLEWALK_TEST_REGION}:${'TABLEWALK_TEST_OTHER' in process.env}:${Object.keys(process.env).join(',')}`",
      ),
    });
    const loaded = await loadApp(app, { lock: 'report', env: [{ name: 'TABLEWALK_TEST_REGION' }] });
    assert.equal(loaded.app.name, 'east:false:TABLEWALK_TEST_REGION');
    assert.deepEqual(loaded.env, [{ name: 'TABLEWALK_TEST_REGION' }]);
  });

  test("Node's own names read as undefined rather than throwing", async () => {
    const app = dir('node-names', { 'app.mjs': reads("process.env.NODE_ENV ?? 'unset'") });
    assert.equal((await loadApp(app, { lock: 'report' })).app.name, 'unset');
  });

  test('each passed name is a line of authority.lock, never its value', async () => {
    const app = dir('locked', { 'app.mjs': reads("'Ops'") });
    const loaded = await loadApp(app, { lock: 'report', env: [{ name: 'TABLEWALK_TEST_REGION' }, { name: 'MAP_KEY', secret: true }] });
    assert.match(loaded.authority!.report, /^env MAP_KEY secret — mistri\.json$/m);
    assert.match(loaded.authority!.report, /^env TABLEWALK_TEST_REGION — mistri\.json$/m);
    assert.doesNotMatch(loaded.authority!.report, /east/);
  });

  test('a name that reads like a credential needs secret: true, and a name is a name', () => {
    assert.throws(() => parseAppEnv(['DB_PASSWORD'], 'here'), /reads like a credential[\s\S]*"secret": true/);
    assert.throws(() => parseAppEnv(['PGHOST'], 'here'), /reads like a credential/);
    assert.deepEqual(parseAppEnv(['REGION', { name: 'MAP_KEY', secret: true }], 'here'), [
      { name: 'REGION' },
      { name: 'MAP_KEY', secret: true },
    ]);
    assert.throws(() => parseAppEnv(['REGION', 'REGION'], 'here'), /twice/);
    assert.throws(() => parseAppEnv(['not a name'], 'here'), /takes names/);
    assert.throws(() => parseAppEnv([{ name: 'X', secret: 'yes' }], 'here'), /takes names/);
    assert.throws(() => parseAppEnv('REGION', 'here'), /must be a list/);
  });

  test('mistri.json lists an App with its env, resolved beside the file', async () => {
    const at = dir('config', { 'mistri.json': JSON.stringify({ connections: [], apps: ['plain', { dir: 'ops', env: ['REGION'] }] }) });
    const config = await readStartupConfig(parseArgs(['--config', join(at, 'mistri.json')]), new Registry(), CONFIG_SECTIONS);
    assert.deepEqual(config.apps, [join(at, 'plain'), join(at, 'ops')]);
    assert.deepEqual(config.appEnv, { [join(at, 'ops')]: [{ name: 'REGION' }] });
  });
});

describe('the targets a start loads', () => {
  const config = { apps: ['/apps/ops'], appEnv: { '/apps/ops': [{ name: 'REGION' }] } };

  test('an --app the config already lists is that App, with its env', () => {
    assert.deepEqual(startupTargets({ apps: ['/apps/ops'] }, config), [{ target: '/apps/ops', env: [{ name: 'REGION' }] }]);
    assert.deepEqual(
      startupTargets({ apps: ['/apps/desk'] }, config).map((target) => target.target),
      ['/apps/ops', '/apps/desk'],
    );
  });

  test("a build checked in its source's place takes the listed entry, and the source is not loaded beside it", () => {
    assert.deepEqual(startupTargets({ apps: ['/builds/ops'] }, config, '/apps/ops'), [{ target: '/builds/ops' }]);
  });

  test('--app-entry names the manifest of exactly one --app', () => {
    assert.deepEqual(startupTargets({ apps: ['/apps/ops'], appEntry: 'gen/app.ts' }, config), [
      { target: '/apps/ops', env: [{ name: 'REGION' }], entry: 'gen/app.ts' },
    ]);
    assert.throws(() => startupTargets({ appEntry: 'gen/app.ts' }, { apps: [], appEnv: {} }), /exactly one --app/);
    assert.throws(() => startupTargets({ apps: ['/apps/desk'], appEntry: 'gen/app.ts' }, config), /exactly one --app/);
  });
});

describe('--app-entry', () => {
  const DONE = "export default function Done({ value }) { return <b className=\"c-done\">{value ? 'done' : 'open'}</b>; }\n";
  const manifest = `export default {
  name: 'Entry',
  resources: { task: { display: { completed: { id: 'done', module: './widgets/Done.jsx', kind: 'value' } } } },
  views: { tasks: { kind: 'list', from: 'task' } },
  home: 'tasks',
};\n`;

  test('the directory stays the root: components compile from it, pages/ and the lock are read there', async () => {
    const app = dir('entry', {
      'package.json': '{ "type": "module" }\n',
      'generated/definition.mjs': manifest,
      'widgets/Done.jsx': DONE,
      'pages/task.json': JSON.stringify({ base: 'task', sections: [] }),
    });
    const loaded = await loadApp(app, { lock: 'report', entry: join(app, 'generated', 'definition.mjs') });
    assert.equal(loaded.dir, app);
    assert.equal(loaded.entry, join(app, 'generated', 'definition.mjs'));
    assert.ok(loaded.components?.entries.done, 'the component resolved against the App directory');
    assert.ok(
      loaded.pages.some((page) => page.id === 'task'),
      'pages/ was read from the App directory',
    );
    assert.equal(loaded.authority!.lockPath, join(app, 'authority.lock'));
  });

  test('a file target with components says to use the directory and --app-entry', async () => {
    const app = dir('file-target', { 'package.json': '{ "type": "module" }\n', 'app.mjs': manifest, 'widgets/Done.jsx': DONE });
    await assert.rejects(loadApp(join(app, 'app.mjs'), { lock: 'report' }), /load the App from its directory[\s\S]*--app-entry/);
  });

  test('an entry that is not a manifest file is refused by name', async () => {
    const app = dir('no-entry', { 'app.mjs': manifest });
    await assert.rejects(
      loadApp(app, { lock: 'report', entry: join(app, 'missing.ts') }),
      /--app-entry .*missing\.ts is not a \.ts, \.mjs or \.json file/,
    );
  });
});
