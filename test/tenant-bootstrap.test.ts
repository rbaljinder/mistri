import {
  createTenantBootstrap,
  type TenantBootstrap,
  type TenantBootstrapOptions,
} from '../packages/mistri/src/server/tenant/tenantBootstrap.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource, type TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { provisionSqliteTenantStore, TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';

const owner = { appId: 'app', source: { id: 'business', connection: 'private-connection' }, storeId: 'store' };
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  return true;
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-bootstrap-'));
  const path = join(dir, 'business.db'),
    db = new DatabaseSync(path);
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    await Promise.allSettled(sources.map((source) => source.close()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, label TEXT)',
  );
  provisionSqliteTenantStore(path, owner);
  const add = (tenantId: string, account = 'alice', status = 'active', tenantStatus = 'active', expiry = 10_000, roles = ['reader']) => {
    db.prepare(`INSERT OR IGNORE INTO "${tables.tenant}" VALUES (?, ?, '1', 'tenant')`).run(tenantId, tenantStatus);
    db.prepare(`INSERT INTO "${tables.membership}" VALUES (?, ?, ?, ?, '1', ?, ?, 'member', NULL, NULL, NULL)`).run(
      tenantId + '-' + account,
      tenantId,
      account,
      status,
      JSON.stringify(roles),
      expiry,
    );
  };
  db.exec('BEGIN');
  const schema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const logical = mapScopeCatalog(schema, new Map([['item', 'item']]));
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: logical,
    physicalSchema: schema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const open = (now = () => 100) => {
    const source = openSqliteTenantReadSource(path, ownership, owner, now);
    sources.push(source);
    return source;
  };
  return { db, add, open, path, ownership };
}

const identity = () => ({ id: 'alice', who: 'Alice', role: 'global-admin' });
function options(reader: TenantReadSource) {
  return { reader, deployment: 'generation', roles: ['reader'], maxLifetimeMs: 1000, verifySession: () => identity(), now: () => 100 };
}

test('bootstrap narrowing guard runs before each membership barrier and cannot hide its last revocation', async (t) => {
  const f = fixture(t);
  f.add('north');
  const service = createTenantBootstrap(options(f.open()));
  let calls = 0;
  await assert.rejects(
    service.read({}, () => {
      if (++calls === 3) f.db.prepare(`UPDATE "${tables.membership}" SET status='revoked' WHERE tenant_id=?`).run('north');
    }),
    safe,
  );
  assert.equal(calls, 3);
});

test('bootstrap rejects a proxy guard before any authentication or trap', async (t) => {
  const f = fixture(t);
  let calls = 0,
    traps = 0;
  const service = createTenantBootstrap({
    ...options(f.open()),
    verifySession: () => {
      calls++;
      return identity();
    },
  });
  const guard = new Proxy(() => {}, {
    apply() {
      traps++;
    },
  });
  await assert.rejects(service.read({}, guard), safe);
  assert.equal(calls, 0);
  assert.equal(traps, 0);
});

test('bootstrap guard rejects custom thenables without invoking their accessors', async (t) => {
  const f = fixture(t);
  f.add('north');
  let traps = 0;
  const service = createTenantBootstrap(options(f.open()));
  // oxlint-disable-next-line unicorn/no-thenable -- Deliberately hostile provider result.
  const value = Object.defineProperty({}, 'then', {
    enumerable: true,
    get() {
      traps++;
      throw new Error('private');
    },
  });
  await assert.rejects(service.read({}, (() => value) as () => Promise<void>), safe);
  assert.equal(traps, 0);
});

test('bootstrap guard rejection is sanitized and does not poison another discovery request', async (t) => {
  const f = fixture(t);
  f.add('north');
  const service = createTenantBootstrap(options(f.open()));
  await assert.rejects(
    service.read({}, async () => {
      throw new Error('private provider details');
    }),
    safe,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await service.read({}))), {
    status: 'ready',
    appId: 'app',
    accountId: 'alice',
    memberships: [{ tenantId: 'north' }],
  });
});

