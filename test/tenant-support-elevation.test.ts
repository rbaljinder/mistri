/**
 * Audited support sessions, opening and exit ("enter as dealer", piece 5A),
 * on SQLite and live PostgreSQL, through the real tenant host over genuine
 * native auth (test/support/tenantSupportFixture.ts).
 *
 * What 5A proves: opening needs a native login no older than five minutes and
 * a whole policy grant; a session lasts the least of thirty minutes, the
 * native session and the parent membership, and nothing renews it; an
 * account holds one session, a new one supersedes the old; a lost
 * acknowledgement is recovered by status, never replayed into a second
 * session; a restart resumes only the same native login. And what 5A grants:
 * nothing by itself. A support lease refuses every business read and write
 * addressed to it as a dealer's lease or as the platform's, and while an
 * account is inside a dealer no administration, invitation, switch, nested
 * support, export or bearer token goes with it. The one thing a lease may do
 * is read its dealer's rows where the request names the support realm, so that
 * the read can be ledgered: that path is proven in tenant-support-read-http.
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { ADMINISTRATION_JOURNAL_TABLES } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalContract.js';
import { SUPPORT_STARTUP_CHECKS } from '../packages/mistri/src/server/tenant/tenantFeatureSupport.js';
import { TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartupError.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, SUPPORT_AUDIT_TABLES } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { ADMINISTRATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantAdministration.js';
import { INVITATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantInvitations.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  appId,
  binding,
  SUPPORT_POLICY,
  tenantSupportFixture,
  type Account,
  type Answer,
  type SupportFixture,
} from './support/tenantSupportFixture.js';

type Session = {
  supportId: string;
  version: string;
  tenantId: string;
  dealerRole: string;
  operatorName: string;
  reason: string;
  openedAt: string;
  validUntil: number;
  remainingMs: number;
  state: 'active' | 'expired' | 'ended';
};
const sessionOf = (reply: Answer) => (reply.body.receipt as { session: Session }).session;
const leaseOf = (reply: Answer) => reply.body.context as TenantContextReply;
function ok(reply: Answer) {
  assert.equal(reply.status, 200, reply.text);
  return reply;
}
/** Refused, with the one public code, and nothing private in the body. */
function refused(reply: Answer, code: string = SUPPORT_REFUSAL_CODES.refused) {
  assert.ok(reply.status >= 400, reply.text);
  assert.equal(reply.body.code, code, reply.text);
  assert.doesNotMatch(reply.text, /PRIVATE_|@example\.test|nativeSession|sessionId|headMac|SELECT|__tablewalk/);
  return reply;
}
const supportRows = (f: SupportFixture) =>
  f.rows(`SELECT id, status, version, roles_json, account_id, tenant_id, valid_until
  FROM "${TENANT_TABLES.membership}" WHERE kind = 'support' ORDER BY id`);
const auditSessions = (f: SupportFixture) =>
  f.rows(`SELECT id, operator_name, end_reason, account_id, tenant_id
  FROM "${SUPPORT_AUDIT_TABLES.session}" ORDER BY opened_at, id`);
const active = async (f: SupportFixture) => (await supportRows(f)).filter((row) => row.status === 'active');
const loginAs = (who: Account, cookie: string): Account => ({ ...who, cookie });
const intent = (tenantId: string, dealerRole: string, reason = 'Checking a stuck application') => ({
  operation: 'openSupport',
  tenantId,
  dealerRole,
  reason,
});

/** The next COMMIT on the business store is applied and then its
 * acknowledgement is lost, exactly as a dropped connection would lose it. */
