import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { fromRecord } from '../packages/mistri/src/shared/branding.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { themePreset } from '../packages/engine/src/shared/themePresets.js';
import { APP_ICON_GLYPHS } from '../packages/engine/src/shared/iconGlyphs.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { closeRecordBranding } from '../packages/mistri/src/server/http/recordBranding.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { retireDevClient } from '../packages/engine/src/server/devclient.js';
import type { AppHost, LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { cardRequest, cardVersion, drawShareCardsWith, shareCard, type ShareCard } from '../packages/mistri/src/server/http/shareCard.js';
import { inInter, loadCardDrawing } from '../packages/mistri/src/server/http/shareCardDraw.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';

/* Every card a route drew, in place of satori and resvg: what a card would say is what these tests read. */
const drawn: ShareCard[] = [];
const STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const recording = () => {
  drawn.length = 0;
  drawShareCardsWith(async () => async (card) => {
    drawn.push(card);
    return STUB;
  });
};
const cardOf = (etag: string | string[] | undefined) => drawn.find((card) => `"${cardVersion(card)}"` === etag);

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
type Ask = (path: string, options?: { host?: string; headers?: Record<string, string> }) => Promise<Reply>;
const asker =
  (port: number): Ask =>
  (path, { host = '127.0.0.1', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host, 'accept-encoding': 'identity', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('latin1') }));
      });
      req.on('error', reject);
      req.end();
    });
const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(html)?.[1]?.replace(/&amp;/g, '&');
/** The card a page names, as the path a fetch asks for. */
const cardPath = (html: string) => {
  const image = meta(html, 'og:image');
  return image?.includes('/api/og?') ? image.slice(image.indexOf('/api/og?')) : undefined;
};

test('a card is drawn from words and the look: the App accent, a plain colour only, the mark only from an icon', () => {
  // An App that names no look is drawn in Workshop's.
  const look = themePreset('workshop')!.light;
  const plain = shareCard({ site: 'Lot', title: '  Toyota \n Corolla ', ui: {} })!;
  assert.deepEqual(plain, {
    site: 'Lot',
    title: 'Toyota Corolla',
    ground: look.ground,
    ink: look.ink,
    muted: look.inkMuted,
    accent: look.accent,
  });
  const own = shareCard({
    site: 'Lot',
    title: 'Toyota',
    summary: 'Toyota',
    ui: { logo: 'car', theme: { preset: 'sage', accent: '#7a1f5c' } },
  })!;
  assert.equal(own.accent, '#7a1f5c');
  assert.equal(own.ground, themePreset('sage')!.light.ground);
  assert.equal(own.summary, undefined, 'a summary that only repeats the title is left off');
  assert.deepEqual(own.mark, APP_ICON_GLYPHS.car[1]);
  // A look's CSS expression is not a colour the renderer reads: that role is the default look's.
  assert.equal(shareCard({ site: 'Lot', title: 'x', ui: { theme: { accent: 'color-mix(in srgb, red 50%, blue)' } } })!.accent, look.accent);
  assert.equal(shareCard({ site: 'Lot', title: '   ', ui: {} }), undefined);
  assert.equal(shareCard({ site: 'Lot', title: 'x'.repeat(300), ui: {} })!.title.length, 110);
  assert.notEqual(cardVersion(plain), cardVersion({ ...plain, title: 'Toyota Corolla LE' }));
  assert.match(cardVersion(plain), /^[0-9a-f]{32}$/);
  assert.equal(inInter('Crème brûlée — Łódź 日本').normalize('NFC'), 'Crème brûlée — ódź');
});

test('the route reads one inside address and a hash, and nothing else', () => {
  const at = (query: string) => cardRequest(new URL(`http://x/api/og?${query}`));
  assert.equal(at('path=%2Flot%2Fvehicles%2F1')?.inside.pathname, '/lot/vehicles/1');
  assert.equal(at(`path=%2Flot%2Fvehicles%3Ftab%3Dall&v=${'a'.repeat(32)}`)?.inside.search, '?tab=all');
  for (const refused of [
    '',
    'path=lot',
    'path=%2F%2Fevil.test%2Fx',
    'path=%2Fapi%2Fapp',
    'path=%2Fx&v=zz',
    'path=%2Fx&tenant=south',
    'path=%2Fx&path=%2Fy',
  ])
    assert.equal(at(refused), undefined, refused);
});

