/**
 * Kept admissions (tenantAdmissionCache.ts): one login's evidence handed from
 * one request to the next instead of read again, and every invariant that
 * makes that safe — each case here goes red when its invariant is taken out.
 *
 * The owners are this deployment's own two, over one SQLite store: the read
 * runtime (every read revalidates in its own snapshot, and a read may be
 * admitted afresh once) and the request runtime (the membership revalidated
 * before the callback, and afresh only there, before anything is written).
 * A kept admission shows as its `verifiedAt`: the clock moves between
 * requests, so evidence minted again carries the new time.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { denyTenant, TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  createAdmissionCache,
  endAdmissionSession,
  noteAdmissionSession,
} from '../packages/mistri/src/server/tenant/tenantAdmissionCache.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { bindTenantReadRuntime } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { bindTenantRequestRuntime } from '../packages/mistri/src/server/tenant/tenantRequestRuntime.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource, TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

/** A request as the host sees one: which login's cookie it carries, if any. */
type Request = { account: string; session?: string };
const binding = { appId: 'kept-app', source: { id: 'business', connection: 'business-db' }, storeId: 'fixture' };
const resources = { item: 'db_item' };
const refused = (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  return true;
};
const failed = (error: unknown) => {
  assert.ok(error instanceof TenantWriteFailure, String(error));
  return true;
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-admission-cache-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE db_item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-row', 'north', 'North'), ('south-row', 'south', 'South'), ('east-row', 'east', 'East');`);
  provisionSqliteTenantStore(path, binding);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = (tenantId: string) => ({
    tenantId,
    accountId: 'alice',
    membershipId: `${tenantId}-alice`,
    status: 'active' as const,
    roles: ['editor'],
    validUntil: 100_000,
    expectedVersion: null,
  });
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south', 'east']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const tenantId of ['north', 'south']) await admin.putMembership(grant(tenantId));
  });
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  let time = 1000;
  const reader = openSqliteTenantReadSource(path, ownership, binding, () => time);
  const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => time);
  const admissions = createAdmissionCache({ ...binding, canonicalPath: path }, 'deployment-1');
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Kept admissions',
      sources: { business: { connection: binding.source.connection } },
      resources: { item: { physical: resources.item, access: 'write' } },
      auth: { roles: { editor: { read: ['item'], write: ['item'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'admission cache test',
  );
  const rows: RowScope = { item: true };
  let admissionRows = 0;
  const common = {
    app,
    deployment: 'deployment-1',
    roles: ['editor'],
    maxLifetimeMs: 5000,
    admissions,
    now: () => time,
    // The host's verifier notes which login it verified (tenantAuthenticatedHttp.ts does this).
    verifySession: (input: Request) => {
      noteAdmissionSession(input, input.session ?? null);
      return { id: input.account, who: input.account };
    },
    // Called once per admission the request runtime computes a scope for.
    resolveMembershipRows: () => {
      admissionRows++;
      return rows;
    },
    resolveRows: () => rows,
  };
  const reads = bindTenantReadRuntime<Request>({ ...common, source: reader });
  const requests = bindTenantRequestRuntime<Request>({ ...common, reader, writer });
  t.after(async () => {
    try {
      await reads.retire();
      await requests.retire();
      admissions.retire();
      await reader.close();
      await writer.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const tick = () => {
    time += 10;
  };
  /** A read's evidence and the names it read. */
  const read = async (request: Request, tenant = 'north') => {
    tick();
    return reads.withContext(request, [tenant], async (context) => ({
      principal: context.principal,
      names: (await context.data.query({ table: 'item', limit: 20, offset: 0 })).rows.map((row) => row.name),
    }));
  };
  /** The evidence a request's callback was handed. */
  const principalOf = async (request: Request, tenant = 'north') => {
    tick();
    return requests.run(request, [tenant], (scope) => scope.principal);
  };
  return {
    db,
    maintenance,
    grant,
    read,
    principalOf,
    requests,
    tick,
    name: (id: string) => db.prepare('SELECT name FROM db_item WHERE id = ?').get(id)!.name,
    rows: () => admissionRows,
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant('north'), status: 'revoked', expectedVersion: '1' })),
    /** Suspended and reactivated: the membership holds, the tenant's version moves on. */
    bump: () =>
      maintenance(async (admin) => {
        await admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' });
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '2' });
      }),
  };
}

const alice = (session = 'session-1'): Request => ({ account: 'alice', session });

test("a login's evidence is kept from one request to its next, across both owners", async (t) => {
  const f = await fixture(t);
  const first = await f.read(alice());
  assert.deepEqual(first.names, ['North']);
  const again = await f.read(alice()),
    written = await f.principalOf(alice());
  assert.equal(again.principal.verifiedAt, first.principal.verifiedAt, 'the read was not admitted again');
  assert.equal(written.verifiedAt, first.principal.verifiedAt, 'nor the request');
});

