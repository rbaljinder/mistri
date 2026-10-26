/** S2 of the API tenant bridge: a tenant App's API reads through its enrolled
 * deployment — the one reader/writer pair, the web UI's row scope — with a
 * bearer token bound to one membership. In process, on both engines: two
 * tenants, a token for one never reads the other's rows (guessed keys, forged
 * cursors, the document, the tool listing), and a revoked membership, a
 * changed membership version or a revoked token ends its authority on the next
 * request. The CLI mounting is S3's. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { issueSqliteApiTenantToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { issuePostgresApiTenantToken, revokePostgresApiToken } from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { captureTenantEnrollment, createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { withTenantApiRequests } from '../packages/mistri/src/server/tenant/tenantApiRequest.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { checkApiTenantReadCatalog } from '../packages/mistri/src/server/api/apiTenantReadCatalog.js';
import { checkApiTenantCommandCatalog } from '../packages/mistri/src/server/api/apiTenantCommandCatalog.js';
import { parseApiCommandRoute } from '../packages/mistri/src/server/api/apiCommandRoute.js';
import { readApiApp } from '../packages/mistri/src/server/api/appApiValidation.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { createTenantApiOwner } from '../packages/mistri/src/server/api/tenantApiReadOwner.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, SESSION_SECRET, writeDepotApp } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
type Answer = { status: number; body: Record<string, unknown> } | { refused: string };

async function withSecret<T>(work: () => Promise<T>) {
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    return await work();
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }
}

type CommandAnswer = { status: number; replayed: boolean; body: Record<string, unknown> } | { thrown: string };

/** The depot deployment on one engine, with alice in north and bob in south;
 * with `commands`, its `touch` command too, on the journal it needs. */
