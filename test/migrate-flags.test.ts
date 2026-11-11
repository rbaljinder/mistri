/**
 * `tablewalk migrate`'s own flags, each by what it changes: `--repeatable` makes `new` write an R__ file, `--number`
 * a V file of that version,
 * `--history-table` is where the run keeps its history, and `--connection` chooses the database when a config
 * names several. Run in process over SQLite files of the test's own.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';

const root = mkdtempSync(join(tmpdir(), 'mistri-migrate-flags-'));
after(() => rmSync(root, { recursive: true, force: true }));

async function migrate(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const error = console.error;
  console.error = (line: string) => err.push(String(line));
  try {
    const code = await runMigrate(args, (line) => out.push(line), undefined, MIGRATE_APPS);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.error = error;
  }
}

const tables = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
};

function project(name: string) {
  const dir = join(root, name);
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, 'V1__note.sql'), 'CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);\n');
  const db = join(dir, 'app.db');
  new DatabaseSync(db).close();
  return { dir, migrations, db };
}

test('--repeatable makes new write an R__ file, which without it is the next V', async () => {
  const { migrations } = project('repeatable');
  const plain = await migrate(['new', 'add tag', '--migrations', migrations]);
  assert.equal(plain.code, 0, plain.err);
  const repeatable = await migrate(['new', 'views', '--repeatable', '--migrations', migrations]);
  assert.equal(repeatable.code, 0, repeatable.err);
  assert.deepEqual(readdirSync(migrations).sort(), ['R__views.sql', 'V1__note.sql', 'V2__add_tag.sql']);
});

test('--number writes the V file at the version given, and refuses one a file already has', async () => {
  const { migrations } = project('number');
  const chosen = await migrate(['new', 'add tag', '--number', '0042', '--migrations', migrations]);
  assert.equal(chosen.code, 0, chosen.err);
  assert.ok(readdirSync(migrations).includes('V0042__add_tag.sql'));
  // 42 and 0042 are one version to Flyway's order, so either spelling is taken.
  for (const taken of ['42', '1']) {
    const again = await migrate(['new', 'other', '--number', taken, '--migrations', migrations]);
    assert.notEqual(again.code, 0);
    assert.match(again.err, /is taken: V(0042__add_tag|1__note)\.sql has it/);
  }
  const words = await migrate(['new', 'other', '--number', 'next', '--migrations', migrations]);
  assert.match(words.err, /takes a version of digits/);
  const r = await migrate(['new', 'views', '--repeatable', '--number', '7', '--migrations', migrations]);
  assert.match(r.err, /an R__ file has no version/);
});

test('up refuses a pending file with no statement in it, by name, and applies nothing', async () => {
  const { migrations, db } = project('blank');
  // What new writes, left as it was: one comment line.
  const blank = await migrate(['new', 'add tag', '--migrations', migrations]);
  assert.equal(blank.code, 0, blank.err);
  writeFileSync(join(migrations, 'V3__later.sql'), 'CREATE TABLE later (id INTEGER PRIMARY KEY);\n');
  const ran = await migrate(['up', db, '--migrations', migrations]);
  assert.notEqual(ran.code, 0);
  assert.match(ran.err, /V2__add_tag\.sql holds no statement/);
  assert.ok(!tables(db).includes('note'), 'nothing before it was applied either');
  writeFileSync(join(migrations, 'V2__add_tag.sql'), '-- a tag\nCREATE TABLE tag (id INTEGER PRIMARY KEY);\n');
  const filled = await migrate(['up', db, '--migrations', migrations]);
  assert.equal(filled.code, 0, filled.err);
  assert.ok(tables(db).includes('tag'));
});

test('--history-table is the table the run keeps its history in', async () => {
  const { migrations, db } = project('history');
  const ran = await migrate(['up', db, '--migrations', migrations, '--history-table', 'flyway_schema_history']);
  assert.equal(ran.code, 0, ran.err);
  // Its history there, and never in the default table (the drift snapshot beside it is tablewalk's own).
  assert.ok(tables(db).includes('flyway_schema_history'));
  assert.ok(!tables(db).includes('__mistri_schema_history'));
  // Named again, the history is read from there: nothing pending.
  const status = await migrate(['validate', db, '--migrations', migrations, '--history-table', 'flyway_schema_history']);
  assert.equal(status.code, 0, `${status.out}\n${status.err}`);
});

test('--connection chooses the database when the config names several', async () => {
  const { dir, migrations } = project('connections');
  const first = join(dir, 'first.db');
  const second = join(dir, 'second.db');
  for (const file of [first, second]) new DatabaseSync(file).close();
  const config = join(dir, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'first', url: first, writable: true },
        { name: 'second', url: second, writable: true },
      ],
    }),
  );
  const unsaid = await migrate(['up', '--config', config, '--migrations', migrations]);
  assert.notEqual(unsaid.code, 0);
  assert.match(unsaid.err, /--connection/);
  const chosen = await migrate(['up', '--config', config, '--migrations', migrations, '--connection', 'second']);
  assert.equal(chosen.code, 0, chosen.err);
  assert.ok(tables(second).includes('note'));
  assert.ok(!tables(first).includes('note'));
});
