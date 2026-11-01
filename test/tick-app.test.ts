import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { parseFile, typecheck } from './support/tsc.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appCeilingWarnings } from '../packages/mistri/src/shared/app.js';

const app = resolve('examples/apps/tick/app.ts');
const seedScript = resolve('examples/databases/tick/seed.mjs');
const run = (args: string[]) => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
const seed = (file: string) => run([seedScript, file]);

test('Tick contains only its pure DSL manifest and README, and inline schema authoring typechecks', () => {
  assert.deepEqual(readdirSync(resolve('examples/apps/tick')).sort(), ['README.md', 'app.ts']);
  const source = parseFile(app);
  assert.ok(
    source.statements.every(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        (ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === '@mistriwork/mistri/app'),
    ),
    'Keep database setup outside the DSL manifest',
  );
  const readme = readFileSync(resolve('examples/apps/tick/README.md'), 'utf8');
  assert.ok(readme.includes('node examples/databases/tick/seed.mjs "$tick_dir/tick.db"'));
  assert.ok(readme.includes('index.ts check --config "$tick_dir/tick.db.json" --app examples/apps/tick'));
  assert.ok(readme.includes('[seed.mjs](../../databases/tick/seed.mjs)'));
  assert.equal(typecheck(app, { project: resolve('tsconfig.json'), only: true }), '');
});

test('Tick seed is deterministic, writable and validates against its real manifest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tick-'));
  const file = join(directory, 'nested', 'tick.db');
  let adapter: SqliteAdapter | undefined;
  try {
    seed(file);
    const original = readFileSync(file);
    const originalConfig = readFileSync(`${file}.json`);
    const second = join(directory, 'second.db');
    seed(second);
    assert.deepEqual(readFileSync(second), original);
    assert.deepEqual(JSON.parse(originalConfig.toString()), {
      connections: [{ name: 'tick', url: file, writable: true }],
    });
    adapter = new SqliteAdapter(file);
    const schema = await adapter.introspect();
    const loaded = await loadApp(app);
    assert.deepEqual(appProblems(loaded, schema), []);
    // A new task is open: the form asks its name and day, and `completed` is defaulted rather than asked.
    assert.deepEqual(loaded.app.resources?.task?.form?.show, ['name', 'due_on']);
    assert.deepEqual(loaded.app.resources?.task?.form?.defaults, { completed: false });
    assert.deepEqual(appCeilingWarnings(loaded.app, schema), []);
    assert.equal(loaded.app?.name, 'Tick');
    assert.deepEqual(loaded.app?.ui.editing, { save: 'blur' });
    assert.equal(schema.tables.length, 1);
    const columns = schema.tables[0].columns;
    assert.deepEqual(
      columns.map((column) => column.name),
      ['id', 'name', 'completed', 'due_on', 'position'],
    );
    assert.equal(columns.find((column) => column.name === 'completed')?.type.toLowerCase(), 'boolean');
    assert.equal(columns.find((column) => column.name === 'due_on')?.nullable, true);
    assert.deepEqual(readFileSync(file), original, 'Loading/introspection must not change seeded data');
    assert.deepEqual(readFileSync(`${file}.json`), originalConfig);
    const db = new DatabaseSync(second);
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM task WHERE completed=0').get()?.n, 3);
      db.prepare('INSERT INTO task(name) VALUES (?)').run('A new task');
      assert.deepEqual({ ...db.prepare('SELECT completed, due_on FROM task WHERE id=5').get() }, { completed: 0, due_on: null });
      assert.throws(() => db.exec("INSERT INTO task(name, completed) VALUES ('Invalid', 2)"), /CHECK/);
    } finally {
      db.close();
    }
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Tick refuses existing database/config paths without changing either', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tick-refusal-'));
  try {
    const seeded = join(directory, 'seeded.db');
    seed(seeded);
    const before = readFileSync(seeded);
    const configBefore = readFileSync(`${seeded}.json`);
    assert.throws(() => seed(seeded), /Refusing to replace/);
    assert.deepEqual(readFileSync(seeded), before);
    assert.deepEqual(readFileSync(`${seeded}.json`), configBefore);
    const databaseOnly = join(directory, 'existing.db');
    writeFileSync(databaseOnly, 'keep database');
    assert.throws(() => seed(databaseOnly), /Refusing to replace/);
    assert.equal(readFileSync(databaseOnly, 'utf8'), 'keep database');
    assert.equal(existsSync(`${databaseOnly}.json`), false);
    const configOnly = join(directory, 'reserved.db');
    writeFileSync(`${configOnly}.json`, 'keep config');
    assert.throws(() => seed(configOnly), /Refusing to replace/);
    assert.equal(existsSync(configOnly), false);
    assert.equal(readFileSync(`${configOnly}.json`, 'utf8'), 'keep config');
    const link = join(directory, 'link.db');
    const missing = join(directory, 'missing.db');
    symlinkSync(missing, link);
    assert.throws(() => seed(link), /Refusing to replace/);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(`${link}.json`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Tick imports and loader argv cannot activate seeding; CLI requires an explicit target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tick-import-'));
  const file = join(directory, 'never.db');
  const argv = [...process.argv];
  try {
    run([app]);
    run([app, file]);
    run([app, '--seed', file]);
    assert.throws(() => run([seedScript]), /Usage:/);
    assert.throws(() => run([seedScript, '--seed']), /Usage:/);
    assert.throws(() => run([seedScript, file, 'extra']), /Usage:/);
    run(['--input-type=module', '-e', 'await import(process.argv[2])', 'manifest-host', app, '--seed', file]);
    run(['--input-type=module', '-e', 'await import(process.argv[2])', 'seed-host', seedScript, file]);
    process.argv.splice(0, process.argv.length, process.execPath, app, '--seed', file);
    const loaded = await loadApp(app);
    assert.equal(loaded.app?.name, 'Tick');
    assert.deepEqual(readdirSync(directory), [], 'Even a host argv resembling the seed CLI must not write');
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    rmSync(directory, { recursive: true, force: true });
  }
});