test('satori and resvg, present, draw a 1200×630 PNG in Inter', { timeout: 60_000 }, async () => {
  const draw = await loadCardDrawing();
  assert.ok(draw, 'satori and @resvg/resvg-js are devDependencies');
  const png = await draw(
    shareCard({ site: 'Forecourt', title: '2024 Toyota Corolla LE', summary: 'Silver, one owner.', ui: { logo: 'car' } })!,
  );
  const bytes = Buffer.from(png);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 630]);
});

/* A lot anyone may browse: vehicles and dealers read signed out (a dealer's email is not), inquiries only by staff. */
const LOT = {
  id: 'lot',
  name: 'Lot',
  connection: 'lot-db',
  resources: { vehicle: {}, dealer: {}, inquiry: {} },
  auth: {
    roles: { staff: { read: true } },
    public: { read: ['vehicle', 'dealer'], fields: { dealer: { read: ['id', 'name'] } } },
  },
  ui: { logo: 'car', theme: { preset: 'lumen', accent: '#7a1f5c' } },
  views: {
    vehicles: { kind: 'list', from: 'vehicle', label: 'Vehicles' },
    dealers: { kind: 'list', from: 'dealer', label: 'Dealers' },
    inquiries: { kind: 'list', from: 'inquiry', label: 'Inquiries' },
  },
  home: [{ view: 'vehicles', signedOut: true }, { view: 'inquiries' }],
  nav: ['vehicles', 'dealers', 'inquiries'],
};
const LOT_SQL = `CREATE TABLE dealer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE vehicle (id INTEGER PRIMARY KEY, make TEXT NOT NULL, price INTEGER, dealer_id INTEGER REFERENCES dealer(id));
  CREATE TABLE inquiry (id INTEGER PRIMARY KEY, vehicle_id INTEGER REFERENCES vehicle(id), email TEXT NOT NULL);
  INSERT INTO dealer VALUES (1, 'North Motors', 'sales@north.test'); INSERT INTO vehicle VALUES (1, 'Toyota', 14500, 1);
  INSERT INTO inquiry VALUES (1, 1, 'buyer@example.test');`;

async function lot(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-card-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(LOT_SQL);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'lot-db', name: 'Lot', url: file, source: 'config' });
  const app = parseAppConfig(LOT, 'card fixture');
  const pages = parsePagesConfig({ pages: [] }, 'card pages');
  const session = { staff: false };
  const host: AppHost = {
    app: { path: 'lot.ts', app, pages, sources: {} },
    pages,
    auth: {
      spec: app.auth!,
      store: 'unused',
      handler: async () => {},
      close: async () => {},
      session: async () => (session.staff ? { id: 'staff-1', who: 'staff@lot.test', role: 'staff' } : null),
    },
  };
  const server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, apps: [host], pages });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retireDevClient(server);
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ask: asker((server.address() as { port: number }).port), session };
}

