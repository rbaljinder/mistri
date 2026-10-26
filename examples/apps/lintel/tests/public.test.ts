/** A public form opened by its view key, as a link or a typed path says it, is the form's page. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

const html = { headers: { accept: 'text/html' }, redirect: 'manual' } as const;

test('/request-viewing opens the viewing form\'s page, not "for signed-in members"', async () => {
  const visitor = lintel.anonymous();
  const bare = await visitor.request('/request-viewing?code=AC-105', html);
  assert.equal(bare.status, 301);
  assert.match(bare.headers.get('location') ?? '', /\/form\/request-viewing\?code=AC-105$/);
  const page = await visitor.request('/form/request-viewing', html);
  assert.equal(page.status, 200);
});

test('the App id said twice, as a link written for a mounted App keeps it, is the same form', async () => {
  const visitor = lintel.anonymous();
  for (const path of ['/lintel/form/request-viewing', '/lintel/request-viewing']) {
    const reply = await visitor.request(`${path}?code=AC-105`, html);
    assert.equal(reply.status, 301, path);
    assert.match(reply.headers.get('location') ?? '', /^\/form\/request-viewing\?code=AC-105$/, path);
  }
});

test('a list is not mistaken for a form: it keeps its own address', async () => {
  const visitor = lintel.anonymous();
  const listings = await visitor.request('/listings', html);
  assert.notEqual(listings.status, 301);
});
