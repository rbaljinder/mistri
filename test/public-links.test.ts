/**
 * A command's link to a public view (`context.publicLink`, server/links/publicLink.ts), as a dialect matrix: SQLite
 * always, PostgreSQL live-gated, on a database of this suite's own.
 *
 * What is proved: a handler names only a view a signed-out visitor opens (a public form, a public page, a list the
 * public grant reads), refused at the call otherwise; the receipt and the outbox keep `mistri-public:<view>.<seal>`, never a
 * URL; it is said as a URL only where it is delivered — the answer, an effect's POST — against the server's own
 * address in an ordinary App, and in a tenant App against the tenant's host with its intake address as `via`, read
 * as it stands at delivery, so an address rotated after the command ran is the one sent. A job's command links the
 * same way. With no address known an answer keeps the reference and an effect is rejected, as a capability link's is.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandEventsFor } from '../packages/mistri/src/server/commands/appCommandEvents.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { post } from '../packages/mistri/src/server/commands/commandEffects.js';
import { id, literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { effectDeployment, openEffectHost } from '../packages/mistri/src/server/effects/effectHost.js';
import { defineJob, defineJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import {
  appPublicUrl,
  configurePublicLinks,
  holdsPublicRef,
  PublicLinkRef,
  publicLinkCallProblems,
  publicLinkKind,
  publicLinkTo,
  renderPublicRefs,
  sayPublicLinks,
  tenantPublicLinks,
  withAppPublicUrls,
  withoutPublicRefs,
  withPublicUrls,
} from '../packages/mistri/src/server/links/publicLink.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { openTenantIntegrations } from '../packages/mistri/src/server/tenant/tenantIntegrations.js';
import { openTenantJobHost } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { openWebhook, webhookConnectionOf } from '../packages/mistri/src/server/webhooks.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

/* This suite's own PostgreSQL database, beside the server's: a run of it next to another never resets its tables. */
const DATABASE = `public_links_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

type Row = Record<string, unknown>;

/** A loopback webhook receiver: the bodies it was posted. */
async function hookServer(t: TestContext): Promise<{ url: string; bodies: Row[] }> {
  const bodies: Row[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(body) as Row);
      response.writeHead(204).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, bodies };
}

/* ---------- the ordinary App ---------- */

const shopManifest = (patch: Record<string, unknown> = {}) => ({
  id: 'shop',
  name: 'Shop',
  sources: { shop: { connection: 'private-db' } },
  resources: { vehicle: { physical: 'db_item', access: 'write' }, note: { physical: 'db_note' } },
  auth: { roles: { staff: { read: true, commands: ['reserve'] } }, public: { read: ['vehicle'] } },
  views: { vehicles: { kind: 'list', from: 'vehicle' }, notes: { kind: 'list', from: 'note' } },
  home: 'vehicles',
  ...patch,
});

describe('which views a public link opens, and what it is until it is delivered', () => {
  test('a list the public grant reads is a room; a list it does not, an unknown view, or a tenant App with no public view is none', () => {
    const shop = parseAppConfig(shopManifest(), 'shop');
    assert.equal(publicLinkKind(shop, 'vehicles'), 'room');
    assert.equal(publicLinkKind(shop, 'notes'), undefined);
    assert.equal(publicLinkKind(shop, 'nope'), undefined);
    // An App with no sign-in is open throughout.
    const open = parseAppConfig({ ...shopManifest(), auth: undefined }, 'open');
    assert.equal(publicLinkKind(open, 'notes'), 'room');
    // A tenant App always signs in: its lists open to members alone, and its public form is the one way in.
    assert.equal(publicLinkKind(tenantApp, 'leads'), undefined);
    assert.equal(publicLinkKind(tenantApp, 'apply'), 'form');
  });

  test('a view that is not public is refused at the call, naming it; an unknown one is named as unknown', () => {
    const shop = parseAppConfig(shopManifest(), 'shop');
    assert.throws(() => publicLinkTo(shop, 'notes'), {
      name: 'TypeError',
      message:
        'publicLink("notes"): "notes" is not a public view of shop. A public link opens a public form, a public page or a list the public grant reads.',
    });
    assert.throws(() => publicLinkTo(shop, 'nope'), { name: 'TypeError', message: 'publicLink("nope"): shop has no view "nope".' });
    const ref = publicLinkTo(shop, 'vehicles');
    assert.ok(ref instanceof PublicLinkRef);
    assert.match(String(ref), /^mistri-public:vehicles\.[A-Za-z0-9_-]{22}$/, 'the view, sealed by the App that made it');
    assert.equal(JSON.stringify({ at: ref }), JSON.stringify({ at: String(ref) }));
  });

  test('a handler naming a view no visitor opens, as a literal, is said by `check`; a computed one is left to the call', () => {
    const shop = parseAppConfig(shopManifest(), 'shop');
    const command = (handle: (context: { publicLink(view: string): unknown }) => unknown) =>
      defineCommand({
        source: 'shop',
        target: 'vehicle',
        targets: 'none',
        input: {},
        output: shape({ at: text() }),
        handle: handle as never,
      });
    const views = ['vehicles', 'notes'];
    const registry = defineCommands({
      fine: command(({ publicLink }) => ({ at: publicLink('vehicles') })),
      // publicLink('notes') in a comment is not a call
      quiet: command(({ publicLink }) => /* publicLink("nope") */ ({ at: publicLink(`vehicles`) })),
      computed: command(({ publicLink }) => ({ at: publicLink(views[1]!) })),
      hidden: command((context) => ({ at: context.publicLink('notes'), again: context.publicLink('notes') })),
      missing: command(({ publicLink }) => ({ at: publicLink('nope') })),
    });
    assert.deepEqual(publicLinkCallProblems(shop, registry), [
      'command "hidden" links to "notes" with publicLink, which is not a public view of shop [public-link-not-public]: ' +
        'a public link opens a public form, a public page or a list the public grant reads. Make "notes" public, or link to a view that is.',
      'command "missing" links to "nope" with publicLink, and shop has no view "nope" [public-link-not-public]. Name one of its public views.',
    ]);
    const { hidden: _hidden, missing: _missing, ...called } = registry;
    assert.deepEqual(publicLinkCallProblems(shop, called), [], 'a computed view is judged where it is called');
  });

  test('a reference ends at its view key, so a sentence can carry one; one that does not render is kept only where asked', async () => {
    // The key's own dots are escaped: the sentence's full stop is not part of it.
    const ref = String(new PublicLinkRef('apply.now', 'shop'));
    assert.match(ref, /^mistri-public:apply%2Enow\.[A-Za-z0-9_-]{22}$/, 'the reference carries its seal');
    const said = `Apply at ${ref}. Or ${ref}!`;
    const views: string[] = [];
    const render = async (view: string) => (views.push(view), view === 'apply.now' ? 'https://x.test/apply' : undefined);
    assert.equal(await renderPublicRefs(said, 'shop', render), 'Apply at https://x.test/apply. Or https://x.test/apply!');
    assert.deepEqual(views, ['apply.now'], 'one view is said once');
    const other = String(new PublicLinkRef('other', 'shop'));
    assert.equal(await renderPublicRefs(`see ${other}`, 'shop', render), undefined, 'strict: a reference with no URL fails the text');
    assert.equal(await renderPublicRefs(`see ${other}`, 'shop', render, true), `see ${other}`);
    assert.equal(await renderPublicRefs('nothing to say', 'shop', render), 'nothing to say');
    assert.deepEqual(await withPublicUrls({ a: [ref], b: 1 }, 'shop', render), { a: ['https://x.test/apply'], b: 1 });
  });

  test('a look-alike a visitor typed is the text it is: never said as a URL, never a reason to refuse delivery', async () => {
    const render = async (view: string) => (view === 'apply' ? 'https://x.test/apply' : undefined);
    const forged = [
      'mistri-public:apply',
      'mistri-public:nope',
      `mistri-public:apply.${'A'.repeat(22)}`,
      String(new PublicLinkRef('apply', 'another App')),
    ];
    for (const typed of forged) {
      const text = `Please call me. ${typed}`;
      assert.equal(holdsPublicRef(text, 'shop'), false, typed);
      assert.equal(await renderPublicRefs(text, 'shop', render), text, typed);
      assert.equal(await sayPublicLinks(text, 'shop', render, undefined), text, typed);
    }
    // Beside a reference the App made, the look-alike stays literal and the minted one renders.
    const minted = String(new PublicLinkRef('apply', 'shop'));
    assert.equal(
      await renderPublicRefs(`Typed mistri-public:apply; ours ${minted}`, 'shop', render),
      'Typed mistri-public:apply; ours https://x.test/apply',
    );
  });

  test("an ordinary App's answer says it under the address the server was started on, and keeps the reference with none", async () => {
    const shop = parseAppConfig(shopManifest(), 'shop');
    const answer = { listing: String(publicLinkTo(shop, 'vehicles')) };
    assert.equal(appPublicUrl(shop, 'vehicles'), undefined);
    assert.deepEqual(await withAppPublicUrls(shop, answer), answer, 'no address: the reference, as an unrendered capability link');
    const stop = configurePublicLinks('shop', (path) => `https://shop.example.test/base${path}`);
    try {
      assert.equal(appPublicUrl(shop, 'notes'), undefined);
      assert.deepEqual(await withAppPublicUrls(shop, answer), { listing: 'https://shop.example.test/base/shop/vehicles' });
    } finally {
      stop();
    }
    assert.equal(appPublicUrl(shop, 'vehicles'), undefined, 'a stopped server says none');
  });
});

