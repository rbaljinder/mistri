/**
 * `tablewalk migrate` on PostgreSQL, each case in a database of its own:
 * the messy database that was there first (several schemas, odd names, no
 * foreign keys, a view, a trigger, an enum and another team's Flyway
 * history), a file PostgreSQL will not run in a transaction, a failure on
 * either side of that line, drift, the advisory lock Flyway takes too, and
 * `check --pending` on a copy the server makes.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { flywayLockNumber } from '../packages/engine/src/server/migrate/database.js';
import { DEFAULT_HISTORY_TABLE } from '../packages/engine/src/server/migrate/history.js';
import {
  migrateBaseline,
  migrateRepair,
  migrateUp,
  migrationStatus,
  type MigrateTarget,
} from '../packages/engine/src/server/migrate/runner.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const ROOT = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-migrate-pg-'));
after(() => rmSync(work, { recursive: true, force: true }));
const drops: Array<() => Promise<void>> = [];
after(async () => {
  for (const drop of drops) await drop();
});

let n = 0;
async function database(
  files: Record<string, string>,
  schemas: string[] = [],
  setup = '',
): Promise<{ url: string; dir: string; target: MigrateTarget; query: (sql: string) => Promise<Array<Record<string, unknown>>> }> {
  const owned = await uuidPostgresDatabase('tw_migrate');
  drops.push(owned.drop);
  const dir = join(work, `m${++n}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const query = async (sql: string) => {
    const client = await pgClient(owned.url);
    try {
      return (await client.query(sql)).rows as Array<Record<string, unknown>>;
    } finally {
      await client.end();
    }
  };
  if (setup) await query(setup);
  return { url: owned.url, dir, target: { url: owned.url, schemas, dir, table: DEFAULT_HISTORY_TABLE }, query };
}

const MESSY = `
  CREATE SCHEMA sales; CREATE SCHEMA "Ops Team";
  CREATE TABLE sales."Customer Accounts" ("Account ID" serial PRIMARY KEY, "Name" text NOT NULL, region text);
  CREATE TABLE sales.orders (id bigint PRIMARY KEY, account integer, total numeric(12,2) DEFAULT 0 CHECK (total >= 0));
  CREATE INDEX orders_account ON sales.orders (account);
  CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE total > 1000;
  CREATE FUNCTION sales.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.total := coalesce(NEW.total, 0); RETURN NEW; END $$;
  CREATE TRIGGER orders_touch BEFORE INSERT ON sales.orders FOR EACH ROW EXECUTE FUNCTION sales.touch();
  CREATE TYPE sales.stage AS ENUM ('new', 'won', 'lost');
  CREATE TABLE "Ops Team".tickets (id int PRIMARY KEY, title text);
  CREATE TABLE sales.flyway_schema_history (installed_rank INT NOT NULL PRIMARY KEY, version VARCHAR(50), description VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL, script VARCHAR(1000) NOT NULL, checksum INTEGER, installed_by VARCHAR(100) NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT now(), execution_time INTEGER NOT NULL, success BOOLEAN NOT NULL);
  INSERT INTO sales.flyway_schema_history VALUES (1, '1', 'their init', 'SQL', 'V1__their_init.sql', 123, 'them', now(), 5, true);
  CREATE TABLE public.unrelated (x int);
  INSERT INTO sales.orders VALUES (1, 1, 1500);`;

describe('tablewalk migrate on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  test('a messy database is baselined in the schema it owns, untouched, and migrated from there', async () => {
    const { target, dir, query } = await database(
      {
        'V1__add_payoff_quote.sql':
          "CREATE TABLE payoff_quote (id serial PRIMARY KEY, order_id bigint REFERENCES orders(id), amount numeric(12,2) NOT NULL);\nALTER TYPE stage ADD VALUE 'hold';\n",
        'R__views.sql': 'CREATE OR REPLACE VIEW open_quotes AS SELECT q.id, q.amount FROM payoff_quote q;\n',
        'concurrent/V2__index_quotes.sql':
          'CREATE INDEX CONCURRENTLY payoff_quote_order ON payoff_quote (order_id);\n-- a comment; with a semicolon\nCREATE INDEX CONCURRENTLY payoff_amount ON payoff_quote (amount);\n',
        'concurrent/V2__index_quotes.sql.conf': 'executeInTransaction=false\n',
      },
      ['sales'],
      MESSY,
    );
    assert.match((await migrateUp(target)).refused!, /already holds 4 tables or views/);
    await migrateBaseline(target);
    const snapshot = JSON.parse(readFileSync(join(dir, 'baseline.schema.json'), 'utf8')) as {
      objects: Record<string, string>;
      schemas: string[];
    };
    assert.deepEqual(snapshot.schemas, ['sales']);
    const keys = Object.keys(snapshot.objects);
    assert.ok(keys.includes('column sales."Customer Accounts"."Account ID"'));
    assert.match(snapshot.objects['view sales.big_orders'], /FROM sales\.orders/);
    assert.match(snapshot.objects['trigger sales.orders.orders_touch'], /BEFORE INSERT ON sales\.orders/);
    assert.equal(snapshot.objects['enum sales.stage'], "('new', 'won', 'lost')");
    assert.match(snapshot.objects['constraint sales.orders.orders_total_check'], /CHECK \(total >= 0/);
    assert.ok(
      keys.some((key) => key.startsWith('column sales.flyway_schema_history.')),
      "another team's history is a table like any other",
    );
    assert.ok(
      !keys.some((key) => key.includes('"Ops Team"') || key.includes('unrelated') || key.includes('__mistri_')),
      'nothing outside the schema it owns',
    );
    const applied = await migrateUp(target);
    assert.deepEqual(
      applied.applied.map(({ file }) => file.script),
      ['V1__add_payoff_quote.sql', 'concurrent/V2__index_quotes.sql', 'R__views.sql'],
    );
    assert.deepEqual(applied.status.drift, []);
    assert.deepEqual(
      (await query('SELECT version, type, script, success FROM sales.__mistri_schema_history ORDER BY installed_rank')).map((row) => [
        row.version,
        row.type,
        row.script,
        row.success,
      ]),
      [
        ['0', 'BASELINE', '<< Flyway Baseline >>', true],
        ['1', 'SQL', 'V1__add_payoff_quote.sql', true],
        ['2', 'SQL', 'concurrent/V2__index_quotes.sql', true],
        [null, 'SQL', 'R__views.sql', true],
      ],
    );
    assert.equal(
      (
        await query(
          "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'sales' AND indexname IN ('payoff_quote_order', 'payoff_amount')",
        )
      )[0].n,
      2,
    );
    assert.deepEqual(
      (await query('SELECT script FROM sales.flyway_schema_history')).map((row) => row.script),
      ['V1__their_init.sql'],
    );
    assert.equal((await query('SELECT total FROM sales.orders'))[0].total, '1500.00', 'rows that were there are there');
  });

  test('a failure: a transactional file leaves nothing; one outside a transaction is recorded failed and stops everything until repair', async () => {
    const { target, query } = await database({
      'V1__a.sql': 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE half (id int);\nINSERT INTO nowhere VALUES (1);\n',
    });
    const first = await migrateUp(target);
    assert.match(first.failure!.message, /relation "nowhere" does not exist\. Nothing of it was applied/);
    assert.equal((await query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('a', 'half')"))[0].n, 0);
    writeFileSync(join(target.dir, 'V1__a.sql'), 'CREATE TABLE a (id int PRIMARY KEY);\n');
    writeFileSync(
      join(target.dir, 'V2__index.sql'),
      'CREATE INDEX CONCURRENTLY a_id ON a (id);\nCREATE INDEX CONCURRENTLY b_id ON nowhere (id);\n',
    );
    writeFileSync(join(target.dir, 'V2__index.sql.conf'), 'executeInTransaction=false\n');
    const second = await migrateUp(target);
    assert.deepEqual(
      second.applied.map(({ file }) => file.script),
      ['V1__a.sql'],
    );
    assert.equal(second.failure!.recorded, true);
    assert.match(second.failure!.message, /It ran outside a transaction, so the statements before the failing one are applied/);
    const stuck = await migrationStatus(target);
    assert.match(stuck.plan.problems.join('\n'), /V2__index\.sql failed on .* `mistri migrate repair` removes the failed entry/);
    assert.deepEqual((await migrateUp(target)).applied, []);
    writeFileSync(join(target.dir, 'V2__index.sql'), 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_id ON a (id);\n');
    assert.deepEqual((await migrateRepair(target)).actions, ['removed the failed entry for V2__index.sql']);
    assert.deepEqual(
      (await migrateUp(target)).applied.map(({ file }) => file.script),
      ['V2__index.sql'],
    );
  });

  test('drift in the schema it owns: a column added and an index dropped by hand', async () => {
    const { target, query } = await database({
      'V1__loan.sql': 'CREATE TABLE loan (id int PRIMARY KEY, status text);\nCREATE INDEX loan_status_idx ON loan (status);\n',
    });
    await migrateUp(target);
    await query('ALTER TABLE loan ADD COLUMN note text; DROP INDEX loan_status_idx; ALTER TABLE loan ALTER COLUMN status SET NOT NULL');
    assert.deepEqual(
      (await migrationStatus(target)).drift!.map((change) => [change.key, change.was ?? null, change.now ?? null]),
      [
        ['column public.loan.note', null, 'text'],
        ['column public.loan.status', 'text', 'text not null'],
        ['index public.loan.loan_status_idx', 'CREATE INDEX loan_status_idx ON public.loan USING btree (status)', null],
      ],
    );
    writeFileSync(
      join(target.dir, 'V2__adopt.sql'),
      'ALTER TABLE loan ADD COLUMN IF NOT EXISTS note text;\nALTER TABLE loan ALTER COLUMN status SET NOT NULL;\nDROP INDEX IF EXISTS loan_status_idx;\n',
    );
    assert.deepEqual((await migrateUp(target)).status.drift, []);
  });

  test('the lock: a run waits while the advisory lock Flyway would take is held, and two runs at once apply each file once', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) files[`V${i}__step.sql`] = `CREATE TABLE t${i} (id int PRIMARY KEY); SELECT pg_sleep(0.05);\n`;
    const { url, target, query } = await database(files);
    const holder = await pgClient(url);
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [String(flywayLockNumber('public', DEFAULT_HISTORY_TABLE))]);
    let waited = false;
    const run = migrateUp(target, {
      waiting: () => {
        waited = true;
      },
    });
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal(waited, true, 'it said it was waiting');
    assert.equal(
      (await query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 't1'"))[0].n,
      0,
      'and did nothing while it waited',
    );
    await holder.end();
    assert.equal((await run).applied.length, 8);
    for (let i = 9; i <= 16; i++)
      writeFileSync(join(target.dir, `V${i}__step.sql`), `CREATE TABLE t${i} (id int PRIMARY KEY); SELECT pg_sleep(0.05);\n`);
    const [a, b] = await Promise.all([migrateUp(target), migrateUp(target)]);
    assert.equal(a.applied.length + b.applied.length, 8);
    assert.deepEqual(
      (await query(`SELECT version FROM ${DEFAULT_HISTORY_TABLE} ORDER BY installed_rank`)).map((row) => row.version),
      Array.from({ length: 16 }, (_, i) => String(i + 1)),
    );
  });

  test('a lock wait: a file that waits past its lock timeout rolls back and is tried again once the table is free', async () => {
    const { url, target, query } = await database({ 'V1__loan.sql': 'CREATE TABLE loan (id int PRIMARY KEY);\n' });
    await migrateUp(target);
    writeFileSync(join(target.dir, 'V2__status.sql'), 'ALTER TABLE loan ADD COLUMN status text;\n');
    // A long transaction reading the table: its ACCESS SHARE blocks the ALTER's ACCESS EXCLUSIVE.
    const reader = await pgClient(url);
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM loan');
    const run = migrateUp(target);
    // Past the first lock timeout (5 s), and inside the retries: the reader ends, the next try applies.
    await new Promise((done) => setTimeout(done, 6_500));
    assert.equal(
      (await query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'loan' AND column_name = 'status'"))[0].n,
      0,
    );
    await reader.query('COMMIT');
    await reader.end();
    const done = await run;
    assert.equal(done.failure, undefined, JSON.stringify(done.failure));
    assert.deepEqual(
      done.applied.map(({ file }) => file.script),
      ['V2__status.sql'],
    );
  });

  test('check --pending judges the App against a copy the server makes, and says why when it cannot make one', async () => {
    const { url, query } = await database({}, [], 'CREATE TABLE task (id int PRIMARY KEY, name text NOT NULL, due_on date)');
    const root = join(work, 'app');
    const appDir = join(root, 'tiny');
    mkdirSync(join(appDir, 'migrations'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(root, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    writeFileSync(join(appDir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(appDir, 'app.ts'),
      "export default { id: 'tiny', name: 'Tiny', connection: 'tiny', resources: { task: {} },\n  views: { tasks: { kind: 'list', from: 'task', show: ['name', 'due_on'] } }, home: 'tasks' };\n",
    );
    writeFileSync(join(root, 'mistri.json'), `${JSON.stringify({ connections: [{ name: 'tiny', url }] })}\n`);
    const cli = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((done) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
          { cwd: ROOT, timeout: 120_000, env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') } },
          (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
        );
      });
    assert.equal((await cli(['migrate', 'baseline', '--app', appDir, '--config', join(root, 'mistri.json')])).code, 0);
    writeFileSync(join(appDir, 'migrations', 'V1__drop_due.sql'), 'ALTER TABLE task DROP COLUMN due_on;\n');
    const judged = await cli(['check', '--app', appDir, '--config', join(root, 'mistri.json'), '--pending']);
    assert.match(
      judged.out,
      /pending\s+passed\s+1 pending migration applied to a copy of the database \(CREATE DATABASE … TEMPLATE\)/,
      judged.out + judged.err,
    );
    assert.match(judged.out, /"due_on"/);
    assert.equal(judged.code, 4);
    assert.equal(
      (await query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'task' AND column_name = 'due_on'"))[0].n,
      1,
      'the database itself still has it',
    );
    const copies = `${decodeURIComponent(new URL(url).pathname.slice(1)).slice(0, 40)}_pending_%`;
    assert.equal((await query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE '${copies}'`))[0].n, 0, 'the copy is gone');
    /* While another session holds the database (the dev server, usually),
       a schema-only copy by pg_dump where it is installed; said, where not. */
    const busy = await pgClient(url);
    try {
      const held = await cli(['check', '--app', appDir, '--config', join(root, 'mistri.json'), '--pending']);
      if (spawnSync('pg_dump', ['--version']).status === 0) {
        assert.match(
          held.out,
          /pending\s+passed\s+1 pending migration applied to a schema-only copy of the database \(pg_dump\), since another session holds it/,
          held.out + held.err,
        );
        assert.equal(held.code, 4);
      } else {
        assert.equal(held.code, 6);
        assert.match(held.out, /PostgreSQL copies a database only while nobody else is connected to it.*pg_dump is not installed/);
      }
    } finally {
      await busy.end();
    }
    assert.equal(
      (await query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE '${copies}'`))[0].n,
      0,
      'that copy is gone too',
    );
  });
});
