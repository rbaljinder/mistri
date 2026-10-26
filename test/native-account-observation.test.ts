import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import {
  readSqliteEligibleAccountRoles,
  readPostgresEligibleAccountRoles,
} from '../packages/mistri/src/server/auth/nativeAccountObservation.js';

test('private readers perform only one exact native observation with no default roles', async () => {
  for (const sqlite of [true, false]) {
    let calls = 0;
    let row: Record<string, unknown> | undefined = {
      id: 'native',
      role: 'reader, admin, reader',
      banned: null,
      banExpires: null,
      roleNul: 0,
      banExpiresNul: null,
    };
    const db = {
      prepare(sql: string) {
        assert.match(sql, /^SELECT id, role,/);
        return {
          get(id: string) {
            calls++;
            assert.equal(id, 'native');
            return row;
          },
        };
      },
    } as unknown as Pick<DatabaseSync, 'prepare'>;
    const pg = {
      async query(sql: string, args: unknown[]) {
        assert.match(sql, /^SELECT id, role,/);
        assert.deepEqual(args, ['native']);
        calls++;
        return { rows: row ? [row] : [] };
      },
    } as unknown as PgQuery;
    const read = () => (sqlite ? readSqliteEligibleAccountRoles(db, 'native') : readPostgresEligibleAccountRoles(pg, 'native'));
    const first = await read();
    assert.deepEqual({ ...first }, { accountId: 'native', roles: ['admin', 'reader'] });
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first!.roles));
    row.role = null;
    assert.deepEqual({ ...(await read()) }, { accountId: 'native', roles: [] });
    assert.deepEqual(first!.roles, ['admin', 'reader']);
    row = undefined;
    assert.equal(await read(), null);
    assert.equal(calls, 3);
  }
});

test('readers retain native expiry differences and strict expiry boundary', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const row: Record<string, unknown> = { id: 'native', role: null, banned: 0, banExpires: 'invalid', roleNul: 0, banExpiresNul: 0 };
  const db = { prepare: () => ({ get: () => row }) } as unknown as Pick<DatabaseSync, 'prepare'>;
  const pg = { query: async () => ({ rows: [row] }) } as unknown as PgQuery;
  assert.throws(() => readSqliteEligibleAccountRoles(db, 'native'));
  row.banned = false;
  assert.deepEqual({ ...(await readPostgresEligibleAccountRoles(pg, 'native')) }, { accountId: 'native', roles: [] });
  for (const expiry of [null, 1000, 999]) {
    row.banned = true;
    row.banExpires = expiry;
    assert.equal((await readPostgresEligibleAccountRoles(pg, 'native')) !== null, expiry === 999);
    row.banned = 1;
    row.banExpires = expiry === null ? null : new Date(expiry).toISOString();
    assert.equal(readSqliteEligibleAccountRoles(db, 'native') !== null, expiry === 999);
  }
});

test('invalid exact native IDs refuse before touching either supplied handle', async () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('must not read');
  };
  const db = { prepare: trap } as unknown as Pick<DatabaseSync, 'prepare'>;
  const pg = { query: trap } as unknown as PgQuery;
  for (const id of ['', ' padded ', '\ud800', 'x'.repeat(1025)]) {
    assert.throws(() => readSqliteEligibleAccountRoles(db, id));
    await assert.rejects(readPostgresEligibleAccountRoles(pg, id));
  }
  assert.equal(calls, 0);
});
