/** Isolated in-memory DDL only; no auth provisioning or bearer admission. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  SQLITE_API_TOKEN_CATALOG,
  SQLITE_API_TOKEN_DDL,
  SQLITE_API_TOKEN_TABLES,
} from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { decodeApiTokenSqlRow, encodeApiTokenSqlRow } from '../packages/mistri/src/server/api/apiTokenStorageContract.js';
import { assertApiTokenAppId } from '../packages/mistri/src/server/api/apiTokenSecret.js';
const id = '36c77f92-cf69-412d-ade3-3971490fb83a';
const token = () => ({
  format: 'twa1',
  digest: 'ab'.repeat(32),
  version: '9007199254740993',
  record: {
    id,
    appId: 'app',
    subject: { kind: 'account', id: 'account' },
    label: 'Automation',
    roles: ['reader'],
    createdAt: 100,
    createdBy: 'operator',
    expiresAt: 8640000000000000,
  },
});
function fixture(work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const ddl of SQLITE_API_TOKEN_DDL) db.exec(ddl);
    work(db);
  } finally {
    db.close();
  }
}
function insert(db: DatabaseSync, row: Record<string, string | number | null>) {
  db.prepare(
    `INSERT INTO "${SQLITE_API_TOKEN_TABLES.token}" (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map(() => '?')
      .join(',')})`,
  ).run(...Object.values(row));
}
test('fixed token extension DDL matches its exact native catalog and has no foreign keys', () =>
  fixture((db) => {
    const actual = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY').all();
    assert.deepEqual(
      actual.map((row) => ({ ...row })),
      SQLITE_API_TOKEN_CATALOG,
    );
    assert.equal(db.prepare(`PRAGMA foreign_key_list('${SQLITE_API_TOKEN_TABLES.token}')`).all().length, 0);
    assert.ok(Object.isFrozen(SQLITE_API_TOKEN_DDL));
    assert.ok(Object.isFrozen(SQLITE_API_TOKEN_CATALOG));
  }));
test('SQL extension roundtrips exact codec values, UUID metadata and NULL versus empty operations', () =>
  fixture((db) => {
    db.prepare(`INSERT INTO "${SQLITE_API_TOKEN_TABLES.meta}" VALUES(1,1,?,?,?)`).run('é'.repeat(128), id, 'twa1');
    for (const operations of [undefined, []]) {
      const value = token(),
        row = encodeApiTokenSqlRow({
          ...value,
          record: { ...value.record, label: '😀'.repeat(128), ...(operations === undefined ? {} : { operations }) },
        });
      insert(db, row);
      assert.deepEqual(
        decodeApiTokenSqlRow(db.prepare(`SELECT * FROM "${SQLITE_API_TOKEN_TABLES.token}"`).get()),
        decodeApiTokenSqlRow(row),
      );
      db.exec(`DELETE FROM "${SQLITE_API_TOKEN_TABLES.token}"`);
    }
  }));
test('physical scalar constraints refuse malformed UUID/revision/digest/time/null pair and scope arrays', () =>
  fixture((db) => {
    const row = encodeApiTokenSqlRow(token());
    for (const change of [
      { token_id: id.toUpperCase() },
      { token_id: id.replace('-4', '-5') },
      { version: '01' },
      { version: '1\n' },
      { version: '9'.repeat(129) },
      { digest: 'AB'.repeat(32) },
      { format: 'twa2' },
      { subject_kind: 'other' },
      { subject_kind: 'service', subject_id: 'Invalid' },
      { expires_at: 8640000000000001 },
      { created_at: 100.5 },
      { expires_at: 100 },
      { revoked_at: 200 },
      { revoked_by: 'operator' },
      { last_used_at: 99 },
      { roles_json: '[]' },
      { roles_json: '{}' },
      { operations_json: 'null' },
      { app_id: 'é'.repeat(129) },
    ]) {
      assert.throws(() => insert(db, { ...row, ...change }));
    }
    // Duplicate entries are deliberately codec validation, not new SQL authority.
    insert(db, { ...row, roles_json: '["reader","reader"]' });
    assert.throws(() => decodeApiTokenSqlRow(db.prepare(`SELECT * FROM "${SQLITE_API_TOKEN_TABLES.token}"`).get()));
  }));
test('App metadata SQL trim/control and UTF8 limits match the private credential validator', () =>
  fixture((db) => {
    const sql = db.prepare(`INSERT INTO "${SQLITE_API_TOKEN_TABLES.meta}" VALUES(1,1,?,?,?)`);
    for (const value of ['app', 'é'.repeat(128), '😀'.repeat(64), 'a\u200bb']) {
      assert.doesNotThrow(() => assertApiTokenAppId(value));
      sql.run(value, id, 'twa1');
      db.exec(`DELETE FROM "${SQLITE_API_TOKEN_TABLES.meta}"`);
    }
    for (const value of [
      '',
      ' app',
      'app\u00a0',
      '\ufeffapp',
      'app\u3000',
      'a\u0000b',
      'a\u001fb',
      'a\u007fb',
      'a\u009fb',
      'é'.repeat(129),
    ]) {
      assert.throws(() => assertApiTokenAppId(value));
      assert.throws(() => sql.run(value, id, 'twa1'));
    }
  }));
test('the OAuth rows (v3) refuse a malformed client, an empty grant, a code or refresh token out of order', () =>
  fixture((db) => {
    db.exec('PRAGMA foreign_keys = ON');
    const t = SQLITE_API_TOKEN_TABLES;
    const run = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values);
    const client = 'twc1.36c77f92-cf69-412d-ade3-3971490fb83b',
      grant = '36c77f92-cf69-412d-ade3-3971490fb83c';
    const addClient = (id: string, uris = '["https://a.example/cb"]', created = 100, consented: number | null = null) =>
      run(
        `INSERT INTO "${t.client}" (client_id, name, redirect_uris_json, created_at, consented_at) VALUES (?, NULL, ?, ?, ?)`,
        id,
        uris,
        created,
        consented,
      );
    for (const [bad, uris, consented] of [
      ['twc1.' + client.slice(5).toUpperCase(), undefined, null],
      ['twc2' + client.slice(4), undefined, null],
      [client, '[]', null],
      [client, JSON.stringify(Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`)), null],
      [client, '"https://a.example/cb"', null],
      [client, undefined, 99],
    ] as const) {
      assert.throws(() => addClient(bad, uris, 100, consented), String(bad) + String(uris));
    }
    addClient(client);
    const addGrant = (change: Record<string, string | number | null> = {}) => {
      const row = {
        grant_id: grant,
        client_id: client,
        subject: 'account',
        app_id: 'app',
        version: 1,
        roles_json: '["reader"]',
        created_at: 100,
        expires_at: 200,
        ...change,
      };
      run(
        `INSERT INTO "${t.grant}" (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`,
        ...Object.values(row),
      );
    };
    for (const change of [
      { roles_json: '[]' },
      { expires_at: 100 },
      { revoked_at: 99 },
      { version: 0 },
      { client_id: 'twc1.36c77f92-cf69-412d-ade3-3971490fb83f' },
      { tenant_id: 'acme' },
    ] as Record<string, string | number | null>[]) {
      assert.throws(() => addGrant(change), JSON.stringify(change));
    }
    addGrant();
    const code = (change: Record<string, string | number | null> = {}) => {
      const row = {
        code_digest: 'cd'.repeat(32),
        client_id: client,
        subject: 'account',
        redirect_uri: 'https://a.example/cb',
        challenge: 'a'.repeat(43),
        app_id: 'app',
        version: 1,
        roles_json: '["reader"]',
        expires_at: 160,
        ...change,
      };
      run(
        `INSERT INTO "${t.code}" (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`,
        ...Object.values(row),
      );
    };
    // A code names its grant only once it is used; a challenge is a SHA-256 in base64url.
    const codes: Record<string, string | number | null>[] = [
      { grant_id: grant },
      { challenge: 'a'.repeat(42) },
      { challenge: `${'a'.repeat(42)}=` },
      { code_digest: 'CD'.repeat(32) },
    ];
    for (const change of codes) {
      assert.throws(() => code(change), JSON.stringify(change));
    }
    code({ grant_id: grant, used_at: 150 });
    assert.throws(() =>
      run(`INSERT INTO "${t.refresh}" (digest, grant_id, issued_at, used_at) VALUES (?, ?, 150, 149)`, 'ef'.repeat(32), grant),
    );
    run(`INSERT INTO "${t.refresh}" (digest, grant_id, issued_at, used_at) VALUES (?, ?, 150, NULL)`, 'ef'.repeat(32), grant);
    // An access row is an issued token's, and goes with it.
    assert.throws(() => run(`INSERT INTO "${t.access}" (token_id, grant_id, app_id, version) VALUES (?, ?, 'app', 1)`, id, grant));
    insert(db, encodeApiTokenSqlRow(token()));
    run(`INSERT INTO "${t.access}" (token_id, grant_id, app_id, version) VALUES (?, ?, 'app', 1)`, id, grant);
    run(`DELETE FROM "${t.token}" WHERE token_id = ?`, id);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${t.access}"`).get()!.n, 0);
  }));