test(
  "a public record's page names its card, and the card is content-addressed: an ETag, a year for its hash, five minutes for any other",
  { timeout: 60_000 },
  async (t) => {
    recording();
    const { ask } = await lot(t);
    const page = await ask('/vehicles/1');
    assert.equal(page.status, 200);
    const path = cardPath(page.body);
    assert.ok(path, `og:image names a card: ${meta(page.body, 'og:image')}`);
    assert.match(path, /^\/api\/og\?path=%2Flot%2Fvehicles%2F1&v=[0-9a-f]{32}$/);
    assert.equal(meta(page.body, 'twitter:image'), meta(page.body, 'og:image'));
    assert.equal(meta(page.body, 'twitter:card'), 'summary_large_image');
    const card = await ask(path);
    assert.equal(card.status, 200, card.body);
    assert.equal(card.headers['content-type'], 'image/png');
    assert.equal(card.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(card.headers.etag, `"${path.slice(-32)}"`);
    const said = cardOf(card.headers.etag)!;
    assert.equal(said.site, 'Lot');
    assert.equal(said.accent, '#7a1f5c');
    assert.equal((await ask(path, { headers: { 'if-none-match': String(card.headers.etag) } })).status, 304);
    const stale = await ask(path.replace(/v=[0-9a-f]{32}/, `v=${'0'.repeat(32)}`));
    assert.equal(stale.status, 200);
    assert.equal(stale.headers['cache-control'], 'public, max-age=300');
    assert.equal(drawn.length, 1, 'one drawing, kept for every later ask');
    // The list and its tab, the same way.
    const list = cardPath((await ask('/vehicles')).body);
    assert.ok(list);
    assert.equal(cardOf((await ask(list)).headers.etag)?.title, 'Vehicles');
  },
);

test(
  "a card draws what the public reads: never a hidden field, a record it cannot see, or a member's grants",
  { timeout: 60_000 },
  async (t) => {
    recording();
    const { ask, session } = await lot(t);
    const dealer = await ask('/dealers/1');
    const path = cardPath(dealer.body);
    assert.ok(path);
    assert.equal((await ask(path)).status, 200);
    assert.ok(drawn.length > 0);
    assert.ok(JSON.stringify(drawn).includes('North Motors'));
    // A staff-only table has no public page, so no card, whoever asks for one.
    const inquiry = await ask('/inquiries/1');
    assert.equal(cardPath(inquiry.body), undefined);
    assert.equal((await ask('/api/og?path=%2Flot%2Finquiries%2F1')).status, 404);
    session.staff = true;
    assert.equal((await ask('/api/og?path=%2Flot%2Finquiries%2F1')).status, 404, 'a member asking still reads as the public');
    const asStaff = await ask(path);
    assert.equal(asStaff.status, 200);
    assert.equal(cardOf(asStaff.headers.etag)?.title, cardOf((await ask(path)).headers.etag)?.title);
    assert.equal(cardPath((await ask('/vehicles/1')).body), undefined, "a member's own page names no public card");
    for (const secret of ['sales@north.test', 'buyer@example.test']) assert.ok(!JSON.stringify(drawn).includes(secret), secret);
    // No such record: no card.
    assert.equal((await ask('/api/og?path=%2Flot%2Fvehicles%2F99')).status, 404);
  },
);

test(
  'without satori and resvg a page names no card and keeps whatever picture it had, and the route draws none',
  { timeout: 60_000 },
  async (t) => {
    drawShareCardsWith(async () => undefined);
    t.after(recording);
    const { ask } = await lot(t);
    const page = await ask('/vehicles/1');
    assert.equal(page.status, 200);
    assert.equal(meta(page.body, 'og:image'), undefined);
    assert.equal(meta(page.body, 'twitter:card'), 'summary');
    assert.ok(meta(page.body, 'og:title'), 'the rest of the head stands');
    assert.equal((await ask('/api/og?path=%2Flot%2Fvehicles%2F1')).status, 404);
  },
);

/* Dealers, each on its own host, each branding the App from its own published row (record branding by host). */
async function dealers(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-card-host-'));
  const file = join(directory, 'records.db');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE dealer_site (id TEXT PRIMARY KEY, dealer_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, published BOOLEAN NOT NULL, color TEXT, name TEXT, headline TEXT, tagline TEXT)',
  );
  const insert = db.prepare('INSERT INTO dealer_site VALUES (?, ?, 1, 1, ?, ?, ?, ?)');
  insert.run('north-row', 'north', '#1d3f8c', 'North dealer', 'North heading', 'North tagline');
  insert.run('south-row', 'south', '#006b73', 'South dealer', 'South heading', 'South tagline');
  db.close();
  const registry = new Registry();
  registry.add({ id: 'brand-data', name: 'Brand data', url: file, source: 'config' });
  const app: AppDef = parseAppConfig(
    {
      id: 'site',
      name: 'Base store',
      sources: { main: { connection: 'brand-data' } },
      resources: { dealer_site: {} },
      auth: { rows: 'policy', roles: { admin: { read: true } }, public: { read: ['dealer_site'] } },
      ui: {
        theme: fromRecord('dealer_site', {
          by: 'host',
          tenantField: 'dealer_id',
          publishedField: 'published',
          fallback: { preset: 'sage' },
          fields: { accent: 'color', name: 'name', heading: 'headline', tagline: 'tagline' },
        }),
      },
      views: {
        sites: { kind: 'list', from: 'dealer_site', label: 'Sites' },
        welcome: {
          kind: 'landing',
          hero: { heading: 'Find your next car', description: 'Every car checked.', actions: [{ label: 'Staff', signIn: true }] },
        },
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'sites' }],
      nav: ['sites'],
    },
    'card host fixture',
  );
  const host: AppHost = {
    app: { path: 'site.ts', app, pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: 'unused', handler: async () => {}, close() {}, session: async () => null },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default {appId:'site',resolveRows:()=>({dealer_site:false}),resolvePublicRows:intent=>intent?{dealer_site:{groups:[
      [{column:'dealer_id',op:'=',value:intent.tenant},{column:'published',op:'=',value:true}]]}}:{}};`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: host.auth!.session });
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: ['north.example.test', 'south.example.test'] };
  const child = createApp({ registry, bound, apps: [host], policy });
  const router = createTenantHostRouter([
    { host: 'north.example.test', app: 'site', tenant: 'north' },
    { host: 'south.example.test', app: 'site', tenant: 'south' },
  ]);
  const server = createServer((req, res) => {
    if (!router.accept(req)) return void res.writeHead(403).end();
    child.emit('request', req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retireDevClient(child);
    await policy.retire?.();
    closeRecordBranding(registry);
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  return asker(bound.port);
}

test(
  "a dealer's host draws its own landing and records, and never a sibling's, whatever the address asks",
  { timeout: 60_000 },
  async (t) => {
    recording();
    const ask = await dealers(t);
    const north = { host: 'north.example.test' };
    /* The landing is the signed-out home, at the App's root (`/welcome` from source is the dev server's module of that name). */
    const welcome = await ask('/', north);
    assert.equal(welcome.status, 200);
    assert.equal(meta(welcome.body, 'og:title'), 'Find your next car', "a landing's preview is its heading");
    const landing = cardPath(welcome.body);
    assert.ok(landing, meta(welcome.body, 'og:image'));
    const card = cardOf((await ask(landing, north)).headers.etag)!;
    assert.deepEqual(
      [card.site, card.title, card.summary, card.accent],
      ['North dealer', 'Find your next car', 'Every car checked.', '#1d3f8c'],
    );
    // The same address on the sibling's host is the sibling's card; a query naming the sibling names nobody's.
    assert.equal(cardOf((await ask('/api/og?path=%2Fsite%2Fwelcome', { host: 'south.example.test' })).headers.etag)?.site, 'South dealer');
    const hinted = await ask('/api/og?path=%2Fsite%2Fwelcome%3Ftenant%3Dsouth', north);
    assert.equal(hinted.status, 200);
    assert.notEqual(cardOf(hinted.headers.etag)?.site, 'South dealer');
    // A record: north's own is drawn; south's, asked on north's host, is not there to draw.
    const own = await ask('/sites/north-row', north);
    const ownCard = cardPath(own.body);
    assert.ok(ownCard, `north's record names its card (${own.status})`);
    assert.equal(cardOf((await ask(ownCard, north)).headers.etag)?.site, 'North dealer');
    assert.equal((await ask('/api/og?path=%2Fsite%2Fsites%2Fsouth-row', north)).status, 404);
    assert.ok(!drawn.some((each) => each.site === 'South dealer' && each.title.includes('north')));
  },
);

