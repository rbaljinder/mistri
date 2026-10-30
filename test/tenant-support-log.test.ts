/**
 * The dealer's log: `GET /api/tenant/support/log`, what a dealer is shown about
 * support visits into its own tenant. Through the real tenant host on SQLite,
 * and on live PostgreSQL when TABLEWALK_TEST_PG names a server.
 *
 * The security property here is tenant isolation. A lender can read a dealer's
 * rows; this is how the dealer sees that it happened, and one dealer must never
 * see another's visits — including by naming another dealer's id. The tenant
 * whose history is read comes from the lease's admitted evidence, never from
 * the request, and that is pinned below.
 *
 * A dealer sees, it does not gate: there is deliberately no approve or block
 * route to test for.
 *
 * The projection's own rules — which columns of a change a viewer may read, and
 * what it is told was withheld — are pinned as unit tests against the pure
 * function, because no write reaches the trail over HTTP yet: writes under
 * support are still refused.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupportEntryRow, SupportSessionRow } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { projectSupportLog, type SupportLogFields } from '../packages/mistri/src/server/tenant/tenantSupportLogProjection.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { SUPPORT_LOG_PATH, SUPPORT_SESSIONS_PATH } from '../packages/mistri/src/shared/tenantSupportLog.js';
import type { SupportAuditReply, SupportLogReply, SupportLogSession } from '../packages/mistri/src/shared/tenantSupportLog.js';
import { TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  appId,
  supportManifest,
  tenantSupportFixture,
  type Account,
  type Answer,
  type SupportFixture,
} from './support/tenantSupportFixture.js';

function ok(reply: Answer) {
  assert.equal(reply.status, 200, reply.text);
  return reply;
}
const leaseOf = (reply: Answer) => reply.body.context as TenantContextReply;
const sessionOf = (reply: Answer) => (reply.body.receipt as { session: { supportId: string; tenantId: string; version: string } }).session;

/** The dealer role its App shows the log to, and the platform role its App
 * shows every dealer's to. `reviewer` is granted neither, on purpose. */
const withLogGrant = (raw: ReturnType<typeof supportManifest>) => {
  const roles = raw.auth.roles as Record<string, Record<string, unknown>>;
  roles.dealer_admin.operations = ['support'];
  roles.lender_admin.operations = ['support'];
};

/** A tenant lease for one of that dealer's own members. */
async function dealerLease(f: SupportFixture, who: Account, tenantId: string): Promise<TenantContextReply> {
  const reply = ok(
    await f.call(`/api/tenant/context/open?app=${appId}&tenant=${tenantId}`, {
      body: {},
      headers: { cookie: who.cookie, [headers.account]: who.accountId },
    }),
  );
  return reply.body as unknown as TenantContextReply;
}
const readLog = (f: SupportFixture, who: Account, lease: TenantContextReply, tenantId = lease.tenantId) =>
  f.call(`${SUPPORT_LOG_PATH}?${new URLSearchParams({ app: appId, tenant: tenantId })}`, {
    method: 'GET',
    headers: {
      cookie: who.cookie,
      [headers.account]: who.accountId,
      [headers.tab]: lease.tabId,
      [headers.context]: lease.context,
      [headers.revision]: String(lease.revision),
    },
  });
const sessions = (reply: Answer) => (reply.body as unknown as SupportLogReply).sessions;

