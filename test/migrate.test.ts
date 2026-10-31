/**
 * `tablewalk migrate` on SQLite, which needs no server: Flyway's names and
 * checksums, the history in Flyway's layout, one transaction per file, the
 * rules that refuse a run (a changed, missing, failed or out-of-order file),
 * repair, baseline on a database that was there first, drift and the run
 * that must not bless it, two runs at once, the command line's words and
 * exit codes, `--tool flyway` handing over through the environment, and the
 * App checked after `up` and before it (`check --pending`).
 *
 * The checksums below were computed by flyway-core 13.8.0 itself (Flyway's
 * `info` over the same bytes), not by this code: they are what makes a
 * history written here one Flyway validates, and the other way round.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { compareVersions, flywayChecksum, newMigration, readMigrations } from '../packages/engine/src/server/migrate/files.js';
import { flywayLockNumber, splitPostgres } from '../packages/engine/src/server/migrate/database.js';
import { flywaySettings } from '../packages/engine/src/server/migrate/flyway.js';
import { DEFAULT_HISTORY_TABLE } from '../packages/engine/src/server/migrate/history.js';
import {
  migrateBaseline,
  migrateRepair,
  migrateUp,
  migrateValidate,
  migrationStatus,
  type MigrateTarget,
} from '../packages/engine/src/server/migrate/runner.js';
import { carryForward, drift } from '../packages/engine/src/server/migrate/snapshot.js';
import { applyMigrations } from '../packages/mistri/src/server/maintenance.js';
import { entryFor } from './support/bins.js';

const ROOT = resolve('.');

const work = mkdtempSync(join(tmpdir(), 'tablewalk-migrate-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;

/** A fresh directory with these migration files, and a database path in it. */
function project(files: Record<string, string>): { dir: string; db: string; target: MigrateTarget } {
  const root = join(work, `p${++n}`);
  const dir = join(root, 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const db = join(root, 'app.db');
  return { dir, db, target: { url: db, schemas: [], dir, table: DEFAULT_HISTORY_TABLE } };
}
const history = (db: string, table = DEFAULT_HISTORY_TABLE) => {
  const open = new DatabaseSync(db, { readOnly: true });
  try {
    return open.prepare(`SELECT * FROM "${table}" ORDER BY installed_rank`).all() as Array<Record<string, unknown>>;
  } finally {
    open.close();
  }
};
const sql = (db: string, text: string) => {
  const open = new DatabaseSync(db);
  try {
    open.exec(text);
  } finally {
    open.close();
  }
};
const tables = (db: string) => {
  const open = new DatabaseSync(db, { readOnly: true });
  try {
    return (open.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    open.close();
  }
};

interface Ran {
  code: number;
  out: string;
  err: string;
}
function cli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', entryFor(args), ...args],
      {
        cwd: options.cwd ?? ROOT,
        timeout: 120_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg'), ...options.env },
      },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`tablewalk ${args.join(' ')} did not exit`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

describe('the files, as Flyway names and sums them', () => {
  test("the checksum is Flyway's: CRC32 of the lines, line breaks and a byte-order mark left out, signed", () => {
    assert.equal(flywayChecksum('CREATE TABLE a(id INTEGER PRIMARY KEY);\r\nINSERT INTO a VALUES (1);\n'), -1843215018);
    assert.equal(flywayChecksum('﻿CREATE VIEW va AS SELECT * FROM a;\n\n-- é\n'), 778089500);
    assert.equal(
      flywayChecksum(
        "CREATE TABLE payoff_quote (id serial PRIMARY KEY, order_id bigint REFERENCES orders(id), amount numeric(12,2) NOT NULL);\nALTER TYPE stage ADD VALUE 'hold';\n",
      ),
      -1329212336,
    );
    // Line breaks are not summed, whichever they are.
    assert.equal(flywayChecksum('a\r\nb\n'), flywayChecksum('a\nb'));
  });

  test('names, versions, descriptions, order and the files that are not migrations', () => {
    const { dir } = project({
      'V1__create_loan.sql': 'SELECT 1;',
      'V1_1__add_rate.sql': 'SELECT 2;',
      'V10__later.sql': 'SELECT 3;',
      'V2__second.sql': 'SELECT 4;',
      'R__views.sql': 'SELECT 5;',
      'R__a_functions.sql': 'SELECT 6;',
      'sub/V3__nested.sql': 'SELECT 7;',
      'V4_forgot_underscore.sql': 'SELECT 8;',
      'notes.sql': 'SELECT 9;',
      'README.md': 'not sql',
    });
    const read = readMigrations(dir);
    assert.deepEqual(
      read.files.map((file) => [file.version ?? 'R', file.description, file.script]),
      [
        ['1', 'create loan', 'V1__create_loan.sql'],
        ['1.1', 'add rate', 'V1_1__add_rate.sql'],
        ['2', 'second', 'V2__second.sql'],
        ['3', 'nested', 'sub/V3__nested.sql'],
        ['10', 'later', 'V10__later.sql'],
        ['R', 'a functions', 'R__a_functions.sql'],
        ['R', 'views', 'R__views.sql'],
      ],
    );
    assert.deepEqual(read.ignored, ['V4_forgot_underscore.sql']);
    assert.equal(compareVersions('1.10', '1.9'), 1);
    assert.equal(compareVersions('1', '1.0'), 0);
  });

  test('new writes the next version, keeps a timestamp scheme, and a repeatable by name', () => {
    const { dir } = project({ 'V1__a.sql': '', 'V7__b.sql': '' });
    assert.match(newMigration(dir, 'add payoff quote!', false), /V8__add_payoff_quote\.sql$/);
    assert.match(newMigration(dir, 'views', true), /R__views\.sql$/);
    const stamped = project({ 'V20260101120000__first.sql': '' });
    assert.match(newMigration(stamped.dir, 'second', false, new Date('2026-09-26T10:00:00Z')), /V20260926100000__second\.sql$/);
    assert.throws(() => newMigration(dir, '  ', false), /gives the file no name/);
    assert.throws(() => newMigration(dir, 'views', true), /already exists/);
  });

  test('a PostgreSQL script as statements: quotes, dollar quotes and comments keep their semicolons', () => {
    assert.deepEqual(
      splitPostgres(`CREATE INDEX CONCURRENTLY a ON t(x);
-- a comment; with a semicolon
/* and; a /* nested */ block */
CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $body$;
INSERT INTO "odd;name" VALUES ('it''s; fine', E'\\'; still');
`),
      [
        'CREATE INDEX CONCURRENTLY a ON t(x)',
        '-- a comment; with a semicolon\n/* and; a /* nested */ block */\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $body$',
        "INSERT INTO \"odd;name\" VALUES ('it''s; fine', E'\\'; still')",
      ],
    );
  });

  test('the lock is the number Flyway takes for the same table, and Flyway is told everything through its environment', () => {
    // 77431708279161 + Java's "\"public\".\"flyway_schema_history\"".hashCode()
    assert.equal(
      flywayLockNumber('public', 'flyway_schema_history'),
      77431708279161n + BigInt(javaHash('"public"."flyway_schema_history"')),
    );
    assert.deepEqual(flywaySettings('postgres://ops:s%40cret@db.example.test:5433/loans?sslmode=require', 'postgres'), {
      FLYWAY_URL: 'jdbc:postgresql://db.example.test:5433/loans?sslmode=require',
      FLYWAY_USER: 'ops',
      FLYWAY_PASSWORD: 's@cret',
    });
  });
});

function javaHash(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

describe('up, validate and repair on SQLite', () => {
  test('each file once, in order, with a Flyway-layout history row in its own transaction; a second run applies nothing', async () => {
    const { db, target } = project({
      'V1__create_loan.sql': 'CREATE TABLE loan (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);\n',
      'V2__add_status.sql': "ALTER TABLE loan ADD COLUMN status TEXT NOT NULL DEFAULT 'open';\n",
      'R__views.sql': "DROP VIEW IF EXISTS open_loans; CREATE VIEW open_loans AS SELECT * FROM loan WHERE status = 'open';\n",
    });
    const dry = await migrateUp(target, { dryRun: true }).catch((error) => error as Error);
    assert.match(String(dry), /no SQLite database/, 'a dry run creates no file');
    const first = await migrateUp(target);
    assert.deepEqual(
      first.applied.map(({ file }) => file.script),
      ['V1__create_loan.sql', 'V2__add_status.sql', 'R__views.sql'],
    );
    const rows = history(db);
    assert.deepEqual(Object.keys(rows[0]), [
      'installed_rank',
      'version',
      'description',
      'type',
      'script',
      'checksum',
      'installed_by',
      'installed_on',
      'execution_time',
      'success',
    ]);
    assert.deepEqual(
      rows.map((row) => [row.installed_rank, row.version, row.description, row.type, row.success]),
      [
        [1, '1', 'create loan', 'SQL', 1],
        [2, '2', 'add status', 'SQL', 1],
        [3, null, 'views', 'SQL', 1],
      ],
    );
    assert.equal(rows[0].checksum, flywayChecksum('CREATE TABLE loan (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);\n'));
    assert.deepEqual((await migrateUp(target)).applied, []);
    assert.equal((await migrateValidate(target)).valid, true);
    // A repeatable runs again when it changes, and only then.
    writeFileSync(
      join(target.dir, 'R__views.sql'),
      "DROP VIEW IF EXISTS open_loans; CREATE VIEW open_loans AS SELECT id FROM loan WHERE status = 'open';\n",
    );
    assert.deepEqual(
      (await migrateUp(target)).applied.map(({ file }) => file.script),
      ['R__views.sql'],
    );
    assert.equal(history(db).length, 4);
  });

  test('a failing file leaves nothing of itself, and a foreign key it breaks fails it before the commit', async () => {
    const { db, target } = project({
      'V1__tables.sql':
        'CREATE TABLE owner (id INTEGER PRIMARY KEY); CREATE TABLE pet (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owner(id));\n',
      'V2__broken.sql': 'CREATE TABLE half (id INTEGER); INSERT INTO nowhere VALUES (1);\n',
    });
    const run = await migrateUp(target);
    assert.deepEqual(
      run.applied.map(({ file }) => file.script),
      ['V1__tables.sql'],
    );
    assert.match(run.failure!.message, /no such table: nowhere\. Nothing of it was applied/);
    assert.equal(tables(db).includes('half'), false, 'its first statement was rolled back with it');
    assert.equal(history(db).length, 1, 'nothing recorded for the failed file');
    writeFileSync(join(target.dir, 'V2__broken.sql'), 'INSERT INTO pet VALUES (1, 99);\n');
    const orphan = await migrateUp(target);
    assert.match(orphan.failure!.message, /leaves 1 row of pet pointing at no row of owner/);
    assert.equal(history(db).length, 1);
  });

  test('a changed, missing or out-of-order file stops the run until repaired', async () => {
    const { db, target } = project({
      'V1__a.sql': 'CREATE TABLE a (id INTEGER);\n',
      'V2__b.sql': 'CREATE TABLE b (id INTEGER);\n',
      'V3__c.sql': 'CREATE TABLE c (id INTEGER);\n',
    });
    await migrateUp(target);
    writeFileSync(join(target.dir, 'V1__a.sql'), 'CREATE TABLE a (id INTEGER, extra TEXT);\n');
    writeFileSync(join(target.dir, 'V1_5__late.sql'), 'CREATE TABLE late (id INTEGER);\n');
    rmSync(join(target.dir, 'V2__b.sql'));
    const refused = await migrateUp(target);
    assert.deepEqual(refused.applied, []);
    const problems = refused.status.plan.problems.join('\n');
    assert.match(problems, /V1__a\.sql changed after it was applied/);
    assert.match(problems, /V2__b\.sql was applied .* not in the directory any more/);
    assert.match(problems, /V1_5__late\.sql is new, but version 3 is already applied: give it a version after 3/);
    assert.equal((await migrateValidate(target)).valid, false);
    rmSync(join(target.dir, 'V1_5__late.sql'));
    const repaired = await migrateRepair(target);
    assert.deepEqual(
      repaired.actions.map((action) => action.replace(/checksum -?\d+/, 'checksum N')),
      ['V1__a.sql: history now says checksum N, "a"', 'marked V2__b.sql deleted'],
    );
    assert.equal(history(db).at(-1)!.type, 'DELETE');
    assert.equal((await migrateValidate(target)).valid, true);
    assert.deepEqual((await migrateRepair(target)).actions, []);
    // A version newer than every file is a newer checkout's: said, not refused (Flyway's "future").
    rmSync(join(target.dir, 'V3__c.sql'));
    const future = await migrationStatus(target);
    assert.deepEqual(future.plan.problems, []);
    assert.match(future.plan.notes.join('\n'), /version 3 \(V3__c\.sql\) is applied but has no file here/);
  });

  test('a database with tables is baselined first, as version 0, untouched, with its schema written read-only beside the migrations', async () => {
    const { db, dir, target } = project({ 'V1__add_note.sql': 'ALTER TABLE "Customer Accounts" ADD COLUMN note TEXT;\n' });
    sql(
      db,
      `CREATE TABLE "Customer Accounts" ("Account ID" INTEGER PRIMARY KEY, "Name" TEXT NOT NULL);
      CREATE TABLE ledger (id INTEGER PRIMARY KEY, account INTEGER, amount INTEGER);
      CREATE VIEW big AS SELECT * FROM ledger WHERE amount > 100;
      CREATE TRIGGER ledger_guard BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'kept'); END;
      INSERT INTO ledger VALUES (1, 1, 500);
      CREATE TABLE flyway_schema_history (installed_rank INT NOT NULL PRIMARY KEY, version VARCHAR(50), description VARCHAR(200) NOT NULL, type VARCHAR(20) NOT NULL, script VARCHAR(1000) NOT NULL, checksum INT, installed_by VARCHAR(100) NOT NULL, installed_on TEXT NOT NULL, execution_time INT NOT NULL, success BOOLEAN NOT NULL);
      INSERT INTO flyway_schema_history VALUES (1, '1', 'their init', 'SQL', 'V1__their_init.sql', 7, 'them', '2026-01-01', 1, 1);`,
    );
    const refused = await migrateUp(target);
    assert.match(refused.refused!, /already holds 4 tables or views and no migration history.*mistri migrate baseline/);
    const baseline = await migrateBaseline(target);
    assert.equal(baseline.wrote, true);
    const snapshot = JSON.parse(readFileSync(join(dir, 'baseline.schema.json'), 'utf8')) as { objects: Record<string, string> };
    // Requested as 0444; the umask may only take bits away, so the invariant is no write bit and an owner who can read.
    const baselineMode = statSync(join(dir, 'baseline.schema.json')).mode & 0o777;
    assert.equal(baselineMode & 0o222, 0, 'a baseline snapshot has no write bits');
    assert.equal(baselineMode & 0o400, 0o400, 'and its owner can read it');
    assert.equal(snapshot.objects['column "Customer Accounts"."Account ID"'], 'INTEGER primary key');
    assert.match(snapshot.objects['view big'], /CREATE VIEW big AS SELECT/);
    assert.match(snapshot.objects['trigger ledger.ledger_guard'], /BEFORE DELETE ON ledger/);
    assert.ok(!Object.keys(snapshot.objects).some((key) => key.includes(DEFAULT_HISTORY_TABLE) || key.includes('__mistri_')));
    assert.deepEqual(
      history(db).map((row) => [row.version, row.type, row.description, row.checksum]),
      [['0', 'BASELINE', '<< Flyway Baseline >>', null]],
    );
    assert.deepEqual(
      history(db, 'flyway_schema_history').map((row) => row.script),
      ['V1__their_init.sql'],
      "another team's history is left as it was",
    );
    assert.deepEqual(
      tables(db).filter((name) => !name.startsWith('__mistri_')),
      ['Customer Accounts', 'flyway_schema_history', 'ledger'],
      'nothing of it touched',
    );
    assert.match((await migrateBaseline(target)).already!, /baselined as version 0/);
    const applied = await migrateUp(target);
    assert.deepEqual(
      applied.applied.map(({ file }) => file.script),
      ['V1__add_note.sql'],
    );
    assert.deepEqual(applied.status.drift, []);
    // A baseline starts a history; it does not join one.
    const migrated = project({ 'V1__a.sql': 'CREATE TABLE a (id INTEGER);' });
    await migrateUp(migrated.target);
    assert.match((await migrateBaseline(migrated.target)).refused!, /already records 1 migration; a baseline starts a history/);
  });

  test('drift: a change made by hand is said, a run that leaves it alone keeps it drift, and one that adopts it settles it', async () => {
    const { db, target } = project({
      'V1__loan.sql': 'CREATE TABLE loan (id INTEGER PRIMARY KEY, amount INTEGER);\nCREATE INDEX loan_amount ON loan(amount);\n',
    });
    await migrateUp(target);
    sql(db, 'ALTER TABLE loan ADD COLUMN note TEXT; DROP INDEX loan_amount; CREATE TABLE scratch_by_hand (x INTEGER, y INTEGER);');
    const status = await migrationStatus(target);
    assert.deepEqual(
      status.drift!.map((change) => [change.key, change.was ?? null, change.now ?? null]),
      [
        ['column loan.note', null, 'TEXT'],
        ['index loan.loan_amount', 'CREATE INDEX loan_amount ON loan(amount)', null],
        ['table scratch_by_hand', null, 'table'],
      ],
      'a new table is one line, not one per column',
    );
    assert.equal((await migrateValidate(target)).valid, false);
    writeFileSync(join(target.dir, 'V2__rate.sql'), 'ALTER TABLE loan ADD COLUMN rate REAL;\n');
    const after = await migrateUp(target);
    assert.deepEqual(
      after.status.drift!.map((change) => change.key),
      ['column loan.note', 'index loan.loan_amount', 'table scratch_by_hand'],
      'the run did not bless them',
    );
    /* Adopted: the dropped index stays dropped by a migration that says so,
       the scratch table is dropped, and the hand-made column is named. */
    writeFileSync(
      join(target.dir, 'V3__adopt.sql'),
      'DROP INDEX IF EXISTS loan_amount;\nDROP TABLE scratch_by_hand;\n-- loan.note was added by hand before migrations owned the table; kept.\n',
    );
    assert.deepEqual((await migrateUp(target)).status.drift, []);
  });

  test('carrying drift forward is a rule about three readings', () => {
    const expected = { 'column t.a': 'int', 'index t.i': 'x' };
    const before = { 'column t.a': 'int', 'column t.hand': 'text' };
    const after = { 'column t.a': 'bigint', 'column t.hand': 'text', 'column t.new': 'int' };
    assert.deepEqual(carryForward(expected, before, after), { 'column t.a': 'bigint', 'column t.new': 'int', 'index t.i': 'x' });
    // A migration that names the drifted object settles it.
    assert.deepEqual(carryForward(expected, before, after, ['ALTER TABLE t ADD COLUMN IF NOT EXISTS hand text;']), {
      'column t.a': 'bigint',
      'column t.hand': 'text',
      'column t.new': 'int',
      'index t.i': 'x',
    });
    assert.deepEqual(carryForward({ 'column "Odd T"."My Col"': 'int' }, {}, {}, ['ALTER TABLE "Odd T" DROP COLUMN "My Col";']), {});
    assert.deepEqual(carryForward(expected, before, after, ['-- the hands are elsewhere']), {
      'column t.a': 'bigint',
      'column t.new': 'int',
      'index t.i': 'x',
    });
    assert.deepEqual(
      drift(expected, before).map((change) => change.key),
      ['column t.hand', 'index t.i'],
    );
  });

  test('two runs at once apply each file once: the second waits on the write lock and finds the work done', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++)
      files[`V${i}__step_${i}.sql`] =
        `CREATE TABLE t${i} (id INTEGER PRIMARY KEY, v TEXT);\nWITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000) INSERT INTO t${i} (v) SELECT hex(randomblob(16)) FROM n;\n`;
    const { db, dir } = project(files);
    const runner = (id: string) =>
      new Promise<{ code: number; out: string }>((done, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '-e',
            `
        const { applyMigrations } = await import(${JSON.stringify(join(ROOT, 'packages/mistri/src/server/maintenance.ts'))});
        const applied = await applyMigrations({ sqlite: ${JSON.stringify(db)} }, ${JSON.stringify(dir)});
        console.log(${JSON.stringify(id)} + ':' + applied.length);`,
          ],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          out += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => done({ code: code ?? 1, out }));
      });
    const [a, b] = await Promise.all([runner('a'), runner('b')]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const counts = [a.out, b.out].map((out) => Number(/:(\d+)/.exec(out)![1]));
    assert.equal(counts[0] + counts[1], 12, `${a.out} ${b.out}`);
    const rows = history(db);
    assert.deepEqual(
      rows.map((row) => row.version),
      Array.from({ length: 12 }, (_, i) => String(i + 1)),
    );
  });

  test('applyMigrations, for a seed: the scripts applied, and a refusal as an error', async () => {
    const { db, dir } = project({ 'V1__a.sql': 'CREATE TABLE a (id INTEGER);\n' });
    assert.deepEqual(await applyMigrations({ sqlite: db }, dir), ['V1__a.sql']);
    assert.deepEqual(await applyMigrations({ sqlite: db }, dir), []);
    writeFileSync(join(dir, 'V1__a.sql'), 'CREATE TABLE a (id INTEGER, b TEXT);\n');
    await assert.rejects(applyMigrations({ sqlite: db }, dir), /changed after it was applied/);
    await assert.rejects(applyMigrations({ oracle: 'x' } as never, dir), /needs \{ sqlite/);
  });

  test('a SQLite file may not run outside a transaction', async () => {
    const { target } = project({ 'V1__a.sql': 'CREATE TABLE a (id INTEGER);\n', 'V1__a.sql.conf': 'executeInTransaction=false\n' });
    await assert.rejects(migrateUp(target), /SQLite runs every migration in a transaction/);
  });
});

describe('tablewalk migrate, the command', () => {
  test('new, up with --dry-run, up, status and validate: their words and exit codes', async () => {
    const root = join(work, 'cli');
    mkdirSync(root);
    const db = join(root, 'shop.db');
    const made = await cli(['migrate', 'new', 'create orders', '--no-config', '--migrations', join(root, 'migrations')]);
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /wrote .*migrations\/V1__create_orders\.sql/);
    writeFileSync(join(root, 'migrations', 'V1__create_orders.sql'), 'CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER);\n');
    const dry = await cli(['migrate', 'up', '--db', db, '--dry-run', '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.equal(dry.code, 1, 'a dry run on a file that is not there refuses rather than creating it');
    const up = await cli(['migrate', 'up', '--db', db, '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.equal(up.code, 0, up.err);
    assert.match(up.out, /applied V1__create_orders\.sql/);
    writeFileSync(join(root, 'migrations', 'V2__add_note.sql'), 'ALTER TABLE orders ADD COLUMN note TEXT;\n');
    const preview = await cli(['migrate', 'up', '--db', db, '--dry-run', '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.equal(preview.code, 0, preview.err);
    assert.match(
      preview.out,
      /-- V2__add_note\.sql, in one transaction\nALTER TABLE orders ADD COLUMN note TEXT;\n-- then its row in __mistri_schema_history: version 2/,
    );
    assert.equal(history(db).length, 1, 'the dry run changed nothing');
    const status = await cli(['migrate', 'status', '--db', db, '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.match(status.out, /1\s+create orders\s+\S+ \S+\s+applied\n\s+2\s+add note\s+pending/);
    assert.match(status.out, /1 migration pending: tablewalk migrate up/);
    const invalid = await cli(['migrate', 'validate', '--db', db, '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.equal(invalid.code, 2);
    assert.match(invalid.out, /pending: V2__add_note\.sql is not applied\nNot valid\./);
    writeFileSync(
      join(root, 'migrations', 'V2__add_note.sql'),
      'ALTER TABLE orders ADD COLUMN note TEXT;\nINSERT INTO nowhere VALUES (1);\n',
    );
    const failed = await cli(['migrate', 'up', '--db', db, '--no-config', '--migrations', join(root, 'migrations')], {});
    assert.equal(failed.code, 3);
    assert.match(failed.out, /failed {2}V2__add_note\.sql: no such table: nowhere\. Nothing of it was applied\./);
    const refused = await cli(['migrate', 'sideways', '--db', db], {});
    assert.equal(refused.code, 1);
    assert.match(refused.err, /"sideways" is not a migrate command/);
    const mode = await cli(['migrate', 'status', '--db', db, '--mcp'], {});
    assert.equal(mode.code, 1);
    assert.match(mode.err, /"--mcp" is not an option of migrate/);
  });

  test('UX-1: before the schema is applied, status and up say so and fail, and the first diff is schema.sql with no Atlas', async () => {
    const root = join(work, 'first');
    mkdirSync(root);
    const db = join(root, 'shop.db');
    sql(db, '');
    const at = ['--db', db, '--no-config', '--migrations', join(root, 'migrations')];
    const schema = 'create table orders (\n  id serial primary key, -- numbered\n  total integer not null\n);\n';
    writeFileSync(join(root, 'schema.sql'), schema);

    const never = await cli(['migrate', 'status', ...at]);
    assert.equal(never.code, 2, never.out);
    assert.match(never.out, /No migrations to apply: tablewalk migrate diff init writes the first from schema\.sql\./);
    const nothing = await cli(['migrate', 'up', ...at]);
    assert.equal(nothing.code, 2, nothing.out);
    assert.match(
      nothing.err,
      /no migrations in .*migrations and none was ever applied, so the schema never was\. Write the first from schema\.sql with tablewalk migrate diff init/,
    );
    assert.deepEqual(tables(db), [], 'a refused up makes no history table either');

    // An Atlas that cannot run: the first diff must not need one.
    const first = await cli(['migrate', 'diff', 'init', ...at], { env: { TABLEWALK_ATLAS: join(root, 'no-atlas-here') } });
    assert.equal(first.code, 0, first.err);
    assert.doesNotMatch(first.err, /Atlas/);
    const written = readFileSync(join(root, 'migrations', 'V1__init.sql'), 'utf8');
    assert.match(written, /^-- Written by tablewalk migrate diff: schema\.sql as it stands/);
    assert.ok(written.endsWith(schema.replace('serial primary key', 'integer primary key')), written);

    const pending = await cli(['migrate', 'status', ...at]);
    assert.equal(pending.code, 2, 'written is not applied');
    assert.match(pending.out, /1 migration pending: tablewalk migrate up/);
    const up = await cli(['migrate', 'up', ...at]);
    assert.equal(up.code, 0, up.err);
    assert.match(up.out, /applied V1__init\.sql/);
    const done = await cli(['migrate', 'status', ...at]);
    assert.equal(done.code, 0, done.out);
  });

  test('--tool flyway hands the command to Flyway through its environment, never its command line', async () => {
    const root = join(work, 'tool');
    mkdirSync(join(root, 'migrations'), { recursive: true });
    writeFileSync(join(root, 'migrations', 'V1__a.sql'), 'CREATE TABLE a (id INTEGER);\n');
    const fake = join(root, 'flyway');
    // Stands in for Flyway: says what it was given, then applies the file as Flyway would have.
    writeFileSync(
      fake,
      `#!/bin/sh\necho "args=$*"\necho "url=$FLYWAY_URL table=$FLYWAY_TABLE locations=$FLYWAY_LOCATIONS baseline=$FLYWAY_BASELINE_VERSION password=\${FLYWAY_PASSWORD:-none}"\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const db = join(root, 'a.db');
    new DatabaseSync(db).close();
    const ran = await cli(['migrate', 'up', '--db', db, '--no-config', '--migrations', join(root, 'migrations'), '--tool', 'flyway'], {
      env: { TABLEWALK_FLYWAY: fake },
    });
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /flyway: args=migrate\n/);
    assert.match(
      ran.out,
      new RegExp(
        `flyway: url=jdbc:sqlite:${db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} table=__mistri_schema_history locations=filesystem:${join(root, 'migrations').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} baseline=0 password=none`,
      ),
    );
    const missing = await cli(
      ['migrate', 'status', '--db', db, '--no-config', '--migrations', join(root, 'migrations'), '--tool', 'flyway'],
      { env: { TABLEWALK_FLYWAY: join(root, 'nope') } },
    );
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Flyway is not installed where this can find it/);
    const other = await cli(['migrate', 'up', '--db', db, '--no-config', '--tool', 'liquibase'], {});
    assert.match(other.err, /--tool takes flyway/);
  });
});

describe('the App, checked against the schema the migrations make', () => {
  /* Outside the checkout, with tablewalk "installed" beside the App: the
     way a project that ran npm install resolves @mistriwork/mistri/app. */
  const root = join(work, 'app');
  const appDir = join(root, 'tiny');
  const db = join(root, 'tiny.db');
  const config = join(root, 'mistri.json');
  const setUp = () => {
    if (existsSync(appDir)) return;
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(root, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    // The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(root, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(root, 'node_modules', '@types', 'node'), 'dir');
    mkdirSync(join(appDir, 'migrations'), { recursive: true });
    writeFileSync(join(appDir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(appDir, 'app.ts'),
      [
        "import type { App } from './mistri-schema.d.ts';",
        "import { listView } from '@mistriwork/mistri/app';",
        "export default { id: 'tiny', name: 'Tiny', connection: 'tiny', resources: { task: {} },",
        "  views: { tasks: listView('task', { show: ['name', 'due_on'] }) }, home: 'tasks' } satisfies App;",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(appDir, 'migrations', 'V1__tasks.sql'),
      'CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL, due_on DATE);\n',
    );
    writeFileSync(config, `${JSON.stringify({ connections: [{ name: 'tiny', url: db }] })}\n`);
  };

  test('up with --app writes the types and checks; a pending drop is judged first by check --pending, on a copy', async () => {
    setUp();
    const up = await cli(['migrate', 'up', '--app', appDir, '--config', config]);
    assert.equal(up.code, 0, `${up.out}\n${up.err}`);
    assert.match(up.out, /applied V1__tasks\.sql/);
    assert.match(up.out, /schema types\s+passed\s+wrote mistri-schema\.d\.ts from the database/);
    writeFileSync(join(appDir, 'migrations', 'V2__drop_due.sql'), 'ALTER TABLE task DROP COLUMN due_on;\n');
    const before = readFileSync(db);
    const pending = await cli(['check', '--app', appDir, '--config', config, '--pending']);
    assert.equal(pending.code, 3, `${pending.out}\n${pending.err}`);
    assert.match(pending.out, /pending\s+passed\s+1 pending migration applied to a copy of the SQLite file/);
    assert.match(pending.out, /V2__drop_due\.sql/);
    assert.match(pending.out, /due_on/);
    assert.deepEqual(readFileSync(db), before, 'the database itself was not touched');
    assert.equal(history(db).length, 1);
    assert.ok(!readdirSync(root).some((name) => name.startsWith('.mistri-pending-')), 'the config written for the copy is gone');
    const status = await cli(['migrate', 'status', '--app', appDir, '--config', config]);
    assert.match(status.out, /2\s+drop due\s+pending/);
    const applied = await cli(['migrate', 'up', '--app', appDir, '--config', config]);
    assert.equal(applied.code, 4, `${applied.out}\n${applied.err}`);
    assert.match(applied.out, /applied V2__drop_due\.sql/);
    assert.match(applied.out, /"due_on"/);
    assert.match(applied.out, /The migrations are applied, and the App no longer fits the schema they made/);
  });

  test("check --pending-on tries the pending migrations on the scratch database named, never on the App's own", async () => {
    setUp();
    writeFileSync(join(appDir, 'migrations', 'V3__note.sql'), 'ALTER TABLE task ADD COLUMN note TEXT;\n');
    const scratch = join(root, 'branch.db');
    try {
      copyFileSync(db, scratch);
      const before = readFileSync(db);
      const judged = await cli(['check', '--app', appDir, '--config', config, '--pending-on', scratch]);
      assert.match(
        judged.out,
        /pending\s+passed\s+1 pending migration applied to the scratch database --pending-on names/,
        judged.out + judged.err,
      );
      assert.match(judged.out, /V3__note\.sql/);
      assert.deepEqual(readFileSync(db), before, "the App's database was not touched");
      assert.equal(history(scratch).length, history(db).length + 1, 'the migration ran on the scratch database');
      assert.ok(existsSync(scratch), "the scratch database is the caller's, so it is not dropped");
      const own = await cli(['check', '--app', appDir, '--config', config, '--pending-on', db]);
      assert.equal(own.code, 6, `${own.out}\n${own.err}`);
      assert.match(own.out, /names the App's own database/);
      const other = await cli(['check', '--app', appDir, '--config', config, '--pending-on', 'postgres://u@h/d']);
      assert.equal(other.code, 6, `${other.out}\n${other.err}`);
      assert.match(other.out, /names a postgres database, and the App's is sqlite/);
    } finally {
      rmSync(join(appDir, 'migrations', 'V3__note.sql'), { force: true });
      rmSync(scratch, { force: true });
    }
  });

  test("status says when the App's types are older than the database", async () => {
    setUp();
    writeFileSync(
      join(appDir, 'app.ts'),
      readFileSync(join(appDir, 'app.ts'), 'utf8').replace("show: ['name', 'due_on']", "show: ['name']"),
    );
    await cli(['check', '--app', appDir, '--config', config]);
    sql(db, 'ALTER TABLE task ADD COLUMN by_hand TEXT;');
    const status = await cli(['migrate', 'status', '--app', appDir, '--config', config]);
    assert.match(status.out, /warning: mistri-schema\.d\.ts is older than the database — task \(columns changed\)/);
    assert.match(status.out, /\+ column task\.by_hand {2}TEXT {2}\(added outside migrations\)/);
  });
});

/* Against a real Flyway, where one is installed: TABLEWALK_TEST_FLYWAY names
   its command. Either tool applies the files and the other agrees. */
const FLYWAY = process.env.TABLEWALK_TEST_FLYWAY;
describe('switching with Flyway, either way', { skip: FLYWAY ? false : 'set TABLEWALK_TEST_FLYWAY=<flyway command> to run these' }, () => {
  const flyway = (command: string, db: string, dir: string) =>
    new Promise<{ code: number; out: string }>((done) => {
      execFile(
        FLYWAY!,
        [command],
        {
          timeout: 120_000,
          env: {
            ...process.env,
            FLYWAY_URL: `jdbc:sqlite:${db}`,
            FLYWAY_LOCATIONS: `filesystem:${dir}`,
            FLYWAY_TABLE: DEFAULT_HISTORY_TABLE,
            FLYWAY_BASELINE_VERSION: '0',
          },
        },
        (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out: `${out}${err}` }),
      );
    });
  test('Flyway validates what tablewalk applied, and tablewalk what Flyway applied', async () => {
    const files = {
      'V1__create.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);\r\nINSERT INTO a VALUES (1);\n',
      'R__views.sql': '﻿CREATE VIEW IF NOT EXISTS va AS SELECT * FROM a;\n\n-- é\n',
      'sub/V2__more.sql': 'CREATE TABLE b (id INTEGER);\n',
    };
    const ours = project(files);
    await migrateUp(ours.target);
    const checked = await flyway('validate', ours.db, ours.dir);
    assert.equal(checked.code, 0, checked.out);
    const theirs = project(files);
    const applied = await flyway('migrate', theirs.db, theirs.dir);
    assert.equal(applied.code, 0, applied.out);
    const status = await migrateValidate(theirs.target);
    assert.deepEqual(status.status.plan.problems, []);
    assert.deepEqual(status.status.plan.pending, []);
    assert.deepEqual(
      history(theirs.db).map((row) => [row.version, row.script, row.checksum]),
      history(ours.db).map((row) => [row.version, row.script, row.checksum]),
    );
  });
});
