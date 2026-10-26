/**
 * Support reads over the wire: the audited business read path, end to end
 * through the real tenant host (test/support/tenantSupportFixture.ts), on
 * SQLite always and live PostgreSQL when TABLEWALK_TEST_PG names a server.
 *
 * What this proves that the owner-level ledger suite cannot: the ledger is a
 * precondition of the answer, not a note taken beside it. The entry commits
 * after the body exists and before a byte of it is released, so a read whose
 * entry cannot commit is refused and the dealer's rows stay unsent.
 *
 * A support session still acts on nothing. Save, New, Delete, Undo and every
 * command are refused on this lease, in its own realm as much as outside it,
 * and its context offers no edits to begin with.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPPORT_AUDIT_TABLES } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';
import { TENANT_DIALECTS } from './support/tenantDialects.js';
import { appId, tenantSupportFixture, type Account, type Answer, type SupportFixture } from './support/tenantSupportFixture.js';

const leaseOf = (reply: Answer) => reply.body.context as TenantContextReply;
function ok(reply: Answer) {
  assert.equal(reply.status, 200, reply.text);
  return reply;
}
/** Refused, with a public code, and nothing private in the body. */
function refused(reply: Answer, code?: string) {
  assert.ok(reply.status >= 400, reply.text);
  if (code) assert.equal(reply.body.code, code, reply.text);
  assert.doesNotMatch(reply.text, /PRIVATE_|@example\.test|nativeSession|sessionId|headMac|SELECT|__tablewalk/);
  return reply;
}
const kinds = async (f: SupportFixture, supportId: string) =>
  (await f.rows(`SELECT kind FROM "${SUPPORT_AUDIT_TABLES.entry}" WHERE session_id = ? ORDER BY seq`, [supportId])).map(
    (row) => row.kind as string,
  );
const details = async (f: SupportFixture, supportId: string) =>
  (
    await f.rows(`SELECT detail_json FROM "${SUPPORT_AUDIT_TABLES.entry}" WHERE session_id = ? AND kind = 'read' ORDER BY seq`, [supportId])
  ).map((row) => JSON.parse(row.detail_json as string) as Record<string, unknown>);
/** A read as the support realm addresses one: its realm, and the dealer it entered. */
const inDealer = (lease: TenantContextReply) => ({ realm: 'support', tenant: lease.tenantId });
/** A metadata GET on a lease; `onLease` always posts a body. */
const getOnLease = (f: SupportFixture, who: Account, lease: TenantContextReply, target: string, selector: Record<string, string>) =>
  f.call(`${target}?${new URLSearchParams({ app: appId, ...selector })}`, {
    method: 'GET',
    headers: {
      cookie: who.cookie,
      [headers.account]: who.accountId,
      [headers.tab]: lease.tabId,
      [headers.context]: lease.context,
      [headers.revision]: String(lease.revision),
    },
  });