/** Oscar administers both dealers; Sam is north's staff and holds no log grant. */
async function grants(f: SupportFixture) {
  const hour = Date.now() + 3600000;
  await f.maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putMembership({
        tenantId,
        accountId: f.accounts.oscar.accountId,
        membershipId: `${tenantId}-oscar`,
        status: 'active',
        roles: ['dealer_admin'],
        validUntil: hour,
        expectedVersion: null,
      });
    }
  });
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a dealer sees a visit into its own tenant, by name, role, reason and counts`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, oscar } = f.accounts;
    const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
    const visit = sessionOf(opened),
      lease = leaseOf(opened);
    ok(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, { realm: 'support', tenant: 'north' }));
    ok(await f.exit(olivia, visit));

    const log = sessions(ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north'))));
    assert.equal(log.length, 1);
    const [entry] = log;
    assert.equal(entry.supportId, visit.supportId);
    // The person, not their address; the lender's label as the App names it.
    assert.equal(entry.operatorName, 'Olivia Operator');
    assert.equal(entry.realmLabel, 'Lender');
    assert.equal(entry.dealerRole, 'dealer_staff');
    assert.equal(entry.reason, 'Checking a stuck application');
    assert.equal(entry.state, 'ended');
    assert.equal(entry.endReason, 'exit');
    assert.equal(typeof entry.openedAt, 'string');
    assert.equal(typeof entry.endedAt, 'string');
    // One read was made, and nothing was changed.
    assert.equal(entry.reads, 1);
    assert.deepEqual(entry.changes, []);
  });

  test(`${dialect}: the log carries no email, native session, version, MAC or policy`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, oscar } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    const reply = ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north')));
    assert.doesNotMatch(reply.text, /@example\.test|nativeSession|sessionId|headMac|prevMac|policyId|policyVersion/);
    assert.doesNotMatch(reply.text, /parentMembership|platformVersion|tenantVersion|openReceipt/);
    // The display name is shown, which is the whole point, so the absence
    // above is a real exclusion rather than an empty reply.
    assert.match(reply.text, /Olivia Operator/);
  });

  test(`${dialect}: a dealer member without the grant is refused its own log`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, sam, oscar } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    // Sam is north's own staff, and holds a live tenant lease; the log is not
    // offered to every member, only to a role the App granted it to.
    const refused = await readLog(f, sam, await dealerLease(f, sam, 'north'));
    assert.equal(refused.status, 403, refused.text);
    assert.doesNotMatch(refused.text, /Olivia Operator|Checking a stuck/);
    // The same tenant, read by the granted role, does answer.
    assert.equal(sessions(ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north')))).length, 1);
  });

  test(`${dialect}: one dealer never sees another's visits, however it addresses the request`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, oscar } = f.accounts;
    // A visit into north only. Oscar administers south as well, so the lease
    // he holds decides what he sees, not the account he is.
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    const south = await dealerLease(f, oscar, 'south');
    const own = ok(await readLog(f, oscar, south));
    assert.deepEqual(sessions(own), []);
    assert.doesNotMatch(own.text, /Olivia Operator|Checking a stuck/);
    // Naming north on south's lease reaches nothing: the tenant read is the
    // lease's, and a selector that disagrees with it is refused outright.
    const forged = await readLog(f, oscar, south, 'north');
    assert.ok(forged.status >= 400, forged.text);
    assert.doesNotMatch(forged.text, /Olivia Operator|Checking a stuck/);
    // North's own lease does show it, so the emptiness above is isolation and
    // not an empty store.
    assert.equal(sessions(ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north')))).length, 1);
  });

  test(`${dialect}: the store read itself returns one dealer's sessions and no other's`, { skip }, async (t) => {
    // The route's confinement has two layers, and this pins the first on its
    // own: the query. Without a test at this level, removing the SQL filter
    // would be caught only by the projection behind it, and a check that
    // passes because of the next layer proves nothing about this one.
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    const { olivia, avery } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    ok(await f.open(avery, 'south', 'dealer_admin'));
    const owner = await f.owner();
    const north = await owner.readLog(f.asLogin(olivia.cookie), 'north');
    assert.deepEqual(
      north.sessions.map((row) => row.tenantId),
      ['north'],
    );
    assert.equal(
      north.entries.every((entry) => entry.tenantId === 'north'),
      true,
    );
    // Both sessions exist, so the single result above is a filter working and
    // not an empty store.
    const every = await owner.readLog(f.asLogin(olivia.cookie), null);
    assert.deepEqual([...new Set(every.sessions.map((row) => row.tenantId))].sort(), ['north', 'south']);
  });
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: the App payload tells the browser whether this member may read the log`, { skip }, async (t) => {
    // The shell offers the screen on this answer alone, so it must follow the
    // same grant the route enforces — and roles are per-tenant, so it can only
    // be known once a lease is held.
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { sam, oscar } = f.accounts;
    const payload = async (who: Account) => {
      const lease = await dealerLease(f, who, 'north');
      const reply = ok(
        await f.call(`/api/app?${new URLSearchParams({ app: appId, tenant: 'north' })}`, {
          method: 'GET',
          headers: {
            cookie: who.cookie,
            [headers.account]: who.accountId,
            [headers.tab]: lease.tabId,
            [headers.context]: lease.context,
            [headers.revision]: String(lease.revision),
          },
        }),
      );
      return reply.body.app as Record<string, unknown>;
    };
    assert.equal((await payload(oscar)).supportLog, true);
    // Absent, not false: the shell has no entry to draw at all.
    assert.equal('supportLog' in (await payload(sam)), false);
  });
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(
    `${dialect}: the payload offers every dealer's support sessions on a platform lease, and API tokens on a dealer's own`,
    { skip },
    async (t) => {
      // The operator's "Support sessions" and a member's "API tokens" screens are
      // drawn on these flags alone, so each follows the route it reads: the
      // audit grant on a platform lease, and the tokens on a tenant lease only.
      const f = await tenantSupportFixture(t, dialect, {
        manifest: (raw) => {
          withLogGrant(raw);
          (raw as Record<string, unknown>).api = {
            version: 1,
            roles: ['dealer_admin', 'dealer_staff'],
            resources: { lead: { fields: ['id', 'name'], sorts: ['id'] } },
          };
        },
      });
      await grants(f);
      const { avery, olivia, oscar } = f.accounts;
      const leased = (who: Account, lease: TenantContextReply, query: Record<string, string>) => ({
        method: 'GET',
        headers: {
          cookie: who.cookie,
          [headers.account]: who.accountId,
          [headers.tab]: lease.tabId,
          [headers.context]: lease.context,
          [headers.revision]: String(lease.revision),
        },
        query: new URLSearchParams({ app: appId, ...query }),
      });
      const payload = async (who: Account, lease: TenantContextReply, query: Record<string, string>) => {
        const { query: search, ...init } = leased(who, lease, query);
        return ok(await f.call(`/api/app?${search}`, init)).body.app as Record<string, unknown>;
      };
      const lender = await payload(avery, await lenderLease(f, avery), { realm: 'platform' });
      assert.equal(lender.supportAudit, true);
      assert.equal('apiTokens' in lender, false, 'a platform lease holds no member tokens');
      // Olivia is a platform reviewer without the audit grant: no entry is drawn.
      assert.equal('supportAudit' in (await payload(olivia, await lenderLease(f, olivia), { realm: 'platform' })), false);
      const dealer = await payload(oscar, await dealerLease(f, oscar, 'north'), { tenant: 'north' });
      assert.equal(dealer.apiTokens, true);
      assert.equal('supportAudit' in dealer, false);

      // And the routes agree: the tenant lease reaches the member's tokens (this fixture's sign-in store keeps none
      // provisioned, which the token route says itself), and a platform lease is not told the route exists.
      const tokens = async (who: Account, lease: TenantContextReply, query: Record<string, string>) => {
        const { query: search, headers: sent } = leased(who, lease, query);
        return f.call(`/api/tokens?${search}`, { body: {}, headers: sent });
      };
      const mine = await tokens(oscar, await dealerLease(f, oscar, 'north'), { tenant: 'north' });
      assert.match(String(mine.body.code), /^tokens_/, mine.text);
      // Making one needs a sign-in from the last five minutes, as opening support does: a token outlives the
      // session that made it, so a stolen or stale one makes none. Fresh, the ask reaches the token store.
      const issue = async (lease: TenantContextReply) => {
        const { query: search, headers: sent } = leased(oscar, lease, { tenant: 'north' });
        return f.call(`/api/tokens/issue?${search}`, { body: { label: 'Nightly export' }, headers: sent });
      };
      const fresh = await issue(await dealerLease(f, oscar, 'north'));
      assert.match(String(fresh.body.code), /^tokens_/, fresh.text);
      await f.native.age(oscar.cookie, 310_000);
      const stale = await issue(await dealerLease(f, oscar, 'north'));
      assert.deepEqual([stale.status, stale.body.code, stale.body.outcome], [403, 'sign_in_required', 'not_applied'], stale.text);
      const refused = await tokens(avery, await lenderLease(f, avery), { realm: 'platform' });
      assert.equal(refused.status, 404, refused.text);
    },
  );
}

/* ---------- the lender's audit view ---------- */

/** A platform lease for a lender's own staff. */
async function lenderLease(f: SupportFixture, who: Account): Promise<TenantContextReply> {
  const reply = ok(
    await f.call(`/api/tenant/context/open?app=${appId}&realm=platform`, {
      body: {},
      headers: { cookie: who.cookie, [headers.account]: who.accountId },
    }),
  );
  return reply.body as unknown as TenantContextReply;
}
const readSessions = (f: SupportFixture, who: Account, lease: TenantContextReply) =>
  f.call(`${SUPPORT_SESSIONS_PATH}?${new URLSearchParams({ app: appId, realm: 'platform' })}`, {
    method: 'GET',
    headers: {
      cookie: who.cookie,
      [headers.account]: who.accountId,
      [headers.tab]: lease.tabId,
      [headers.context]: lease.context,
      [headers.revision]: String(lease.revision),
    },
  });
const audited = (reply: Answer) => (reply.body as unknown as SupportAuditReply).sessions;

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: the lender sees every dealer's visits, and the email appears only here`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, avery, oscar } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    // Avery is the lender's admin; the audit view is read on a platform lease
    // taken before entering anywhere, and reading is not acting, so it answers.
    const lender = await lenderLease(f, avery);
    const seen = audited(ok(await readSessions(f, avery, lender)));
    assert.deepEqual(
      seen.map((row) => row.tenantId),
      ['north'],
    );
    assert.equal(seen[0].operatorName, 'Olivia Operator');
    assert.equal(seen[0].operatorEmail, olivia.email.toLowerCase());
    // The same visit, in the dealer's own log, carries the name and no address.
    const dealer = sessions(ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north'))));
    assert.equal(dealer[0].operatorName, 'Olivia Operator');
    assert.equal('operatorEmail' in dealer[0], false);
  });

  test(`${dialect}: the lender's view crosses dealers, which a dealer's own log never does`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, avery, oscar } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    ok(await f.open(avery, 'south', 'dealer_admin'));
    // Avery's own session is live, so a fresh platform lease is taken after it;
    // platform reads still answer while inside a dealer — only acting is refused.
    const seen = audited(ok(await readSessions(f, avery, await lenderLease(f, avery))));
    assert.deepEqual([...new Set(seen.map((row) => row.tenantId))].sort(), ['north', 'south']);
    // North's dealer sees its own visit and not south's.
    const dealer = sessions(ok(await readLog(f, oscar, await dealerLease(f, oscar, 'north'))));
    assert.deepEqual(
      dealer.map((row) => row.supportId),
      [seen.find((row) => row.tenantId === 'north')!.supportId],
    );
  });

  test(`${dialect}: a platform role without the audit grant is refused, and a dealer's lease never reaches it`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, { manifest: withLogGrant });
    await grants(f);
    const { olivia, avery, oscar } = f.accounts;
    ok(await f.open(olivia, 'north', 'dealer_staff'));
    // Olivia is a reviewer: a platform member, granted no `support` operation.
    const refused = await readSessions(f, olivia, await lenderLease(f, olivia));
    assert.equal(refused.status, 403, refused.text);
    assert.doesNotMatch(refused.text, /@example\.test|Olivia Operator/);
    // And the view is the platform realm's: a dealer's tenant lease is not a
    // way into every dealer's history, whatever grants that dealer holds.
    const dealerTried = await f.call(`${SUPPORT_SESSIONS_PATH}?${new URLSearchParams({ app: appId, tenant: 'north' })}`, {
      method: 'GET',
      headers: { cookie: oscar.cookie, [headers.account]: oscar.accountId },
    });
    assert.ok(dealerTried.status >= 400, dealerTried.text);
    assert.doesNotMatch(dealerTried.text, /@example\.test/);
    // The granted platform role does answer, so the refusals are the grant.
    assert.equal(audited(ok(await readSessions(f, avery, await lenderLease(f, avery)))).length, 1);
  });
}

