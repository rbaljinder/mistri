/**
 * The Domains panel's server routes, `/api/domains*`, over genuine native auth and the real tenant host
 * (test/support/tenantSupportFixture.ts): who may read and who may change, what a bearer, a platform session and a
 * support session reach, and what a session may ask of them in a minute (429 with Retry-After). The service behind is
 * the real one over the fixture's own tenant store, with DNS and certificates faked.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  ACTIVE_ON_VERIFY,
  createTenantDomains,
  DOMAIN_CHANGES_PER_MINUTE,
  DOMAIN_CHECK_EVERY_MS,
  validateCustomDomains,
  type DnsResolver,
} from '../packages/mistri/src/server/http/customDomains.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { appId, binding, tenantSupportFixture, type Account, type Answer, type SupportFixture } from './support/tenantSupportFixture.js';

const EDITOR = 'dealer_admin';

/** Every lookup is counted and answers "nothing there", so a check is a `failed` and the rate limit is seen by its count. */
function domainsFixture(t: TestContext) {
  const lookups = { count: 0 };
  const resolver: DnsResolver = {
    async lookup() {
      lookups.count++;
      return [];
    },
  };
  const config = validateCustomDomains(
    { enabled: true, target: 'domains.yourapp.test', limit: 50, editors: [EDITOR] },
    { publicOrigin: 'https://staff.yourapp.test' },
  )!;
  return {
    lookups,
    fixture: () =>
      tenantSupportFixture(t, 'sqlite', {
        domains: (path) =>
          createTenantDomains(
            { where: { sqlite: path }, owner: binding },
            { config, certificates: ACTIVE_ON_VERIFY, resolver, heldBy: async () => undefined, warn: () => {} },
          ),
      }),
  };
}

const own = (who: Pick<Account, 'accountId' | 'cookie'>) => ({ cookie: who.cookie, 'x-mistri-account': who.accountId });
const leaseOf = (reply: Answer) => reply.body as unknown as TenantContextReply;
/** A member of north's tenant lease, as a tab holds it. */
async function northLease(f: SupportFixture, who: Account) {
  const opened = await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own(who) });
  assert.equal(opened.status, 200, opened.text);
  return leaseOf(opened);
}
const asEditor = async (f: SupportFixture) => {
  const { oscar } = f.accounts;
  await f.maintenance(async (admin) => {
    await admin.putMembership({
      tenantId: 'north',
      accountId: oscar.accountId,
      membershipId: 'north-oscar',
      status: 'active',
      roles: [EDITOR],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
  });
  return oscar;
};
const domains = (f: SupportFixture, who: Account, lease: TenantContextReply, path = '', body: unknown = {}) =>
  f.onLease(who, lease, `/api/domains${path}`, body, { tenant: 'north' });

const domainsOf = (answer: Answer) => answer.body.domains as { host: string; records?: unknown; status: string }[];

test('a member reads the domains and an editor changes them: a non-editor is 403 on every change and never sees the records', async (t) => {
  const f = await domainsFixture(t).fixture();
  const oscar = await asEditor(f);
  const editorLease = await northLease(f, oscar);

  const added = await domains(f, oscar, editorLease, '/add', { host: 'shop.example.com' });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.body.editor, true);
  assert.ok(domainsOf(added).find((row) => row.host === 'shop.example.com')?.records, 'an editor is given the records to add');

  // Sam is a member of north without the editor role.
  const sam = f.accounts.sam;
  const memberLease = await northLease(f, sam);
  const read = await domains(f, sam, memberLease);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.editor, false);
  const shown = domainsOf(read);
  assert.deepEqual(
    shown.map((row) => row.host),
    ['shop.example.com'],
    'the domains are visible',
  );
  assert.ok(
    shown.every((row) => !('records' in row)),
    'the records carry the verification token and stay with the editors',
  );
  assert.doesNotMatch(read.text, /mistri-[A-Za-z0-9_-]{20,}/, 'no token anywhere in the reply');

  for (const [path, body] of [
    ['/add', { host: 'other.example.com' }],
    ['/check', { host: 'shop.example.com' }],
    ['/primary', { host: 'shop.example.com' }],
    ['/remove', { host: 'shop.example.com' }],
  ] as const) {
    const refused = await domains(f, sam, memberLease, path, body);
    assert.equal(refused.status, 403, `${path}: ${refused.text}`);
    assert.equal(refused.body.code, 'forbidden');
    assert.equal(refused.body.outcome, 'not_applied');
    assert.equal('domains' in refused.body, false, `${path}: a refusal carries no records`);
    assert.doesNotMatch(refused.text, /records|mistri-[A-Za-z0-9_-]{20,}/);
  }
  assert.deepEqual(
    domainsOf(await domains(f, oscar, editorLease)).map((row) => row.host),
    ['shop.example.com'],
    'nothing was changed',
  );
});