async function depot(t: TestContext, dialect: 'sqlite' | 'postgres', options: { commands?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), `tw-tenant-api-${dialect}-`));
  const cleanup: Array<() => Promise<unknown> | unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
  const storeId = randomUUID();
  let maintenance: (run: (admin: TenantStoreAdministration) => Promise<void>) => Promise<void>;
  let business: string, authStore: string, source: { id: string; connection: string; existingPath?: string; url?: string };
  let accounts: (ids: string[]) => Promise<void>;
  /** The business database stops answering (true), then answers again. The
   * auth database is separate and stays up, so tokens still observe. */
  let outage: (down: boolean) => Promise<void>;
  if (dialect === 'sqlite') {
    business = join(directory, 'business.db');
    authStore = join(directory, 'auth.db');
    const db = new DatabaseSync(business);
    cleanup.push(() => db.close());
    db.exec(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
    if (options.commands) migrateSqliteCommandJournal(business);
    provisionSqliteTenantStore(business, store);
    maintenance = async (run) => {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, store));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    };
    source = { ...store.source, existingPath: business };
    // An exclusive lock from another connection: the rollback-journal reader
    // is busy past its timeout, a database fault like any other.
    let blocker: DatabaseSync | undefined;
    cleanup.push(() => blocker?.close());
    outage = async (down) => {
      if (down) {
        blocker = new DatabaseSync(business);
        blocker.exec('BEGIN EXCLUSIVE');
        return;
      }
      blocker?.exec('ROLLBACK');
      blocker?.close();
      blocker = undefined;
    };
    accounts = async (ids) => {
      const native = new DatabaseSync(authStore);
      try {
        for (const id of ids)
          native
            .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
            .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
      } finally {
        native.close();
      }
    };
  } else {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    await control.connect();
    const names = ['auth', 'business'].map((kind) => `tw_tenant_api_${kind}_${randomUUID().replaceAll('-', '')}`);
    cleanup.unshift(async () => {
      for (const name of names) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    });
    for (const name of names) await control.query(`CREATE DATABASE "${name}"`);
    [authStore, business] = names.map((name) => {
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      return url.href;
    });
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
    if (options.commands) await migratePostgresCommandJournal(business);
    await migratePostgresTenantStore(business, store);
    maintenance = async (run) => {
      const operations = new TransactionOperations();
      await client.query('BEGIN');
      try {
        await run(createPostgresTenantAdministration(client, operations, store));
        await operations.finish();
        await client.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await client.query('ROLLBACK');
        throw error;
      }
    };
    source = { ...store.source, url: business };
    // The business database refuses new connections and its backends are
    // terminated — all but this fixture's maintenance client.
    const businessName = names[1],
      spared = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    cleanup.unshift(() => control.query(`ALTER DATABASE "${businessName}" ALLOW_CONNECTIONS true`));
    outage = async (down) => {
      await control.query(`ALTER DATABASE "${businessName}" ALLOW_CONNECTIONS ${down ? 'false' : 'true'}`);
      if (down)
        await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> $2', [
          businessName,
          spared,
        ]);
    };
    await migratePostgresAuthStore(authStore);
    accounts = async (ids) => {
      const native = new pg.default.Client({ connectionString: authStore, statement_timeout: 10000 });
      await native.connect();
      try {
        for (const id of ids)
          await native.query(
            `INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
          VALUES($1,$1,$2,true,now(),now(),NULL,false)`,
            [id, `${id}@example.test`],
          );
      } finally {
        await native.end();
      }
    };
  }
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const [account, tenantId] of [
      ['alice', 'north'],
      ['bob', 'south'],
    ]) {
      await admin.putMembership({
        tenantId,
        accountId: account,
        membershipId: `m-${account}-${tenantId}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 3600000,
        expectedVersion: null,
      });
    }
  });
  const physical = dialect === 'sqlite' ? 'physical_item' : 'public.physical_item';
  const written = writeDepotApp(directory, { business, authStore, physical, commands: options.commands });
  const loaded = await loadApp(written.appDir);
  const registry = written.commands ? await loadBusinessCommands(written.commands) : undefined;
  const auth: AppAuthRuntime = await withSecret(() =>
    createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] }),
  );
  cleanup.push(() => auth.close());
  await accounts(['alice', 'bob', 'operator']);
  const exclusions = dialect === 'sqlite' ? [captureAuthStoreExclusion(business)] : [];
  const excludeConnections = [{ url: business, name: 'data', source: 'session' as const }];
  if (dialect === 'sqlite') provisionSqliteApiTokenStore(authStore, { appId: 'depot', storeId, exclusions });
  else await provisionPostgresApiTokenStore(authStore, { appId: 'depot', storeId, excludeConnections });
  const enrollment = await createTenantEnrollment({
    app: loaded.app,
    pages: loaded.pages,
    policy: defineAppTenantPolicy({
      kind: 'tenant',
      appId: 'depot',
      storeId: DEPOT_STORE,
      ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: () => ({ item: true }),
      resolveRows: () => ({ item: true }),
      ...(registry ? { resultReferences: { touch: () => [], stock: () => [] } } : {}),
    }),
    source,
    deployment: randomUUID(),
    roles: ['member'],
    maxLifetimeMs: 60000,
    // No browser session in this deployment: only App API requests answer.
    verifySession: withTenantApiRequests(async () => null),
    ...(registry ? { commands: { registry } } : {}),
  });
  cleanup.push(() => enrollment.retire());
  const ownership = captureTenantEnrollment(enrollment).ownership;
  const reads = checkApiTenantReadCatalog(readApiApp(loaded.app), ownership);
  // A token's scope is drawn from both halves, as issuance through the CLI draws it.
  const catalog = registry
    ? { operations: [...reads.operations, ...checkApiTenantCommandCatalog(loaded.app, ownership, registry).operations] }
    : reads;
  const issue = async (subjectId: string, tenantId: string, extra: { operations?: string[] } = {}) => {
    const options = {
      storeId,
      subjectId,
      actorId: 'operator',
      roles: ['member'],
      label: 'Owner test',
      expiresAt: Date.now() + 600000,
      tenant: { tenantId, membershipId: `m-${subjectId}-${tenantId}`, membershipVersion: '1', roles: ['member'] },
      ...extra,
    };
    return dialect === 'sqlite'
      ? issueSqliteApiTenantToken(authStore, loaded.app, catalog, { ...options, exclusions }, Date.now())
      : await issuePostgresApiTenantToken(authStore, loaded.app, catalog, { ...options, excludeConnections }, Date.now);
  };
  const revoke = async (tokenId: string) =>
    dialect === 'sqlite'
      ? revokeSqliteApiToken(
          authStore,
          { appId: 'depot', storeId, exclusions, tokenId, expectedVersion: '1', actorId: 'operator' },
          Date.now(),
        )
      : await revokePostgresApiToken(
          authStore,
          { appId: 'depot', storeId, excludeConnections, tokenId, expectedVersion: '1', actorId: 'operator' },
          Date.now,
        );
  const owner = await createTenantApiOwner({ enrollment, auth, integers: 'decimal-string' });
  cleanup.push(() => owner.retire());
  /** One owner call, as a transport would make it: the answer, or the refusal's code. */
  const ask = async (call: (send: (answer: { status: number; body: string }) => void) => Promise<unknown>): Promise<Answer> => {
    let answer: { status: number; body: string } | undefined;
    try {
      await call((value) => {
        answer = value;
      });
    } catch (error) {
      return { refused: (error as { code?: string }).code ?? 'unknown' };
    }
    return answer ? { status: answer.status, body: JSON.parse(answer.body) } : { refused: 'unwritten' };
  };
  /** One command call, as a transport would make it: the answer, or what was thrown. */
  const command = async (
    call: (send: (answer: { status: number; headers: Readonly<Record<string, string>>; body: string }) => void) => Promise<unknown>,
  ): Promise<CommandAnswer> => {
    let answer: { status: number; headers: Readonly<Record<string, string>>; body: string } | undefined;
    try {
      await call((value) => {
        answer = value;
      });
    } catch (error) {
      return { thrown: (error as Error).name };
    }
    return answer
      ? { status: answer.status, replayed: answer.headers['idempotent-replayed'] === 'true', body: JSON.parse(answer.body) }
      : { thrown: 'unwritten' };
  };
  return { owner, ask, command, issue, revoke, maintenance, outage };
}

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
]) {
  test(
    `tenant API reads on ${dialect}: a token for one tenant reads only its rows, and loses authority with its membership`,
    { skip, timeout: 240000 },
    async (t) => {
      const f = await depot(t, dialect);
      const alice = await f.issue('alice', 'north'),
        bob = await f.issue('bob', 'south');
      const item = (token: string, key: string) => f.ask((send) => f.owner.readItem(token, 'item:item', key, send));
      const list = (token: string, query = '') => f.ask((send) => f.owner.readList(token, 'list:item', query, send));
      const notFound = { status: 404, body: { error: { code: 'not_found', message: 'The API request could not be completed.' } } };

      assert.deepEqual(await item(alice.token, 'north-1'), { status: 200, body: { id: 'north-1', name: 'North one' } });
      assert.deepEqual(await item(bob.token, 'south-2'), { status: 200, body: { id: 'south-2', name: 'South two' } });
      // A guessed key from the other tenant is not found, not forbidden: its row
      // is outside this membership's scope, so it does not exist here.
      assert.deepEqual(await item(alice.token, 'south-1'), notFound);
      assert.deepEqual(await item(bob.token, 'north-2'), notFound);
      // A tenant table's key is opaque text (the tenant store's rule); lists
      // order it by bytes and page through this membership's rows only.
      const page = async (token: string, query: string) => {
        const answer = await list(token, query);
        assert.ok('body' in answer, JSON.stringify(answer));
        return answer.body as { items: { id: string }[]; next: string | null };
      };
      const first = await page(alice.token, 'limit=1&sort=id');
      assert.deepEqual(first.items, [{ id: 'north-1', name: 'North one' }]);
      assert.equal(typeof first.next, 'string');
      const second = await page(alice.token, `limit=1&sort=id&cursor=${encodeURIComponent(first.next!)}`);
      assert.deepEqual(second.items, [{ id: 'north-2', name: 'North two' }]);
      assert.equal(second.next, null);
      assert.deepEqual(
        (await page(bob.token, 'limit=10&sort=-id')).items.map((row) => row.id),
        ['south-2', 'south-1'],
      );
      // The count is the membership's too, bounded in its statement.
      assert.deepEqual(((await page(alice.token, 'limit=1&count=true')) as { count?: unknown }).count, {
        value: 2,
        exact: true,
        capped: false,
      });
      // A cursor is bound to the membership it was issued through: alice's
      // cursor under bob's token is refused, and yields neither tenant's rows.
      // So is a cursor from alice's other token, and a tampered one.
      assert.deepEqual(await list(bob.token, `limit=1&sort=id&cursor=${encodeURIComponent(first.next!)}`), { refused: 'invalid_request' });
      const other = await f.issue('alice', 'north');
      assert.deepEqual(await list(other.token, `limit=1&sort=id&cursor=${encodeURIComponent(first.next!)}`), {
        refused: 'invalid_request',
      });
      assert.deepEqual(await list(alice.token, `limit=1&sort=id&cursor=${encodeURIComponent(first.next!.slice(0, -4) + 'AAAA')}`), {
        refused: 'invalid_request',
      });
      // The document and the tool listing are the token's scope, and name no rows.
      const spec = await f.ask((send) => f.owner.readSpec(alice.token, send));
      assert.ok('body' in spec);
      assert.deepEqual(Object.keys(spec.body.paths as object).sort(), ['/item', '/item/{id}']);
      assert.doesNotMatch(JSON.stringify(spec.body), /North|South|tenant_id/);
      const narrow = await f.issue('alice', 'north', { operations: ['item:item'] });
      const narrowed = await f.ask((send) => f.owner.readSpec(narrow.token, send));
      assert.ok('body' in narrowed);
      assert.deepEqual(Object.keys(narrowed.body.paths as object), ['/item/{id}']);
      // Outside the token's scope: forbidden before any request is planned.
      assert.deepEqual(await list(narrow.token), { refused: 'forbidden' });
      const tools = await f.ask((send) => f.owner.readTools(alice.token, send));
      assert.ok('body' in tools);
      assert.deepEqual((tools.body.tools as { name: string }[]).map((tool) => tool.name.split('_')[0]).sort(), ['get', 'list']);

      // The business database stops answering: authority was never decided,
      // so every read is temporarily_unavailable (503), never forbidden, and reads nothing.
      // The token is checked first, in the auth database, which is still up.
      await f.outage(true);
      try {
        assert.deepEqual(await item(alice.token, 'north-1'), { refused: 'temporarily_unavailable' });
        assert.deepEqual(await list(bob.token, 'limit=10'), { refused: 'temporarily_unavailable' });
        assert.deepEqual(await f.ask((send) => f.owner.readSpec(alice.token, send)), { refused: 'temporarily_unavailable' });
        assert.deepEqual(await item('twa1.not-a-token', 'north-1'), { refused: 'unauthenticated' });
      } finally {
        await f.outage(false);
      }
      // Answering again: a pool may discard a dead connection or two first,
      // and meanwhile says only "temporarily_unavailable" — never forbidden, never rows.
      let recovered: Answer = { refused: 'unwritten' };
      for (let attempt = 0; attempt < 5; attempt++) {
        recovered = await item(alice.token, 'north-1');
        if (!('refused' in recovered)) break;
        assert.deepEqual(recovered, { refused: 'temporarily_unavailable' });
      }
      assert.deepEqual(recovered, { status: 200, body: { id: 'north-1', name: 'North one' } });

      // A new membership version — here the same roles, reissued — ends the
      // token's authority: it was issued against version 1.
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'north',
          accountId: 'alice',
          membershipId: 'm-alice-north',
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.deepEqual(await item(alice.token, 'north-1'), { refused: 'forbidden' });
      assert.deepEqual(await f.ask((send) => f.owner.readSpec(alice.token, send)), { refused: 'forbidden' });
      // A suspended tenant stops every membership in it on the next request;
      // reactivated, the unchanged membership acts again (the token binds the
      // membership's version, not the tenant's).
      assert.deepEqual(await item(bob.token, 'south-1'), { status: 200, body: { id: 'south-1', name: 'South one' } });
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '1' }));
      assert.deepEqual(await item(bob.token, 'south-1'), { refused: 'forbidden' });
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: '2' }));
      assert.deepEqual(await item(bob.token, 'south-1'), { status: 200, body: { id: 'south-1', name: 'South one' } });
      // A revoked membership ends it on the next request.
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'south',
          accountId: 'bob',
          membershipId: 'm-bob-south',
          status: 'revoked',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.deepEqual(await item(bob.token, 'south-1'), { refused: 'forbidden' });
      // A revoked token is unauthenticated, whatever its membership.
      const carol = await f.issue('alice', 'north');
      await f.revoke(carol.tokenId);
      assert.deepEqual(await item(carol.token, 'north-1'), { refused: 'unauthenticated' });
      assert.deepEqual(await item('twa1.not-a-token', 'north-1'), { refused: 'unauthenticated' });
    },
  );

  test(
    `tenant API commands on ${dialect}: a token runs its own tenant's commands only, and each refusal says what is known`,
    { skip, timeout: 240000 },
    async (t) => {
      const f = await depot(t, dialect, { commands: true });
      const alice = await f.issue('alice', 'north'),
        bob = await f.issue('bob', 'south');
      const item = (token: string, key: string) => f.ask((send) => f.owner.readItem(token, 'item:item', key, send));
      const version = async (token: string, key: string) => {
        const answer = await item(token, key);
        assert.ok('body' in answer, JSON.stringify(answer));
        return answer.body.version;
      };
      let counter = 0;
      const fresh = () => `tenant-command-${String(++counter).padStart(12, '0')}`;
      const touch = (token: string, key: string, version: number, idempotencyKey = fresh()) =>
        f.command((send) =>
          f.owner.execute(
            token,
            f.owner.map(
              parseApiCommandRoute(`/api/apps/depot/v1/item/${key}/commands/touch/v1`),
              { expectedVersion: version, idempotencyKey },
              {},
            ),
            send,
          ),
        );
      const problem = (status: number, code: string, outcome: string) => ({ status, code, outcome });
      const said = (answer: CommandAnswer) =>
        'body' in answer ? { status: answer.status, code: answer.body.code, outcome: answer.body.outcome } : answer;

      const prepare = (token: string, key: string) =>
        f.command((send) =>
          f.owner.prepare(
            token,
            f.owner.map(parseApiCommandRoute(`/api/apps/depot/v1/item/${key}/commands/touch/v1/prepare`), {}, undefined),
            send,
          ),
        );
      const prepared = await prepare(alice.token, 'north-1');
      assert.ok('body' in prepared && prepared.status === 200, JSON.stringify(prepared));
      assert.deepEqual(prepared.body, { version: 0 });
      const outside = await prepare(alice.token, 'south-1');
      assert.ok('status' in outside && [403, 404].includes(outside.status), JSON.stringify(outside));
      assert.equal(await version(alice.token, 'north-1'), '0');
      // Applied once, then replayed from its receipt under the same key.
      const applied = await touch(alice.token, 'north-1', 0, 'tenant-command-applied-01');
      assert.ok('body' in applied, JSON.stringify(applied));
      assert.equal(applied.status, 200);
      assert.equal(applied.replayed, false);
      assert.deepEqual(applied.body.result, { ok: true });
      const replayed = await touch(alice.token, 'north-1', 0, 'tenant-command-applied-01');
      assert.ok('body' in replayed && replayed.replayed, JSON.stringify(replayed));
      assert.deepEqual((replayed.body.receipt as { id: string }).id, (applied.body.receipt as { id: string }).id);
      assert.equal(await version(alice.token, 'north-1'), '1');
      // Refused inside the command transaction: the runtime's own outcome
      // stands — never upgraded, and never "applied".
      const refusedInside = (answer: CommandAnswer, status: number, code: string) => {
        const value = said(answer);
        assert.ok(
          'status' in value &&
            value.status === status &&
            value.code === code &&
            ['not_applied', 'unknown'].includes(value.outcome as string),
          JSON.stringify(value),
        );
      };
      // Another tenant's guessed key is not this membership's row, and changes nothing.
      refusedInside(await touch(alice.token, 'south-1', 0), 403, 'forbidden');
      assert.equal(await version(bob.token, 'south-1'), '0');
      // A stale version is the executor's refusal.
      refusedInside(await touch(alice.token, 'north-1', 0), 409, 'stale_record');
      assert.equal(await version(alice.token, 'north-1'), '1');
      // No receipt recovery for a tenant token: refused, never the earlier outcome.
      const recovery = f.owner.map(
        parseApiCommandRoute('/api/apps/depot/v1/commands/touch/v1/receipts/tenant-command-applied-01'),
        {},
        undefined,
      );
      assert.deepEqual(
        said(await f.command((send) => f.owner.recover(alice.token, recovery, send))),
        problem(422, 'invalid_input', 'unknown'),
      );
      // The document and the tools offer the command, and no recovery.
      const spec = await f.ask((send) => f.owner.readSpec(alice.token, send));
      assert.ok('body' in spec);
      const paths = Object.keys(spec.body.paths as object);
      assert.ok(
        paths.includes('/item/{id}/commands/touch/v1') && !paths.some((path) => path.includes('/receipts/')),
        JSON.stringify(paths),
      );
      const tools = await f.ask((send) => f.owner.readTools(alice.token, send));
      assert.ok('body' in tools);
      const names = (tools.body.tools as { name: string }[]).map((tool) => tool.name.split('_')[0]).sort();
      assert.deepEqual(names, ['get', 'list', 'prepare', 'run']);
      // Outside the token's scope: forbidden before any work.
      const reader = await f.issue('alice', 'north', { operations: ['item:item'] });
      assert.deepEqual(said(await touch(reader.token, 'north-1', 1)), problem(403, 'forbidden', 'not_applied'));
      const narrowed = await f.ask((send) => f.owner.readSpec(reader.token, send));
      assert.ok('body' in narrowed);
      assert.deepEqual(Object.keys(narrowed.body.paths as object), ['/item/{id}']);

      // The business database stops answering: 503, the outcome unknown —
      // retried under the same key, the command applies once.
      await f.outage(true);
      try {
        assert.deepEqual(
          said(await touch(bob.token, 'south-2', 0, 'tenant-command-outage-01')),
          problem(503, 'temporarily_unavailable', 'unknown'),
        );
      } finally {
        await f.outage(false);
      }
      let retried: CommandAnswer = { thrown: 'unwritten' };
      for (let attempt = 0; attempt < 5; attempt++) {
        retried = await touch(bob.token, 'south-2', 0, 'tenant-command-outage-01');
        if ('body' in retried && retried.status === 200) break;
        assert.deepEqual(said(retried), problem(503, 'temporarily_unavailable', 'unknown'));
      }
      assert.ok('body' in retried && retried.status === 200, JSON.stringify(retried));
      assert.equal(await version(bob.token, 'south-2'), '1');

      // A new membership version ends the token's authority: not applied.
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'north',
          accountId: 'alice',
          membershipId: 'm-alice-north',
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.deepEqual(said(await touch(alice.token, 'north-1', 1)), problem(403, 'forbidden', 'not_applied'));
      // A suspended tenant, then a revoked membership: not applied, and nothing changed.
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '1' }));
      assert.deepEqual(said(await touch(bob.token, 'south-1', 0)), problem(403, 'forbidden', 'not_applied'));
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: '2' }));
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'south',
          accountId: 'bob',
          membershipId: 'm-bob-south',
          status: 'revoked',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.deepEqual(said(await touch(bob.token, 'south-1', 0)), problem(403, 'forbidden', 'not_applied'));
      // A revoked token: unauthenticated, before any work.
      const carol = await f.issue('alice', 'north');
      await f.revoke(carol.tokenId);
      assert.deepEqual(await touch(carol.token, 'north-1', 1), { thrown: 'ApiCommandUnauthenticated' });
    },
  );
}