async function loseNextCommit(t: TestContext, f: SupportFixture) {
  let armed = true;
  if (f.dialect === 'sqlite') {
    const business = realpathSync(f.path),
      exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      const result = exec.call(this, sql);
      if (armed && sql === 'COMMIT' && this.location() === business) {
        armed = false;
        throw new Error('PRIVATE_SENTINEL: acknowledgement lost');
      }
      return result;
    });
  } else {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default: { Client: { prototype: { query: (...args: unknown[]) => unknown } } } };
    const prototype = pg.default.Client.prototype,
      query = prototype.query,
      control = f.control();
    t.mock.method(prototype, 'query', function (this: unknown, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (armed && text === 'COMMIT' && this !== control) {
        armed = false;
        return Promise.resolve(query.apply(this, args)).then(() => {
          throw new Error('PRIVATE_SENTINEL: acknowledgement lost');
        });
      }
      return query.apply(this, args);
    });
  }
  return () => {
    armed = false;
    t.mock.restoreAll();
  };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(
    `${dialect}: an operator enters a dealer, the support lease refuses every business read and write, and exit ends it`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { olivia } = f.accounts;
      const whoami = ok(await f.call(`/api/whoami?app=${appId}`, { headers: { cookie: olivia.cookie } }));
      assert.equal(whoami.body.tenantSupport, true);
      const before = ok(await f.support(olivia, 'status'));
      assert.equal(before.body.session, null);
      assert.equal(before.body.signInRequired, false);
      assert.equal(before.body.passwordSignIn, true);
      // Parkside is suspended: a grant naming it offers nothing there.
      assert.deepEqual(before.body.choices, [{ tenantId: 'north', roles: ['dealer_staff'], name: 'North Motors' }]);

      const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
      const session = sessionOf(opened),
        lease = leaseOf(opened);
      assert.equal(opened.body.replayed, false);
      assert.deepEqual(
        {
          tenantId: session.tenantId,
          dealerRole: session.dealerRole,
          operatorName: session.operatorName,
          state: session.state,
          version: session.version,
        },
        { tenantId: 'north', dealerRole: 'dealer_staff', operatorName: 'Olivia Operator', state: 'active', version: '1' },
      );
      assert.equal(session.validUntil - Date.parse(session.openedAt), 1800000);
      assert.equal(lease.realm, 'support');
      assert.equal(lease.tenantId, 'north');
      assert.equal(opened.headers.get('x-mistri-realm'), 'support');
      assert.doesNotMatch(opened.text, /@example\.test|nativeSessionId|parent|policy/);

      // None of these is addressed to the support realm, and none is served:
      // a dealer's own address, and the platform's, grant a support lease
      // nothing. Reads named to the support realm are a separate suite's.
      // Nothing is written under support at all until its write trail is proven.
      const business: [string, unknown, Record<string, string>?][] = [
        ['/api/query', { table: 'lead' }],
        ['/api/count', { table: 'lead' }],
        ['/api/run', { q: 'lead' }],
        ['/api/references', { table: 'lead', key: { id: 'n1' } }],
        ['/api/update', { table: 'lead', key: { id: 'n1' }, values: { name: 'Changed under support' } }],
        ['/api/insert', { table: 'lead', values: { id: 'n9', tenant_id: 'north', name: 'Inserted under support' } }],
        ['/api/delete', { table: 'lead', key: { id: 'n1' }, confirm: true }],
        ['/api/revert', { confirm: false }],
        ['/api/commands/prepare', { command: 'flag', commandVersion: 1, key: { id: 'n1' } }],
        [
          '/api/commands/execute',
          { command: 'flag', commandVersion: 1, key: { id: 'n1' }, expectedVersion: 0, idempotencyKey: 'k', input: {} },
        ],
        // The platform realm's reads and commands, on the support lease: never.
        ['/api/query', { table: 'lead' }, { realm: 'platform' }],
        [
          '/api/commands/execute',
          { command: 'flag', commandVersion: 1, key: { id: 'n1' }, expectedVersion: 0, idempotencyKey: 'k', input: {} },
          { realm: 'platform' },
        ],
      ];
      for (const [target, body, selector] of business) {
        const reply = refused(await f.onLease(olivia, lease, target, body, selector), SUPPORT_REFUSAL_CODES.unavailable);
        assert.equal(reply.status, 403);
        assert.equal(reply.body.error, 'Support access is not available yet.');
        assert.notEqual(reply.body.outcome, 'unknown');
        assert.equal(reply.headers.get('x-mistri-context'), null);
      }
      assert.equal((await f.rows('SELECT name FROM lead WHERE id = ?', ['n1']))[0].name, 'North lead');
      assert.equal((await f.rows('SELECT count(*) AS n FROM lead'))[0].n, dialect === 'sqlite' ? 2 : '2');
      // There is no export route to reach: the tenant host serves none.
      assert.equal((await f.onLease(olivia, lease, '/api/export', { table: 'lead' })).status, 403);

      const current = ok(await f.support(olivia, 'status', { resume: true }));
      assert.equal((current.body.session as Session).supportId, session.supportId);
      assert.equal((current.body.session as Session).state, 'active');
      assert.equal((current.body.context as TenantContextReply).realm, 'support');
      assert.notEqual((current.body.context as TenantContextReply).tabId, lease.tabId);

      const ended = ok(await f.exit(olivia, session));
      assert.equal(sessionOf(ended).state, 'ended');
      assert.equal((ended.body.receipt as { operation: string }).operation, 'exitSupport');
      assert.deepEqual(
        (await supportRows(f)).map((row) => [row.status, row.version]),
        [['revoked', '2']],
      );
      const [audit] = await auditSessions(f);
      assert.deepEqual([audit.operator_name, audit.end_reason], ['Olivia Operator', 'exit']);
      assert.deepEqual(await f.verifyAudit(), { version: 1, sessions: 1, entries: 2, failed: [] });
      // The dealer's side of the record names a person, never an email.
      const recorded = JSON.stringify([
        ...(await f.rows(`SELECT * FROM "${SUPPORT_AUDIT_TABLES.session}"`)),
        ...(await f.rows(`SELECT * FROM "${SUPPORT_AUDIT_TABLES.entry}"`)),
      ]);
      assert.doesNotMatch(recorded, /@example\.test/);
      assert.deepEqual(
        (await f.rows(`SELECT operation FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}" ORDER BY completed_at`)).map(
          (row) => row.operation,
        ),
        ['openSupport', 'exitSupport'],
      );
      // The ended session's lease is fenced off; status no longer shows it.
      refused(
        await f.call(`/api/tenant/context/recover?app=${appId}`, {
          body: { tabId: lease.tabId },
          headers: { cookie: olivia.cookie, 'x-mistri-account': olivia.accountId },
        }),
        'tenant_context_unavailable',
      );
      assert.equal(ok(await f.support(olivia, 'status')).body.session, null);
    },
  );

  test(`${dialect}: opening needs a native sign-in from the last five minutes; exit and status do not`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    await f.native.age(olivia.cookie, 290_000);
    const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
    // Older now than five minutes: the open session still reports and exits.
    await f.native.age(olivia.cookie, 310_000);
    assert.equal((ok(await f.support(olivia, 'status')).body.session as Session).state, 'active');
    assert.equal(ok(await f.support(olivia, 'status')).body.signInRequired, true);
    ok(await f.exit(olivia, sessionOf(opened)));
    // But a new opening is refused, with the one code the dialog acts on, and writes nothing.
    const stale = refused(await f.open(olivia, 'north', 'dealer_staff'), SUPPORT_REFUSAL_CODES.signInRequired);
    assert.equal(stale.body.outcome, 'not_applied');
    assert.equal((await supportRows(f)).length, 1);
    // A real sign-in is a new native session: it opens, and the old login cannot see it.
    const fresh = loginAs(olivia, await f.signIn(olivia.email, olivia.password));
    ok(await f.open(fresh, 'north', 'dealer_staff'));
    assert.equal(ok(await f.support(olivia, 'status')).body.session, null);
    assert.equal((ok(await f.support(fresh, 'status')).body.session as Session).state, 'active');
  });

  test(
    `${dialect}: a session lasts thirty minutes at most, capped by the parent and the native login, and nothing renews it`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { avery, olivia } = f.accounts;
      // The deployment's clock only moves forward, so the caps come first.
      const first = sessionOf(ok(await f.open(avery, 'south', 'dealer_admin')));
      assert.equal(first.validUntil - Date.parse(first.openedAt), 1800000);
      // The parent membership's validity caps the next session, which supersedes the first.
      const parentUntil = Date.now() + 600_000;
      await f.maintenance((admin) =>
        admin.putPlatformMembership({
          accountId: avery.accountId,
          membershipId: 'platform-avery',
          status: 'active',
          roles: ['lender_admin'],
          validUntil: parentUntil,
          expectedVersion: '1',
        }),
      );
      // A changed parent fences the running session off at once: it is not called active.
      assert.equal((ok(await f.support(avery, 'status')).body.session as Session).state, 'ended');
      const capped = sessionOf(ok(await f.open(avery, 'south', 'dealer_admin')));
      assert.equal(capped.validUntil, parentUntil);
      // So does the native session's own expiry.
      const nativeUntil = Date.now() + 240_000;
      await f.native.expire(avery.cookie, nativeUntil);
      const short = sessionOf(ok(await f.open(avery, 'north', 'dealer_staff')));
      assert.equal(short.validUntil, nativeUntil);
      assert.deepEqual(
        (await auditSessions(f)).map((row) => row.end_reason),
        ['superseded', 'superseded', null],
      );

      // Thirty minutes, never renewed: status and a resumed lease do not move the end.
      const long = sessionOf(ok(await f.open(olivia, 'north', 'dealer_staff')));
      assert.equal(long.validUntil - Date.parse(long.openedAt), 1800000);
      f.clock.offset = long.validUntil - Date.now() - 5000;
      const late = ok(await f.support(olivia, 'status', { resume: true }));
      assert.equal((late.body.session as Session).state, 'active');
      assert.ok((late.body.session as Session).remainingMs <= 5000);
      assert.equal((late.body.session as Session).validUntil, long.validUntil);
      assert.ok(late.body.context);
      // At the thirtieth minute it has ended, and this very call is what ends it:
      // the row is revoked and the chain says `expired`. It is not resumed, and
      // not revived to be exited.
      f.clock.offset = long.validUntil - Date.now();
      const expired = ok(await f.support(olivia, 'status', { resume: true }));
      assert.equal((expired.body.session as Session).state, 'ended');
      assert.equal((expired.body.session as Session).remainingMs, 0);
      assert.equal(expired.body.context, undefined);
      assert.equal(
        (await f.rows(`SELECT end_reason FROM "${SUPPORT_AUDIT_TABLES.session}" WHERE id = ?`, [long.supportId]))[0].end_reason,
        'expired',
      );
      refused(
        await f.onLease(olivia, late.body.context as TenantContextReply, '/api/query', { table: 'lead' }),
        SUPPORT_REFUSAL_CODES.unavailable,
      );
      refused(await f.exit(olivia, long));
      // Olivia's row is closed; Avery's, expired too, waits for Avery's own next call.
      assert.equal((await active(f)).length, 1);
      // Closing it is said once: the next call finds no session and changes nothing.
      assert.equal(ok(await f.support(olivia, 'status')).body.session, null);
      assert.equal((await active(f)).length, 1);
      assert.deepEqual((await f.verifyAudit()).failed, []);
    },
  );

  test(`${dialect}: impersonation, over-ceiling roles, other dealers, suspended dealers and outsiders are refused`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia, avery, sam, oscar } = f.accounts;
    refused(await f.open(olivia, 'north', 'dealer_admin')); // a role above the grant
    refused(await f.open(olivia, 'south', 'dealer_staff')); // a dealer the grant does not name
    refused(await f.open(olivia, 'parkside', 'dealer_staff')); // a named dealer, suspended
    refused(await f.open(avery, 'parkside', 'dealer_admin')); // 'all' is every ACTIVE dealer
    refused(await f.open(avery, 'north', 'lender_admin')); // a platform role is no dealer role
    refused(await f.open(oscar, 'north', 'dealer_staff')); // no platform membership at all
    refused(await f.open(sam, 'north', 'dealer_staff')); // a dealer's own member is not lender staff
    refused(await f.open({ ...olivia, accountId: avery.accountId }, 'north', 'dealer_staff')); // a stale account claim
    refused(await f.support(olivia, 'open', { idempotencyKey: 'bad', intent: { ...intent('north', 'dealer_staff'), reason: '   ' } }));
    refused(await f.support(olivia, 'open', { idempotencyKey: 'bad', intent: intent('north', 'dealer_staff', 'x'.repeat(501)) }));
    refused(await f.support(olivia, 'open', { idempotencyKey: 'bad', intent: { ...intent('north', 'dealer_staff'), extra: true } }));
    // A suspended platform realm admits no support.
    await f.maintenance((admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
    refused(await f.open(avery, 'south', 'dealer_admin'));
    await f.maintenance((admin) => admin.putPlatform({ status: 'active', expectedVersion: '2' }));
    // An impersonated native login is never anyone's authority.
    await f.native.impersonate(avery.cookie, olivia.accountId);
    refused(await f.open(avery, 'south', 'dealer_admin'));
    assert.deepEqual(await supportRows(f), []);
    assert.deepEqual(await auditSessions(f), []);
    assert.equal(
      (await f.rows(`SELECT count(*) AS n FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}"`))[0].n,
      dialect === 'sqlite' ? 0 : '0',
    );
  });

  test(`${dialect}: a policy granting a platform role, or an undeclared role, as a dealer role never starts`, { skip }, async (t) => {
    for (const grants of [
      [{ platformRole: 'reviewer', tenants: 'all', dealerRoles: ['lender_admin'] }],
      [{ platformRole: 'dealer_staff', tenants: 'all', dealerRoles: ['dealer_staff'] }],
      [{ platformRole: 'reviewer', tenants: 'all', dealerRoles: ['ghost'] }],
    ]) {
      await t.test(JSON.stringify(grants), async (sub) => {
        await assert.rejects(tenantSupportFixture(sub, dialect, { policy: { id: 'bad', version: '1', grants } }));
      });
    }
    await t.test('without the platform realm', async (sub) => {
      await assert.rejects(
        tenantSupportFixture(sub, dialect, {
          manifest: (raw) => {
            const auth = raw.auth as { tenancy: Record<string, unknown> };
            delete auth.tenancy.platform;
            delete auth.tenancy.profile;
            (raw.resources as Record<string, { owner: string }>).dealer.owner = 'global';
            raw.nav = [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] }] as never;
            (raw.auth.roles as Record<string, { realm: string }>).reviewer.realm = 'tenant';
            (raw.auth.roles as Record<string, { realm: string }>).lender_admin.realm = 'tenant';
          },
        }),
      );
    });
  });

  test(`${dialect}: an account holds one session; a new opening supersedes the old, from any login`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { avery } = f.accounts;
    const firstReply = ok(await f.open(avery, 'north', 'dealer_staff')),
      first = sessionOf(firstReply);
    const second = sessionOf(ok(await f.open(avery, 'south', 'dealer_admin')));
    assert.deepEqual(
      (await active(f)).map((row) => row.id),
      [second.supportId],
    );
    assert.deepEqual(
      (await auditSessions(f)).map((row) => [row.id, row.end_reason]),
      [
        [first.supportId, 'superseded'],
        [second.supportId, null],
      ],
    );
    // The superseded session's lease is fenced off, and it cannot be exited now.
    refused(
      await f.call(`/api/tenant/context/recover?app=${appId}`, {
        body: { tabId: leaseOf(firstReply).tabId },
        headers: { cookie: avery.cookie, 'x-mistri-account': avery.accountId },
      }),
      'tenant_context_unavailable',
    );
    refused(await f.exit(avery, first));
    // Another login of the same account supersedes it too; the first login no longer sees one.
    const other = loginAs(avery, await f.signIn(avery.email, avery.password));
    const third = sessionOf(ok(await f.open(other, 'north', 'dealer_admin')));
    assert.equal(ok(await f.support(avery, 'status')).body.session, null);
    assert.equal((ok(await f.support(other, 'status')).body.session as Session).supportId, third.supportId);
    refused(await f.exit(avery, second));
    assert.deepEqual(
      (await active(f)).map((row) => row.id),
      [third.supportId],
    );
    assert.deepEqual(await f.verifyAudit(), { version: 1, sessions: 3, entries: 5, failed: [] });
  });

  test(
    `${dialect}: revoking the parent platform membership ends the session under it, said in the chain as parent_revoked`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { olivia } = f.accounts;
      const where = f.dialect === 'sqlite' ? { sqlite: f.path } : { postgres: f.url };
      const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
      const session = sessionOf(opened),
        lease = leaseOf(opened);
      // The lender revokes the operator's own platform membership. The support
      // session under it ends in that same transaction, and the receipt names it.
      const revoked = await maintenance.revokePlatformMembership(where, binding, {
        membershipId: 'platform-olivia',
        expectedVersion: '1',
        operator: 'ops-kim',
      });
      assert.deepEqual(revoked.supportRevoked, [session.supportId]);
      assert.deepEqual(
        (await supportRows(f)).map((row) => [row.status, row.version]),
        [['revoked', '2']],
      );
      const [audit] = await auditSessions(f);
      assert.equal(audit.end_reason, 'parent_revoked');
      // The end is an entry on the chain, not a column edited around it.
      assert.deepEqual(await f.verifyAudit(), { version: 1, sessions: 1, entries: 2, failed: [] });
      // Nothing of the dealer's is reachable on that lease, and status offers no session.
      const gone = await f.onLease(olivia, lease, '/api/query', { table: 'lead' });
      assert.ok(gone.status >= 400, gone.text);
      assert.doesNotMatch(gone.text, /@example\.test|North lead/);
      assert.equal(ok(await f.support(olivia, 'status')).body.session, null);
      // A revoked session is not ended a second time.
      refused(await f.exit(olivia, session));
      assert.equal((await active(f)).length, 0);
    },
  );

  test(
    `${dialect}: a damaged audit chain cannot keep a session alive; revocation ends it and says the chain did not verify`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { olivia } = f.accounts;
      const where = f.dialect === 'sqlite' ? { sqlite: f.path } : { postgres: f.url };
      const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
      const session = sessionOf(opened),
        lease = leaseOf(opened);
      // Someone holding the database edits the chain: the opening entry's detail
      // no longer matches the MAC that covers it.
      await f.rows(`UPDATE "${SUPPORT_AUDIT_TABLES.entry}" SET detail_json = ? WHERE session_id = ? AND seq = 0`, [
        '{"tampered":true}',
        session.supportId,
      ]);
      assert.deepEqual((await f.verifyAudit()).failed, [session.supportId]);
      // Revocation is the mechanism that cuts access off, so it is never
      // blockable by damaging the record of it: the row is revoked either way
      // and the receipt states what could not be recorded.
      const revoked = await maintenance.revokePlatformMembership(where, binding, {
        membershipId: 'platform-olivia',
        expectedVersion: '1',
        operator: 'ops-kim',
      });
      assert.deepEqual(revoked.supportRevoked, [session.supportId]);
      assert.deepEqual(revoked.supportChainUnverified, [session.supportId]);
      assert.deepEqual(
        (await supportRows(f)).map((row) => [row.status, row.version]),
        [['revoked', '2']],
      );
      // Nothing was forged onto a chain that does not verify: it has no end.
      assert.equal(
        (await f.rows(`SELECT end_reason FROM "${SUPPORT_AUDIT_TABLES.session}" WHERE id = ?`, [session.supportId]))[0].end_reason,
        null,
      );
      assert.deepEqual(
        JSON.parse(
          (
            await f.rows(`SELECT result_json FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}"
      WHERE operation = 'revokePlatformMembership'`)
          )[0].result_json as string,
        ).supportChainUnverified,
        [session.supportId],
      );
      // And the access itself is gone.
      const gone = await f.onLease(olivia, lease, '/api/query', { table: 'lead' });
      assert.ok(gone.status >= 400, gone.text);
      assert.equal(ok(await f.support(olivia, 'status')).body.session, null);
      assert.equal((await active(f)).length, 0);
    },
  );

  test(
    `${dialect}: lost open and exit acknowledgements are recovered by status and never replayed into a second session`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { olivia } = f.accounts;
      // A retried open replays its receipt: the same session, not a second.
      const first = ok(await f.open(olivia, 'north', 'dealer_staff', 'open-retry'));
      const again = ok(await f.open(olivia, 'north', 'dealer_staff', 'open-retry'));
      assert.equal(again.body.replayed, true);
      assert.equal(sessionOf(again).supportId, sessionOf(first).supportId);
      // The same key for another intent is refused, never reinterpreted.
      refused(await f.open(olivia, 'north', 'dealer_staff', 'open-retry', 'A different reason'));
      ok(await f.exit(olivia, sessionOf(first)));
      assert.equal((await supportRows(f)).length, 1);

      // The open commits and its acknowledgement is lost.
      let restore = await loseNextCommit(t, f);
      const lost = await f.open(olivia, 'north', 'dealer_staff', 'open-lost');
      restore();
      assert.equal(lost.status, 503, lost.text);
      assert.equal(lost.body.outcome, 'unknown');
      const recovered = ok(
        await f.support(olivia, 'status', { attempt: { idempotencyKey: 'open-lost', intent: intent('north', 'dealer_staff') } }),
      );
      const receipt = recovered.body.recovered as { operation: string; session: Session };
      assert.equal(receipt.operation, 'openSupport');
      assert.equal(receipt.session.state, 'active');
      const replay = ok(await f.open(olivia, 'north', 'dealer_staff', 'open-lost'));
      assert.equal(replay.body.replayed, true);
      assert.equal(sessionOf(replay).supportId, receipt.session.supportId);
      assert.equal((await active(f)).length, 1);

      // The exit commits and its acknowledgement is lost.
      restore = await loseNextCommit(t, f);
      const exitIntent = { operation: 'exitSupport', tenantId: 'north', supportId: receipt.session.supportId, expectedSupportVersion: '1' };
      const lostExit = await f.support(olivia, 'exit', { idempotencyKey: 'exit-lost', intent: exitIntent });
      restore();
      assert.equal(lostExit.status, 503, lostExit.text);
      assert.equal(lostExit.body.outcome, 'unknown');
      const exited = ok(await f.support(olivia, 'status', { attempt: { idempotencyKey: 'exit-lost', intent: exitIntent } }));
      assert.equal((exited.body.recovered as { session: Session }).session.state, 'ended');
      assert.equal((await active(f)).length, 0);
      // An attempt that never committed recovers nothing, and status opens nothing.
      const never = ok(
        await f.support(olivia, 'status', { attempt: { idempotencyKey: 'never-sent', intent: intent('north', 'dealer_staff') } }),
      );
      assert.equal(never.body.recovered, null);
      assert.equal((await supportRows(f)).length, 2);
      assert.deepEqual((await f.verifyAudit()).failed, []);
    },
  );

  test(`${dialect}: a restart resumes a live session only for the same native login`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const opened = ok(await f.open(olivia, 'north', 'dealer_staff')),
      session = sessionOf(opened);
    await f.restart();
    // The old tab died with the old host.
    refused(
      await f.call(`/api/tenant/context/recover?app=${appId}`, {
        body: { tabId: leaseOf(opened).tabId },
        headers: { cookie: olivia.cookie, 'x-mistri-account': olivia.accountId },
      }),
      'tenant_context_unavailable',
    );
    const resumed = ok(await f.support(olivia, 'status', { resume: true }));
    assert.equal((resumed.body.session as Session).supportId, session.supportId);
    assert.equal((resumed.body.context as TenantContextReply).realm, 'support');
    // The same account's other login neither sees nor resumes it.
    const other = loginAs(olivia, await f.signIn(olivia.email, olivia.password));
    const elsewhere = ok(await f.support(other, 'status', { resume: true }));
    assert.equal(elsewhere.body.session, null);
    assert.equal(elsewhere.body.context, undefined);
    // Its lease still refuses every business read.
    refused(
      await f.onLease(olivia, resumed.body.context as TenantContextReply, '/api/query', { table: 'lead' }),
      SUPPORT_REFUSAL_CODES.unavailable,
    );
    ok(await f.exit(olivia, session));
  });

  test(`${dialect}: while an account is inside a dealer, its other tabs do not act as the platform`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { avery } = f.accounts;
    const own = { cookie: avery.cookie, 'x-mistri-account': avery.accountId };
    // A platform lease in its own tab, taken before entering any dealer.
    const lender = ok(await f.call(`/api/tenant/context/open?app=${appId}&realm=platform`, { body: {}, headers: own }))
      .body as unknown as TenantContextReply;
    assert.equal(lender.realm, 'platform');
    const command = { command: 'flag', commandVersion: 1, key: { id: 'n1' }, expectedVersion: 0, idempotencyKey: 'k', input: {} };
    const opened = ok(await f.open(avery, 'north', 'dealer_admin'));
    // The account is inside a dealer now, so the platform tab may not act as
    // the platform, even though its own lease is untouched and still current.
    const blocked = refused(
      await f.onLease(avery, lender, '/api/commands/execute', command, { realm: 'platform' }),
      SUPPORT_REFUSAL_CODES.active,
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.outcome, 'not_applied');
    // The support lease's own tab is refused as it always was.
    refused(
      await f.onLease(avery, leaseOf(opened), '/api/commands/execute', command, { realm: 'platform' }),
      SUPPORT_REFUSAL_CODES.unavailable,
    );
    // Looking is not acting: a platform read in that tab still answers, so an
    // operator can see what they were reading before they entered.
    assert.equal((await f.onLease(avery, lender, '/api/query', { table: 'dealer' }, { realm: 'platform' })).status, 200);
    // Out of the dealer, the platform tab is no longer refused for being in one.
    ok(await f.exit(avery, sessionOf(opened)));
    assert.notEqual(
      (await f.onLease(avery, lender, '/api/commands/execute', command, { realm: 'platform' })).body.code,
      SUPPORT_REFUSAL_CODES.active,
    );
  });

  // The platform realm's generic edit acts as the platform, so it is held the same way as its commands.
  test(`${dialect}: while an account is inside a dealer, its platform tab saves nothing either`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect, {
        manifest: (raw) => {
          (raw.resources as Record<string, unknown>).dealer = { owner: 'platform', access: 'write' };
          (raw.auth.roles as Record<string, unknown>).lender_admin = { realm: 'platform', read: true, write: ['dealer'] };
        },
      }),
      { avery } = f.accounts;
    const own = { cookie: avery.cookie, 'x-mistri-account': avery.accountId };
    const lender = ok(await f.call(`/api/tenant/context/open?app=${appId}&realm=platform`, { body: {}, headers: own }))
      .body as unknown as TenantContextReply;
    const rename = (name: string) => ({ table: 'dealer', key: { id: 'parkside' }, values: { name } });
    ok(await f.onLease(avery, lender, '/api/update', rename('Parkside Motors'), { realm: 'platform' }));
    const opened = ok(await f.open(avery, 'north', 'dealer_admin'));
    const blocked = refused(
      await f.onLease(avery, lender, '/api/update', rename('Parkside Inside'), { realm: 'platform' }),
      SUPPORT_REFUSAL_CODES.active,
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.outcome, 'not_applied');
    ok(await f.exit(avery, sessionOf(opened)));
    ok(await f.onLease(avery, lender, '/api/update', rename('Parkside Again'), { realm: 'platform' }));
  });

  test(
    `${dialect}: inside a dealer, no administration, invitation, switch, nested support, renewal, export or bearer token`,
    { skip },
    async (t) => {
      const f = await tenantSupportFixture(t, dialect),
        { avery, olivia } = f.accounts;
      const opened = ok(await f.open(avery, 'north', 'dealer_admin')),
        lease = leaseOf(opened);
      const own = { cookie: avery.cookie, 'x-mistri-account': avery.accountId };
      // Membership changes and delegated administration are administration's routes; invitations are theirs.
      for (const target of [
        `${ADMINISTRATION_HTTP_ROOT}/open`,
        `${ADMINISTRATION_HTTP_ROOT}/execute`,
        `${ADMINISTRATION_HTTP_ROOT}/status`,
        `${INVITATION_HTTP_ROOT}/issue`,
        `${INVITATION_HTTP_ROOT}/accept`,
      ]) {
        const reply = refused(await f.call(`${target}?app=${appId}`, { body: {}, headers: own }), SUPPORT_REFUSAL_CODES.active);
        assert.equal(reply.status, 403);
      }
      // Another account, outside any dealer, reaches administration's own answer.
      assert.notEqual(
        (
          await f.call(`${ADMINISTRATION_HTTP_ROOT}/open?app=${appId}`, {
            body: {},
            headers: { cookie: olivia.cookie, 'x-mistri-account': olivia.accountId },
          })
        ).body.code,
        SUPPORT_REFUSAL_CODES.active,
      );
      const assertion = { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision };
      // Switching to another tenant or to the platform, and renewing as a tenant's lease.
      for (const selector of ['tenant=south', 'tenant=north', 'realm=platform']) {
        refused(
          await f.call(`/api/tenant/context/switch?app=${appId}&${selector}`, { body: assertion, headers: own }),
          'tenant_context_unavailable',
        );
      }
      refused(
        await f.call(`/api/tenant/context/renew?app=${appId}&tenant=north`, { body: assertion, headers: own }),
        'tenant_context_unavailable',
      );
      // A support row never admits through an ordinary tenant selection.
      refused(await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own }), 'tenant_context_unavailable');
      // Nested support: a support request carries no lease, so none can stack on another.
      const nested = await f.support(
        avery,
        'open',
        { idempotencyKey: 'nested', intent: intent('south', 'dealer_admin') },
        { 'x-mistri-tab': lease.tabId, 'x-mistri-context': lease.context, 'x-mistri-lease-revision': String(lease.revision) },
      );
      assert.equal(nested.status, 400);
      // An App API bearer token never enters support.
      assert.equal((await f.support(avery, 'status', {}, { authorization: 'Bearer twk_not_a_support_credential' })).status, 403);
      assert.equal((await f.onLease(avery, lease, '/api/export', {})).status, 403);
      assert.equal((await active(f)).length, 1);
      // Once out of the dealer, administration answers for itself again.
      ok(await f.exit(avery, sessionOf(opened)));
      assert.notEqual(
        (await f.call(`${ADMINISTRATION_HTTP_ROOT}/open?app=${appId}`, { body: {}, headers: own })).body.code,
        SUPPORT_REFUSAL_CODES.active,
      );
    },
  );
}