test('ready DTO contains only account/app and ordered tenant IDs; global auth role is not a membership grant', async (t) => {
  const f = fixture(t);
  f.add('south');
  f.add('north');
  f.add('private', 'bob');
  const reader = f.open(),
    service = createTenantBootstrap(options(reader));
  const result = await service.read({});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: 'ready',
    appId: 'app',
    accountId: 'alice',
    memberships: [{ tenantId: 'north' }, { tenantId: 'south' }],
  });
  assert.ok(Object.isFrozen(service) && Object.isFrozen(result));
  assert.deepEqual(Object.keys(service).sort(), ['read', 'retire']);
  if (result.status === 'ready') assert.ok(Object.isFrozen(result.memberships) && Object.isFrozen(result.memberships[0]));
  await service.retire();
  await assert.rejects(
    reader.readMemberships({ appId: owner.appId, source: owner.source, accountId: 'alice', deployment: 'generation' }),
    safe,
  );
});

test('only genuine null session returns signed_out without requiring a membership lookup', async (t) => {
  const f = fixture(t),
    reader = f.open();
  f.db.exec(`UPDATE "${tables.meta}" SET store_id='wrong'`);
  const service = createTenantBootstrap({ ...options(reader), verifySession: () => null });
  assert.deepEqual(await service.read({}), { status: 'signed_out' });
  await service.retire();
});

test('authenticated empty discovery is ready, not signed_out and never selects a tenant', async (t) => {
  const f = fixture(t),
    service = createTenantBootstrap(options(f.open()));
  const result = await service.read({});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'ready', appId: 'app', accountId: 'alice', memberships: [] });
  await service.retire();
});

for (const value of [
  undefined,
  false,
  {},
  { id: 'alice' },
  { ...identity(), id: ' alice' },
  { ...identity(), extra: 'secret' },
  { ...identity(), role: 42 },
]) {
  test(`malformed session ${JSON.stringify(value)} never becomes signed_out or empty`, async (t) => {
    const f = fixture(t),
      service = createTenantBootstrap({
        ...options(f.open()),
        verifySession: (() => value) as TenantBootstrapOptions<unknown>['verifySession'],
      });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  });
}

test('provider throws and async rejection have safe errors without private causes', async (t) => {
  const f = fixture(t);
  for (const verifySession of [
    () => {
      throw new Error('PRIVATE_SESSION_SECRET');
    },
    () => Promise.reject(new Error('PRIVATE_SESSION_SECRET')),
  ]) {
    const service = createTenantBootstrap({ ...options(f.open()), verifySession });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  }
});