const reserveOutput = shape({ id: id(), status: literal('reserved'), listing: text() });
const shopCommands = defineCommands({
  reserve: defineCommand({
    source: 'shop',
    target: 'vehicle',
    when: 'status = available',
    input: {},
    output: reserveOutput,
    effects: { notify: post<{ listing: string }>('dealer-hooks', (result) => ({ listing: result.listing })) },
    async handle({ db, record, publicLink }) {
      const updated = await db.vehicle.update(record!, { status: 'reserved' });
      return { id: updated.id as number, status: 'reserved' as const, listing: publicLink('vehicles') };
    },
  }),
});
// A free text output takes the reference as it is (above); a literal output does not, since no URL is one of its words.
void (() =>
  defineCommand({
    source: 'shop',
    target: 'vehicle',
    input: {},
    output: reserveOutput,
    // @ts-expect-error a literal output is never a link
    async handle({ publicLink }) {
      return { id: 1, status: publicLink('vehicles'), listing: '' };
    },
  }));

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`public links in an ordinary App on ${dialect}`, { skip }, () => {
    test('the receipt keeps the reference; the answer and the delivered effect say the URL; with no address the delivery is rejected', async (t) => {
      const setup = `CREATE TABLE db_item (id INTEGER PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
        INSERT INTO db_item VALUES (1, 'available', 0), (2, 'available', 0);
        CREATE TABLE db_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL);`;
      const engine = await openTenantEngine(dialect, {
        tables: ['db_item', 'db_note'],
        sqlite: setup,
        postgres: setup,
        database: DATABASE,
      });
      const registry = new Registry();
      t.after(async () => {
        await registry.closeAll();
        await engine.close();
      });
      const hooks = await hookServer(t);
      await engine.migrateCommandJournal();
      const target = dialect === 'sqlite' ? { sqlite: engine.path } : { postgres: engine.url };
      await provisionStores(target, { app: { id: 'shop', commands: shopCommands } });
      registry.add({ id: 'private-db', name: 'Shop', url: engine.path || engine.url, writable: true, source: 'config' });
      const manifest = shopManifest();
      manifest.resources = { vehicle: { physical: engine.id('db_item'), access: 'write' }, note: { physical: engine.id('db_note') } };
      const app = parseAppConfig(manifest, 'public links fixture');
      const resources = await loadAppRuntimeResources(registry, app, 'private-db');
      const events = await appCommandEventsFor(app, shopCommands, resources, (id) => registry.configOf(id)?.url);
      const binding = bindBusinessCommands({ app, registry: shopCommands, resources, writableConnection: () => true, events });
      // Load refuses a handler naming, as a literal, a view no visitor opens: by command and view, before any run throws.
      const peek = defineCommand({
        source: 'shop',
        target: 'vehicle',
        targets: 'none',
        input: {},
        output: shape({ at: text() }),
        handle: async ({ publicLink }) => ({ at: publicLink('notes') }),
      });
      assert.throws(
        () => validateBusinessCommandReferences(app, defineCommands({ ...shopCommands, peek }), resources),
        /command "peek" links to "notes" with publicLink, which is not a public view of shop \[public-link-not-public\]/,
      );
      assert.doesNotThrow(() => validateBusinessCommandReferences(app, shopCommands, resources));
      const reserve = (key: number) =>
        executeBusinessCommand(
          binding,
          { id: 'account-a', appId: 'shop', roles: ['staff'] },
          {
            command: 'reserve',
            commandVersion: 1,
            key: { id: key },
            expectedVersion: 0,
            idempotencyKey: `public-link-reserve-${key}`,
            input: {},
          },
        );
      const webhooks = new Map([
        ['dealer-hooks', openWebhook(webhookConnectionOf({ name: 'dealer-hooks', kind: 'webhook', url: hooks.url }, 'test'))],
      ]);
      const host = await openEffectHost({
        deployment: effectDeployment({ appId: 'shop', commands: shopCommands })!,
        target,
        webhooks,
        publicLinks: (view) => Promise.resolve(appPublicUrl(app, view)),
      });
      t.after(() => host.stop());

      const stop = configurePublicLinks('shop', (path) => `https://shop.example.test${path}`);
      let stopped = false;
      t.after(() => {
        if (!stopped) stop();
      });
      const first = await reserve(1);
      const listing = String(new PublicLinkRef('vehicles', app.id));
      assert.deepEqual(first.result, { id: 1, status: 'reserved', listing }, 'the receipt keeps the reference');
      assert.deepEqual(await withAppPublicUrls(app, first.result), {
        id: 1,
        status: 'reserved',
        listing: 'https://shop.example.test/shop/vehicles',
      });
      const stored = await engine.all(`SELECT envelope_json FROM "${COMMAND_EVENT_TABLES.event}"`);
      assert.match(
        String(stored[0]!.envelope_json),
        /mistri-public:vehicles\.[A-Za-z0-9_-]{22}/,
        'the outbox keeps the reference, never a URL',
      );
      await host.tick();
      assert.deepEqual(
        hooks.bodies.map((body) => body.payload),
        [{ listing: 'https://shop.example.test/shop/vehicles' }],
      );

      // A server with no address: the answer keeps the reference, and an effect that would carry it is rejected.
      stop();
      stopped = true;
      const second = await reserve(2);
      assert.deepEqual(await withAppPublicUrls(app, second.result), { id: 2, status: 'reserved', listing });
      await host.tick();
      assert.equal(hooks.bodies.length, 1, 'nothing is sent with a reference its recipient cannot open');
    });
  });

