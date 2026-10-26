/** Local OpenAPI export never starts a command host or acquires unrelated data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { constants, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';
import { appOpenApi } from '../packages/mistri/src/server/cli/oneShot.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { Registry } from '../packages/engine/src/server/connections.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { Registry as ConnectionRegistry } from '../packages/engine/src/server/connections.js';
import { namedCommands, parseTestApi, parseTestApp } from './support/commandCatalog.js';
import { VALIDATE, validating } from './support/validation.js';

const definition = () => ({
  id: 'directory',
  name: 'Directory',
  connection: 'data',
  resources: { person: { physical: 'people' } },
  auth: { roles: { reader: { read: true } } },
  views: { people: { kind: 'list', from: 'person' } },
  home: 'people',
  api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'name'], sorts: ['id'] } } },
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-api-export-'));
  const app = join(directory, 'app');
  mkdirSync(app);
  const file = join(directory, 'data.db'),
    config = join(directory, 'connections.json');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, secret TEXT); INSERT INTO people VALUES(1,'A','private');");
  db.close();
  writeFileSync(join(app, 'app.json'), JSON.stringify(definition()));
  // The active connection must not be opened merely because it comes first.
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { id: 'unrelated', name: 'Unrelated', url: join(directory, 'missing', 'must-not-open.db') },
        { id: 'data', name: 'Data', url: file },
      ],
    }),
  );
  const commands = join(directory, 'metadata-only.mjs');
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${pathToFileURL(resolve('packages/mistri/src/server/commands/businessCommands.ts')).href}';
export default defineCommands({ unused: defineCommand({ source: 'main', target: 'person', targets: 'none', input: {}, handle() { throw new Error('Export executed a handler'); } }) });`,
  );
  return { directory, app, file, config, commands };
}
/** An App with one targeted command on a writable, journal-migrated source.
 * `declared` writes the exposure into app.json; otherwise a caller attaches
 * the returned `api` in code. */
function commandFixture(declared: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-api-export-commands-'));
  const app = join(directory, 'app');
  mkdirSync(app);
  // .mts: a temporary directory has no package.json, so a .ts file would load
  // as CommonJS and wrap the default export the loader expects.
  const file = join(directory, 'data.db'),
    config = join(directory, 'connections.json'),
    commands = join(directory, 'commands.mts');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, private_note TEXT); INSERT INTO item VALUES(1,0,NULL);');
  db.close();
  migrateSqliteCommandJournal(file);
  const api = {
    version: 1,
    roles: ['operator'],
    resources: { item: { fields: ['id', 'revision'], sorts: ['id'] } },
    commands: [{ id: 'change', version: 1, target: 'item', input: {} }],
  };
  const { commands: _exposure, ...readApi } = api;
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify(
      namedCommands({
        id: 'ledger',
        name: 'Ledger',
        sources: { business: { connection: 'data', default: true } },
        resources: { item: { access: 'write' } },
        auth: { roles: { operator: { read: true, commands: ['change'] } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        api: declared ? api : readApi,
      }).app,
    ),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: file, writable: true }] }));
  const source = (path: string) => pathToFileURL(resolve(path)).href;
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ change: defineCommand({ source: 'business', target: 'item', 
  input: {}, output: shape({ ok: bool() }), async handle() { return { ok: true }; } }) });
