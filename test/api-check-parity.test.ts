/**
 * `mistri check` refuses what `--export openapi` refuses, by the same rules: the check renders the same document
 * (oneShot.ts renderApiExport) and says its refusal with a code, so a refusal is found while the App is written and not
 * by the first export. A field report: a sort by a timestamp column, a view that names totals, a command with no
 * record and a command no role holds each passed a check and failed an export.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { namedCommands } from './support/commandCatalog.js';
import { validating } from './support/validation.js';

function run(directory: string, args: string[]) {
  const spawned = validating(args, { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' });
  return new Promise<{ code: number; out: string; err: string }>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...spawned.args],
      { timeout: 30_000, env: spawned.env },
      (error, out, err) => done({ code: Number(error?.code ?? 0), out, err }),
    ),
  );
}

/** An App on a SQLite file, its manifest and, when `commands` is given, its commands module. */
function fixture(app: Record<string, unknown>, sql: string, commands?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-api-check-'));
  mkdirSync(join(directory, 'app'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  migrateSqliteCommandJournal(file);
  writeFileSync(join(directory, 'app', 'app.json'), JSON.stringify(namedCommands(app).app));
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: file, writable: true }] }));
  const source = (path: string) => pathToFileURL(resolve(path)).href;
  const module = join(directory, 'commands.mts');
  if (commands !== undefined)
    writeFileSync(
      module,
      `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ change: defineCommand({ source: 'business', target: 'item'${commands}, input: {}, output: shape({ ok: bool() }), async handle() { return { ok: true }; } }) });
`,
    );
  const base = ['--config', config, '--app', join(directory, 'app'), ...(commands !== undefined ? ['--commands', module] : [])];
  return { directory, check: ['check', ...base], exported: [...base, '--export', 'openapi', '--api-integers', 'decimal-string'] };
}

/** The check's verdict names the code and the export's refusal is the same sentence. */
async function parity(f: ReturnType<typeof fixture>, code: string) {
  const checked = await run(f.directory, f.check);
  assert.equal(checked.code, 4, checked.out + checked.err);
  assert.match(checked.out + checked.err, new RegExp(`\\[${code}\\]`));
  const exported = await run(f.directory, f.exported);
  assert.notEqual(exported.code, 0);
  assert.match(exported.err, new RegExp(`\\[${code}\\]`));
}

const people = (view: Record<string, unknown>, resource: Record<string, unknown>) => ({
  id: 'directory',
  name: 'Directory',
  connection: 'data',
  resources: { person: { physical: 'people' } },
  auth: { roles: { reader: { read: true } } },
  views: { people: { kind: 'list', from: 'person', ...view } },
  home: 'people',
  api: { version: 1, roles: ['reader'], resources: { person: resource }, views: [{ view: 'people' }] },
});
const PEOPLE =
  "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMP NOT NULL); INSERT INTO people VALUES(1,'A','2020-01-01 00:00:00');";

const ledger = (held: string[]) => ({
  id: 'ledger',
  name: 'Ledger',
  sources: { business: { connection: 'data', default: true } },
  resources: { item: { access: 'write' } },
  auth: { roles: { operator: { read: true, commands: held } } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
  api: {
    version: 1,
    roles: ['operator'],
    resources: { item: { fields: ['id', 'revision'], sorts: ['id'] } },
    commands: [{ id: 'change', version: 1, target: 'item', input: {} }],
  },
});
const ITEM = 'CREATE TABLE item(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO item VALUES(1,0);';

test('a sort by a timestamp column is a check problem [api-sort-type], as the export refuses it', async (t) => {
  const f = fixture(people({}, { fields: ['id', 'name', 'created_at'], sorts: ['created_at'] }), PEOPLE);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await parity(f, 'api-sort-type');
});

test('a view that names totals is a check problem [api-view-totals], as the export refuses it', async (t) => {
  const f = fixture(people({ totals: ['id'] }, { fields: ['id', 'name'], sorts: ['id'] }), PEOPLE);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await parity(f, 'api-view-totals');
});

test('an exposed command that names no record is a check problem [api-command-no-record], as the export refuses it', async (t) => {
  const f = fixture(ledger(['change']), ITEM, ", targets: 'none'");
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await parity(f, 'api-command-no-record');
});

test('an exposed command no role holds is a check problem [api-command-unheld], as the export refuses it', async (t) => {
  const f = fixture(ledger([]), ITEM, '');
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await parity(f, 'api-command-unheld');
});

test('a command only a link runs is held by no role, and is no fault of the check or the export while the API leaves it out', async (t) => {
  const app = ledger([]);
  const linked = {
    ...app,
    resources: { item: { access: 'write', links: { offer: { show: ['id'], commands: ['change'] } } } },
    api: { ...app.api, commands: [] },
  };
  const f = fixture(linked, ITEM, '');
  // A link is sealed with the App's form key; the check loads the App as a server does.
  process.env.MISTRI_FORM_KEY = 'k'.repeat(40);
  t.after(() => {
    delete process.env.MISTRI_FORM_KEY;
    rmSync(f.directory, { recursive: true, force: true });
  });
  const checked = await run(f.directory, f.check);
  assert.equal(checked.code, 0, checked.out + checked.err);
  assert.doesNotMatch(checked.out + checked.err, /api-command-unheld|never offered|no role is granted/);
  const exported = await run(f.directory, f.exported);
  assert.equal(exported.code, 0, exported.err);
});

test('an App whose API the export renders passes the check', async (t) => {
  const f = fixture(people({}, { fields: ['id', 'name'], sorts: ['id'] }), PEOPLE);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  assert.equal((await run(f.directory, f.exported)).code, 0);
  const checked = await run(f.directory, f.check);
  assert.equal(checked.code, 0, checked.out + checked.err);
});

/* A field report: four refusals of one App's API surfaced one at a time, each from its own run. Every exposure is
   judged on its own now, and one run says each refused one: here a resource and the view over it. */
test('one check says every refused exposure, and the export the same', async (t) => {
  const app = ledger(['change']);
  const many = {
    ...app,
    api: {
      ...app.api,
      resources: { item: { fields: ['id', 'revision', 'created_at'], sorts: ['created_at'] } },
      views: [{ view: 'items' }],
    },
  };
  const f = fixture(
    many,
    "CREATE TABLE item(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, created_at TIMESTAMP NOT NULL); INSERT INTO item VALUES(1,0,datetime(0, 'unixepoch'));",
    '',
  );
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const checked = await run(f.directory, f.check);
  assert.equal(checked.code, 4, checked.out + checked.err);
  for (const at of ['api.resources.item', 'api.views.items'])
    assert.match(checked.out + checked.err, new RegExp(`${at.replace(/\./g, '\\.')}: sort "created_at" .*\\[api-sort-type\\]`));
  const exported = await run(f.directory, f.exported);
  assert.notEqual(exported.code, 0);
  for (const at of ['api.resources.item', 'api.views.items'])
    assert.match(exported.err, new RegExp(`${at.replace(/\./g, '\\.')}: sort "created_at" .*\\[api-sort-type\\]`));
});
