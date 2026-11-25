/**
 * A tenant App's first page in one read on its lease (`POST /api/boot`, shared/tenantBoot.ts), on the clinic
 * fixture: each answer it carries is the answer its own request gets, keyed by that request as the tenant transport
 * sends it; one role's, one clinic's, is never another's; and what a lease could not ask alone it cannot ask here.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readKey } from '../packages/engine/src/shared/firstPaint.js';
import { TENANT_BOOT_PATH, TENANT_ENTER_PATH, tenantReadAddress } from '../packages/mistri/src/shared/tenantBoot.js';
import { TENANT_HTTP_HEADERS } from '../packages/mistri/src/shared/tenantContext.js';
import { createTestClient } from '../packages/mistri/src/server/testing/client.ts';
import { startClinic, ADDRESSES } from './support/clinicFixture.ts';
import type { TestTenantClient } from '../packages/mistri/src/server/testing/tenant.ts';

type Boot = { reads: Record<string, { body: unknown; reads?: string }>; items: Record<string, { body: unknown }> };

async function boot(client: TestTenantClient, path: string, search = ''): Promise<{ status: number; value: Boot }> {
  const answer = await client.request(TENANT_BOOT_PATH, { method: 'POST', json: { path, search } });
  return { status: answer.status, value: (await answer.json()) as Boot };
}
const key = (client: TestTenantClient, method: 'GET' | 'POST', target: string, body?: Record<string, unknown>) =>
  readKey(method, tenantReadAddress(target, 'clinic', client.lease.tenantId), body);
async function alone(client: TestTenantClient, target: string, body?: Record<string, unknown>): Promise<unknown> {
  const answer = await client.request(target, body === undefined ? {} : { method: 'POST', json: body });
  assert.equal(answer.status, 200, `${target}: ${await answer.clone().text()}`);
  return answer.json();
}

async function evidence(t: TestContext) {
  const { host } = await startClinic(t, 'sqlite');
  const northOwner = await host.tenant('north', { roles: ['owner'] });
  const northReception = await host.tenant('north', { roles: ['reception'] });
  const southOwner = await host.tenant('south', { roles: ['owner'] });
  const operator = await host.platform({ roles: ['operator'] });

  await t.test("a list's boot answers the shell's reads and the room's, each as its own request does", async () => {
    const { status, value } = await boot(northOwner, '/clinic/appointments');
    assert.equal(status, 200, JSON.stringify(value));
    for (const target of ['/api/runtime', '/api/app', '/api/pages', '/api/schema']) {
      const carried = value.reads[key(northOwner, 'GET', target)];
      assert.ok(carried, `${target} is carried`);
      assert.deepEqual(carried.body, await alone(northOwner, target), target);
    }
    /* The room's own reads: the list's rows, under the lease's tenant. */
    const room = Object.keys(value.reads).filter((name) => name.startsWith('POST /api/run?'));
    assert.ok(room.length >= 1, Object.keys(value.reads).join('\n'));
    for (const name of room) assert.ok(name.split('\u0000')[0].endsWith('?app=clinic&tenant=north'), name);
    const rows = JSON.stringify(room.map((name) => value.reads[name].body));
    assert.match(rows, /ap-north-1/);
    assert.doesNotMatch(rows, /ap-south-1|pt-south-cy/);
    /* The clinic's menu counts nothing, so its boot carries no batch's items. */
    assert.deepEqual(value.items, {});
  });

  await t.test("one role's answers are never another's, nor one clinic's another's", async () => {
    const [owner, reception, south] = await Promise.all(
      [northOwner, northReception, southOwner].map(async (client) => {
        const { status, value } = await boot(client, '/clinic/appointments');
        assert.equal(status, 200);
        return (value.reads[key(client, 'GET', '/api/app')].body as { app: Record<string, unknown> }).app;
      }),
    );
    assert.deepEqual([...(owner.writableTables as string[])].sort(), ['patient', 'room_booking', 'service']);
    assert.deepEqual(reception.writableTables, ['patient']);
    /* The same role in another clinic: that clinic's own addresses, never the first's. */
    assert.deepEqual(owner.addresses, { ...ADDRESSES.north });
    assert.deepEqual(south.addresses, { ...ADDRESSES.south });
    assert.doesNotMatch(JSON.stringify(south), new RegExp(`${ADDRESSES.north.intake}|${ADDRESSES.north.public}`));
    /* The same role in the same clinic: the same answer, asked again. */
    const again = await boot(northOwner, '/clinic/appointments');
    assert.deepEqual((again.value.reads[key(northOwner, 'GET', '/api/app')].body as { app: unknown }).app, owner);
    /* The platform realm's lease is offered the platform's rooms, keyed under its own selector. */
    const platform = await boot(operator, '/clinic/clinics');
    assert.equal(platform.status, 200);
    const platformApp = platform.value.reads[readKey('GET', '/api/app?app=clinic&realm=platform')];
    assert.ok(platformApp, Object.keys(platform.value.reads).join('\n'));
    assert.ok(Object.hasOwn((platformApp.body as { app: { views: object } }).app.views, 'clinics'));
    assert.ok(!Object.hasOwn((owner as { views: object }).views, 'clinics'));
  });

  await t.test("a record's boot composes its page, and another clinic's record reads nothing", async () => {
    const mine = await boot(northOwner, '/clinic/appointments/ap-north-1');
    assert.equal(mine.status, 200);
    const composed = Object.keys(mine.value.reads).find((name) => name.startsWith('POST /api/pages/compose?'));
    assert.ok(composed, Object.keys(mine.value.reads).join('\n'));
    assert.match(JSON.stringify(mine.value.reads[composed].body), /Ada North/);
    const theirs = await boot(northOwner, '/clinic/appointments/ap-south-1');
    assert.equal(theirs.status, 200);
    assert.doesNotMatch(JSON.stringify(theirs.value), /pt-south-cy|Cy South|9000/);
  });

  /* A write's refresh asks the record's page, its lists and its counts in one moment, and the transport sends them
     as one request on the lease (tenantTransport.ts `batched`): one round trip, one context, one snapshot. */
  await t.test('reads asked together are answered as one, each as its own request answers it', async () => {
    const page = await boot(northOwner, '/clinic/appointments/ap-north-1');
    const posts = Object.keys(page.value.reads)
      .filter((name) => /^POST \/api\/(run|pages\/compose)\?/.test(name))
      .map((name) => {
        const [head, body] = name.split('\u0000');
        const at = new URL(head.slice('POST '.length), 'http://x');
        at.searchParams.delete('app');
        at.searchParams.delete('tenant');
        return { method: 'POST' as const, path: `${at.pathname}${at.search}`, body: JSON.parse(body) as Record<string, unknown> };
      });
    assert.ok(
      posts.some((read) => read.path.startsWith('/api/pages/compose')),
      JSON.stringify(posts),
    );
    const reads: Array<{ method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }> = [
      { method: 'GET', path: '/api/schema' },
      { method: 'GET', path: '/api/runtime' },
      ...posts,
    ];
    const answer = await northOwner.request(TENANT_BOOT_PATH, { method: 'POST', json: { reads } });
    assert.equal(answer.status, 200, await answer.clone().text());
    const value = (await answer.json()) as Boot;
    assert.equal(Object.keys(value.reads).length, reads.length, Object.keys(value.reads).join('\n'));
    for (const read of reads) {
      const carried = value.reads[key(northOwner, read.method, read.path, read.body)];
      assert.ok(carried, `${read.path} is answered`);
      if (read.path.startsWith('/api/pages/compose')) {
        /* A compose answers with its verbs' availability beside it, as the boot's does: the same page. */
        assert.match(JSON.stringify(carried.body), /Ada North/);
        continue;
      }
      assert.deepEqual(carried.body, await alone(northOwner, read.path, read.body), read.path);
    }
    /* Another clinic's record, asked in a batch, reads nothing of it. */
    const theirs = await northOwner.request(TENANT_BOOT_PATH, {
      method: 'POST',
      json: {
        reads: [
          { method: 'GET', path: '/api/schema' },
          ...posts.map((read) => ({
            ...read,
            path: read.path.replace(/ap-north-1/g, 'ap-south-1'),
            body: JSON.parse(JSON.stringify(read.body).replace(/ap-north-1/g, 'ap-south-1')),
          })),
        ],
      },
    });
    assert.ok(theirs.status < 500);
    assert.doesNotMatch(await theirs.text(), /pt-south-cy|Cy South|9000/);
    /* What a batch may not carry: a write, a read under the wrong method, a body on a GET, too many, a stray field. */
    for (const json of [
      { reads: [{ method: 'POST', path: '/api/commands/execute', body: {} }] },
      { reads: [{ method: 'POST', path: '/api/schema', body: {} }] },
      { reads: [{ method: 'GET', path: '/api/schema', body: {} }] },
      { reads: [{ method: 'GET', path: '/api/run' }] },
      { reads: [] },
      { reads: Array.from({ length: 25 }, () => ({ method: 'GET', path: '/api/schema' })) },
      { reads: [{ method: 'GET', path: '/api/schema' }], path: '/clinic/appointments' },
      { reads: [{ method: 'GET', path: '/api/schema', extra: 1 }] },
    ]) {
      const refused = await northOwner.request(TENANT_BOOT_PATH, { method: 'POST', json });
      assert.notEqual(refused.status, 200, JSON.stringify(json).slice(0, 80));
      assert.ok(refused.status < 500, JSON.stringify(json).slice(0, 80));
    }
  });

  await t.test('a boot asks only what its lease may: another App, a bad address, a support visit', async () => {
    for (const asked of [
      { path: '/another/appointments', search: '' },
      { path: 'clinic/appointments', search: '' },
      { path: '/clinic/appointments', search: 'tab=x' },
      { path: '/clinic/appointments', search: '', extra: 1 },
      { path: '/clinic/appointments' },
      { path: `/clinic/${'x'.repeat(5000)}`, search: '' },
    ]) {
      const answer = await northOwner.request(TENANT_BOOT_PATH, { method: 'POST', json: asked });
      assert.notEqual(answer.status, 200, JSON.stringify(asked).slice(0, 80));
      assert.ok(answer.status < 500, JSON.stringify(asked).slice(0, 80));
    }
    const opened = await operator.support('north', { role: 'reception', reason: 'Checking the first page' });
    assert.ok(opened.ok, opened.ok ? '' : opened.message);
    const visit = opened.value;
    const refused = await visit.request(TENANT_BOOT_PATH, { method: 'POST', json: { path: '/clinic/appointments', search: '' } });
    assert.equal(refused.status, 404);
    /* Nor a batch: the transport hears the 404 and asks the visit's reads one by one. */
    const batch = await visit.request(TENANT_BOOT_PATH, { method: 'POST', json: { reads: [{ method: 'GET', path: '/api/schema' }] } });
    assert.equal(batch.status, 404);
    /* The visit still reads, read by read, as it always did. */
    assert.ok((await visit.rows('appointment')).ok);
    assert.ok((await visit.exit()).ok);
  });

  /* Discovery, the lease and the boot in one request (shared/tenantBoot.ts `TENANT_ENTER_PATH`): a person in one
     clinic is entered with the page's boot, the same answers its own boot asks on a lease; a platform member, who
     has the realm to choose too, is asked, and no support visit is ever entered this way. */
  await t.test('enter: a sole member is entered with its boot; a platform member and a support visit are asked', async () => {
    const asker = async (client: TestTenantClient) => {
      const session = createTestClient(host.url, { app: 'clinic' });
      await session.signIn(client.account.email, client.account.password);
      return (json: Record<string, unknown>, query = '') =>
        session.request(`${TENANT_ENTER_PATH}?app=clinic${query}`, {
          method: 'POST',
          headers: { [TENANT_HTTP_HEADERS.account]: client.account.accountId, [TENANT_HTTP_HEADERS.app]: 'clinic' },
          json: { path: '/clinic/appointments', search: '', ...json },
        });
    };
    type Entered = {
      memberships: { tenantId: string }[];
      platform?: true;
      entered?: { context: { tenantId: string; tabId: string }; boot: Boot };
    };
    const member = await asker(northOwner);
    const answer = await member({});
    assert.equal(answer.status, 200, await answer.clone().text());
    const value = (await answer.json()) as Entered;
    assert.deepEqual(
      value.memberships.map((membership) => membership.tenantId),
      ['north'],
    );
    assert.equal(value.entered?.context.tenantId, 'north');
    assert.equal(answer.headers.get(TENANT_HTTP_HEADERS.tab), value.entered?.context.tabId);
    const boot = value.entered!.boot;
    for (const target of ['/api/app', '/api/pages', '/api/schema'])
      assert.deepEqual(boot.reads[key(northOwner, 'GET', target)]?.body, await alone(northOwner, target), target);
    const rows = JSON.stringify(Object.entries(boot.reads).filter(([name]) => name.startsWith('POST /api/run?')));
    assert.match(rows, /ap-north-1/);
    assert.doesNotMatch(rows, /ap-south-1|pt-south-cy/);
    /* A link to the other clinic, not this member's: discovery alone, and the chooser says whose the link is. */
    const elsewhere = (await (await member({ tenant: 'south' })).json()) as Entered;
    assert.equal('entered' in elsewhere, false);

    /* A person in two clinics: a link that names one, or the one this tab kept, enters it in the same request; a link
       to a clinic that is not theirs, or to none, asks. */
    await host.join(northOwner, 'south', ['owner']);
    const two = await asker(northOwner);
    const names = (value: Entered) => value.memberships.map((membership) => membership.tenantId).sort();
    const several = (await (await two({})).json()) as Entered;
    assert.deepEqual(names(several), ['north', 'south']);
    assert.equal('entered' in several, false, 'two clinics and no word of which: the chooser');
    const named = (await (await two({ tenant: 'south' })).json()) as Entered;
    assert.equal(named.entered?.context.tenantId, 'south');
    assert.ok(
      Object.keys(named.entered!.boot.reads).some((name) => name.startsWith('POST /api/run?')),
      'the boot is in the answer',
    );
    const kept = (await (await two({ kept: { tenantId: 'north', tabId: 'tab-that-is-gone' } })).json()) as Entered;
    assert.equal(kept.entered?.context.tenantId, 'north');
    const strange = (await (await two({ tenant: 'east' })).json()) as Entered;
    assert.equal('entered' in strange, false);

    const platform = await asker(operator);
    const asked = await platform({});
    assert.equal(asked.status, 200, await asked.clone().text());
    const chooser = (await asked.json()) as Entered;
    assert.equal(chooser.platform, true);
    assert.equal('entered' in chooser, false);
    assert.equal(asked.headers.get(TENANT_HTTP_HEADERS.tab), null);
    /* A support visit is opened by the support routes alone: naming its realm here, or the platform's, is refused. */
    for (const query of ['&realm=support&tenant=north', '&realm=platform', '&tenant=north'])
      assert.equal((await platform({}, query)).status, 400, query);
  });

  /* A tenant page's first request is entering, before it knows whose session it is, and its answer says who-am-I: the
     very body `/api/whoami` answers (one function in the host), for a signed-in member, who is entered as ever, and
     for no one, whose answer is who-am-I's and takes no lease. */
  await t.test("enter answers who-am-I as who-am-I does, signed in or out, with nothing sent but the page's address", async () => {
    const enter = (session: ReturnType<typeof createTestClient>, tenant?: string) =>
      session.request(`${TENANT_ENTER_PATH}?app=clinic`, {
        method: 'POST',
        headers: { [TENANT_HTTP_HEADERS.app]: 'clinic' },
        json: { path: '/clinic/appointments', search: '', ...(tenant ? { tenant } : {}) },
      });
    const whoami = async (session: ReturnType<typeof createTestClient>) => {
      const answer = await session.request('/api/whoami?app=clinic');
      assert.equal(answer.status, 200);
      return (await answer.json()) as Record<string, unknown>;
    };
    const member = createTestClient(host.url, { app: 'clinic' });
    await member.signIn(northOwner.account.email, northOwner.account.password);
    /* In two clinics by now, so the link names one. */
    const entered = await enter(member, 'north');
    assert.equal(entered.status, 200, await entered.clone().text());
    const inside = (await entered.json()) as { whoami?: Record<string, unknown>; entered?: { context: { tenantId: string } } };
    assert.equal(inside.entered?.context.tenantId, 'north', 'still entered with its boot');
    assert.equal(inside.whoami?.signedIn, true);
    assert.equal(inside.whoami?.accountId, northOwner.account.accountId);
    assert.equal(entered.headers.get(TENANT_HTTP_HEADERS.account), northOwner.account.accountId);
    assert.deepEqual(inside.whoami, await whoami(member));
    /* A platform member, who is asked to choose: the same body, and no lease. */
    const operatorSession = createTestClient(host.url, { app: 'clinic' });
    await operatorSession.signIn(operator.account.email, operator.account.password);
    const chosen = (await (await enter(operatorSession)).json()) as { whoami?: Record<string, unknown>; entered?: unknown };
    assert.equal('entered' in chosen, false);
    assert.deepEqual(chosen.whoami, await whoami(operatorSession));
    /* No session: who-am-I's signed-out answer, and nothing else of the entry. */
    const visitor = createTestClient(host.url, { app: 'clinic' });
    const signedOut = await enter(visitor);
    assert.equal(signedOut.status, 200, await signedOut.clone().text());
    const nobody = (await signedOut.json()) as Record<string, unknown>;
    assert.equal(nobody.status, 'signed_out');
    assert.equal(signedOut.headers.get(TENANT_HTTP_HEADERS.account), null);
    assert.equal((nobody.whoami as Record<string, unknown>).signedIn, false);
    assert.deepEqual(nobody.whoami, await whoami(visitor));
  });
}

test('a tenant App boots its first page in one read on its lease', { timeout: 240000 }, (t) => evidence(t));