`,
  );
  return { directory, app, file, config, commands, api };
}
function cli(directory: string, args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((done, reject) => {
    const entry =
      process.env.TABLEWALK_TEST_BUILT_CLI === '1'
        ? ['--conditions=mistri-built', resolve('packages/mistri/dist/server/index.js')]
        : ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts')];
    const run = validating(args, { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' });
    execFile(
      process.execPath,
      [...entry, ...run.args],
      {
        timeout: 20_000,
        env: run.env,
      },
      (error, out, err) => {
        if (error?.killed) return reject(new Error('Export unexpectedly remained running.'));
        done({ code: Number(error?.code ?? 0), out, err });
      },
    );
  });
}

test('integer export option is explicit, single-use and rejected outside OpenAPI before startup', async (t) => {
  assert.equal(parseArgs(['--api-integers', 'number']).apiIntegers, 'number');
  assert.match(parseArgs(['--api-integers', 'number', '--api-integers', 'decimal-string']).unknown!, /only once/);
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  for (const args of [
    ['--export', 'openapi'],
    ['--export', 'openapi', '--api-integers', 'rounded'],
    ['--api-integers', 'number'],
  ]) {
    const result = await cli(f.directory, ['--config', join(f.directory, 'missing-config.json'), ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, /--api-integers/);
    assert.doesNotMatch(result.err, /ENOENT|Could not open|Listening/);
  }
  for (const mode of [['--from-openapi', 'https://example.invalid/must-not-fetch'], [VALIDATE], ['--demo'], ['--reindex']]) {
    const result = await cli(f.directory, [
      '--config',
      join(f.directory, 'missing-config.json'),
      '--export',
      'openapi',
      '--api-integers',
      'number',
      ...mode,
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, /cannot be combined/);
    assert.doesNotMatch(result.err, /ENOENT|Could not open|Listening|fetch failed/);
  }
});

test('local export emits only checked JSON, preserves database and round-trips its read surface', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  for (const integers of ['decimal-string', 'number']) {
    const result = await cli(f.directory, ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', integers]);
    assert.equal(result.code, 0, result.err);
    const document = JSON.parse(result.out);
    assert.equal(document.openapi, '3.1.0');
    assert.equal(document['x-mistri-integer-representation'], integers);
    assert.equal(document['x-mistri-document'], 'app-api-reads');
    assert.deepEqual(Object.keys(document.paths), ['/person', '/person/{id}']);
    assert.equal(JSON.stringify(document).includes('secret'), false);
    assert.equal(readOpenApi(document).resources.length, 1);
    assert.doesNotMatch(result.err, /Listening|Could not open/);
  }
  const db = new DatabaseSync(f.file);
  try {
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name),
      ['people'],
    );
    assert.equal(db.prepare('SELECT secret FROM people WHERE id=1').get()!.secret, 'private');
  } finally {
    db.close();
  }
});

test('export rejects stale authority before unavailable data and never executes command handlers', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const old = definition();
  old.api.resources.person.fields = ['id'];
  writeFileSync(join(f.app, 'authority.lock'), authorityReport(parseTestApp(old, 'fixture')));
  const args = ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string'];
  const stale = await cli(f.directory, args);
  assert.equal(stale.code, 1);
  assert.equal(stale.out, '');
  assert.match(stale.err, /authority.*differs/i);
  assert.doesNotMatch(stale.err, /Could not open|SQLITE_CANTOPEN/);
  // The registry is loaded to resolve contracts; no command handler runs during export.
  const commands = await cli(f.directory, [...args, '--commands', f.commands]);
  assert.equal(commands.code, 1);
  assert.match(commands.err, /authority.*differs/i);
  assert.doesNotMatch(commands.err, /ERR_MODULE_NOT_FOUND|ENOENT|could not be loaded/);
});

test('a read-only App exports its read surface without executing unrelated registered commands', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const args = ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string'];
  const readOnly = await cli(f.directory, [...args, '--commands', f.commands]);
  assert.equal(readOnly.code, 0, readOnly.err);
  assert.deepEqual(Object.keys(JSON.parse(readOnly.out).paths), ['/person', '/person/{id}']);
  assert.doesNotMatch(readOnly.err, /ERR_MODULE_NOT_FOUND|ENOENT|could not be loaded/);
});

test('an App file declaring API commands exports them with --commands, and refuses without it before importing anything', async (t) => {
  const c = commandFixture(true);
  t.after(() => rmSync(c.directory, { recursive: true, force: true }));
  const args = ['--config', c.config, '--app', c.app, '--export', 'openapi', '--api-integers', 'decimal-string'];
  const missing = await cli(c.directory, args);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, '');
  assert.match(missing.err, /commands module|no commands module is loaded/);
  assert.doesNotMatch(missing.err, /could not be loaded|ERR_MODULE_NOT_FOUND/);
  const result = await cli(c.directory, [...args, '--commands', c.commands]);
  assert.equal(result.code, 0, result.err);
  const document = JSON.parse(result.out);
  assert.equal(document['x-mistri-document'], 'app-api');
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/commands/change/v1/receipts/{idempotencyKey}',
    '/item',
    '/item/{id}',
    '/item/{id}/commands/change/v1',
    '/item/{id}/commands/change/v1/prepare',
  ]);
});

test('once commands are exposed, the export needs --commands and describes them beside the unchanged reads', async (t) => {
  const c = commandFixture(false);
  t.after(() => rmSync(c.directory, { recursive: true, force: true }));
  const loaded = await loadApp(c.app);
  // Attached in code: the function-level path, without the CLI's loader.
  const app = { ...loaded, app: { ...loaded.app, api: parseTestApi(c.api, ['operator'])! } };
  const registry = new ConnectionRegistry();
  registry.add({ id: 'data', name: 'Data', url: c.file, writable: true, source: 'config' });
  t.after(() => registry.closeAll());
  await assert.rejects(appOpenApi(registry, [app], 'decimal-string'), /commands module|no commands module is loaded/);
  const document = JSON.parse(await appOpenApi(registry, [app], 'decimal-string', c.commands));
  assert.equal(document['x-mistri-document'], 'app-api');
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/commands/change/v1/receipts/{idempotencyKey}',
    '/item',
    '/item/{id}',
    '/item/{id}/commands/change/v1',
    '/item/{id}/commands/change/v1/prepare',
  ]);
  assert.doesNotMatch(JSON.stringify(document), /private_note/);
});

test('single named-source export selects its binding instead of the unrelated active connection', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const { connection: _connection, ...app } = definition();
  writeFileSync(join(f.app, 'app.json'), JSON.stringify({ ...app, sources: { main: { connection: 'Data' } } }));
  const result = await cli(f.directory, ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(Object.keys(JSON.parse(result.out).paths), ['/person', '/person/{id}']);
  assert.doesNotMatch(result.err, /Could not open|Listening/);
});

test('renderer refusal after acquisition emits no partial spec and exits', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const app = definition();
  writeFileSync(
    join(f.app, 'app.json'),
    JSON.stringify({
      ...app,
      resources: { commands: { physical: 'people' } },
      views: { people: { kind: 'list', from: 'commands' } },
      api: { ...app.api, resources: { commands: app.api.resources.person } },
    }),
  );
  const result = await cli(f.directory, ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string']);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /reserved route namespace/);
  assert.doesNotMatch(result.err, /Could not open|Listening/);
});

test('composite-key export publishes one object key parameter, serialized simple/explode', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const db = new DatabaseSync(f.file);
  try {
    db.exec('DROP TABLE people; CREATE TABLE people(id INTEGER NOT NULL, name TEXT NOT NULL, secret TEXT, PRIMARY KEY(id,name));');
  } finally {
    db.close();
  }
  const result = await cli(f.directory, ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string']);
  assert.equal(result.code, 0, result.err);
  const document = JSON.parse(result.out);
  const item = Object.entries(document.paths as Record<string, { get?: { parameters?: Array<Record<string, unknown>> } }>).find(([path]) =>
    path.includes('{key}'),
  );
  assert.ok(item, 'the item route is published under one key parameter');
  const key = item[1].get!.parameters!.find((parameter) => parameter.name === 'key')!;
  assert.equal(key.in, 'path');
  assert.equal(key.style, 'simple');
  assert.equal(key.explode, true);
  assert.deepEqual(key['x-mistri-key-columns'], ['id', 'name']);
});

test('metadata-only helper rejects missing/multiple Apps and unsupported contexts without data acquisition', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const loaded = await loadApp(f.app);
  let touched = false;
  const registry = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('No data acquisition allowed');
      },
    },
  ) as Registry;
  await assert.rejects(appOpenApi(registry, [], 'number'), /exactly one/);
  await assert.rejects(appOpenApi(registry, [loaded, loaded], 'number'), /exactly one/);
  const multi = {
    ...loaded,
    app: {
      ...loaded.app,
      sources: { a: { connection: 'a', default: true }, b: { connection: 'b', default: false } },
      resources: {
        person: { ...loaded.app.resources!.person, source: 'a', references: { team_id: { to: 'b.team' } } },
        'b.team': { source: 'b' },
      },
      api: { ...loaded.app.api!, resources: { person: { fields: ['id', 'team_id.name'], filters: [], sorts: [] } } },
    },
  };
  await assert.rejects(appOpenApi(registry, [multi], 'number'), /api-multi-source/);
  assert.equal(touched, false);
});

test('export refuses an ambiguous connection name or ID before acquiring either database', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const loaded = await loadApp(f.app);
  for (const connections of [
    [
      { id: 'wrong', name: 'data' },
      { id: 'data', name: 'Right' },
    ],
    [
      { id: 'first', name: 'data' },
      { id: 'second', name: 'data' },
    ],
    [{ id: 'other', name: 'Other' }],
  ]) {
    let acquired = false;
    const registry = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'list') return () => connections;
          acquired = true;
          throw new Error('No data acquisition allowed');
        },
      },
    ) as Registry;
    await assert.rejects(appOpenApi(registry, [loaded], 'decimal-string'), /unconfigured or ambiguous connection/);
    assert.equal(acquired, false);
  }
});

test('local comparison reports missing version increases without opening a server', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    const refused = await cli(f.directory, ['compare-openapi', 'previous.json', 'current.json']);
    assert.equal(refused.code, 2);
    assert.equal(refused.out, '');
    assert.match(refused.err, /platform|support/i);
    return;
  }
  const args = ['--config', f.config, '--app', f.app, '--export', 'openapi', '--api-integers', 'decimal-string'];
  const previous = join(f.directory, 'previous.json'),
    current = join(f.directory, 'current.json');
  const baseline = await cli(f.directory, args);
  assert.equal(baseline.code, 0, baseline.err);
  writeFileSync(previous, baseline.out);
  let result = await cli(f.directory, ['compare-openapi', previous, previous]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).findings, []);
  const changed = definition();
  changed.api.resources.person.fields = ['id'];
  writeFileSync(join(f.app, 'app.json'), JSON.stringify(changed));
  let exported = await cli(f.directory, args);
  assert.equal(exported.code, 0, exported.err);
  writeFileSync(current, exported.out);
  result = await cli(f.directory, ['compare-openapi', previous, current]);
  assert.equal(result.code, 1, result.err);
  const findings = JSON.parse(result.out).findings;
  assert.ok(findings.some((finding: { change: string }) => finding.change === 'field-removed:name'));
  changed.api.version = 2;
  writeFileSync(join(f.app, 'app.json'), JSON.stringify(changed));
  exported = await cli(f.directory, args);
  assert.equal(exported.code, 0, exported.err);
  writeFileSync(current, exported.out);
  result = await cli(f.directory, ['compare-openapi', previous, current]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).findings, findings);
  for (const invalid of [
    ['compare-openapi', previous],
    ['compare-openapi', previous, current, '--commands', 'must-not-import.ts'],
    ['compare-openapi', previous, join(f.directory, 'missing.json')],
  ]) {
    const refused = await cli(f.directory, invalid);
    assert.equal(refused.code, 2);
    assert.equal(refused.out, '');
    assert.doesNotMatch(refused.err, /Listening|ERR_MODULE_NOT_FOUND/);
  }
});
