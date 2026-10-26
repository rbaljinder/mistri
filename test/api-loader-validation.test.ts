import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { VALIDATE, validating } from './support/validation.js';

const definition = () => ({
  id: 'api-fixture',
  name: 'API fixture',
  connection: 'data',
  resources: { item: { physical: 'db_item' } },
  auth: { roles: { reader: { read: true } } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
  api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } },
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-api-loader-'));
  const app = join(directory, 'app');
  mkdirSync(app);
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE db_item (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
  db.close();
  writeFileSync(join(app, 'app.json'), JSON.stringify(definition()));
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: path }] }));
  return { directory, app, path, config };
}
function cli(args: string[]) {
  return new Promise<{ code: number; output: string }>((done, reject) => {
    const run = validating(args);
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...run.args],
      { timeout: 20_000, env: run.env },
      (error, stdout, stderr) => {
        if (error?.killed) return reject(new Error('CLI unexpectedly remained running.'));
        done({ code: Number(error?.code ?? 0), output: stdout + stderr });
      },
    );
  });
}

test('runtime API validation uses logical resource aliases and refuses invalid exposed fields', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const registry = new Registry();
  t.after(() => registry.closeAll());
  registry.add({ id: 'data', name: 'Data', url: f.path, source: 'config' });
  const loaded = await loadApp(f.app);
  assert.ok((await loadAppRuntimeResources(registry, loaded.app, 'data')).schema.tables.some((table) => table.id === 'item'));
  const invalid = structuredClone(loaded.app);
  invalid.api!.resources.item.fields.push('missing');
  await assert.rejects(loadAppRuntimeResources(registry, invalid, 'data'), /missing/);
});

test('unsupported API contexts refuse before registry schema acquisition', async () => {
  const app = parseAppConfig(definition(), 'fixture');
  let opens = 0;
  const registry = {
    open() {
      opens++;
      throw new Error('Must not acquire data');
    },
  } as unknown as Registry;
  // A path from one connection's resource into another's: one request would read two databases.
  const crossing = {
    ...app,
    sources: { a: { connection: 'a', default: true }, b: { connection: 'b', default: false } },
    resources: {
      item: { ...app.resources!.item, source: 'a', references: { owner_id: { to: 'b.owner' } } },
      'b.owner': { source: 'b' },
    },
    api: { ...app.api!, resources: { item: { fields: ['id', 'owner_id.name'], filters: [], sorts: [] } } },
  };
  await assert.rejects(loadAppRuntimeResources(registry, crossing, 'data'), /"owner_id\.name" reaches "b\.owner".*\[api-multi-source\]/);
  assert.equal(opens, 0);
});

test('API check refuses an unaccepted authority lock before an invalid database path', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const before = definition();
  before.api.resources.item.fields = ['id'];
  writeFileSync(join(f.app, 'authority.lock'), authorityReport(parseAppConfig(before, 'fixture')));
  writeFileSync(f.config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: join(f.directory, 'absent', 'never.db') }] }));
  await assert.rejects(loadApp(f.app), /authority.*differs/i);
  const result = await cli(['--config', f.config, '--app', f.app, VALIDATE]);
  assert.equal(result.code, 1);
  assert.match(result.output, /authority.*differs/i);
  assert.doesNotMatch(result.output, /Could not open|SQLITE_CANTOPEN|unable to open database|ENOENT/);
});

test('API catalog validation participates in check and fatal startup', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  assert.equal((await cli(['--config', f.config, '--app', f.app, VALIDATE])).code, 0);
  const invalid = definition();
  invalid.api.resources.item.fields.push('missing');
  writeFileSync(join(f.app, 'app.json'), JSON.stringify(invalid));
  for (const flags of [[VALIDATE], ['--port', '0']]) {
    const result = await cli(['--config', f.config, '--app', f.app, ...flags]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /missing/);
  }
});

test('build retains server API declarations and validates source/built logical catalogs', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const out = join(f.directory, 'built');
  const result = await buildApp({ app: f.app, out, config: f.config }, { typecheck: false });
  assert.equal(result.manifest.checks.database.status, 'passed');
  const source = await loadApp(f.app),
    built = await loadApp(out);
  assert.deepEqual(built.app.api, source.app.api);
  const registry = new Registry();
  t.after(() => registry.closeAll());
  registry.add({ id: 'data', name: 'Data', url: f.path, source: 'config' });
  await loadAppRuntimeResources(registry, built.app, 'data');
  const invalid = definition();
  invalid.api.resources.item.fields.push('missing');
  writeFileSync(join(f.app, 'app.json'), JSON.stringify(invalid));
  await assert.rejects(
    buildApp({ app: f.app, out: join(f.directory, 'invalid-build'), config: f.config }, { typecheck: false }),
    /missing/,
  );
});