test('another session, another tenant or a login with no session instance never meets kept evidence', async (t) => {
  const f = await fixture(t);
  const kept = (await f.read(alice())).principal;
  const other = (await f.read(alice('session-2'))).principal;
  assert.notEqual(other.verifiedAt, kept.verifiedAt, 'the same account signed in again is admitted afresh');
  const south = (await f.read(alice(), 'south')).principal;
  assert.equal(south.tenantId, 'south');
  assert.notEqual(south.verifiedAt, kept.verifiedAt, 'another tenant is admitted afresh');
  const token = { account: 'alice' };
  const first = (await f.read(token)).principal,
    second = (await f.read(token)).principal;
  assert.notEqual(second.verifiedAt, first.verifiedAt, 'a login without a session instance is never kept');
  assert.equal((await f.read(alice())).principal.verifiedAt, kept.verifiedAt, 'the first login still has its own');
});

test('a membership revoked between two requests is refused within the next one', async (t) => {
  const f = await fixture(t);
  await f.read(alice());
  await f.principalOf(alice());
  await f.revoke();
  await assert.rejects(f.read(alice()), refused);
  await assert.rejects(
    f.requests.run(alice(), ['north'], () => 'PRIVATE_SENTINEL'),
    failed,
  );
  assert.equal(f.name('north-row'), 'North');
});

test('sign-out drops what that session kept, and only that session', async (t) => {
  const f = await fixture(t);
  const one = (await f.read(alice())).principal,
    two = (await f.read(alice('session-2'))).principal;
  endAdmissionSession('session-1');
  assert.notEqual((await f.read(alice())).principal.verifiedAt, one.verifiedAt, 'admitted afresh after its sign-out');
  assert.equal((await f.read(alice('session-2'))).principal.verifiedAt, two.verifiedAt, 'the other session keeps its own');
});

test('kept evidence refused before the callback is admitted afresh exactly once, and never after a write', async (t) => {
  const f = await fixture(t);
  const kept = await f.principalOf(alice());
  // The tenant's version moved on: the kept evidence is refused, fresh evidence is not.
  await f.bump();
  let ran = 0;
  const before = f.rows();
  f.tick();
  const principal = await f.requests.run(alice(), ['north'], (scope) => {
    ran++;
    return scope.principal;
  });
  /* Nothing read the membership before the callback: its answer, which no
     transaction proved, met the release fence, which refused the kept evidence,
     and the callback ran once more on evidence admitted afresh. */
  assert.equal(ran, 2);
  assert.equal(f.rows() - before, 2, 'kept, refused, then admitted once more');
  assert.notEqual(principal.tenantVersion, kept.tenantVersion);

  // A refusal every admission meets: one retry, not two.
  const met = new Set<TenantMembershipEvidence>();
  f.tick();
  await assert.rejects(
    f.requests.run(
      alice(),
      ['north'],
      () => 'unreached',
      (member) => {
        met.add(member);
        denyTenant();
      },
    ),
    failed,
  );
  assert.equal(met.size, 2, 'the kept admission and one fresh one');

  // Refused after its write: nothing is retried, nothing commits, and the evidence is not kept.
  const primed = await f.principalOf(alice()),
    writes = f.rows();
  let attempts = 0;
  await assert.rejects(
    f.requests.run(alice(), ['north'], (scope) =>
      scope.transaction(async (records) => {
        attempts++;
        await records.update({ table: 'item', key: { id: 'north-row' }, values: { name: 'Written' } });
        return denyTenant();
      }),
    ),
    failed,
  );
  assert.equal(attempts, 1, 'the write ran once');
  assert.equal(f.rows() - writes, 1, 'and was admitted once');
  assert.equal(f.name('north-row'), 'North');
  assert.notEqual((await f.principalOf(alice())).verifiedAt, primed.verifiedAt, 'evidence that met a refusal is not served again');
});

test('a refusal is never kept: a membership granted after one is admitted at once', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.read(alice(), 'east'), refused);
  await f.maintenance((admin) => admin.putMembership(f.grant('east')));
  assert.deepEqual((await f.read(alice(), 'east')).names, ['East']);
});

test('kept evidence is served only inside its own window', async (t) => {
  const f = await fixture(t);
  const kept = await f.principalOf(alice());
  // Past its validUntil (at most maxLifetimeMs after it was minted) it is not
  // even tried: the one admission the request sees is a fresh one.
  for (let step = 0; step < 500; step++) f.tick();
  const met: TenantMembershipEvidence[] = [];
  const principal = await f.requests.run(
    alice(),
    ['north'],
    (scope) => scope.principal,
    (member) => {
      met.push(member);
    },
  );
  assert.ok(principal.verifiedAt >= kept.validUntil);
  assert.deepEqual([...new Set(met)], [principal], 'one admission, and not the kept one');
});
