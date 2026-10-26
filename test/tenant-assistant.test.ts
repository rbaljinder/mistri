/**
 * The in-App assistant in a tenant App (docs/tenant-apps.md, "The assistant"),
 * end to end through the real tenant host (test/support/tenantSupportFixture.ts),
 * on live PostgreSQL when TABLEWALK_TEST_PG names a server and SQLite always.
 *
 * A conversation is one tenant's: kept with it, listed and resumed only in it,
 * and gone with it. Every read the assistant makes is the person's own tenant
 * request on their tab's lease, admitted again per call, so a person removed
 * mid-conversation is refused at the next one, and an id from the other tenant
 * reads as nothing. Whether a tenant has the assistant at all is the platform
 * owner's switch, journaled with its consent reference; a tenant's own admin
 * may turn it off, never on. A support session has no assistant.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ASSISTANT_TABLES } from '../packages/mistri/src/adapters/assistant/assistantStore.js';
import { TENANT_SWITCH_TABLES } from '../packages/mistri/src/adapters/switch/tenantSwitch.js';
import { provisionPostgresAssistant } from '../packages/mistri/src/adapters/assistant/postgresAssistant.js';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import { setAssistantModel, type AssistantModel, type ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { scriptedModel, type AssistantScript } from '../packages/mistri/src/server/assistant/assistantScripted.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { createTenantAssistant } from '../packages/mistri/src/server/tenant/tenantAssistant.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import {
  ADMINISTRATION_HTTP_HEADER as administrationHeader,
  ADMINISTRATION_HTTP_ROOT,
} from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  appId,
  supportManifest,
  tenantSupportFixture,
  type Account,
  type Answer,
  type SupportFixture,
} from './support/tenantSupportFixture.js';

after(() => setAssistantModel(undefined));

const SCRIPT: AssistantScript = {
  turns: [{ when: 'leads', steps: [{ tools: [{ name: 'query', input: { q: 'lead' } }] }, { text: 'Here they are.' }] }],
  otherwise: 'Hello.',
};
interface Event {
  event: string;
  data: any;
}
const of = (events: Event[], kind: string) => events.filter((event) => event.event === kind).map((event) => event.data);

/** The fixture with an assistant, a switch the platform owner holds, and a tenant admin who may turn it off. */
async function assistantFixture(t: Parameters<typeof tenantSupportFixture>[0], dialect: 'sqlite' | 'postgres', cap?: number) {
  setAssistantModel(undefined);
  const tenantPolicy: Record<string, unknown> = {};
  const f = await tenantSupportFixture(t, dialect, {
    manifest: (raw) => Object.assign(raw, { assistant: {} }),
    tenantPolicy,
  });
  const { avery, sam, oscar } = f.accounts;
  // Sam works for both dealers; Oscar is North's own admin.
  const hour = Date.now() + 3_600_000;
  await f.maintenance(async (admin) => {
    await admin.putMembership({
      tenantId: 'south',
      accountId: sam.accountId,
      membershipId: 'south-sam',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil: hour,
      expectedVersion: null,
    });
    await admin.putMembership({
      tenantId: 'north',
      accountId: oscar.accountId,
      membershipId: 'north-oscar',
      status: 'active',
      roles: ['dealer_admin'],
      validUntil: hour,
      expectedVersion: null,
    });
  });
  if (dialect === 'sqlite') provisionSqliteAssistant(f.path);
  else await provisionPostgresAssistant(f.url);
  Object.assign(tenantPolicy, {
    administration: {
      id: 'dealer-management',
      version: 'v1',
      maxMembershipLifetimeMs: 3_600_000,
      operators: [
        { accountId: avery.accountId, tenants: ['north', 'south'], operations: ['setTenantAssistant', 'setTenantStatus'], roles: [] },
      ],
      delegates: [{ role: 'dealer_admin', operations: ['setTenantAssistant'], roles: [] }],
    },
    ...(cap === undefined ? {} : { assistant: { tokensPerTenantPerDay: cap } }),
  });
  const requests: ModelRequest[] = [];
  const model = scriptedModel(SCRIPT);
  const recording: AssistantModel = {
    async stream(request, onText, signal) {
      requests.push(request);
      return model.stream(request, onText, signal);
    },
  };
  setAssistantModel(() => recording);
  t.after(() => setAssistantModel(undefined));
  await f.restart();

  /** A tab's lease in a tenant, as the page opens one. */
  const lease = async (who: Account, tenant: string): Promise<TenantContextReply> => {
    const opened = await f.call(`/api/tenant/context/open?app=${appId}&tenant=${tenant}`, {
      body: {},
      headers: { cookie: who.cookie, [headers.account]: who.accountId },
    });
    assert.equal(opened.status, 200, opened.text);
    return opened.body as unknown as TenantContextReply;
  };
  const leaseHeaders = (who: Account, held: TenantContextReply) => ({
    cookie: who.cookie,
    [headers.account]: who.accountId,
    [headers.app]: appId,
    [headers.tab]: held.tabId,
    [headers.context]: held.context,
    [headers.revision]: String(held.revision),
  });
  /** An assistant request as the panel sends one: the lease, and nothing that names a tenant. */
  const assistant = async (who: Account, held: TenantContextReply, path: string, body?: Record<string, unknown>) => {
    const target = body === undefined ? `${path}${path.includes('?') ? '&' : '?'}app=${appId}` : path;
    const response = await fetch(f.origin + target, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { origin: f.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...leaseHeaders(who, held) },
      ...(body === undefined ? {} : { body: JSON.stringify({ app: appId, ...body }) }),
    });
    const text = await response.text();
    if (!response.headers.get('content-type')?.startsWith('text/event-stream'))
      return { status: response.status, events: [] as Event[], body: text ? JSON.parse(text) : {} };
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }));
    return { status: response.status, events, body: {} };
  };
  const servedApp = async (who: Account, held: TenantContextReply) => {
    const answer = await f.call(`/api/app?app=${appId}&tenant=${held.tenantId}`, { headers: leaseHeaders(who, held) });
    assert.equal(answer.status, 200, answer.text);
    return answer.body.app as Record<string, unknown>;
  };

  /** Manage tenants, as the account opens it. */
  const administration = async (who: Account) => {
    const identity = { cookie: who.cookie, [headers.app]: appId, [headers.account]: who.accountId };
    const opened = await f.call(`${ADMINISTRATION_HTTP_ROOT}/open?app=${appId}`, { body: {}, headers: identity });
    assert.equal(opened.status, 200, opened.text);
    const session = opened.body.session as { context: string } | null;
    assert.ok(session, opened.text);
    const owned = { ...identity, [administrationHeader]: session.context };
    let attempt = 0;
    return {
      tenants: () => f.call(`${ADMINISTRATION_HTTP_ROOT}/tenants?app=${appId}`, { headers: owned }),
      usage: (since?: string) =>
        f.call(`${ADMINISTRATION_HTTP_ROOT}/assistant-usage?app=${appId}${since ? `&since=${since}` : ''}`, { headers: owned }),
      execute: (intent: Record<string, unknown>) =>
        f.call(`${ADMINISTRATION_HTTP_ROOT}/execute?app=${appId}`, {
          body: { idempotencyKey: `${who.accountId}-${++attempt}-${Date.now()}`, intent },
          headers: owned,
        }),
    };
  };
  const version = async (tenantId: string) =>
    String((await f.rows(`SELECT version FROM "${TENANT_TABLES.tenant}" WHERE id = ?`, [tenantId]))[0]?.version);
  /** The platform owner sets a tenant's switch. */
  const setSwitch = async (tenantId: string, enabled: boolean, consent = enabled ? `DPA-${tenantId}-2026` : '', who = avery) => {
    const admin = await administration(who);
    return admin.execute({ operation: 'setTenantAssistant', tenantId, expectedTenantVersion: await version(tenantId), enabled, consent });
  };
  return { f, requests, lease, assistant, servedApp, administration, setSwitch, version };
}
type Harness = Awaited<ReturnType<typeof assistantFixture>>;
const applied = (answer: Answer) => {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.body.outcome, 'applied', answer.text);
  return answer;
};
const count = async (f: SupportFixture, table: string, where = '1 = 1', params: unknown[] = []) =>
  Number((await f.rows(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, params))[0].n);

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(
    `${dialect}: one person in two tenants: no conversation, event or usage row crosses, and a forged id reads as nothing`,
    { skip },
    async (t) => {
      const h: Harness = await assistantFixture(t, dialect);
      const { f, requests } = h,
        { sam } = f.accounts;
      applied(await h.setSwitch('north', true));
      applied(await h.setSwitch('south', true));
      const north = await h.lease(sam, 'north'),
        south = await h.lease(sam, 'south');
      assert.ok((await h.servedApp(sam, north)).assistant);

      const asked = await h.assistant(sam, north, '/api/assistant/turn', { text: 'show me the leads' });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const conversation = of(asked.events, 'conversation')[0]?.id ?? of(asked.events, 'done').at(-1)?.conversation;
      assert.equal(typeof conversation, 'string', JSON.stringify(asked.events));
      // The tool's read was North's own: its lead, never South's.
      const sent = JSON.stringify(requests.at(-1)!.messages);
      assert.match(sent, /North lead/);
      assert.doesNotMatch(sent, /South lead/);

      // In South the history is South's: empty, and North's id reads as nothing however it is asked for.
      assert.deepEqual((await h.assistant(sam, south, '/api/assistant')).body.conversations, []);
      assert.equal((await h.assistant(sam, south, `/api/assistant/conversation?id=${conversation}`)).status, 404);
      assert.equal((await h.assistant(sam, south, '/api/assistant/turn', { conversation, text: 'show me the leads' })).status, 404);
      assert.equal((await h.assistant(sam, south, '/api/assistant/rename', { conversation, title: 'Taken' })).status, 404);
      assert.equal((await h.assistant(sam, south, '/api/assistant/delete', { conversation })).status, 404);
      const southTurn = await h.assistant(sam, south, '/api/assistant/turn', { text: 'show me the leads' });
      assert.equal(southTurn.status, 200);
      const southSent = JSON.stringify(requests.at(-1)!.messages);
      assert.match(southSent, /South lead/);
      assert.doesNotMatch(southSent, /North lead/);

      // A tenant the request names is refused outright: the tenant is the lease's alone.
      const named = await fetch(`${f.origin}/api/assistant?app=${appId}`, {
        headers: {
          origin: f.origin,
          cookie: sam.cookie,
          [headers.account]: sam.accountId,
          [headers.app]: appId,
          [headers.tenant]: 'north',
        },
      });
      assert.equal(named.status, 403);

      // Back in North the conversation is there, whole, and the stores agree row for row.
      const listed = (await h.assistant(sam, north, '/api/assistant')).body.conversations as { id: string }[];
      assert.deepEqual(
        listed.map((each) => each.id),
        [conversation],
      );
      const { conversation: conversations, event, usage } = ASSISTANT_TABLES;
      assert.equal(await count(f, conversations, 'tenant = ?', ['north']), 1);
      assert.equal(await count(f, conversations, 'tenant = ?', ['south']), 1);
      assert.equal((await count(f, event, `conversation IN (SELECT id FROM "${conversations}" WHERE tenant = ?)`, ['south'])) > 0, true);
      assert.equal(await count(f, usage, 'tenant = ?', ['north']), 1);
      assert.equal(await count(f, usage, 'tenant = ?', ['south']), 1);
      assert.equal(await count(f, usage, "tenant NOT IN ('north', 'south')"), 0);

      // The platform owner's usage reads by tenant and day.
      const usageRows = (await (await h.administration(f.accounts.avery)).usage()).body.usage as { rows: { tenantId: string }[] };
      assert.deepEqual(usageRows.rows.map((row) => row.tenantId).sort(), ['north', 'south']);
    },
  );

  test(`${dialect}: a person removed mid-conversation is refused at the next call`, { skip }, async (t) => {
    const h = await assistantFixture(t, dialect);
    const { f } = h,
      { sam } = f.accounts;
    applied(await h.setSwitch('north', true));
    const north = await h.lease(sam, 'north');
    assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'show me the leads' })).status, 200);
    const [{ version: membershipVersion }] = await f.rows(`SELECT version FROM "${TENANT_TABLES.membership}" WHERE id = ?`, ['north-sam']);
    await f.maintenance(async (admin) => {
      await admin.putMembership({
        tenantId: 'north',
        accountId: sam.accountId,
        membershipId: 'north-sam',
        status: 'revoked',
        roles: ['dealer_staff'],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: String(membershipVersion),
      });
    });
    assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'show me the leads' })).status, 403);
    assert.equal((await h.assistant(sam, north, '/api/assistant')).status, 403);
  });

  test(
    `${dialect}: the switch is the platform owner's, journaled with its consent; off, the panel is gone and the turn refused`,
    { skip },
    async (t) => {
      const h = await assistantFixture(t, dialect);
      const { f } = h,
        { sam, oscar, avery } = f.accounts;
      const north = await h.lease(sam, 'north');
      // Off by default.
      assert.equal((await h.servedApp(sam, north)).assistant, undefined);
      assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello' })).status, 403);
      // Turning it on names a consent reference.
      assert.equal((await h.setSwitch('north', true, '   ')).body.outcome, 'not_applied');
      applied(await h.setSwitch('north', true, 'DPA-north-2026'));
      assert.ok((await h.servedApp(sam, north)).assistant);
      assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello' })).status, 200);
      const listing = (await (await h.administration(avery)).tenants()).body.page as { items: { tenantId: string; assistant?: unknown }[] };
      assert.deepEqual(listing.items.find((item) => item.tenantId === 'north')!.assistant, { enabled: true, consent: 'DPA-north-2026' });

      // North's own admin may turn it off, never on.
      applied(await h.setSwitch('north', false, 'Asked by the dealer', oscar));
      assert.equal((await h.servedApp(sam, north)).assistant, undefined);
      assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello' })).status, 403);
      assert.equal((await h.assistant(sam, north, '/api/assistant')).status, 403);
      assert.notEqual((await h.setSwitch('north', true, 'DPA-north-2026', oscar)).body.outcome, 'applied');
      assert.equal((await h.servedApp(sam, north)).assistant, undefined);

      // Every change is journaled: who, when and the consent reference.
      const changes = await f.rows(
        `SELECT r.actor_id, r.completed_at, r.change_json FROM "${journal.receipt}" r
       WHERE r.operation = 'setTenantAssistant' ORDER BY r.completed_at, r.id`,
      );
      assert.equal(changes.length, 2);
      const [on, off] = changes.map((row) => ({
        actor: row.actor_id,
        at: String(row.completed_at),
        change: JSON.parse(String(row.change_json)),
      }));
      assert.equal(on.actor, avery.accountId);
      assert.deepEqual(on.change.after.assistant, { enabled: true, consent: 'DPA-north-2026' });
      assert.deepEqual(on.change.before.assistant, { enabled: false, consent: '' });
      assert.equal(off.actor, oscar.accountId);
      assert.deepEqual(off.change.after.assistant, { enabled: false, consent: 'Asked by the dealer' });
      assert.ok(Date.parse(off.at));
    },
  );

  test(`${dialect}: a switch turned off mid-conversation refuses the next turn before the model is asked`, { skip }, async (t) => {
    const h = await assistantFixture(t, dialect);
    const { f, requests } = h,
      { sam } = f.accounts;
    applied(await h.setSwitch('north', true));
    const north = await h.lease(sam, 'north');
    const first = await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello' });
    assert.equal(first.status, 200);
    const asked = requests.length;
    applied(await h.setSwitch('north', false));
    assert.equal((await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello again' })).status, 403);
    assert.equal(requests.length, asked);
  });

  test(`${dialect}: the per-tenant daily cap holds for the tenant, not for the other`, { skip }, async (t) => {
    const h = await assistantFixture(t, dialect, 1);
    const { f, requests } = h,
      { sam, oscar } = f.accounts;
    applied(await h.setSwitch('north', true));
    applied(await h.setSwitch('south', true));
    const north = await h.lease(sam, 'north');
    assert.deepEqual(of((await h.assistant(sam, north, '/api/assistant/turn', { text: 'hello' })).events, 'note'), []);
    const asked = requests.length;
    // Another person in the same tenant meets the tenant's limit too.
    const oscarNorth = await h.lease(oscar, 'north');
    const capped = await h.assistant(oscar, oscarNorth, '/api/assistant/turn', { text: 'hello' });
    assert.match(of(capped.events, 'note')[0]?.text ?? '', /customer's assistant has reached its limit for today/);
    assert.equal(requests.length, asked);
    // South's day is its own.
    const south = await h.lease(sam, 'south');
    assert.deepEqual(of((await h.assistant(sam, south, '/api/assistant/turn', { text: 'hello' })).events, 'note'), []);
  });

  test(`${dialect}: a support session has no assistant`, { skip }, async (t) => {
    const h = await assistantFixture(t, dialect);
    const { f } = h,
      { olivia } = f.accounts;
    applied(await h.setSwitch('north', true));
    const opened = await f.open(olivia, 'north', 'dealer_staff');
    assert.equal(opened.status, 200, opened.text);
    const support = opened.body.context as TenantContextReply;
    assert.equal(support.realm, 'support');
    const page = await f.call(`/api/app?${new URLSearchParams({ app: appId, realm: 'support', tenant: 'north' })}`, {
      headers: {
        cookie: olivia.cookie,
        [headers.account]: olivia.accountId,
        [headers.tab]: support.tabId,
        [headers.context]: support.context,
        [headers.revision]: String(support.revision),
      },
    });
    assert.equal(page.status, 200, page.text);
    assert.equal((page.body.app as Record<string, unknown>).assistant, undefined);
    assert.equal((await h.assistant(olivia, support, '/api/assistant')).status, 403);
    assert.equal((await h.assistant(olivia, support, '/api/assistant/turn', { text: 'hello' })).status, 403);
  });

  test(`${dialect}: conversations are kept for the retention period and go with their tenant; the bill stays`, { skip }, async (t) => {
    const h = await assistantFixture(t, dialect);
    const { f } = h,
      { sam } = f.accounts;
    applied(await h.setSwitch('north', true));
    applied(await h.setSwitch('south', true));
    for (const tenant of ['north', 'south'])
      assert.equal((await h.assistant(sam, await h.lease(sam, tenant), '/api/assistant/turn', { text: 'hello' })).status, 200);
    const { conversation, event, usage } = ASSISTANT_TABLES;
    const switches = TENANT_SWITCH_TABLES.tenant;

    // Within the period nothing goes; past it, every untouched conversation does.
    const app = parseAppConfig({ ...supportManifest(f.path), assistant: {} }, 'retention');
    const where = dialect === 'sqlite' ? { path: f.path } : { url: f.url };
    const unused = () => assert.fail('the purge makes no request');
    const today = createTenantAssistant({ app, dispatch: unused, binding: unused, where, policy: { retentionDays: 30 } });
    t.after(() => today.close());
    assert.equal(await today.purge(), 0);
    assert.equal(await count(f, conversation), 2);

    // Closing a tenant deletes its conversations and switch with it; its token counts stay.
    applied(
      await (
        await h.administration(f.accounts.avery)
      ).execute({ operation: 'setTenantStatus', tenantId: 'south', expectedTenantVersion: await h.version('south'), status: 'closed' }),
    );
    assert.equal(await count(f, conversation, 'tenant = ?', ['south']), 0);
    assert.equal(await count(f, switches, 'tenant = ?', ['south']), 0);
    assert.equal(await count(f, event, `conversation NOT IN (SELECT id FROM "${conversation}")`), 0);
    assert.equal(await count(f, usage, 'tenant = ?', ['south']), 1);
    assert.equal(await count(f, conversation, 'tenant = ?', ['north']), 1);

    const later = createTenantAssistant({
      app,
      dispatch: unused,
      binding: unused,
      where,
      policy: { retentionDays: 30 },
      now: () => Date.now() + 31 * 86_400_000,
    });
    t.after(() => later.close());
    assert.equal(await later.purge(), 1);
    assert.equal(await count(f, conversation), 0);
    assert.equal(await count(f, event), 0);
    assert.equal(await count(f, usage, 'tenant = ?', ['north']), 1);
  });
}
