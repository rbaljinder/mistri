/**
 * The tenant branding store, on SQLite in a file this test owns and (when
 * TABLEWALK_TEST_PG names a server) on a PostgreSQL database this run owns:
 * provisioned once and only by maintenance, a save's revision, a logo read by
 * hash, the logo a later save no longer names removed with it, and the bounds.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import {
  BRANDING_LIMITS,
  BRANDING_TABLES,
  BRANDING_VERSION,
  BrandingUnavailable,
  type BrandingWrite,
} from '../packages/mistri/src/adapters/branding/branding.js';
import {
  provisionSqliteBranding,
  readSqliteBranding,
  readSqliteBrandingLogo,
} from '../packages/mistri/src/adapters/branding/sqliteBranding.js';
import {
  provisionPostgresBranding,
  readPostgresBranding,
  readPostgresBrandingLogo,
} from '../packages/mistri/src/adapters/branding/postgresBranding.js';
import { bindTenantBrandingStore } from '../packages/mistri/src/server/tenant/tenantBrandingStore.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const png = (seed: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2]);
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const save = (tenant: string, over: Partial<BrandingWrite> = {}): BrandingWrite => ({
  app: 'crm',
  tenant,
  value: '{"accent":"#336699"}',
  logoHash: null,
  by: 'ann',
  at: '2026-10-06T10:00:00.000Z',
  ...over,
});
const withLogo = (tenant: string, bytes: Uint8Array, over: Partial<BrandingWrite> = {}): BrandingWrite => {
  const hash = hashOf(bytes);
  return save(tenant, {
    logoHash: hash,
    logo: { hash, type: 'image/png', bytes },
    ...over,
  });
};

interface Engine {
  ready(): Promise<boolean>;
  provision(): Promise<{ version: number; provisioned: boolean }>;
  write(write: BrandingWrite): Promise<number>;
  read(
    app: string,
    tenant: string,
  ): Promise<{
    value: string;
    revision: number;
    by: string;
    at: string;
  } | null>;
  logo(app: string, hash: string): Promise<{ type: string; bytes: Uint8Array } | null>;
  foreign(): Promise<void>;
  rows(table: 'logo'): Promise<number>;
}

/** The same assertions on every engine; `fresh` hands each a store-free database. */
async function exercise(engine: Engine) {
  assert.equal(await engine.ready(), false);
  assert.deepEqual(await engine.provision(), {
    version: BRANDING_VERSION,
    provisioned: true,
  });
  assert.deepEqual(await engine.provision(), {
    version: BRANDING_VERSION,
    provisioned: false,
  });
  assert.equal(await engine.ready(), true);

  assert.equal(await engine.read('crm', 'acme'), null);
  assert.equal(await engine.write(save('acme')), 1);
  assert.equal(
    await engine.write(
      save('acme', {
        value: '{"accent":"#aa0000"}',
        by: 'bob',
        at: '2026-10-06T11:00:00.000Z',
      }),
    ),
    2,
  );
  assert.deepEqual(await engine.read('crm', 'acme'), {
    value: '{"accent":"#aa0000"}',
    revision: 2,
    by: 'bob',
    at: '2026-10-06T11:00:00.000Z',
  });
  assert.equal(await engine.read('crm', 'globex'), null);
  assert.equal(await engine.read('other', 'acme'), null);

  const first = png(1);
  const second = png(9);
  assert.equal(await engine.write(withLogo('acme', first)), 3);
  const stored = await engine.logo('crm', hashOf(first));
  assert.equal(stored?.type, 'image/png');
  assert.deepEqual([...stored!.bytes], [...first]);
  // A second tenant naming the same logo keeps it through the first's change.
  assert.equal(await engine.write(withLogo('globex', first)), 1);
  assert.equal(await engine.write(withLogo('acme', second)), 4);
  assert.ok(await engine.logo('crm', hashOf(first)));
  assert.ok(await engine.logo('crm', hashOf(second)));
  assert.equal(await engine.write(save('globex')), 2);
  assert.equal(await engine.logo('crm', hashOf(first)), null);
  assert.equal(await engine.rows('logo'), 1);

  // A value naming a logo nobody stored is refused, and nothing of it is kept.
  await assert.rejects(engine.write(save('acme', { logoHash: hashOf(png(40)) })), /not stored/);
  assert.equal((await engine.read('crm', 'acme'))?.revision, 4);

  await assert.rejects(engine.write(save('acme', { value: 'x'.repeat(BRANDING_LIMITS.value + 1) })), /value is not valid/);
  await assert.rejects(engine.write(save('acme', { logoHash: 'ABC' })), /logo hash is not valid/);
  await assert.rejects(engine.write(save('bad tenant!')), /tenant is not valid/);
  await assert.rejects(engine.write(save('acme', { value: 'not json' })), /not JSON/);
  assert.equal((await engine.read('crm', 'acme'))?.revision, 4);

  // A dark logo is stored beside the logo and named in the value alone (no column of its own): it is kept for as long
  // as a value names it, collected when none does, and one the value names but nobody stored is refused.
  const dark = png(20);
  const darkValue = (bytes: Uint8Array) => JSON.stringify({ logoDark: { hash: hashOf(bytes), type: 'image/png' } });
  assert.equal(
    await engine.write(
      withLogo('acme', second, { value: darkValue(dark), darkLogo: { hash: hashOf(dark), type: 'image/png', bytes: dark } }),
    ),
    5,
  );
  assert.deepEqual([...(await engine.logo('crm', hashOf(dark)))!.bytes], [...dark]);
  assert.equal(await engine.rows('logo'), 2);
  assert.equal(await engine.write(withLogo('acme', second, { value: darkValue(dark) })), 6, 'kept while the value names it');
  assert.ok(await engine.logo('crm', hashOf(dark)));
  await assert.rejects(engine.write(withLogo('acme', second, { value: darkValue(png(50)) })), /dark logo the value names is not stored/);
  assert.equal(await engine.write(withLogo('acme', second)), 7);
  assert.equal(await engine.logo('crm', hashOf(dark)), null, 'collected once no value names it');
  assert.equal(await engine.rows('logo'), 1);

  await engine.foreign();
}

