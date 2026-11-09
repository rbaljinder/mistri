/**
 * A tenant App's public form wears the tenant's saved name when it is reached through that tenant's own intake
 * address (`?via=`), as one on its mapped host does. Anywhere no tenant is named — no address, an address that places
 * nobody, the sign-in page — the App's own name stays, and the sign-in page is dressed only by a host that names the
 * tenant.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NORTH,
  NORTH_BRAND,
  NORTH_HOST,
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

test('the sign-in page is dressed only when the host names the tenant', async (t) => {
  const f = await open(t);
  const shared = await f.call(`/yard/leads${via(NORTH)}`);
  assert.doesNotMatch(shared.text, new RegExp(NORTH_BRAND));
  const mapped = await f.call('/api/forms/apply', { host: `${NORTH_HOST}:${f.port}` });
  assert.equal(mapped.body.app.name, NORTH_BRAND);
  const mappedPage = await f.call('/yard/leads', { host: `${NORTH_HOST}:${f.port}` });
  assert.match(mappedPage.text, new RegExp(NORTH_BRAND));
});
