/**
 * A tenant App's `choose` at the command door (tenant/tenantCommands.ts), on SQLite and on PostgreSQL: a command run
 * for a member is told the row they picked as `ctx.chosen`, and its `where` can say `chosen.site`. The pick is the
 * tab's header, else what the member stored for this tenant, and is re-read under the member's own reader in the
 * tenant the lease names — so a site of another tenant, sent or stored, and a site the member's role cannot read, are
 * not chosen: `ctx.chosen.site` is undefined and the where matches no row, never every row.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import { openPostgresPreferences, provisionPostgresPreferences } from '../packages/mistri/src/adapters/preferences/postgresPreferences.js';
import { openSqlitePreferences, provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { storePick } from '../packages/mistri/src/server/app/appPreferences.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'clinic';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'clinic-choose-store' };

const COMMANDS = ['tally', 'startOnboarding', 'submitOnboarding'];
const nameInput = { full_name: { label: 'Full name', type: 'text', max: 60 } } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const config = {
  id: appId,
  name: 'Clinic',
  auth: {
    rows: 'tenant',
    me: { from: 'person', column: 'account_id' },
    tenancy: { label: 'Clinic group', profile: 'customer', platform: { label: 'Operator' } },
    roles: {
      agent: { realm: 'tenant', read: ['site', 'visit', 'ticket', 'person', 'onboarding'], commands: COMMANDS },
      // A clerk reads visits but no site, so no site is theirs to pick.
      clerk: { realm: 'tenant', read: ['visit', 'ticket', 'person', 'onboarding'], commands: COMMANDS },
      operator: { realm: 'platform', read: true },
    },
  },
  sources: { business: { connection: binding.source.connection } },
  resources: {
    customer: { owner: 'platform' },
    site: { owner: 'tenant' },
    visit: { owner: 'tenant' },
    ticket: { owner: 'tenant', access: 'write' },
    person: { owner: 'tenant' },
    onboarding: { owner: 'tenant', access: 'write' },
  },
  choose: { site: { from: 'site', label: 'name' } },
  views: {
    tickets: { kind: 'list', from: 'ticket', realm: 'tenant' },
    onboard: {
      kind: 'form',
      label: 'Onboarding',
      command: { id: 'submitOnboarding', version: 1, input: submitInput },
      steps: [{ id: 'you', label: 'You', command: { id: 'startOnboarding', version: 1, input: nameInput } }],
      resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
      draft: { status: 'in_progress' },
      owner: 'person_id',
    },
  },
  home: 'tickets',
  nav: [{ id: 'clinic', label: 'Clinic', realm: 'tenant', children: ['tickets', 'onboard'] }],
};

/** What the handler saw: `ctx.chosen`, and the visit ids a `where` naming `chosen.site` matched. */
const seen: Array<{ chosen: Record<string, unknown>; ids: string[] }> = [];
const registry = defineCommands({
  tally: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    read: ['visit'],
    write: ['ticket'],
    input: { id: { type: 'text' } },
    output: { parse: (value: unknown) => value as { id: string } },
    async handle({ db, chosen }, input) {
      const rows = await db.visit.where('site_id = chosen.site');
      seen.push({ chosen: { ...chosen }, ids: rows.map((row) => String(row.id)).sort() });
      await db.ticket.insert({ id: String(input.id), opened_on: '2026-01-01' });
      return { id: String(input.id) };
    },
  }),
  // A signed-in form's step: the same handler context, through the draft door.
  startOnboarding: defineCommand({
    source: 'business',
    target: 'onboarding',
    targets: 'none',
    read: ['visit', 'onboarding', 'person'],
    write: ['onboarding'],
    input: nameInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft, chosen }, input) {
      if (!draft) return refuse('forbidden');
      const rows = await db.visit.where('site_id = chosen.site');
      seen.push({ chosen: { ...chosen }, ids: rows.map((row) => String(row.id)).sort() });
      if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
      else await db.onboarding.insert({ id: randomUUID(), ...input, ...draft.start });
      return { message: 'Saved.' as const };
    },
  }),
  submitOnboarding: defineCommand({
    source: 'business',
    target: 'onboarding',
    targets: 'none',
    read: ['visit', 'onboarding', 'person'],
    write: ['onboarding'],
    input: submitInput,
    output: shape({ message: literal('Saved.') }),
    async handle() {
      return { message: 'Saved.' as const };
    },
  }),
});
const rows: RowScope = { site: true, visit: true, ticket: true, person: true, onboarding: true };
// The tenant's row policy is the App's own: a clerk's holds no site, so none is theirs to pick.
const rowsOf = (principal: { roles: readonly string[] }): RowScope =>
  principal.roles.includes('clerk') ? { visit: true, ticket: true, person: true, onboarding: true } : rows;
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    customer: { kind: 'platform' },
    site: { kind: 'tenant', column: 'tenant_id' },
    visit: { kind: 'tenant', column: 'tenant_id' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
    person: { kind: 'tenant', column: 'tenant_id' },
    onboarding: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: rowsOf,
  resolveRows: rowsOf,
  resultReferences: { tally: () => [], startOnboarding: () => [], submitOnboarding: () => [] },
  resolvePlatformRows: () => ({ ...rows, customer: true }),
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const suffix = `choose_${randomUUID().replaceAll('-', '')}`;
  const tables = `
    CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE site (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE visit (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL REFERENCES site(id), note TEXT);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, opened_on DATE NOT NULL);
    CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
      UNIQUE (tenant_id, account_id));
    CREATE TABLE onboarding (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES person(id), full_name TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    INSERT INTO person VALUES ('north-eve', 'north', 'eve', 'Eve'), ('south-eve', 'south', 'eve', 'Eve'), ('north-zed', 'north', 'zed', 'Zed');
    INSERT INTO customer (id, name) VALUES ('north', 'North'), ('south', 'South');
    INSERT INTO site (id, tenant_id, name) VALUES ('n-hq', 'north', 'HQ'), ('n-annex', 'north', 'Annex'), ('s-hq', 'south', 'HQ');
    INSERT INTO visit (id, tenant_id, site_id, note) VALUES
      ('n-v1', 'north', 'n-hq', 'a'), ('n-v2', 'north', 'n-hq', 'b'), ('n-v3', 'north', 'n-annex', 'c'), ('s-v1', 'south', 's-hq', 'd');`;
  const engine = await openTenantEngine(dialect, {
    tables: ['customer', 'site', 'visit', 'ticket', 'person', 'onboarding'],
    sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;${tables}`,
    postgres: tables,
    database: suffix,
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    if (dialect === 'postgres') await dropDedicatedPostgresDatabase(suffix);
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const [tenantId, accountId, role] of [
      ['north', 'eve', 'agent'],
      ['south', 'eve', 'agent'],
      ['north', 'zed', 'clerk'],
    ] as const)
      await admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: [role],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: null,
      });
  });
  // A fresh App per fixture: the preferences store is opened once per App, beside this fixture's own source.
  const app = parseTestApp(config, 'tenant choose commands fixture');
  const store =
    dialect === 'postgres'
      ? (await provisionPostgresPreferences(engine.url), await openPostgresPreferences(engine.url))
      : (provisionSqlitePreferences(engine.path), openSqlitePreferences(engine.path));
  t.after(() => store.close());
  // What a person's picks were is remembered for a moment, by App id and person, across fixtures in this process: forget
  // what the dialect run before this one left.
  for (const [account, tenant] of [
    ['eve', 'north'],
    ['eve', 'south'],
    ['zed', 'north'],
  ])
    await storePick(app, store, account, tenant, 'site', null);
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'clinic-choose-deployment',
    roles: ['agent', 'clerk'],
    commands: { registry },
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: who.id, who: `${who.id}@example.invalid` }),
  });
  let who = { id: 'eve' };
  const sessionOf = (): VerifiedSessionInstance => ({
    identity: { id: who.id, who: `${who.id}@example.invalid` },
    sessionId: `session-${who.id}`,
    expiresAt: Date.now() + 3_600_000,
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: sessionOf });
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
    owner.server.closeAllConnections();
    await stopped;
    await owner.retire();
    await enrollment.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const leased = async (tenant: string) => {
    const opened = await call(`/api/tenant/context/open?app=${appId}&tenant=${tenant}`, {});
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body as unknown as Context;
    return {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    };
  };
  /* One run: what the handler saw. `chosen` is the tab's header, absent where the tab sends none. */
  /* The same asked through a signed-in form's draft step, which runs the handler in the same context. */
  const step = async (tenant: string, chosen?: string) => {
    seen.length = 0;
    const reply = await call(
      `/api/commands/draft?app=${appId}&tenant=${tenant}`,
      {
        form: 'onboard',
        op: 'step',
        step: 'you',
        request: commandEnvelope({
          command: 'startOnboarding',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          input: { full_name: 'Eve' },
          idempotencyKey: `step-${randomUUID()}`,
        }),
      },
      { ...(await leased(tenant)), ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }) },
    );
    assert.equal(reply.status, 200, reply.text);
    assert.equal(seen.length, 1);
    return seen[0];
  };
  const run = async (tenant: string, chosen?: string) => {
    seen.length = 0;
    const reply = await call(
      `/api/commands/execute?app=${appId}&tenant=${tenant}`,
      {
        command: 'tally',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `tally-${randomUUID()}`,
        input: { id: randomUUID() },
      },
      { ...(await leased(tenant)), ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }) },
    );
    assert.equal(reply.status, 200, reply.text);
    assert.equal(seen.length, 1);
    return seen[0];
  };
  return {
    run,
    step,
    as: (id: string) => {
      who = { id };
    },
    keep: (account: string, tenant: string, value: string) => storePick(app, store, account, tenant, 'site', value),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant command's ctx.chosen (${dialect})`, { skip }, () => {
    test('the header, else the stored pick, read in the lease’s tenant under the member’s own role', async (t) => {
      const { run, as, keep } = await fixture(t, dialect);
      // (a) The header's pick reaches ctx.chosen, and the where is narrowed to that site.
      assert.deepEqual(await run('north', 'site=n-hq'), { chosen: { site: 'n-hq' }, ids: ['n-v1', 'n-v2'] });
      assert.deepEqual(await run('north', 'site=n-annex'), { chosen: { site: 'n-annex' }, ids: ['n-v3'] });
      // A site that is no row is not chosen, so the where matches nothing rather than everything.
      assert.deepEqual(await run('north', 'site=nowhere'), { chosen: { site: undefined }, ids: [] });
      assert.deepEqual(await run('north'), { chosen: { site: undefined }, ids: [] });
      // (b) With no header, what the member stored for this tenant is the default; a header still wins.
      await keep('eve', 'north', 'n-annex');
      assert.deepEqual(await run('north'), { chosen: { site: 'n-annex' }, ids: ['n-v3'] });
      assert.deepEqual(await run('north', 'site=n-hq'), { chosen: { site: 'n-hq' }, ids: ['n-v1', 'n-v2'] });
      // Another tenant's key is no pick here, sent or stored: tenant B's site read as tenant A's is null.
      assert.deepEqual(await run('north', 'site=s-hq'), { chosen: { site: undefined }, ids: [] });
      await keep('eve', 'north', 's-hq');
      assert.deepEqual(await run('north', 'site=s-hq'), { chosen: { site: undefined }, ids: [] });
      assert.deepEqual(await run('north'), { chosen: { site: undefined }, ids: [] });
      await keep('eve', 'south', 'n-hq');
      assert.deepEqual(await run('south', 'site=n-hq'), { chosen: { site: undefined }, ids: [] });
      assert.deepEqual(await run('south'), { chosen: { site: undefined }, ids: [] });
      assert.deepEqual(await run('south', 'site=s-hq'), { chosen: { site: 's-hq' }, ids: ['s-v1'] });
      // (c) A clerk's role reads no site: whatever the tab sends or was stored, nothing is chosen and no row matches.
      as('zed');
      assert.deepEqual(await run('north', 'site=n-hq'), { chosen: { site: undefined }, ids: [] });
      await keep('zed', 'north', 'n-hq');
      assert.deepEqual(await run('north'), { chosen: { site: undefined }, ids: [] });
    });

    test('a signed-in form’s draft step reads the header’s pick and the stored one in the lease’s tenant', async (t) => {
      const { step, keep } = await fixture(t, dialect);
      assert.deepEqual(await step('north', 'site=n-hq'), { chosen: { site: 'n-hq' }, ids: ['n-v1', 'n-v2'] });
      assert.deepEqual(await step('north', 'site=nowhere'), { chosen: { site: undefined }, ids: [] });
      // Another tenant's key is no pick here.
      assert.deepEqual(await step('north', 'site=s-hq'), { chosen: { site: undefined }, ids: [] });
      assert.deepEqual(await step('north'), { chosen: { site: undefined }, ids: [] });
      await keep('eve', 'north', 'n-annex');
      assert.deepEqual(await step('north'), { chosen: { site: 'n-annex' }, ids: ['n-v3'] });
      assert.deepEqual(await step('north', 'site=n-hq'), { chosen: { site: 'n-hq' }, ids: ['n-v1', 'n-v2'] });
      await keep('eve', 'south', 'n-hq');
      assert.deepEqual(await step('south'), { chosen: { site: undefined }, ids: [] });
    });
  });
}