test('SQLite branding: provisioned by maintenance, saved with a revision, logos by hash and collected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branding-store-'));
  const path = join(dir, 'app.db');
  new DatabaseSync(path).close();
  const adapter = new SqliteAdapter(path);
  const db = new DatabaseSync(path);
  try {
    await exercise({
      ready: () => appStoresOf(adapter).brandingReady(),
      provision: async () => provisionSqliteBranding(path),
      write: (write) => appStoresOf(adapter).writeBranding(write),
      read: async (app, tenant) => readSqliteBranding(db, { app, tenant }),
      logo: async (app, hash) => readSqliteBrandingLogo(db, { app, hash }),
      rows: async () => Number((db.prepare(`SELECT count(*) AS n FROM "${BRANDING_TABLES.logo}"`).get() as { n: number }).n),
      foreign: async () => {
        const other = join(dir, 'foreign.db');
        const foreign = new DatabaseSync(other);
        foreign.exec(`CREATE TABLE "${BRANDING_TABLES.value}" (app TEXT)`);
        foreign.close();
        assert.throws(() => provisionSqliteBranding(other), BrandingUnavailable);
        const again = new DatabaseSync(other);
        const tables = again.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all();
        again.close();
        assert.deepEqual(
          tables.map((row) => row.name),
          [BRANDING_TABLES.value],
        );
        assert.equal(await appStoresOf(new SqliteAdapter(other)).brandingReady(), false);
      },
    });
  } finally {
    db.close();
    await adapter.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup refuses a tenant App that declares branding when its database holds no store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branding-bind-'));
  const path = join(dir, 'app.db');
  new DatabaseSync(path).close();
  const adapter = new SqliteAdapter(path);
  try {
    await assert.rejects(bindTenantBrandingStore(adapter, 'sqlite'), /provisionStores\(\{ sqlite: path \}, \{ only: \['branding'\] \}\)/);
    provisionSqliteBranding(path);
    await bindTenantBrandingStore(adapter, 'sqlite');
  } finally {
    await adapter.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL branding: the same store, attested and written in one transaction', { skip: liveSkip('postgres', LIVE_PG) }, async () => {
  const url = await ownedPostgresDatabase();
  const control = await pgControl(url);
  const adapter = new PostgresAdapter(url, 'branding');
  try {
    await control.query(
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', BRANDING_TABLES.logo)}, ${runtimeTable('postgres', BRANDING_TABLES.value)}, ${runtimeTable('postgres', BRANDING_TABLES.meta)}`,
    );
    await exercise({
      ready: () => appStoresOf(adapter).brandingReady(),
      provision: () => provisionPostgresBranding(url),
      write: (write) => appStoresOf(adapter).writeBranding(write),
      read: (app, tenant) => readPostgresBranding(control, { app, tenant }),
      logo: (app, hash) => readPostgresBrandingLogo(control, { app, hash }),
      rows: async () =>
        Number((await control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', BRANDING_TABLES.logo)}`)).rows[0].n),
      foreign: async () => {
        await control.query(`DROP TABLE ${runtimeTable('postgres', BRANDING_TABLES.logo)}`);
        await assert.rejects(provisionPostgresBranding(url), BrandingUnavailable);
        assert.equal(await appStoresOf(adapter).brandingReady(), false);
      },
    });
  } finally {
    await control.query(
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', BRANDING_TABLES.logo)}, ${runtimeTable('postgres', BRANDING_TABLES.value)}, ${runtimeTable('postgres', BRANDING_TABLES.meta)}`,
    );
    await control.end();
    await adapter.close?.();
  }
});
