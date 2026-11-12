/**
 * A tenant App's public form wears the tenant's saved name when it is reached through that tenant's own intake
 * address (`?via=`), as one on its mapped host does. Anywhere no tenant is named — no address, an address that places
 * nobody, the sign-in page — the App's own name stays, and the sign-in page is dressed only by a host that names the
 * tenant.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import {
  readSqliteBranding,
  readSqliteBrandingLogo,
  writeSqliteBranding,
} from '../packages/mistri/src/adapters/branding/sqliteBranding.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { parseBrandingDeclaration } from '../packages/mistri/src/shared/tenantBranding.js';
import { createTenantBrandingService } from '../packages/mistri/src/server/tenant/tenantBranding.js';
import {
  APP_ID,
  binding,
  NORTH,
  NORTH_BRAND,
  NORTH_HOST,
  NORTH_PUBLIC,
  openTenantPublicForms,
  publicFormsDatabase,
  SOUTH,
  UNKNOWN,
  via,
} from './support/tenantPublicForms.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const open = (t: Parameters<typeof openTenantPublicForms>[0]) =>
  openTenantPublicForms(t, 'sqlite', publicFormsDatabase(), { tenantBranding: true });

test("a form reached by a tenant's intake address is dressed in that tenant's name", async (t) => {
  const f = await open(t);
  const named = await f.call(`/api/forms/apply${via(NORTH)}`);
  assert.equal(named.status, 200, named.text);
  assert.equal(named.body.app.name, NORTH_BRAND);
  // The page's own title says the same.
  const page = await f.call(`/yard/form/apply${via(NORTH)}`);
  assert.match(page.text, new RegExp(NORTH_BRAND));
});

test("no address, an address that places nobody, and a tenant that saved no name keep the App's name", async (t) => {
  const f = await open(t);
  assert.equal((await f.call('/api/forms/apply')).body.app.name, 'Yard');
  assert.equal((await f.call(`/api/forms/apply${via(UNKNOWN)}`)).body.app.name, 'Yard');
  assert.equal((await f.call(`/api/forms/apply${via(SOUTH)}`)).body.app.name, 'Yard');
  const bare = await f.call('/yard/form/apply');
  assert.doesNotMatch(bare.text, new RegExp(NORTH_BRAND));
});

/* The security review's BR-1: an address that places nobody and a real tenant's that published no look answer
   alike — the same bytes, and the same reads on the way, since an unknown address that skipped the look's read
   answered sooner and so told the two apart. */
