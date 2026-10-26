/**
 * The identity plugin's tables are tablewalk's own declarations
 * (packages/mistri/src/server/auth/identityStore.ts), and the SCIM ones must stay exactly
 * @better-auth/scim 1.7.10's: field for field, and in the DDL Better Auth's
 * schema merge makes of them. A plugin release that moved its schema would
 * fail here instead of moving the store's layout.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { accountAuditPlugin } from '../packages/mistri/src/server/auth/accountAudit.js';
import { IDP_SESSION_MODEL, SCIM_DIRECTORY_SCHEMA, identityStorePlugin } from '../packages/mistri/src/server/auth/identityStore.js';

const require = createRequire(import.meta.url);
const scimPlugin = async () => {
  const { scim } = await import('@better-auth/scim');
  return scim({ connections: [{ id: 'directory', credentials: [{ type: 'bearer', id: 'directory-0', token: 'x'.repeat(40) }] }] } as never);
};

const planned = async (plugins: unknown[]) => {
  const { admin } = await import('better-auth/plugins');
  const { getMigrations } = await import('better-auth/db/migration');
  const migrations = await getMigrations({
    database: new DatabaseSync(':memory:'),
    emailAndPassword: { enabled: true },
    plugins: [admin({ defaultRole: 'user' }), accountAuditPlugin(), ...plugins],
    secret: 'x'.repeat(40),
    baseURL: 'http://127.0.0.1:1',
    telemetry: { enabled: false },
  } as never);
  return migrations.compileMigrations();
};

test('the SCIM tables are @better-auth/scim 1.7.10 schema, field for field', async () => {
  const { version } = JSON.parse(readFileSync(join(dirname(require.resolve('@better-auth/scim')), '..', 'package.json'), 'utf8'));
  assert.equal(version, '1.7.10', 'a new @better-auth/scim is a new auth store layout: review its schema first');
  const exported = JSON.parse(JSON.stringify((await scimPlugin()).schema));
  assert.deepEqual(JSON.parse(JSON.stringify(SCIM_DIRECTORY_SCHEMA)), exported);
  assert.deepEqual(Object.keys(SCIM_DIRECTORY_SCHEMA), Object.keys(exported), 'in its order, which is the order Better Auth creates them');
  for (const [table, { fields }] of Object.entries(SCIM_DIRECTORY_SCHEMA))
    assert.deepEqual(Object.keys(fields), Object.keys(exported[table].fields), `${table}: its columns, in order`);
});

test("Better Auth's merge makes the same DDL with the SCIM plugin's own schema", async () => {
  const ours = await planned([identityStorePlugin()]);
  assert.match(ours, /create table "idpSession"/);
  assert.match(ours, /create table "scimUser"/);
  // The SCIM plugin loaded beside ours (as a directory will be) declares nothing new.
  assert.equal(await planned([identityStorePlugin(), await scimPlugin()]), ours);
  // And our session index beside the plugin's own SCIM tables is the same layout.
  const sessionOnly = { id: 'session-index', schema: { [IDP_SESSION_MODEL]: identityStorePlugin().schema[IDP_SESSION_MODEL] } };
  assert.equal(await planned([sessionOnly, await scimPlugin()]), ours);
});

test('the store declares no single sign-on provider table', () => {
  assert.equal(Object.keys(identityStorePlugin().schema).includes('ssoProvider'), false);
});