test('a bearer token stands for no session here, and a platform or a support session is told there is no such route', async (t) => {
  const f = await domainsFixture(t).fixture();
  const oscar = await asEditor(f);
  const lease = await northLease(f, oscar);
  const asBearer = (path: string, body: unknown) =>
    f.call(`/api/domains${path}?app=${appId}&tenant=north`, {
      body,
      headers: {
        authorization: 'Bearer twk_not_a_session',
        'x-mistri-account': oscar.accountId,
        'x-mistri-tab': lease.tabId,
        'x-mistri-context': lease.context,
        'x-mistri-lease-revision': String(lease.revision),
      },
    });
  for (const [path, body] of [
    ['', {}],
    ['/add', { host: 'bearer.example.com' }],
  ] as const) {
    const refused = await asBearer(path, body);
    assert.equal(refused.status, 403, `bearer ${path}: ${refused.text}`);
    assert.equal(refused.body.code, 'tenant_context_unavailable');
  }
  assert.deepEqual(domainsOf(await domains(f, oscar, lease)), [], 'the bearer added nothing');

  // A platform session (the operator's own realm) and a support session inside north: no Domains there, for a read or a change.
  const { avery } = f.accounts;
  const platform = leaseOf(await f.call(`/api/tenant/context/open?app=${appId}&realm=platform`, { body: {}, headers: own(avery) }));
  for (const [path, body] of [
    ['', {}],
    ['/add', { host: 'platform.example.com' }],
    ['/check', { host: 'x.example.com' }],
  ] as const) {
    const answer = await f.onLease(avery, platform, `/api/domains${path}`, body, { realm: 'platform' });
    assert.equal(answer.status, 404, `platform ${path}: ${answer.text}`);
    assert.equal(answer.body.code, 'not_found');
  }
  const opened = await f.open(avery, 'north', 'dealer_admin');
  assert.equal(opened.status, 200, opened.text);
  const support = leaseOf({ ...opened, body: opened.body.context as Record<string, unknown> });
  for (const [path, body] of [
    ['', {}],
    ['/add', { host: 'support.example.com' }],
    ['/remove', { host: 'x.example.com' }],
  ] as const) {
    const answer = await f.onLease(avery, support, `/api/domains${path}`, body, { realm: 'support', tenant: 'north' });
    assert.equal(answer.status, 404, `support ${path}: ${answer.text}`);
    assert.equal(answer.body.code, 'not_found');
  }
  assert.deepEqual(domainsOf(await domains(f, oscar, lease)), [], 'neither added anything');
});

test('a session may check a domain once in 30 seconds and change ten times a minute: 429 with Retry-After, before any work', async (t) => {
  const { fixture, lookups } = domainsFixture(t);
  const f = await fixture();
  const oscar = await asEditor(f);
  const lease = await northLease(f, oscar);
  for (const host of ['one.example.com', 'two.example.com']) assert.equal((await domains(f, oscar, lease, '/add', { host })).status, 200);

  const first = await domains(f, oscar, lease, '/check', { host: 'one.example.com' });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.outcome, 'failed');
  const spent = lookups.count;
  assert.ok(spent > 0);
  const again = await domains(f, oscar, lease, '/check', { host: 'one.example.com' });
  assert.equal(again.status, 429, again.text);
  assert.equal(again.body.code, 'rate_limited');
  assert.equal(again.body.outcome, 'not_applied');
  const wait = Number(again.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= DOMAIN_CHECK_EVERY_MS / 1000, `Retry-After ${wait}`);
  assert.equal(lookups.count, spent, 'a refused check read no DNS');
  // The budget is per domain: another row is its own.
  assert.equal((await domains(f, oscar, lease, '/check', { host: 'two.example.com' })).status, 200);

  // Two adds are already counted; eight more changes (even refused ones) use the minute's ten, and the next is 429.
  const statuses: number[] = [];
  for (let i = 0; i < DOMAIN_CHANGES_PER_MINUTE - 2; i++)
    statuses.push((await domains(f, oscar, lease, '/primary', { host: 'nobody.example.com' })).status);
  assert.deepEqual(statuses, Array(DOMAIN_CHANGES_PER_MINUTE - 2).fill(404));
  const over = await domains(f, oscar, lease, '/remove', { host: 'one.example.com' });
  assert.equal(over.status, 429, over.text);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.deepEqual(
    domainsOf(await domains(f, oscar, lease))
      .map((row) => row.host)
      .sort(),
    ['one.example.com', 'two.example.com'],
    'the refused removal did nothing',
  );
  // Reading is never counted.
  for (let i = 0; i < 12; i++) assert.equal((await domains(f, oscar, lease)).status, 200);
  // Another session of the same tenant has a budget of its own.
  const other = await f.signIn(oscar.email, oscar.password);
  const second = await northLease(f, { ...oscar, cookie: other });
  assert.equal((await domains(f, { ...oscar, cookie: other }, second, '/check', { host: 'one.example.com' })).status, 200);
});