/* ---------- the projection's own rules ---------- */

const row = (over: Partial<SupportSessionRow> = {}): SupportSessionRow => ({
  id: 's1',
  tenantId: 'north',
  accountId: 'a1',
  operatorName: 'Olivia Operator',
  dealerRole: 'dealer_staff',
  parentMembershipId: 'p1',
  parentMembershipVersion: '1',
  platformVersion: '1',
  reason: 'Looking',
  openedAt: '2026-01-01T00:00:00.000Z',
  validUntil: 1,
  nativeSessionId: 'n1',
  deployment: 'd',
  policyId: 'p',
  policyVersion: '1',
  openReceiptId: 'r1',
  endedAt: null,
  endReason: null,
  headSeq: 1,
  headMac: 'x',
  ...over,
});
const change = (detail: unknown, over: Partial<SupportEntryRow> = {}): SupportEntryRow => ({
  sessionId: 's1',
  seq: 1,
  kind: 'write',
  at: '2026-01-01T00:00:01.000Z',
  requestId: 'q1',
  actorId: 'a1',
  tenantId: 'north',
  realm: 'support',
  tenantVersion: '1',
  supportMembershipVersion: '1',
  parentMembershipVersion: '1',
  platformVersion: '1',
  resource: 'application',
  operation: 'update',
  keyJson: '{"id":"x1"}',
  detailJson: JSON.stringify(detail),
  commandReceiptId: null,
  prevMac: 'a',
  mac: 'b',
  ...over,
});
const only = (columns: string[]): SupportLogFields => new Map([['application', new Set(columns)]]);
const first = (result: readonly SupportLogSession[]) => result[0];

