/**
 * `mistri check --schema-file`: the App judged against the schema it declares, with no database to reach. The file
 * is run on a scratch database as a migration is, every step reads that, and it is dropped after.
 *
 * The equivalence tests are the point: the catalog the describer reads from the scratch must be the one it reads from
 * a live database the same DDL built (a difference is a describer bug), on the sample fixtures SQLite can hold.
 * Row counts are the one statistic left out: a scratch has no rows.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../packages/engine/src/server/connections.js';
import { schemaDatabase } from '../packages/engine/src/server/migrate/desired.js';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'mistri-schema-file-'));
after(() => rmSync(work, { recursive: true, force: true }));

interface Ran {
  code: number;
  out: string;
  err: string;
}
function run(args: string[]): Promise<Ran> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...args],
      { cwd: ROOT, timeout: 120_000, killSignal: 'SIGKILL' },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) reject(new Error(`mistri ${args.join(' ')} did not exit`));
        else done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

/** The DDL a SQLite database holds, as the schema file that would have built it. */
function ddlOf(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rootpage").all() as {
        sql: string;
      }[]
    )
      .map((row) => `${row.sql};`)
      .join('\n');
  } finally {
    db.close();
  }
}

async function catalogOf(url: string) {
  const registry = new Registry();
  try {
    const { schema } = await registry.open(registry.add({ name: 'catalog', url, schemas: [], source: 'argument' }).id);
    const { label: _label, readAt: _readAt, ...rest } = schema;
    return { ...rest, tables: rest.tables.map(({ approxRows: _rows, ...table }) => table) };
  } finally {
    await registry.closeAll();
  }
}

const FIXTURES: Record<string, string> = {
  tick: 'examples/databases/tick/seed.mjs',
  compass: 'test/fixtures/databases/crm/make-crm-db.mjs',
  payday: 'test/fixtures/databases/payday/seed.mjs',
};

describe('the catalog a schema file builds is the one a live database gives', () => {
  for (const [name, seed] of Object.entries(FIXTURES)) {
    test(`${name}: live equals the scratch its own DDL builds`, async () => {
      const live = join(work, `${name}.db`);
      execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, seed), live], { cwd: ROOT, stdio: 'pipe' });
      const file = join(work, `${name}.sql`);
      writeFileSync(file, ddlOf(live));
      const scratch = await schemaDatabase({ schemaFile: file });
      try {
        assert.equal(scratch.dialect, 'sqlite');
        assert.deepEqual(await catalogOf(scratch.url), await catalogOf(live));
      } finally {
        await scratch.drop();
      }
      assert.equal(existsSync(scratch.url), false, 'the scratch is dropped');
    });
  }

  test('a serial primary key is numbered, as SQLite reads schema.sql everywhere else', async () => {
    const file = join(work, 'serial.sql');
    writeFileSync(file, 'CREATE TABLE customer (id serial primary key, name text NOT NULL);\n');
    const scratch = await schemaDatabase({ schemaFile: file });
    try {
      const db = new DatabaseSync(scratch.url);
      db.prepare("INSERT INTO customer (name) VALUES ('Ana')").run();
      assert.equal((db.prepare('SELECT id FROM customer').get() as { id: number }).id, 1);
      db.close();
    } finally {
      await scratch.drop();
    }
  });

  test('a file that does not run says so, and leaves no scratch behind', async () => {
    const before = readdirSync(tmpdir()).filter((entry) => entry.includes('-schema-')).length;
    const file = join(work, 'broken.sql');
    writeFileSync(file, 'CREATE TABLE ( nope;\n');
    await assert.rejects(schemaDatabase({ schemaFile: file }), /broken\.sql did not run on a scratch sqlite database/);
    await assert.rejects(schemaDatabase({ schemaFile: join(work, 'absent.sql') }), /there is no .*absent\.sql/);
    assert.equal(readdirSync(tmpdir()).filter((entry) => entry.includes('-schema-')).length, before);
  });
});

describe('mistri check --schema-file, the command', () => {
  test('with no database and no schema file, the refusal is catalog-missing and names both ways out', async () => {
    const ran = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--json']);
    assert.equal(ran.code, 1);
    const report = JSON.parse(ran.out);
    assert.deepEqual(
      report.problems.map((found: { code: string }) => found.code),
      ['catalog-missing'],
    );
    assert.match(report.problems[0].message, /--db <url>/);
    assert.match(report.problems[0].message, /--schema-file/);
  });

  test("checks Tick against a schema file alone: no database is named, and Tick's own is never opened", async () => {
    const live = join(work, 'tick-live.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, FIXTURES.tick), live], { cwd: ROOT, stdio: 'pipe' });
    const file = join(work, 'tick-schema.sql');
    writeFileSync(file, ddlOf(live));
    const ran = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--schema-file', file]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.match(ran.out, /schema file {3}passed {2}.*tick-schema\.sql loaded into a scratch sqlite database/);
    assert.match(ran.out, /validation {4}passed {2}Tick: ok/);
  });

  test("a schema without the App's table fails the check as a database without it would", async () => {
    const file = join(work, 'other.sql');
    writeFileSync(file, 'CREATE TABLE other (id INTEGER PRIMARY KEY);\n');
    const ran = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--schema-file', file]);
    assert.notEqual(ran.code, 0, ran.out);
    assert.match(ran.out + ran.err, /task/);
  });

  test('refuses what it cannot honor, with exit 1', async () => {
    const alone = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--dev-url', 'postgres://x/y']);
    assert.equal(alone.code, 1);
    assert.match(alone.err, /--dev-url is the server --schema-file loads/);
    const pending = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--schema-file', '--pending']);
    assert.equal(pending.code, 1);
    assert.match(pending.err, /--schema-file checks the App against a scratch database/);
    const absent = await run(['check', '--app', 'examples/apps/tick', '--no-config', '--schema-file', join(work, 'nowhere.sql')]);
    assert.equal(absent.code, 1);
    assert.match(absent.err, /there is no .*nowhere\.sql/);
  });
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('on PostgreSQL', { skip: PG ? false : 'set TABLEWALK_TEST_PG=<a server where CREATEDB is allowed> to run this' }, () => {
  test('keystone schema.sql builds on a scratch database that is dropped after', async () => {
    const scratch = await schemaDatabase({ schemaFile: join(ROOT, 'test/fixtures/databases/keystone/schema.sql'), devUrl: PG! });
    try {
      assert.equal(scratch.dialect, 'postgres');
      assert.ok((await catalogOf(scratch.url)).tables.length > 5);
    } finally {
      await scratch.drop();
    }
    await assert.rejects(catalogOf(scratch.url));
  });
});