test('startup names each support requirement it cannot meet', () => {
  const [write, ceiling, authStore, key] = SUPPORT_STARTUP_CHECKS;
  const policy = { support: SUPPORT_POLICY };
  const run = (check: typeof write, startup: Record<string, unknown>) => (check as { run(value: unknown): void }).run(startup);
  assert.throws(() => run(write, { policy, connection: {} }), TenantStartupError);
  run(write, { policy, connection: { writable: true } });
  run(write, { policy: {}, connection: {} });
  assert.throws(() => run(ceiling, { policy, app: { auth: { roles: {} } } }), TenantStartupError);
  assert.throws(
    () => run(authStore, { policy, engine: 'sqlite', loaded: { path: '/x/app.ts', app: { auth: { store: 'postgres://db/auth' } } } }),
    TenantStartupError,
  );
  const saved = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  try {
    delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    assert.throws(() => run(key, { policy }), TenantStartupError);
    process.env[SUPPORT_AUDIT_KEY_VARIABLE] = 'too short';
    assert.throws(() => run(key, { policy }), TenantStartupError);
    run(key, { policy: {} });
  } finally {
    if (saved === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = saved;
  }
  assert.ok([write, ceiling, authStore, key].every((check) => typeof check.stage === 'string' && check.stage.includes('support')));
});