test("an unknown intake address and a real one that published no look can't be told apart", async (t) => {
  const f = await open(t);
  const reads: string[] = [];
  const get = MemoryCacheStore.prototype.get;
  t.mock.method(MemoryCacheStore.prototype, 'get', function (this: MemoryCacheStore, key: string) {
    if (key.includes('branding:')) reads.push(key);
    return get.call(this, key);
  });
  const answer = async (address: string) => {
    reads.length = 0;
    const api = await f.call(`/api/forms/apply${via(address)}`);
    const apiReads = reads.length;
    const page = await f.call(`/yard/form/apply${via(address)}`);
    return {
      api: [api.status, api.text],
      page: [page.status, page.text.replaceAll(/nonce="[^"]*"|nonce-[A-Za-z0-9+/=_-]+/g, 'nonce')],
      reads: [apiReads, reads.length - apiReads],
    };
  };
  const unknown = await answer(UNKNOWN);
  assert.equal(unknown.api[0], 200);
  assert.deepEqual(await answer(SOUTH), unknown);
  assert.deepEqual(await answer(NORTH_PUBLIC), unknown);
  assert.ok(unknown.reads[0] > 0, 'an unknown address reads a look as a real one does');
});

test('the sign-in page is dressed only when the host names the tenant', async (t) => {
  const f = await open(t);
  const shared = await f.call(`/yard/leads${via(NORTH)}`);
  assert.doesNotMatch(shared.text, new RegExp(NORTH_BRAND));
  const mapped = await f.call('/api/forms/apply', { host: `${NORTH_HOST}:${f.port}` });
  assert.equal(mapped.body.app.name, NORTH_BRAND);
  const mappedPage = await f.call('/yard/leads', { host: `${NORTH_HOST}:${f.port}` });
  assert.match(mappedPage.text, new RegExp(NORTH_BRAND));
});

/* A field report: once a tenant saved a name, every public form of that tenant answered a signed-out visitor 403
   auth_unavailable. The save goes through the branding service, as Branding's own save does, and the visitor then
   opens the form's page, reads the form and submits it, carrying no session at all. */
test("a tenant's saved name never asks a signed-out visitor for a session: its forms still open and take a submission", async (t) => {
  const f = await open(t);
  const handle = () => new DatabaseSync(f.engine.path!);
  const at = <T>(work: (db: DatabaseSync) => T) => {
    const db = handle();
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const service = createTenantBrandingService({
    app: { id: 'yard', name: 'Yard', branding: { allow: ['name'], editors: ['staff'] } } as unknown as AppDef,
    store: {
      read: async (query) => at((db) => readSqliteBranding(db, query)),
      logo: async (query) => at((db) => readSqliteBrandingLogo(db, query)),
      write: async (write) => at((db) => writeSqliteBranding(db, write)),
    },
    cache: new MemoryCacheStore(),
  });
  await service.save('south', { value: { name: 'South Wheels Co' } }, 'south-owner');
  for (const [address, name] of [
    [SOUTH, 'South Wheels Co'],
    [NORTH, NORTH_BRAND],
  ] as const) {
    const page = await f.call(`/yard/form/apply${via(address)}`);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, new RegExp(name));
    const form = await f.call(`/api/forms/apply${via(address)}`);
    assert.equal(form.status, 200, form.text);
    assert.equal(form.body.app.name, name);
    const sent = await f.call(`/api/forms/apply${via(address)}`, { body: { input: { name: 'Avery' }, submission: randomUUID() } });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(Object.keys(sent.body).sort(), ['receipt', 'reference']);
  }
});

/* The same report, on the host `mistri tenant` serves — its one App at the root, so a form's page is
   `/form/{key}` — and with a whole look saved, logo and favicon included: the page, the form, the logo the page
   names and a submission all answer a visitor carrying no session. */
test("a tenant's whole saved look, at the root, never asks a signed-out visitor for a session", async (t) => {
  const f = await openTenantPublicForms(t, 'sqlite', publicFormsDatabase(), { tenantBranding: true, atRoot: true });
  const at = <T>(work: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(f.engine.path!);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const declared = parseBrandingDeclaration(
    { allow: ['name', 'logo', 'accent', 'radius', 'density'], editors: ['staff'] },
    { ui: {}, auth: { rows: 'tenant', roles: { staff: { realm: 'tenant', read: true } } } } as never,
    'branding',
  );
  const service = createTenantBrandingService({
    app: { id: 'yard', name: 'Yard', branding: declared } as unknown as AppDef,
    store: {
      read: async (query) => at((db) => readSqliteBranding(db, query)),
      logo: async (query) => at((db) => readSqliteBrandingLogo(db, query)),
      write: async (write) => at((db) => writeSqliteBranding(db, write)),
    },
    cache: new MemoryCacheStore(),
  });
  const png = PNG.toString('base64');
  await service.save(
    'south',
    {
      value: { name: 'South Wheels Co', accent: { light: '#1d4ed8', dark: '#93c5fd' }, radius: '4px', density: 'compact' },
      logo: png,
      darkLogo: png,
      favicon: png,
    },
    'south-owner',
  );
  const page = await f.call(`/form/apply${via(SOUTH)}`);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /South Wheels Co/);
  const form = await f.call(`/api/forms/apply${via(SOUTH)}`);
  assert.equal(form.status, 200, form.text);
  assert.equal(form.body.app.name, 'South Wheels Co');
  const logo = /\/api\/branding\/logo\/[0-9a-f]{64}/.exec(JSON.stringify(form.body))?.[0];
  assert.ok(logo, "the form names its tenant's logo");
  assert.equal((await f.call(logo)).status, 200);
  const sent = await f.call(`/api/forms/apply${via(SOUTH)}`, { body: { input: { name: 'Avery' }, submission: randomUUID() } });
  assert.equal(sent.status, 200, sent.text);
});

/* The same report, saved as a tenant saves it: an editor signs in, opens their tenant's lease and posts Branding's
   own save to the host, so the host's copy of the look is the one that changes. Then the form is opened by a visitor
   with no session, and by the same browser still holding the editor's cookie. The App that reported it wore a theme
   of its own with a font file, which the page's head refused to write: the tenant's look starts from that theme. */
test("a look saved through the host's own Branding save never asks a form's visitor for a session", async (t) => {
  for (const [atRoot, ownFaces] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const f = await openTenantPublicForms(t, 'sqlite', publicFormsDatabase(), {
      tenantBranding: true,
      ...(atRoot ? { atRoot: true } : {}),
      ...(ownFaces ? { ownFaces: true } : {}),
    });
    const signedUp = await f.call('/api/auth/sign-up/email', {
      body: { email: `editor-${atRoot}-${ownFaces}@example.invalid`, password: 'a-long-synthetic-password-1', name: 'Editor' },
    });
    assert.equal(signedUp.status, 200, signedUp.text);
    const accountId = String(signedUp.body.user.id);
    const cookie = ([] as string[])
      .concat(signedUp.headers['set-cookie'] ?? [])
      .map((value) => value.split(';')[0])
      .join('; ');
    await f.engine.maintenance(binding, (admin) =>
      admin
        .putMembership({
          tenantId: 'south',
          accountId,
          membershipId: `m-${accountId}`,
          status: 'active',
          roles: ['staff'],
          validUntil: Date.now() + 3600000,
          expectedVersion: null,
        })
        .then(() => {}),
    );
    const signed = { cookie, 'x-mistri-account': accountId };
    const opened = await f.call(`/api/tenant/context/open?app=${APP_ID}&tenant=south`, { body: {}, headers: signed });
    assert.equal(opened.status, 200, opened.text);
    const lease = {
      ...signed,
      'x-mistri-tab': String(opened.body.tabId),
      'x-mistri-context': String(opened.body.context),
      'x-mistri-lease-revision': String(opened.body.revision),
    };
    const png = PNG.toString('base64');
    const saved = await f.call(`/api/branding/save?app=${APP_ID}&tenant=south`, {
      body: {
        branding: { name: 'South Wheels Co', accent: { light: '#1d4ed8', dark: '#93c5fd' }, radius: '4px', density: 'compact' },
        logo: png,
        favicon: png,
      },
      headers: lease,
    });
    assert.equal(saved.status, 200, saved.text);
    const pagePath = atRoot ? `/form/apply${via(SOUTH)}` : `/${APP_ID}/form/apply${via(SOUTH)}`;
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const page = await f.call(pagePath, { headers });
      assert.equal(page.status, 200, `${pagePath} ${JSON.stringify(Object.keys(headers))}: ${page.text.slice(0, 300)}`);
      assert.match(page.text, /South Wheels Co/);
      const form = await f.call(`/api/forms/apply${via(SOUTH)}`, { headers });
      assert.equal(form.status, 200, form.text);
      assert.equal(form.body.app.name, 'South Wheels Co');
      const logo = /\/api\/branding\/logo\/[0-9a-f]{64}/.exec(JSON.stringify(form.body))?.[0];
      assert.ok(logo);
      assert.equal((await f.call(logo, { headers })).status, 200);
    }
  }
});

