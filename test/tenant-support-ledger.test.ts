/**
 * The read ledger: one entry per read a support session made, committed in a
 * short fenced writer transaction of the support owner's own before the entry's
 * caller may release anything. SQLite always; live PostgreSQL when
 * TABLEWALK_TEST_PG names a server.
 *
 * This suite drives the owner's method directly, which is how it pins the
 * entry's own shape and refusals. The half it cannot reach from here — that the
 * commit is a precondition of the answer, so a read whose entry cannot commit
 * releases no body — is proven over the wire in tenant-support-read-http.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPPORT_AUDIT_TABLES } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import type { SupportReadRequest } from '../packages/mistri/src/server/tenant/tenantSupportOperations.js';
import { TENANT_DIALECTS } from './support/tenantDialects.js';
import { tenantSupportFixture, type Answer, type SupportFixture } from './support/tenantSupportFixture.js';

type Session = { supportId: string; version: string; tenantId: string };
const sessionOf = (reply: Answer) => (reply.body.receipt as { session: Session }).session;
function ok(reply: Answer) {
  assert.equal(reply.status, 200, reply.text);
  return reply;
}
const entries = async (f: SupportFixture, supportId: string) =>
  (
    await f.rows(
      `SELECT seq, kind, resource, operation, key_json, detail_json FROM "${SUPPORT_AUDIT_TABLES.entry}"
    WHERE session_id = ? ORDER BY seq`,
      [supportId],
    )
  ).map((row) => ({
    kind: row.kind as string,
    resource: row.resource,
    operation: row.operation,
    keyJson: row.key_json,
    detail: JSON.parse(row.detail_json as string) as Record<string, unknown>,
  }));

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a read is recorded as one entry that names no resource, operation or key`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const session = sessionOf(ok(await f.open(olivia, 'north', 'dealer_staff')));
    const owner = await f.owner();
    const said = { path: '/api/query', table: 'lead', returned: ['n1'], rows: 1 };
    const asked: SupportReadRequest = { tenantId: 'north', supportId: session.supportId, detail: said };
    await owner.ledgerRead(f.asLogin(olivia.cookie), asked);
    const recorded = await entries(f, session.supportId);
    assert.deepEqual(
      recorded.map((entry) => entry.kind),
      ['open', 'read'],
    );
    // The store's rule for every kind that is not a write: those columns are
    // null, so what was read is said in the detail and nowhere else.
    assert.equal(recorded[1].resource, null);
    assert.equal(recorded[1].operation, null);
    assert.equal(recorded[1].keyJson, null);
    assert.deepEqual(recorded[1].detail, said);
    // A second read is a second entry, in order, on the same chain.
    await owner.ledgerRead(f.asLogin(olivia.cookie), {
      tenantId: 'north',
      supportId: session.supportId,
      detail: { path: '/api/count', table: 'lead' },
    });
    assert.deepEqual(
      (await entries(f, session.supportId)).map((entry) => entry.kind),
      ['open', 'read', 'read'],
    );
    assert.deepEqual(await f.verifyAudit(), { version: 1, sessions: 1, entries: 3, failed: [] });
  });

  test(`${dialect}: a description that will not fit is refused, and records nothing`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const session = sessionOf(ok(await f.open(olivia, 'north', 'dealer_staff')));
    const owner = await f.owner();
    // Refused for being too large, never trimmed to fit: a partial account of
    // what an operator read is worse than a refusal to answer at all.
    await assert.rejects(
      owner.ledgerRead(f.asLogin(olivia.cookie), {
        tenantId: 'north',
        supportId: session.supportId,
        detail: { returned: 'x'.repeat(300_000) },
      }),
    );
    assert.deepEqual(
      (await entries(f, session.supportId)).map((entry) => entry.kind),
      ['open'],
    );
    // And the session is still usable afterwards: a refusal is not damage.
    await owner.ledgerRead(f.asLogin(olivia.cookie), { tenantId: 'north', supportId: session.supportId, detail: { path: '/api/query' } });
    assert.deepEqual(
      (await entries(f, session.supportId)).map((entry) => entry.kind),
      ['open', 'read'],
    );
    assert.deepEqual((await f.verifyAudit()).failed, []);
  });

  test(`${dialect}: only this login's own live session is recorded against`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia, avery } = f.accounts;
    const session = sessionOf(ok(await f.open(olivia, 'north', 'dealer_staff')));
    const owner = await f.owner();
    const detail = { path: '/api/query', table: 'lead' };
    // Another account's login cannot record against this session.
    await assert.rejects(owner.ledgerRead(f.asLogin(avery.cookie), { tenantId: 'north', supportId: session.supportId, detail }));
    // Nor can another login of the same account: the chain names the session that opened it.
    const other = await f.signIn(olivia.email, olivia.password);
    await assert.rejects(owner.ledgerRead(f.asLogin(other), { tenantId: 'north', supportId: session.supportId, detail }));
    // Nor a dealer the session is not inside, nor a session that does not exist.
    await assert.rejects(owner.ledgerRead(f.asLogin(olivia.cookie), { tenantId: 'south', supportId: session.supportId, detail }));
    await assert.rejects(owner.ledgerRead(f.asLogin(olivia.cookie), { tenantId: 'north', supportId: 'no-such-session', detail }));
    assert.deepEqual(
      (await entries(f, session.supportId)).map((entry) => entry.kind),
      ['open'],
    );
    assert.deepEqual((await f.verifyAudit()).failed, []);
  });

  test(`${dialect}: an ended session records no further reads`, { skip }, async (t) => {
    const f = await tenantSupportFixture(t, dialect),
      { olivia } = f.accounts;
    const opened = ok(await f.open(olivia, 'north', 'dealer_staff'));
    const session = sessionOf(opened);
    const owner = await f.owner();
    ok(await f.exit(olivia, session));
    await assert.rejects(
      owner.ledgerRead(f.asLogin(olivia.cookie), { tenantId: 'north', supportId: session.supportId, detail: { path: '/api/query' } }),
    );
    // The chain keeps its open and its exit, and nothing after the exit.
    assert.deepEqual(
      (await entries(f, session.supportId)).map((entry) => entry.kind),
      ['open', 'exit'],
    );
    assert.deepEqual((await f.verifyAudit()).failed, []);
  });
}