test('session getters, proxies and custom thenables are never executed', async (t) => {
  const f = fixture(t);
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('private');
  };
  const revoked = Proxy.revocable(identity(), {});
  revoked.revoke();
  for (const result of [
    Object.defineProperty(identity(), 'id', { get: trap }),
    new Proxy(identity(), { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    revoked.proxy,
    // Deliberately hostile provider values must not be assimilated.
    // eslint-disable-next-line unicorn/no-thenable
    { then: trap },
    // eslint-disable-next-line unicorn/no-thenable
    Object.defineProperty({}, 'then', { get: trap }),
  ]) {
    const service = createTenantBootstrap({
      ...options(f.open()),
      verifySession: (() => result) as unknown as TenantBootstrapOptions<unknown>['verifySession'],
    });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  }
  assert.equal(hooks, 0);
});

test('synchronous session results are captured before provider-scheduled mutation', async (t) => {
  const f = fixture(t);
  f.add('north');
  const service = createTenantBootstrap({
    ...options(f.open()),
    verifySession: () => {
      const value = identity();
      queueMicrotask(() => {
        value.id = 'bob';
      });
      return value;
    },
  });
  assert.equal((await service.read({})).status, 'ready');
  await service.retire();
});

test('native promises are consumed intrinsically, without consulting an own then getter', async (t) => {
  const f = fixture(t);
  let hooks = 0;
  const service = createTenantBootstrap({
    ...options(f.open()),
    verifySession: () =>
      // eslint-disable-next-line unicorn/no-thenable -- Deliberately hostile own getter.
      Object.defineProperty(Promise.resolve(identity()), 'then', {
        get: () => {
          hooks++;
          throw new Error('secret');
        },
      }),
  });
  assert.equal((await service.read({})).status, 'ready');
  assert.equal(hooks, 0);
  await service.retire();
});

for (const patch of [
  { deployment: '' },
  { roles: ['reader', 'reader'] },
  { roles: [' reader'] },
  { maxLifetimeMs: 0 },
  { maxLifetimeMs: 300001 },
  { maxLifetimeMs: NaN },
  { now: null },
  { extra: true },
]) {
  test(`invalid configuration leaves source caller-owned ${JSON.stringify(patch)}`, async (t) => {
    const f = fixture(t),
      reader = f.open();
    assert.throws(() => createTenantBootstrap({ ...options(reader), ...patch } as TenantBootstrapOptions<unknown>), safe);
    assert.deepEqual(
      await reader.readMemberships({ appId: owner.appId, source: owner.source, accountId: 'alice', deployment: 'generation' }),
      [],
    );
  });
}

test('forged reader/options and proxy callbacks refuse without executing traps', async (t) => {
  const f = fixture(t),
    reader = f.open();
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('private');
  };
  const base = options(reader);
  const cases = [
    new Proxy(base, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty({ ...base }, 'reader', { get: trap }),
    { ...base, reader: { ...reader } },
    { ...base, reader: new Proxy(reader, { get: trap }) },
    { ...base, verifySession: new Proxy(base.verifySession, { apply: trap }) },
    { ...base, now: new Proxy(base.now, { apply: trap }) },
  ];
  for (const value of cases) assert.throws(() => createTenantBootstrap(value), safe);
  assert.equal(hooks, 0);
});

test('configured roles are captured; unknown membership roles fail closed even for global admin', async (t) => {
  const f = fixture(t);
  f.add('north', 'alice', 'active', 'active', 10000, ['unknown']);
  const config = options(f.open()),
    service = createTenantBootstrap(config);
  config.roles.push('unknown');
  await assert.rejects(service.read({}), safe);
  await service.retire();
});

for (const mutation of ['addition', 'removal', 'id', 'version', 'tenantVersion', 'roles', 'expiry', 'suspension']) {
  test(`complete re-enumeration refuses membership ${mutation} between snapshots`, async (t) => {
    const f = fixture(t);
    f.add('north');
    let calls = 0;
    const service = createTenantBootstrap({
      ...options(f.open()),
      roles: ['reader', 'writer'],
      verifySession: () => {
        if (++calls === 2) {
          if (mutation === 'addition') f.add('south');
          else if (mutation === 'tenantVersion') f.db.exec(`UPDATE "${tables.tenant}" SET version='2'`);
          else if (mutation === 'suspension') f.db.exec(`UPDATE "${tables.tenant}" SET status='suspended'`);
          else {
            const changes: Record<string, string> = {
              removal: "status='revoked'",
              id: "id='new-grant'",
              version: "version='2'",
              roles: `roles_json='["writer"]'`,
              expiry: 'valid_until=9999',
            };
            f.db.exec(`UPDATE "${tables.membership}" SET ${changes[mutation]}`);
          }
        }
        return identity();
      },
    });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  });
}

for (const account of [null, 'bob'])
  test(`logout/account swap during final source snapshot is refused: ${account}`, async (t) => {
    const f = fixture(t);
    f.add('north');
    let sourceClocks = 0,
      current: ReturnType<typeof identity> | null = identity();
    const reader = f.open(() => {
      if (++sourceClocks === 3) current = account === null ? null : { ...identity(), id: account };
      return 100;
    });
    const service = createTenantBootstrap({ ...options(reader), verifySession: () => current });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  });

test('source attestation failure never becomes an empty discovery result', async (t) => {
  const f = fixture(t);
  f.add('north');
  const service = createTenantBootstrap(options(f.open()));
  f.db.exec(`UPDATE "${tables.meta}" SET store_id='secret-other-store'`);
  await assert.rejects(service.read({}), safe);
  await service.retire();
});

test('source overflow remains a refusal at the bootstrap boundary', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 257; i++) f.add(`t${i}`);
  const service = createTenantBootstrap(options(f.open()));
  await assert.rejects(service.read({}), safe);
  await service.retire();
});

