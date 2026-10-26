/**
 * A read-only connection over a role that can do more. Every read runs in a
 * read-only transaction, which holds for everything tablewalk sends but not
 * for a superuser; the role is the boundary that always holds. So the adapters
 * say what a role could do beyond reading, and the registry says so once, on
 * the first open, for a connection that is not writable.
 *
 * Live and opt-in (test/live.ts). The service databases in CI connect as a
 * superuser; a least-privilege account is made here and dropped after.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { mysqlPrivileges } from '../packages/engine/src/adapters/rolePrivileges.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { liveSkip } from './live.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PG = process.env.TABLEWALK_TEST_PG;
const MY = process.env.TABLEWALK_TEST_MYSQL;

/** Open a connection twice through the registry: its notices, and what its role could do. */
async function probe(url: string, writable = false) {
  const registry = new Registry();
  const warnings: string[] = [];
  registry.onWarning = (message) => {
    warnings.push(message);
  };
  const { id } = registry.add({ name: 'probe', url, writable, source: 'config' });
  try {
    const { adapter } = await registry.open(id);
    await registry.open(id);
    return { warnings, role: await adapter.privileges!() };
  } finally {
    await registry.closeAll();
  }
}

test('a wider role is said once per connection per run, not on every schema refresh; a new grant is news', async (t) => {
  /* SQLite has no roles; the reach is lent to its adapter here so the rule
     is held without a live server. */
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-role-once-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'one.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY)');
  db.close();
  let reach = { superuser: true, writes: [] as string[], create: false };
  const prototype = SqliteAdapter.prototype as unknown as { privileges?: () => Promise<typeof reach> };
  prototype.privileges = async () => reach;
  t.after(() => {
    delete prototype.privileges;
  });
  const registry = new Registry();
  const warnings: string[] = [];
  registry.onWarning = (message) => {
    warnings.push(message);
  };
  const { id } = registry.add({ name: 'probe', url: file, writable: false, source: 'config' });
  try {
    await registry.open(id);
    await registry.refresh(id);
    await registry.refresh(id);
    assert.equal(warnings.length, 1, warnings.join('\n'));
    reach = { ...reach, create: true };
    await registry.refresh(id);
    assert.equal(warnings.length, 2, warnings.join('\n'));
    assert.match(warnings[1], /\(superuser; CREATE\)/);
  } finally {
    await registry.closeAll();
  }
});

const as = (url: string, user: string, password: string) => {
  const next = new URL(url);
  next.username = user;
  next.password = password;
  return next.toString();
};

test('MySQL grants: SUPER or every privilege on *.* is a superuser; only grants on the browsed databases count', () => {
  const on = (grants: string[], databases = ['crm']) => mysqlPrivileges(grants, databases);
  assert.deepEqual(on(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION']), {
    superuser: true,
    create: true,
    writes: ['ALL PRIVILEGES on *.*'],
  });
  assert.equal(on(['GRANT SELECT, INSERT, SUPER, FILE ON *.* TO `ops`@`%`']).superuser, true);
  assert.deepEqual(on(['GRANT USAGE ON *.* TO `reader`@`%`', 'GRANT SELECT ON `crm`.* TO `reader`@`%`']), {
    superuser: false,
    create: false,
    writes: [],
  });
  assert.deepEqual(on(['GRANT USAGE ON *.* TO `w`@`%`', 'GRANT SELECT, INSERT, UPDATE ON `crm`.* TO `w`@`%`']), {
    superuser: false,
    create: false,
    writes: ['INSERT/UPDATE on `crm`.*'],
  });
  assert.deepEqual(on(['GRANT DELETE ON `crm`.`invoice` TO `w`@`%`', 'GRANT CREATE ON `crm`.* TO `w`@`%`']), {
    superuser: false,
    create: true,
    writes: ['DELETE on `crm`.`invoice`'],
  });
  // Another database's grants are not this connection's reach; nor is a line that is not a grant.
  assert.deepEqual(on(['GRANT ALL PRIVILEGES ON `billing`.* TO `w`@`%`', 'GRANT PROXY ON ``@`` TO `w`@`%`', 'nonsense']), {
    superuser: false,
    create: false,
    writes: [],
  });
});

