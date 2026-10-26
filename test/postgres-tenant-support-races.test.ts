/**
 * Support sessions racing on live PostgreSQL, through the real host and two
 * or more real connections. Every support operation takes its own receipt
 * scope, then `@platform`, the parent memberships, the dealers and the
 * support rows FOR UPDATE, in that order (tenantSupportTransactionPostgres.ts);
 * platform membership maintenance takes `@platform` first too. So openings
 * by one account serialise, an exit racing an opening leaves one live
 * session, and a parent revocation either waits for an opening or makes it
 * wait — and never deadlocks. Each test owns a UUID-named database.
 */
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { createPostgresTenantAdministration } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { SUPPORT_AUDIT_TABLES } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';
import { liveSkip } from './live.js';
import { pgClient } from './support/tenantDialects.js';
import { appId, binding, tenantSupportFixture, type Account, type Answer, type SupportFixture } from './support/tenantSupportFixture.js';

const skip = liveSkip('postgres', process.env.TABLEWALK_TEST_PG);
type Session = { supportId: string; version: string; tenantId: string; state: string };
const sessionOf = (reply: Answer) => (reply.body.receipt as { session: Session }).session;
const live = async (f: SupportFixture) =>
  (
    await f.rows(`SELECT id FROM "${TENANT_TABLES.membership}"
  WHERE kind = 'support' AND status = 'active' ORDER BY id`)
  ).map((row) => row.id);
const ends = async (f: SupportFixture) =>
  Object.fromEntries((await f.rows(`SELECT id, end_reason FROM "${SUPPORT_AUDIT_TABLES.session}"`)).map((row) => [row.id, row.end_reason]));
const loginAs = (who: Account, cookie: string): Account => ({ ...who, cookie });

/** A settled flag for a request still on the wire. */
function watched<T>(promise: Promise<T>) {
  const state = {
    settled: false,
    promise: promise.finally(() => {
      state.settled = true;
    }),
  };
  return state;
}
/** A revocation of Avery's platform membership, held open on its own connection. */
async function heldRevocation(f: SupportFixture) {
  const client = await pgClient(f.url);
  // The fixture drops its database last; this connection must be gone by then.
  (client as unknown as { on(event: string, listener: () => void): void }).on('error', () => {});
  const operations = new TransactionOperations();
  await client.query('BEGIN');
  const revoked = createPostgresTenantAdministration(client, operations, binding).putPlatformMembership({
    accountId: f.accounts.avery.accountId,
    membershipId: 'platform-avery',
    status: 'revoked',
    roles: ['lender_admin'],
    validUntil: Date.now() + 3600000,
    expectedVersion: '1',
  });
  void revoked.catch(() => {});
  return {
    revoked,
    commit: async () => {
      await revoked;
      await operations.finish();
      await client.query('COMMIT');
    },
    end: () => client.end().catch(() => {}),
  };
}
/** Hold the support owner's transaction just before it records the new session. */
async function pauseOpening(t: TestContext) {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default: { Client: { prototype: { query: (...args: unknown[]) => unknown } } } };
  const prototype = pg.default.Client.prototype,
    query = prototype.query;
  let reached!: () => void,
    release!: () => void,
    armed = true;
  const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  t.mock.method(prototype, 'query', function (this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    if (armed && text?.startsWith(`INSERT INTO ${runtimeTable('postgres', SUPPORT_AUDIT_TABLES.session)}`)) {
      armed = false;
      reached();
      return gate.then(() => query.apply(this, args));
    }
    return query.apply(this, args);
  });
  t.after(() => release());
  return { arrived, release };
}