test("a tenant App's card is its landing, and nothing a member reads", { timeout: 60_000 }, async (t) => {
  recording();
  const appId = 'shop-proof';
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-card-tenant-'));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  db.close();
  const source = { id: 'business', connection: 'fixture-business' };
  provisionSqliteTenantStore(business, { appId, source, storeId: 'fixture-store' });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Shop proof',
        auth: { store: join(directory, 'auth.db'), signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        ui: { logo: 'storefront' },
        views: {
          items: { kind: 'list', from: 'item', label: 'Items' },
          welcome: { kind: 'landing', hero: { heading: 'Shop with us', actions: [{ label: 'Sign in', signIn: true }] } },
        },
        home: [{ view: 'welcome', signedOut: true }, { view: 'items' }],
        nav: ['items'],
      },
      'tenant card fixture',
    ),
  };
  const auth = await createAppAuth(loaded, {
    baseURL: origin,
    trustedOrigins: [origin],
    environment: { BETTER_AUTH_SECRET: 'synthetic-share-card-secret-at-least-thirty-two-characters' },
  });
  const owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: 'fixture-store',
        ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => ({ item: true }),
        resolveRows: () => ({ item: true }),
      }),
      source: { ...source, existingPath: business },
      deployment: 'card-generation',
      roles: ['member'],
      maxLifetimeMs: 60000,
    },
  });
  t.after(async () => {
    try {
      owner.server.closeAllConnections();
      await owner.retire();
    } finally {
      auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');
  const ask = asker(port);
  const page = await ask(`/${appId}/welcome`);
  assert.equal(page.status, 200);
  const path = cardPath(page.body);
  assert.ok(path, meta(page.body, 'og:image'));
  const card = cardOf((await ask(path)).headers.etag)!;
  assert.deepEqual([card.site, card.title], ['Shop proof', 'Shop with us']);
  assert.deepEqual(card.mark, APP_ICON_GLYPHS.storefront[1]);
  // The tenant's rows are a member's, and no card is drawn of them.
  assert.equal((await ask(`/api/og?path=%2F${appId}%2Fitems`)).status, 404);
  assert.equal(cardPath((await ask(`/${appId}/items`)).body), undefined);
});
