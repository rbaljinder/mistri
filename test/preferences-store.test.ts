/**
 * The preferences store (adapters/preferences): one row per (subject, scope, key), values are text of a few characters,
 * a null value takes the row away, and a person's rows are never another's or another scope's. SQLite always; the
 * same checks on PostgreSQL where `TABLEWALK_TEST_PG` names a server.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PREFERENCES_LIMITS, PREFERENCES_TABLES, type PreferencesStore } from '../packages/mistri/src/adapters/preferences/preferences.js';
import { openSqlitePreferences, provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';

async function exercise(store: PreferencesStore) {
  const ana = { app: 'clinic', subject: 'account-ana', scope: '' };
  assert.deepEqual(await store.read(ana), {});
  assert.equal(await store.set(ana, 'choose.site', '1'), 1);
  assert.equal(await store.set(ana, 'choose.site', '2'), 2);
  assert.equal(await store.set(ana, 'choose.region', '9'), 1);
  assert.deepEqual(await store.read(ana), { 'choose.site': '2', 'choose.region': '9' });
  // Another person, another scope (a tenant), another App: each their own.
  assert.deepEqual(await store.read({ ...ana, subject: 'account-bo' }), {});
  assert.deepEqual(await store.read({ ...ana, scope: 'tenant-a' }), {});
  assert.deepEqual(await store.read({ ...ana, app: 'other' }), {});
  await store.set({ ...ana, scope: 'tenant-a' }, 'choose.site', '7');
  assert.deepEqual(await store.read(ana), { 'choose.site': '2', 'choose.region': '9' });
  // Null takes the row away, and a row that is not there stays not there.
  await store.set(ana, 'choose.region', null);
  await store.set(ana, 'choose.region', null);
  assert.deepEqual(await store.read(ana), { 'choose.site': '2' });
  // A value past the limit, an empty key and a malformed owner are refused, and nothing is written.
  await assert.rejects(store.set(ana, 'choose.site', 'x'.repeat(PREFERENCES_LIMITS.value + 1)));
  await assert.rejects(store.set(ana, '', '1'));
  await assert.rejects(store.read({ app: '', subject: 'a', scope: '' }));
  assert.deepEqual(await store.read(ana), { 'choose.site': '2' });
}

test('the SQLite preferences store keeps a person’s rows apart and holds its limits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-preferences-'));
  const file = join(directory, 'app.db');
  new DatabaseSync(file).close();
  try {
    assert.deepEqual(provisionSqlitePreferences(file), { version: 1, provisioned: true });
    assert.equal(provisionSqlitePreferences(file).provisioned, false);
    const store = openSqlitePreferences(file);
    try {
      await exercise(store);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opening a database that was never provisioned refuses by name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-preferences-'));
  const file = join(directory, 'app.db');
  new DatabaseSync(file).close();
  try {
    assert.throws(() => openSqlitePreferences(file), /preferences/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the store names its tables with the reserved prefix', () => {
  for (const name of Object.values(PREFERENCES_TABLES)) assert.match(name, /^__mistri_preference_/);
});

const live = process.env.TABLEWALK_TEST_PG;
test('the PostgreSQL preferences store keeps a person’s rows apart and holds its limits', { skip: !live }, async () => {
  // A variable specifier: the driver ships no types the suite relies on (as the other live-PostgreSQL files do).
  const specifier = 'pg';
  const { Client } = (await import(specifier)) as {
    Client: new (options: { connectionString?: string }) => {
      connect(): Promise<void>;
      query(sql: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const { openPostgresPreferences, provisionPostgresPreferences } =
    await import('../packages/mistri/src/adapters/preferences/postgresPreferences.js');
  // Its own database: the store's tables live in a schema of a fixed name, so a shared database would hold a rerun's rows.
  const database = `preferences_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: live });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(live!);
  url.pathname = `/${database}`;
  try {
    assert.equal((await provisionPostgresPreferences(url.toString())).provisioned, true);
    assert.equal((await provisionPostgresPreferences(url.toString())).provisioned, false);
    const store = await openPostgresPreferences(url.toString());
    try {
      await exercise(store);
    } finally {
      await store.close();
    }
  } finally {
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