/* A field report: a tenant App's public form drew a lettered square where its signed-in screens drew the App's icon
   logo, because the presentation it sent a visitor carried the name and the theme and not the logo. The ordinary host
   tells a visitor the whole look (appLook), glyphs included, so the brand row has a mark to draw. */
test("a tenant App's public form is told the App's own logo, glyph and all, as the ordinary host's is", async (t) => {
  const f = await openTenantPublicForms(t, 'sqlite', publicFormsDatabase(), { logo: 'wrench' });
  for (const path of ['/api/forms', '/api/forms/apply']) {
    const form = await f.call(path);
    assert.equal(form.status, 200, form.text);
    assert.equal(form.body.app.logo, 'wrench', path);
    assert.ok(form.body.app.icons?.wrench, `${path} carries the glyph the page cannot fetch before it draws`);
  }
});

/* A tenant's font: the page that wears the tenant's look says its face from the first byte — the @font-face and a preload of
   the file — so the first paint is set in it rather than swapped after, which is what a layout shift is. */
test("a tenant's picked font is declared and preloaded in its public page's head, and another tenant's page carries none", async (t) => {
  const f = await openTenantPublicForms(t, 'sqlite', publicFormsDatabase(), { tenantBranding: true, tenantFont: true });
  const north = await f.call(`/yard/form/apply${via(NORTH)}`);
  assert.equal(north.status, 200, north.text);
  const file = /rel="preload" as="font" type="font\/woff2" crossorigin href="(\/yard\/_fonts\/figtree-[0-9a-f]{12}\.woff2)"/.exec(
    north.text,
  )?.[1];
  assert.ok(file, 'the picked face is preloaded');
  assert.match(north.text, new RegExp(`@font-face\\{font-family:"Figtree";src:url\\("${file.replace('.', '\\.')}"\\)`));
  // The file is the App's own, served from its origin.
  const served = await f.call(file);
  assert.equal(served.status, 200);
  // South saved no font: nothing of Figtree in its head.
  const south = await f.call(`/yard/form/apply${via(SOUTH)}`);
  assert.doesNotMatch(south.text, /Figtree/);
  // And a page that names no tenant is the App's own.
  const bare = await f.call('/yard/form/apply');
  assert.doesNotMatch(bare.text, /Figtree/);
});
