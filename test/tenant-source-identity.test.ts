import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource, type TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  assertTenantSourcePair,
  getTenantSourceIdentity,
  registerTenantSourceIdentity,
  type TenantSourceIdentity,
} from '../packages/mistri/src/server/tenant/tenantSourceIdentity.js';
import { provisionSqliteTenantStore, TENANT_TABLES, type TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource, type TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';

const binding: TenantStoreBinding = {
  appId: 'identity-app',
  source: { id: 'business', connection: 'private-connection' },
  storeId: 'private-store',
};
const plain = <T>(value: T): T => structuredClone(value);
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  assert.equal(JSON.stringify(error).includes('private-'), false);
  return true;
}
async function fixture(t: TestContext, owner = plain(binding)) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-identity-'));
  const path = join(directory, 'source.db'),
    db = new DatabaseSync(path);
  const sources: Array<TenantReadSource | TenantWriteSource> = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, alternate_owner TEXT NOT NULL);
    CREATE TABLE other (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, alternate_owner TEXT NOT NULL);`);
  provisionSqliteTenantStore(path, owner);
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: mapScopeCatalog(physicalSchema, new Map([['item', 'record']])),
    resources: { record: 'item' },
    ownership: { record: { kind: 'tenant', column: 'tenant_id' } },
  });
  const read = (file = path, owned = ownership, store = owner) => {
    const source = openSqliteTenantReadSource(file, owned, store, () => 100);
    sources.push(source);
    return source;
  };
  const write = async (file = path, owned = ownership, store = owner) => {
    const source = await openSqliteTenantWriteSource(file, owned, store, () => 100);
    sources.push(source);
    return source;
  };
  return { directory, path, db, owner, ownership, read, write };
}

test('genuine same-file read/write pair returns captured immutable namespace without adding public methods', async (t) => {
  const f = await fixture(t),
    read = f.read(),
    write = await f.write();
  const identity = assertTenantSourcePair(read, write);
  assert.equal(identity, getTenantSourceIdentity(read));
  assert.deepEqual(plain(identity), { ...binding, canonicalPath: realpathSync(f.path) });
  assert.deepEqual(plain(getTenantSourceIdentity(write)), plain(identity));
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.source));
  assert.equal(Reflect.set(identity, 'storeId', 'other'), false);
  assert.equal(Reflect.set(identity.source, 'connection', 'other'), false);
  /* `assertSupportCurrent`/`scopeSupportReads` (0.5.0): a support session's
     twins of the member and platform pairs — fenced on the support row, reading
     the dealer's own scope. `assertPublicCurrent`/`bindPublicReads`/`resolvePublic`
     (1.0): a visitor's, placed by a tenant's public address and fenced on it.
     `readSandboxClocks`/`readSandboxes` (G47): which tenants are sandboxes, for the
     timer sweep's dev clock and discovery's mark. */
  assert.deepEqual(Object.keys(read).sort(), [
    'assertCurrent',
    'assertPlatformCurrent',
    'assertPublicCurrent',
    'assertSupportCurrent',
    'bindPlatformReads',
    'bindPublicReads',
    'bindReads',
    'close',
    'ownership',
    'readActiveTenants',
    'readBranding',
    'readBrandingLogo',
    'readDueTimers',
    'readEmailOff',
    'readInbox',
    'readMembership',
    'readMemberships',
    'readPlatformMembership',
    'readRecordActivity',
    'readRecordHistory',
    'readSandboxClocks',
    'readSandboxes',
    'readServiceAnchors',
    'readTenantAddresses',
    'readTenantNames',
    'resolveIntake',
    'resolvePublic',
    'scopePlatformReads',
    'scopeReads',
    'scopeSupportReads',
    'together',
    'withPlatformReads',
    'withReads',
  ]);
  assert.deepEqual(Object.keys(write).sort(), [
    'close',
    'commandTransaction',
    'inboxMail',
    'intakeCommandTransaction',
    'markInboxRead',
    'ownership',
    'platformCommandTransaction',
    'platformTenantCommandTransaction',
    'platformTransaction',
    'serviceCommandTransaction',
    'supportCommandTransaction',
    'supportTransaction',
    'transaction',
    'writeBranding',
  ]);
  Reflect.set(f.owner, 'storeId', 'changed');
  Reflect.set(f.owner.source, 'connection', 'changed');
  assert.deepEqual(plain(assertTenantSourcePair(read, write)), { ...binding, canonicalPath: realpathSync(f.path) });
});

test('existing relative and symlink aliases resolve to the same canonical file', async (t) => {
  const f = await fixture(t),
    alias = join(f.directory, 'alias.db');
  symlinkSync(f.path, alias);
  const read = f.read(relative(process.cwd(), alias));
  const write = await f.write(f.path);
  assert.equal(assertTenantSourcePair(read, write).canonicalPath, realpathSync(f.path));
  assert.equal(assertTenantSourcePair(f.read(), await f.write(alias)).canonicalPath, realpathSync(f.path));
});

test('identical app/source labels do not pair distinct store namespaces', async (t) => {
  const a = await fixture(t),
    b = await fixture(t, { ...binding, storeId: 'other-store' });
  assert.throws(() => assertTenantSourcePair(a.read(), undefined as unknown as TenantWriteSource), safe);
  const write = await b.write();
  assert.throws(() => assertTenantSourcePair(a.read(), write), safe);
});

test('copied database with identical durable namespace and ownership is still a different source', async (t) => {
  const f = await fixture(t),
    copy = join(f.directory, 'copy.db');
  copyFileSync(f.path, copy);
  const read = f.read(),
    write = await f.write(copy);
  assert.equal(getTenantSourceIdentity(read).storeId, getTenantSourceIdentity(write).storeId);
  assert.notEqual(getTenantSourceIdentity(read).canonicalPath, getTenantSourceIdentity(write).canonicalPath);
  assert.throws(() => assertTenantSourcePair(read, write), safe);
});

test('retargeting the opening symlink cannot rebind previously captured identity', async (t) => {
  const f = await fixture(t),
    copy = join(f.directory, 'copy.db'),
    alias = join(f.directory, 'alias.db');
  copyFileSync(f.path, copy);
  symlinkSync(f.path, alias);
  const read = f.read(alias);
  unlinkSync(alias);
  symlinkSync(copy, alias);
  const write = await f.write(alias);
  assert.equal(getTenantSourceIdentity(read).canonicalPath, realpathSync(f.path));
  assert.throws(() => assertTenantSourcePair(read, write), safe);
});

for (const field of ['storeId', 'appId', 'sourceId', 'connection'] as const) {
  test(`same canonical file cannot hide a changed exact ${field}`, async (t) => {
    const f = await fixture(t),
      read = f.read(),
      owner = plain(binding);
    if (field === 'connection') Reflect.set(owner.source, 'connection', 'Private-connection');
    else if (field === 'sourceId') {
      Reflect.set(owner.source, 'id', 'Business');
      f.db.prepare(`UPDATE "${TENANT_TABLES.meta}" SET source_id = ?`).run(owner.source.id);
    } else {
      Reflect.set(owner, field, field === 'storeId' ? 'Private-store' : 'Identity-app');
      f.db.prepare(`UPDATE "${TENANT_TABLES.meta}" SET ${field === 'storeId' ? 'store_id' : 'app_id'} = ?`).run(owner[field]);
    }
    const ownership = captureTenantOwnership({ ...f.ownership, appId: owner.appId, source: owner.source });
    const write = await f.write(f.path, ownership, owner);
    assert.equal(getTenantSourceIdentity(read).canonicalPath, getTenantSourceIdentity(write).canonicalPath);
    assert.throws(() => assertTenantSourcePair(read, write), safe);
  });
}

for (const change of ['mapping', 'owner-column', 'logical-id'] as const) {
  test(`pair refuses independently valid but incompatible ownership: ${change}`, async (t) => {
    const f = await fixture(t),
      read = f.read();
    let owned: TenantOwnershipSnapshot;
    if (change === 'owner-column')
      owned = captureTenantOwnership({ ...f.ownership, ownership: { record: { kind: 'tenant', column: 'alternate_owner' } } });
    else {
      const logical = change === 'logical-id' ? 'renamed' : 'record',
        physical = change === 'mapping' ? 'other' : 'item';
      owned = captureTenantOwnership({
        ...f.ownership,
        schema: mapScopeCatalog(f.ownership.physicalSchema, new Map([[physical, logical]])),
        resources: { [logical]: physical },
        ownership: { [logical]: { kind: 'tenant', column: 'tenant_id' } },
      });
    }
    const write = await f.write(f.path, owned);
    assert.throws(() => assertTenantSourcePair(read, write), safe);
  });
}

test('ownership presentation/order differences remain compatible', async (t) => {
  const f = await fixture(t),
    read = f.read();
  const owned = captureTenantOwnership({
    ...f.ownership,
    schema: {
      ...f.ownership.schema,
      tables: f.ownership.schema.tables.map((table) => ({ ...table, name: 'Display title', columns: [...table.columns].reverse() })),
    },
    physicalSchema: {
      ...f.ownership.physicalSchema,
      tables: [...f.ownership.physicalSchema.tables].reverse().map((table) => ({ ...table, schema: 'main' })),
    },
  });
  assert.ok(assertTenantSourcePair(read, await f.write(f.path, owned)));
});

test('wrong source roles refuse even though both arguments are genuine', async (t) => {
  const f = await fixture(t),
    read = f.read(),
    write = await f.write();
  for (const [a, b] of [
    [write, read],
    [read, read],
    [write, write],
  ]) {
    assert.throws(() => assertTenantSourcePair(a as TenantReadSource, b as TenantWriteSource), safe);
  }
});

test('forged objects, getters, wrappers and revoked proxies cannot inspect or mint identity', async (t) => {
  const f = await fixture(t),
    read = f.read(),
    write = await f.write();
  let traps = 0;
  const hostile = {
    get ownership() {
      traps++;
      throw new Error('private-getter');
    },
  };
  const proxy = new Proxy(read, {
    get() {
      traps++;
      throw new Error('private-proxy');
    },
    getPrototypeOf() {
      traps++;
      throw new Error('private-proxy');
    },
    ownKeys() {
      traps++;
      return [];
    },
  });
  const revoked = Proxy.revocable(write, {});
  revoked.revoke();
  const metadata = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error('private-metadata');
      },
    },
  ) as TenantSourceIdentity;
  for (const candidate of [
    null,
    undefined,
    1,
    'source',
    {},
    { ...read },
    { ...write },
    Object.create(read),
    hostile,
    proxy,
    revoked.proxy,
  ]) {
    const fake = candidate as TenantReadSource;
    assert.throws(() => getTenantSourceIdentity(fake), safe);
    assert.throws(() => assertTenantSourcePair(fake, write), safe);
    assert.throws(() => assertTenantSourcePair(read, candidate as TenantWriteSource), safe);
    assert.throws(() => registerTenantSourceIdentity(fake, metadata), safe);
  }
  assert.equal(traps, 0);
  assert.ok(assertTenantSourcePair(read, write));
});

test('one-shot factory registration cannot replace genuine identity, even with forged metadata', async (t) => {
  const f = await fixture(t),
    read = f.read(),
    write = await f.write(),
    original = getTenantSourceIdentity(read);
  let calls = 0;
  const getter = {
    get canonicalPath() {
      calls++;
      return f.path;
    },
  } as TenantSourceIdentity;
  for (const source of [read, write])
    for (const input of [original, { ...original, storeId: 'other' }, getter]) {
      assert.throws(() => registerTenantSourceIdentity(source, input), safe);
    }
  assert.equal(calls, 0);
  assert.equal(assertTenantSourcePair(read, write), original);
});

test('hostile factory binding metadata never executes getters or proxies', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const getter = {
    ...binding,
    get storeId() {
      calls++;
      return 'private-store';
    },
  };
  const proxy = new Proxy(binding, {
    ownKeys() {
      calls++;
      return [];
    },
  });
  for (const store of [getter, proxy]) {
    assert.throws(() => f.read(f.path, f.ownership, store));
    await assert.rejects(f.write(f.path, f.ownership, store));
  }
  assert.equal(calls, 0);
});

test('identity is descriptive after close, and does not revive closed authority', async (t) => {
  const f = await fixture(t),
    read = f.read(),
    write = await f.write(),
    identity = assertTenantSourcePair(read, write);
  await Promise.all([read.close(), write.close()]);
  assert.equal(assertTenantSourcePair(read, write), identity);
  await assert.rejects(read.assertCurrent(undefined!));
  await assert.rejects(write.transaction(undefined!, {}, () => undefined));
});

test('missing files and directories cannot produce identities or implicit database creation', async (t) => {
  const f = await fixture(t),
    missing = join(f.directory, 'missing.db');
  for (const path of [missing, f.directory]) {
    assert.throws(() => f.read(path));
    await assert.rejects(f.write(path));
  }
  assert.equal(existsSync(missing), false);
});