test('postgres: two openings by one account serialise on @platform; one survives, the other is superseded', { skip }, async (t) => {
  const f = await tenantSupportFixture(t, 'postgres'),
    { avery } = f.accounts;
  const other = loginAs(avery, await f.signIn(avery.email, avery.password));
  const [a, b] = await Promise.all([f.open(avery, 'north', 'dealer_admin'), f.open(other, 'south', 'dealer_staff')]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const survivor = await live(f);
  assert.equal(survivor.length, 1);
  const closed = [sessionOf(a).supportId, sessionOf(b).supportId].filter((id) => id !== survivor[0]);
  assert.deepEqual(await ends(f), { [survivor[0] as string]: null, [closed[0]]: 'superseded' });
  assert.deepEqual((await f.verifyAudit()).failed, []);
});

test('postgres: an exit racing a new opening leaves exactly the new session live', { skip }, async (t) => {
  const f = await tenantSupportFixture(t, 'postgres'),
    { avery } = f.accounts;
  const first = sessionOf(await f.open(avery, 'north', 'dealer_admin'));
  const [exited, next] = await Promise.all([f.exit(avery, first), f.open(avery, 'south', 'dealer_staff')]);
  assert.equal(next.status, 200, next.text);
  assert.deepEqual(await live(f), [sessionOf(next).supportId]);
  // Whichever took @platform first wrote the old session's one end.
  assert.equal((await ends(f))[first.supportId], exited.status === 200 ? 'exit' : 'superseded');
  if (exited.status !== 200) assert.equal(exited.body.code, SUPPORT_REFUSAL_CODES.refused);
  assert.deepEqual((await f.verifyAudit()).failed, []);
});

test('postgres: a parent revocation holding @platform makes an opening wait, then refuse', { skip }, async (t) => {
  const f = await tenantSupportFixture(t, 'postgres'),
    { avery } = f.accounts;
  const held = await heldRevocation(f);
  try {
    await held.revoked;
    const opening = watched(f.open(avery, 'north', 'dealer_admin'));
    await sleep(500);
    assert.equal(opening.settled, false);
    await held.commit();
    const reply = await opening.promise;
    assert.equal(reply.status, 403, reply.text);
    assert.equal(reply.body.code, SUPPORT_REFUSAL_CODES.refused);
    assert.deepEqual(await live(f), []);
  } finally {
    await held.end();
  }
});

test('postgres: an opening holding its locks makes a revocation wait; the revoked parent then fences its lease', { skip }, async (t) => {
  const f = await tenantSupportFixture(t, 'postgres'),
    { avery } = f.accounts;
  const pause = await pauseOpening(t);
  const opening = watched(f.open(avery, 'north', 'dealer_admin'));
  await pause.arrived;
  const held = await heldRevocation(f);
  try {
    const revoking = watched(held.revoked);
    await sleep(500);
    assert.equal(revoking.settled, false);
    pause.release();
    // The opening commits first, and the revocation, queued on @platform
    // behind it, takes the row next. The opening's lease is admitted after
    // that, in a transaction of its own that reads @platform FOR SHARE, so it
    // waits for the revocation to commit and then reads it: the reply cannot
    // come back before the revocation ends. (It once did, only because the
    // observation refused this file's mocked client query as a proxy.)
    await held.commit();
    const reply = await opening.promise;
    assert.equal(reply.status, 200, reply.text);
    // This revokes through the private store administration, which has no
    // cascade of its own: ending the support rows under a parent belongs to
    // public maintenance (revokePlatformMembership), the only way platform
    // memberships are managed. The lease's fence refuses the revoked parent
    // either way, so no authority survives here.
    const lease = reply.body.context as TenantContextReply | undefined;
    if (lease) {
      const recovered = await f.call(`/api/tenant/context/recover?app=${appId}`, {
        body: { tabId: lease.tabId },
        headers: { cookie: avery.cookie, 'x-mistri-account': avery.accountId },
      });
      assert.equal(recovered.status, 403, recovered.text);
    }
    const status = await f.support(avery, 'status', { resume: true });
    assert.equal((status.body.session as Session).state, 'ended');
    assert.equal(status.body.context, undefined);
    assert.deepEqual((await f.verifyAudit()).failed, []);
  } finally {
    await held.end();
  }
});
