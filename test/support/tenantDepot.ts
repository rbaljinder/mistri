/** A tenant App deployed as an operator deploys one, for tests that run the
 * real CLI against it: the depot's `item` table in a database of its own on
 * the live PostgreSQL server, tenants north and south, a local sign-in store,
 * its policy and its one command (`touch`), and the config beside them —
 * which a test extends with services. Then a person's way in: sign up over
 * HTTP, a membership the operator grants, a lease on a tenant. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresCommandJournal } from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { TenantStoreAdministration } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, ROOT } from '../appApiCli.js';

interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
export type Reply = { status: number; body: Record<string, any>; headers: Headers };

export async function tenantDepot(t: TestContext, live: string, options: Readonly<{ services?: readonly Record<string, unknown>[] }> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-tenant-depot-'));
  const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const pg = (await import('pg' as string)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: live, statement_timeout: 10000 });
  await control.connect();
  const name = `tw_depot_${randomUUID().replaceAll('-', '')}`;
  await control.query(`CREATE DATABASE "${name}"`);
  cleanup.push(async () => {
    await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await control.end();
  });
  const url = new URL(live);
  url.pathname = `/${name}`;
  const business = url.href;
  const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
  await client.connect();
  cleanup.push(() => client.end());
  await client.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
  const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
  await migratePostgresCommandJournal(business);
  await migratePostgresTenantStore(business, store);
  const administer = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
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
  await administer(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });

  const appDir = join(directory, 'depot');
  mkdirSync(appDir);
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'depot',
      name: 'Depot',
      auth: {
        providers: ['email'],
        signUp: 'open',
        store: join(directory, 'auth.db'),
        rows: 'tenant',
        roles: { member: { read: true, write: ['item'], commands: ['touch'] } },
      },
      sources: { business: { connection: 'data' } },
      resources: {
        item: {
          physical: 'public.physical_item',
          owner: 'tenant',
          access: 'write',
          fields: { read: ['id', 'name', 'version'], write: ['id', 'name'] },
          actions: { touch: { label: 'Touch', command: 'touch' } },
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  const config = join(directory, 'depot.json');
  writeFileSync(
    config,
    JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business, writable: true }, ...(options.services ?? [])] }),
  );
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  const policy = join(directory, 'policy.mjs'),
    commands = join(appDir, 'commands.mjs');
  writeFileSync(
    policy,
    `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'depot', storeId: '${DEPOT_STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true }),
  resultReferences: { touch: () => [] } });
`,
  );
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ touch: defineCommand({ source: 'business', target: 'item',
  input: {}, output: shape({ ok: bool() }), async handle(context) {
    await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { version: Number(context.record.version) + 1 } });
    return { ok: true };
  } }) });
`,
  );

  const call = async (origin: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  type Person = { id: string; cookie: string; email: string };
  /** Signs up on `origin`, and is granted `member` of `tenant`. */
  const member = async (origin: string, who: string, tenant: string): Promise<Person> => {
    const email = `${who}@example.test`;
    const answer = await call(origin, '/api/auth/sign-up/email', { name: who, email, password: 'Disposable-local-password-123!' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const person = {
      id: String((answer.body.user as { id: string }).id),
      cookie: answer.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
      email,
    };
    await administer((admin) =>
      admin.putMembership({
        tenantId: tenant,
        accountId: person.id,
        membershipId: `${tenant}-${who}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 600000,
        expectedVersion: null,
      }),
    );
    return person;
  };
  /** `person`'s lease on `tenant` at `origin`, and a call on it. */
  const lease = async (origin: string, person: Person, tenant: string) => {
    const signed = { cookie: person.cookie, 'x-mistri-account': person.id };
    const opened = await call(origin, `/api/tenant/context/open?app=depot&tenant=${tenant}`, {}, signed);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const headers = {
      ...signed,
      'x-mistri-tab': String(opened.body.tabId),
      'x-mistri-context': String(opened.body.context),
      'x-mistri-lease-revision': String(opened.body.revision),
    };
    return (path: string, body: unknown) => call(origin, `${path}?app=depot&tenant=${tenant}`, body, headers);
  };
  return {
    directory,
    business,
    client,
    administer,
    appDir,
    config,
    policy,
    commands,
    args: ['--config', config, '--app', appDir, '--policy', policy, '--commands', commands],
    cleanup: (step: () => unknown) => cleanup.push(step),
    call,
    member,
    lease,
  };
}