/* ---------- the tenant App ---------- */

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'public-links-store' };
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-BBBBBBBBBBBBBBBB',
  ROTATED = 'rotated-intake-GGGGGGGGGGGGGG';
const HOUR = 3_600_000;
const SCHEMA = {
  tables: ['lead', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL);`,
};
const ROWS = `INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', '${SOUTH}');`;

const tenantApp = parseTestApp(
  {
    id: binding.appId,
    name: 'Lending',
    sources: { business: { connection: binding.source.connection } },
    resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
      roles: {
        staff: { realm: 'tenant', read: true, commands: ['invite'] },
        clock: { realm: 'tenant', read: true, service: true, commands: ['remind'] },
      },
    },
    views: {
      leads: { kind: 'list', from: 'lead' },
      apply: {
        kind: 'form',
        label: 'Apply for financing',
        public: true,
        command: { id: 'apply', version: 1, input: { name: { type: 'text' } } },
      },
    },
    home: 'leads',
  },
  'lending.ts',
);
const linked = shape({ apply: text() });
const invitation = post<{ apply: string }>('dealer-hooks', (value) => ({ apply: value.apply }));
const tenantCommands = defineCommands({
  apply: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    public: true,
    input: { name: { label: 'Name', type: 'text', max: 80 } },
    output: shape({ reference: text(), message: literal('Application received.') }),
    async handle({ db }, value) {
      const id = randomUUID();
      await db.lead.insert({ id, name: value.name });
      return { reference: id, message: 'Application received.' as const };
    },
  }),
  // A member's invitation: the answer and the dealer's webhook carry the dealer's own application form.
  invite: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    input: {},
    output: linked,
    effects: { notify: invitation },
    async handle({ publicLink }) {
      return { apply: publicLink('apply') };
    },
  }),
  // The same, from a job run as the tenant's service.
  remind: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    input: {},
    output: linked,
    effects: { notify: invitation },
    async handle({ publicLink }) {
      return { apply: publicLink('apply') };
    },
  }),
});
const tenantJobs = defineJobs(
  { remindDaily: defineJob({ every: '@daily', realm: 'tenant', runAs: 'reminders', command: 'remind' }) },
  {
    principals: { reminders: { roles: ['clock'] } },
    store: { namespace: 'public-links', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } },
  },
);
/* The reference a lending command makes to its public form: the view, sealed by the App. */
const APPLY_REF = () => String(new PublicLinkRef('apply', binding.appId));
const tenantPolicy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ dealer: true, lead: true }),
  resolveRows: () => ({ dealer: true, lead: true }),
  resolvePlatformRows: () => ({ dealer: true, lead: true }),
  resultReferences: { apply: () => [], invite: () => [], remind: () => [] },
  intake: { address: 'intake_address' },
});

