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
import { createTenantBrandingService } from '../packages/mistri/src/server/tenant/tenantBranding.js';
import {
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
