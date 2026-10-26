/**
 * A store written by another tablewalk says which way it differs. The attestation compares a
 * whole catalog and can only say "not the layout this version expects"; the version row, read
 * after it has failed, names the store, the version found and the one expected, and what to do:
 * upgrade to open it for a newer store, `mistri migrate stores up` for an older one. The
 * PostgreSQL authentication store's own cases are in postgres-auth-store.test.ts (live).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { layoutRefusal } from '../packages/engine/src/adapters/layoutRefusal.js';
import { BRANDING_TABLES, BRANDING_VERSION } from '../packages/mistri/src/adapters/branding/branding.js';
import { provisionSqliteBranding } from '../packages/mistri/src/adapters/branding/sqliteBranding.js';
import { INBOX_TABLES, INBOX_VERSION } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { RECORD_HISTORY_TABLES, RECORD_HISTORY_VERSION } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';

test('the message names the store, both versions and the way forward, and is silent when the version explains nothing', () => {
  const newer = layoutRefusal('The thing store', 5, 2)!;
  assert.match(newer, /^The thing store is at layout version 5, newer than the version 2 this build expects\./);
  assert.match(newer, /upgrade to open it/);
  assert.doesNotMatch(newer, /migrate stores up/);
  const older = layoutRefusal('The thing store', 1, 2)!;
  assert.match(older, /^The thing store is at layout version 1, older than the version 2 this build expects\./);
  assert.match(older, /Stop the server and run `mistri migrate stores up`/);
  assert.equal(layoutRefusal('The thing store', 2, 2), undefined, 'the expected version is a foreign layout, not a version difference');
  assert.equal(layoutRefusal('The thing store', null, 2), undefined);
  assert.equal(layoutRefusal('The thing store', 'x', 2), undefined);
  assert.equal(layoutRefusal('The thing store', '7', 2)?.includes('version 7'), true, 'PostgreSQL may hand a count back as text');
});

const stores = [
  {
    name: 'branding',
    label: 'The branding store',
    meta: BRANDING_TABLES.meta,
    version: BRANDING_VERSION,
    provision: provisionSqliteBranding,
  },
  {
    name: 'inbox',
    label: 'The notification store',
    meta: INBOX_TABLES.meta,
    version: INBOX_VERSION,
    provision: provisionSqliteInbox,
  },
  {
    name: 'record history',
    label: 'The record history store',
    meta: RECORD_HISTORY_TABLES.meta,
    version: RECORD_HISTORY_VERSION,
    provision: provisionSqliteRecordHistory,
  },
];

for (const store of stores) {
  test(`${store.name} on SQLite: a newer and an older layout each say so at open`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-layout-'));
    try {
      const path = join(dir, 'app.db');
      new DatabaseSync(path).close();
      store.provision(path);
      const setVersion = (version: number) => {
        const db = new DatabaseSync(path);
        // The table's own CHECK pins the version it was made for; a store of another version has another CHECK.
        db.exec(`PRAGMA ignore_check_constraints = ON; UPDATE "${store.meta}" SET version = ${version}`);
        db.close();
      };
      setVersion(store.version + 1);
      assert.throws(
        () => store.provision(path),
        (error: Error) =>
          error.message.startsWith(`${store.label} is at layout version ${store.version + 1}, newer than the version ${store.version}`) &&
          /upgrade to open it/.test(error.message),
      );
      setVersion(store.version - 1);
      assert.throws(
        () => store.provision(path),
        (error: Error) =>
          error.message.startsWith(`${store.label} is at layout version ${store.version - 1}, older than the version ${store.version}`) &&
          /mistri migrate stores up/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