type Request = { readonly account: string };
/* North is reached on its own host; south on the shared one. */
const ORIGINS: Record<string, string> = { north: 'https://north.example.test' };
const tenantOrigin = (tenant: string) => ORIGINS[tenant] ?? 'https://lending.example.test';

async function lending(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  let enrollment: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await enrollment?.retire();
    } finally {
      await engine.close();
    }
  });
  const hooks = await hookServer(t);
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  // As tenant-integrations.test.ts provisions: the jobs module's stores, then the effects' deliveries.
  const stores = dialect === 'sqlite' ? { sqlite: engine.path } : { postgres: engine.url };
  await provisionStores(stores, { app: { tenant: binding, commands: tenantCommands }, jobs: tenantJobs });
  await provisionStores(stores, { app: { tenant: binding, commands: tenantCommands } });
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId,
        accountId: 'ada',
        membershipId: `${tenantId}-ada`,
        roles: ['staff'],
        status: 'active',
        validUntil: Date.now() + HOUR,
        expectedVersion: null,
      });
    }
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  enrollment = await createTenantEnrollment<Request>({
    app: tenantApp,
    policy: tenantPolicy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation-1',
    roles: ['staff', 'clock'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: tenantCommands },
    jobs: { module: tenantJobs },
  });
  const enrolled = enrollment;
  // As the server composes it (tenantAuthenticatedHttp.ts): the tenant's host, the mount, the addresses as they stand.
  const render = tenantPublicLinks(tenantApp, { origin: tenantOrigin, outward: (path) => path, addresses: enrolled.addresses });
  const integrations = await openTenantIntegrations({
    enrollment: enrolled,
    webhookConfig: (name) => (name === 'dealer-hooks' ? webhookConnectionOf({ name, kind: 'webhook', url: hooks.url }, 'test') : undefined),
    warn: () => {},
    publicLinks: render,
  });
  assert.ok(integrations, 'a deployment with effects opens its delivery');
  t.after(() => integrations.stop());
  const clock = { now: Date.now() };
  const jobs = await openTenantJobHost(enrolled, { now: () => clock.now, idleMs: 60_000 });
  assert.ok(jobs, 'an enrollment with jobs opens a host');
  t.after(() => jobs.stop());
  const invite = async (tenant: string) =>
    (
      await enrolled.deployment.execute({ account: 'ada' }, [tenant], {
        command: 'invite',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        input: {},
      })
    ).result as Row;
  const answer = async (tenant: string) => ({ ...(await invite(tenant)) });
  const settle = async () => {
    for (let step = 0; step < 20 && (await integrations.tick()); step++);
  };
  const delivered = () => hooks.bodies.map((body) => ({ tenant: body.tenant, command: body.command, payload: body.payload }));
  return { engine, enrollment: enrolled, render, invite: answer, settle, delivered, jobs };
}