describe('role reach on PostgreSQL, against a real server', { skip: liveSkip('postgres', PG) }, () => {
  const role = 'tablewalk_privileges_reader';
  const table = 'tablewalk_privileges_probe';
  type Client = { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
  let control: Client;
  let reader: string;
  const drop = async () => {
    await control.query(`DROP TABLE IF EXISTS public.${table}`);
    await control.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
      EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`);
  };

  before(async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default: { Client: new (options: { connectionString: string }) => Client } };
    control = new pg.default.Client({ connectionString: PG! });
    await control.connect();
    await drop();
    await control.query(`CREATE TABLE public.${table} (id integer PRIMARY KEY)`);
    await control.query(`CREATE ROLE ${role} LOGIN PASSWORD 'reader-only'`);
    await control.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await control.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    reader = as(PG!, role, 'reader-only');
  });
  after(async () => {
    try {
      await drop();
    } finally {
      await control.end();
    }
  });

  test('a superuser is said once, on the first open; a writable connection is not', async () => {
    const opened = await probe(PG!);
    assert.equal(opened.role.superuser, true);
    assert.equal(opened.warnings.length, 1, opened.warnings.join('\n'));
    assert.match(opened.warnings[0], /^"probe" is read-only here, but its database role can do more \(superuser/);
    assert.match(opened.warnings[0], /connect as a role that can only read/);
    assert.deepEqual((await probe(PG!, true)).warnings, []);
  });

  test('a role that can only read says nothing; a write grant on one table is named', async () => {
    assert.deepEqual(await probe(reader), { warnings: [], role: { superuser: false, writes: [], create: false } });
    await control.query(`GRANT INSERT ON public.${table} TO ${role}`);
    try {
      const opened = await probe(reader);
      assert.deepEqual(opened.role, { superuser: false, writes: ['INSERT/UPDATE/DELETE on 1 table'], create: false });
      assert.match(opened.warnings[0], /\(INSERT\/UPDATE\/DELETE on 1 table\)/);
    } finally {
      await control.query(`REVOKE INSERT ON public.${table} FROM ${role}`);
    }
  });
});

describe('role reach on MySQL, against a real server', { skip: liveSkip('mysql', MY) }, () => {
  const user = 'tw_privileges_reader';
  type Admin = { query(sql: string): Promise<unknown>; end(): Promise<void> };
  let admin: Admin;
  let reader: string;
  let database: string;

  before(async () => {
    const specifier = 'mysql2/promise';
    const mysql = (await import(specifier)) as { createConnection: (c: Record<string, unknown>) => Promise<Admin> };
    admin = await mysql.createConnection({ uri: MY! });
    database = decodeURIComponent(new URL(MY!).pathname.slice(1));
    await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'reader-only'`);
    await admin.query(`GRANT SELECT ON \`${database}\`.* TO '${user}'@'%'`);
    reader = as(MY!, user, 'reader-only');
  });
  after(async () => {
    try {
      await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    } finally {
      await admin.end();
    }
  });

  test('an account with every privilege is said; SELECT alone says nothing; a write grant is named', async () => {
    const root = await probe(MY!);
    assert.equal(root.role.superuser, true);
    assert.equal(root.warnings.length, 1, root.warnings.join('\n'));
    assert.deepEqual(await probe(reader), { warnings: [], role: { superuser: false, writes: [], create: false } });
    await admin.query(`GRANT INSERT ON \`${database}\`.* TO '${user}'@'%'`);
    const opened = await probe(reader);
    assert.deepEqual(opened.role, { superuser: false, writes: [`INSERT on \`${database}\`.*`], create: false });
    assert.equal(opened.warnings.length, 1);
  });
});