for (const boundary of [1, 2, 3, 4, 5, 6, 7])
  test(`retirement from bootstrap clock boundary ${boundary} stops admission/release`, async (t) => {
    const f = fixture(t);
    f.add('north');
    let clocks = 0,
      closing: Promise<void> | undefined;
    let service!: TenantBootstrap<unknown>;
    service = createTenantBootstrap({
      ...options(f.open()),
      now: () => {
        if (++clocks === boundary) closing = service.retire();
        return 100;
      },
    });
    await assert.rejects(service.read({}), safe);
    await closing;
    await assert.rejects(service.read({}), safe);
  });

test('retirement reserves accepted provider work, drains it and closes only the dedicated reader', async (t) => {
  const f = fixture(t),
    reader = f.open(),
    independent = f.open();
  let release!: (value: ReturnType<typeof identity>) => void;
  const service = createTenantBootstrap({
    ...options(reader),
    verifySession: () =>
      new Promise<ReturnType<typeof identity>>((resolve) => {
        release = resolve;
      }),
  });
  const read = service.read({}),
    retiring = service.retire();
  let done = false;
  void retiring.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(retiring, service.retire());
  release(identity());
  await assert.rejects(read, safe);
  await retiring;
  const query = { appId: 'app', source: owner.source, accountId: 'alice', deployment: 'generation' };
  await assert.rejects(reader.readMemberships(query), safe);
  assert.deepEqual(await independent.readMemberships(query), []);
});

test('provider reentrant retirement cannot release signed_out', async (t) => {
  const f = fixture(t);
  let service!: TenantBootstrap<unknown>, closing: Promise<void> | undefined;
  service = createTenantBootstrap({
    ...options(f.open()),
    verifySession: () => {
      closing = service.retire();
      return null;
    },
  });
  await assert.rejects(service.read({}), safe);
  await closing;
});

test('expiry after final async authentication refuses buffered memberships', async (t) => {
  const f = fixture(t);
  f.add('north', 'alice', 'active', 'active', 200);
  let now = 100,
    calls = 0;
  const service = createTenantBootstrap({
    ...options(f.open()),
    now: () => now,
    verifySession: async () => {
      if (++calls === 3) now = 200;
      return identity();
    },
  });
  await assert.rejects(service.read({}), safe);
  await service.retire();
});

for (const change of ['revoke', 'suspend', 'replace'])
  test(`release barrier detects ${change} during final authentication wait`, async (t) => {
    const f = fixture(t);
    f.add('north');
    let calls = 0;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createTenantBootstrap({
      ...options(f.open()),
      verifySession: async () => {
        if (++calls === 3) {
          entered();
          await gate;
        }
        return identity();
      },
    });
    const pending = service.read({});
    await waiting;
    if (change === 'suspend') f.db.exec(`UPDATE "${tables.tenant}" SET status='suspended', version='2'`);
    else {
      f.db.exec(`UPDATE "${tables.membership}" SET status='revoked', version='2'`);
      if (change === 'replace')
        f.db
          .prepare(`INSERT INTO "${tables.membership}" VALUES (?, ?, ?, 'active', '1', ?, ?, 'member', NULL, NULL, NULL)`)
          .run('replacement-grant', 'north', 'alice', '["reader"]', 10000);
    }
    release();
    await assert.rejects(pending, safe);
    await service.retire();
  });

test('clock high-water spans requests and lifetime includes session waits', async (t) => {
  const f = fixture(t);
  let now = 100;
  const service = createTenantBootstrap({ ...options(f.open()), now: () => now });
  await service.read({});
  now = 99;
  await assert.rejects(service.read({}), safe);
  await service.retire();
  const expiring = createTenantBootstrap({
    ...options(f.open()),
    now: () => now,
    verifySession: async () => {
      now += 1000;
      return identity();
    },
  });
  await assert.rejects(expiring.read({}), safe);
  await expiring.retire();
});

for (const value of [NaN, Infinity, -1, 1.1, '100', Number.MAX_SAFE_INTEGER])
  test(`invalid bootstrap clock ${String(value)}`, async (t) => {
    const f = fixture(t),
      service = createTenantBootstrap({ ...options(f.open()), now: () => value as number });
    await assert.rejects(service.read({}), safe);
    await service.retire();
  });