test('a change shows only the columns the viewer may read, and names the rest as withheld', () => {
  const rows = {
    sessions: [row()],
    entries: [change({ before: { status: 'new', ssn: 'redacted:abcd' }, after: { status: 'open', ssn: 'redacted:efgh' } })],
  };
  const [shown] = first(projectSupportLog(rows, 'north', 'Lender', only(['status']))).changes;
  assert.deepEqual(shown.before, { status: 'new' });
  assert.deepEqual(shown.after, { status: 'open' });
  // The dealer is told a column it may not read was changed, without its value.
  assert.deepEqual(shown.withheld, ['ssn']);
  assert.equal(shown.resource, 'application');
  assert.equal(shown.operation, 'update');
});

test('a redacted column keeps its keyed hash, which is what the write trail stored', () => {
  const rows = { sessions: [row()], entries: [change({ before: { ssn: 'redacted:abcd' }, after: { ssn: 'redacted:efgh' } })] };
  const [shown] = first(projectSupportLog(rows, 'north', 'Lender', only(['ssn']))).changes;
  // Readable, so it is shown — and what was stored is a hash, never the value.
  assert.deepEqual(shown.before, { ssn: 'redacted:abcd' });
  assert.deepEqual(shown.withheld, []);
});

test('a change to a resource the viewer cannot read at all is not listed', () => {
  const rows = { sessions: [row()], entries: [change({ after: { status: 'open' } }, { resource: 'secret' })] };
  assert.deepEqual(first(projectSupportLog(rows, 'north', 'Lender', only(['status']))).changes, []);
});

test("the projection refuses to carry another tenant's session even if handed one", () => {
  // Defence in depth: the query already filters by tenant, and this filters
  // again, because one dealer seeing another\'s visits is the failure the
  // whole view exists to prevent.
  const rows = { sessions: [row(), row({ id: 's2', tenantId: 'south' })], entries: [] };
  const result = projectSupportLog(rows, 'north', 'Lender', only([]));
  assert.deepEqual(
    result.map((entry) => entry.supportId),
    ['s1'],
  );
});
