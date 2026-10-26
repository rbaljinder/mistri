/*
 * MySQL's catalog copy is kept under an epoch (packages/engine/src/adapters/mysqlSchemaEpoch.ts),
 * as PostgreSQL's and SQLite's are (catalog-epoch.test.ts): served while one cheap
 * statement still answers what it answered, derived again the moment it does not,
 * so a migration is seen by the next request instead of at the next reload.
 * The statement's shape is checked everywhere; the behaviour needs a server
 * (TABLEWALK_TEST_MYSQL).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';
import { mysqlSchemaEpochOf, mysqlSchemaEpochStatement } from '../packages/engine/src/adapters/mysqlSchemaEpoch.js';
import { liveSkip } from './live.js';

test('the epoch statement binds one list of databases per source it digests, and reads no statistics', () => {
  const { text, params } = mysqlSchemaEpochStatement(['a', 'b']);
  const holes = text.match(/\?/g)!.length;
  assert.equal(holes, params.length);
  assert.equal(holes, 4 * 2, 'tables, columns, index parts, key parts');
  for (const volatile of ['TABLE_ROWS', 'UPDATE_TIME', 'AUTO_INCREMENT', 'CARDINALITY'])
    assert.ok(!text.includes(volatile), `${volatile} moves with data, not schema`);
  assert.throws(() => mysqlSchemaEpochStatement([]), /at least one database/);
});

test('an answer that is not one non-empty string is no epoch', () => {
  assert.equal(mysqlSchemaEpochOf([{ epoch: '1:2:3|4:5:6' }]), '1:2:3|4:5:6');
  assert.equal(mysqlSchemaEpochOf([]), undefined);
  assert.equal(mysqlSchemaEpochOf([{ epoch: null }]), undefined);
  assert.equal(mysqlSchemaEpochOf(undefined), undefined);
});

const LIVE = process.env.TABLEWALK_TEST_MYSQL;
const DB = 'tablewalk_mysql_epoch';

describe('MySQL: the catalog copy follows the schema', { skip: liveSkip('mysql', LIVE) }, () => {
  type Admin = { query(sql: string): Promise<unknown>; end(): Promise<void> };
  const specifier = 'mysql2/promise';
  const open = async (uri: string): Promise<Admin> =>
    ((await import(specifier)) as { createConnection: (c: Record<string, unknown>) => Promise<Admin> }).createConnection({ uri });
  const url = () => {
    const u = new URL(LIVE!);
    u.pathname = `/${DB}`;
    return u.toString();
  };
  let adapter: MysqlAdapter;
  let admin: Admin;
  const schema = () => (adapter as unknown as { schema(): Promise<{ tables: { name: string; columns: { name: string }[] }[] }> }).schema();

  before(async () => {
    const root = await open(LIVE!);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE \`${DB}\``);
    await root.end();
    admin = await open(url());
    await admin.query('CREATE TABLE item (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)');
    adapter = new MysqlAdapter(url(), 'epoch');
    await adapter.introspect();
  });

  after(async () => {
    await adapter?.close();
    await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await admin?.end();
  });

  test('a warm request reuses the copy, and data changes do not disturb it', async () => {
    const first = await schema();
    await admin.query(`INSERT INTO item VALUES (1, 'one')`);
    assert.equal(await schema(), first, 'the same object: nothing was derived again');
  });

  test('a column, an index, a foreign key and a new table are each seen by the next request', async () => {
    let seen = await schema();
    await admin.query('ALTER TABLE item ADD COLUMN note VARCHAR(10)');
    let next = await schema();
    assert.notEqual(next, seen);
    assert.ok(next.tables.find((t) => t.name === 'item')!.columns.some((c) => c.name === 'note'));

    seen = next;
    await admin.query('CREATE INDEX item_name ON item (name)');
    next = await schema();
    assert.notEqual(next, seen, 'an index is part of what introspection reads');

    seen = next;
    await admin.query(
      'CREATE TABLE part (id INT PRIMARY KEY, item_id INT, CONSTRAINT part_item FOREIGN KEY (item_id) REFERENCES item (id))',
    );
    next = await schema();
    assert.ok(next.tables.some((t) => t.name === 'part'));

    seen = next;
    await admin.query('ALTER TABLE part DROP FOREIGN KEY part_item');
    assert.notEqual(await schema(), seen, 'a dropped key moves it too');
  });

  test('a comment change is seen, and a settled catalog is reused again', async () => {
    const seen = await schema();
    await admin.query(`ALTER TABLE item COMMENT 'things'`);
    const next = await schema();
    assert.notEqual(next, seen);
    assert.equal(await schema(), next);
  });
});