const names = (reply: Answer) => (reply.body.rows as Record<string, unknown>[]).map((row) => row.id as string);

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a support session reads its dealer's rows in its own realm, and each read is one ledger entry`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const opened = ok(await f.open(olivia, 'north', 'dealer_staff')),
      lease = leaseOf(opened);
    const supportId = lease.supportId!;
    assert.equal(lease.realm, 'support');
    assert.equal(typeof supportId, 'string');

    const read = ok(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, inDealer(lease)));
    assert.deepEqual(names(read), ['n1']);
    // The answer says which realm and dealer answered it.
    assert.equal(read.headers.get(headers.realm), 'support');
    assert.equal(read.headers.get(headers.tenant), 'north');
    assert.deepEqual(await kinds(f, supportId), ['open', 'read']);
    assert.deepEqual(await details(f, supportId), [{ path: '/api/query' }]);

    // A second read is a second entry: one per request, not one per session.
    ok(await f.onLease(olivia, lease, '/api/count', { table: 'lead' }, inDealer(lease)));
    assert.deepEqual(await kinds(f, supportId), ['open', 'read', 'read']);
    assert.deepEqual(await f.verifyAudit(), { version: 1, sessions: 1, entries: 3, failed: [] });
  });

  test(`${dialect}: a read whose ledger cannot commit releases no body`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    // The read itself is fine and the rows are in hand; only the ledger's own
    // append is made impossible, which is the one thing this pins.
    const entry = SUPPORT_AUDIT_TABLES.entry;
    if (dialect === 'sqlite') {
      f.businessDb()!.exec(`CREATE TRIGGER stop_ledger BEFORE INSERT ON "${entry}"
        BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`);
    } else {
      await f.rows(`CREATE OR REPLACE FUNCTION stop_ledger() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'ledger unavailable'; END $$`);
      await f.rows(`CREATE TRIGGER stop_ledger BEFORE INSERT ON "${entry}" FOR EACH ROW EXECUTE FUNCTION stop_ledger()`);
    }
    try {
      const reply = await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, inDealer(lease));
      refused(reply, SUPPORT_REFUSAL_CODES.refused);
      // The whole point: the rows existed and were not sent. Neither the row's
      // id nor its value may appear anywhere in the refusal.
      assert.doesNotMatch(reply.text, /n1|North lead/);
      assert.equal('rows' in reply.body, false, reply.text);
      // Nothing was recorded either: the entry rolled back with the answer.
      assert.deepEqual(await kinds(f, supportId), ['open']);
    } finally {
      if (dialect === 'sqlite') f.businessDb()!.exec('DROP TRIGGER stop_ledger');
      else await f.rows(`DROP TRIGGER stop_ledger ON "${entry}"`);
    }
    // With the ledger writable again the same read is answered, and recorded.
    assert.deepEqual(names(ok(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, inDealer(lease)))), ['n1']);
    assert.deepEqual(await kinds(f, supportId), ['open', 'read']);
  });

  /* A batch of cards would be several reads ledgered as one: the support
     realm is not offered it, and the client asks each card alone (breakdownBatch.ts). */
  test(`${dialect}: a support lease is not offered the breakdown batch, and records nothing for asking`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    const asked = await f.onLease(olivia, lease, '/api/breakdowns', { items: [{ text: 'lead count' }] }, inDealer(lease));
    assert.equal(asked.status, 404, asked.text);
    assert.deepEqual(await kinds(f, supportId), ['open']);
  });

  test(`${dialect}: a support lease reads nothing when addressed as a tenant, and records nothing`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    // The dealer's own address grants a support lease nothing: reads are served
    // only where the request names the support realm and so can be ledgered.
    refused(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }), SUPPORT_REFUSAL_CODES.unavailable);
    assert.deepEqual(await kinds(f, supportId), ['open']);
  });

  test(`${dialect}: a support read is confined to the dealer entered`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    // Naming another dealer on this lease is refused, and no row of that
    // dealer's is returned or recorded.
    const other = await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, { realm: 'support', tenant: 'south' });
    refused(other);
    assert.doesNotMatch(other.text, /s1|South lead/);
    assert.deepEqual(await kinds(f, supportId), ['open']);
    // Its own dealer's rows are the only ones the scope yields.
    assert.deepEqual(names(ok(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, inDealer(lease)))), ['n1']);
  });

  test(`${dialect}: nothing acts on a support lease, in its own realm as much as outside it`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    const acts: [string, Record<string, unknown>][] = [
      ['/api/update', { table: 'lead', key: { id: 'n1' }, values: { name: 'Edited' } }],
      ['/api/insert', { table: 'lead', values: { id: 'n2', name: 'New lead' } }],
      ['/api/delete', { table: 'lead', key: { id: 'n1' }, confirm: true }],
      ['/api/revert', { confirm: true, expectedId: 'whatever' }],
      ['/api/commands/execute', { command: 'anything', commandVersion: 1, key: { id: 'n1' }, idempotencyKey: 'k', input: {} }],
    ];
    for (const [path, body] of acts) refused(await f.onLease(olivia, lease, path, body, inDealer(lease)));
    // Not one of them reached the dealer's rows, and none was recorded as a
    // write: the write trail stays empty because nothing was written.
    assert.deepEqual(await kinds(f, supportId), ['open']);
    assert.deepEqual(names(ok(await f.onLease(olivia, lease, '/api/query', { table: 'lead' }, inDealer(lease)))), ['n1']);
    assert.equal((await f.rows('SELECT name FROM lead WHERE id = ?', ['n1']))[0].name, 'North lead');
  });

  test(`${dialect}: a support context offers no edits, and asking for it is itself a read`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const lease = leaseOf(ok(await f.open(olivia, 'north', 'dealer_staff'))),
      supportId = lease.supportId!;
    const runtime = ok(await getOnLease(f, olivia, lease, '/api/runtime', inDealer(lease)));
    const apps = runtime.body.apps as { writable: boolean }[];
    // A session that may not write is not offered a button that would only
    // ever be refused.
    assert.equal(apps[0].writable, false);
    assert.deepEqual(await details(f, supportId), [{ path: '/api/runtime' }]);
  });
}