const formUrl = (origin: string, address: string) => `${origin}/lending/form/apply?via=${encodeURIComponent(address)}`;

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`public links in a tenant App on ${dialect}`, { skip }, () => {
    test("a member's command answers and posts the tenant's own form at its host, by its intake address", async (t) => {
      const f = await lending(t, dialect);
      const north = await f.invite('north'),
        south = await f.invite('south');
      assert.deepEqual(north, { apply: APPLY_REF() }, 'the receipt names the view, never a tenant or an address');
      // The answer, as the server renders it for the request's tenant.
      assert.deepEqual(await withPublicUrls(north, binding.appId, (view) => f.render(view, 'north')), {
        apply: formUrl('https://north.example.test', NORTH),
      });
      assert.deepEqual(await withPublicUrls(south, binding.appId, (view) => f.render(view, 'south')), {
        apply: formUrl('https://lending.example.test', SOUTH),
      });
      // A member list is not a public view, and the platform has no tenant to say one for.
      assert.equal(await f.render('leads', 'north'), undefined);
      assert.equal(await f.render('apply', undefined), undefined);
      await f.settle();
      assert.deepEqual(
        f.delivered().sort((a, b) => String(a.tenant).localeCompare(String(b.tenant))),
        [
          { tenant: 'north', command: 'invite', payload: { apply: formUrl('https://north.example.test', NORTH) } },
          { tenant: 'south', command: 'invite', payload: { apply: formUrl('https://lending.example.test', SOUTH) } },
        ],
      );
    });

    test("a job's command, run as the tenant's service, links the same way", async (t) => {
      const f = await lending(t, dialect);
      assert.equal((await f.jobs.runNow('remindDaily', 10_000, 'north')).state, 'succeeded');
      await f.settle();
      // The host may also have run its own due occurrence for each tenant; every one says its own tenant's form.
      const sent = f.delivered();
      assert.ok(sent.some((body) => body.tenant === 'north'));
      for (const body of sent)
        assert.deepEqual(body, {
          tenant: body.tenant,
          command: 'remind',
          payload: {
            apply: body.tenant === 'north' ? formUrl('https://north.example.test', NORTH) : formUrl('https://lending.example.test', SOUTH),
          },
        });
    });

    test('an address rotated after the command ran is the one delivered, and a tenant with none sends nothing', async (t) => {
      const f = await lending(t, dialect);
      const answer = await f.invite('north');
      await f.engine.exec(`UPDATE dealer SET intake_address = '${ROTATED}' WHERE id = 'north'`);
      assert.deepEqual(await withPublicUrls(answer, binding.appId, (view) => f.render(view, 'north')), {
        apply: formUrl('https://north.example.test', ROTATED),
      });
      await f.settle();
      assert.deepEqual(f.delivered(), [
        { tenant: 'north', command: 'invite', payload: { apply: formUrl('https://north.example.test', ROTATED) } },
      ]);
      // South withdraws its address: an answer keeps the reference, and the effect is rejected rather than sent bare.
      await f.engine.exec(`UPDATE dealer SET intake_address = NULL WHERE id = 'south'`);
      const south = await f.invite('south');
      assert.deepEqual(await withPublicUrls(south, binding.appId, (view) => f.render(view, 'south')), { apply: APPLY_REF() });
      await f.settle();
      assert.equal(f.delivered().length, 1);
    });
  });

describe('a message whose links cannot be said keeps its words', () => {
  const ref = (view: string) => String(new PublicLinkRef(view, 'shop'));
  test('each reference the App made is said as nothing, with the space and punctuation around it tidied', () => {
    assert.equal(withoutPublicRefs(`Thanks! Apply at ${ref('apply')}.`, 'shop'), 'Thanks! Apply at.');
    assert.equal(withoutPublicRefs(`Book (${ref('visit')}) or call ${ref('call')} today`, 'shop'), 'Book or call today');
    assert.equal(withoutPublicRefs(ref('apply'), 'shop'), '');
    assert.ok(!withoutPublicRefs(`${ref('apply')} and ${ref('apply')}`, 'shop').includes('mistri-public:'));
  });
  test("a message with no reference, a typed look-alike or another App's reference is left as it is", () => {
    assert.equal(withoutPublicRefs('Thanks, we  will call.', 'shop'), 'Thanks, we  will call.');
    assert.equal(withoutPublicRefs('Typed: mistri-public:apply ( ) .', 'shop'), 'Typed: mistri-public:apply ( ) .');
    const other = `See ${new PublicLinkRef('apply', 'other')}`;
    assert.equal(withoutPublicRefs(other, 'shop'), other);
  });
});
