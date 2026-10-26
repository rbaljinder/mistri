/**
 * Account-creating invitations: an invitation to an email address, whose
 * reservation admits nobody until it is claimed. The claim is signed out, with
 * the one-time token the inviter handed over: it creates the native account
 * under the invited address, then accepts the invitation for it, in two
 * stores. The address is not verified; the token is what vouches, and works
 * once. An address that already has an account is claimed signed in instead,
 * with the same token. Every token that cannot be claimed reads alike.
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import { publicFormLimiter, resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { validatePair } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalContract.js';
import { openSqliteTenantAdministration, openTenantAdministration } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { createTenantInvitationHttp } from '../packages/mistri/src/server/tenant/tenantInvitationHttp.js';
import type { InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { TenantInvitationClaimRefusal, TenantInvitationFailure } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import { INVITATION_TABLES, provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { migratePostgresTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import {
  INVITATION_HTTP_ROOT,
  INVITATION_ISSUER_OPERATIONS,
  type InvitationIntent,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { pgClient, TENANT_DIALECTS, uuidPostgresDatabase, type TenantDialect } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

const policy = (operator: string): InvitationPolicy => ({
  id: 'inviters',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  maxRedemptionLifetimeMs: 120_000,
  maxPendingPerTenant: 10,
  operators: [{ accountId: operator, tenants: ['north'], operations: INVITATION_ISSUER_OPERATIONS, roles: ['reader', 'manager'] }],
});
/** A signed-out request: no cookie, and nothing the claim reads but `aborted`. */
const signedOut = () => ({ headers: {}, aborted: false }) as unknown as IncomingMessage;
const refusal =
  (reason: string, outcome = 'not_applied') =>
  (error: unknown) =>
    error instanceof TenantInvitationClaimRefusal &&
    error.reason === reason &&
    error.outcome === outcome &&
    error.message === 'The invitation claim could not be completed.';
const newcomer = { name: 'Newcomer', password: 'newcomer-password-123' };

async function fixture(t: TestContext, dialect: TenantDialect) {
  const f = await tenantAdministrationFixture(t);
  let where: { path: string } | { url: string }, exec: (sql: string, ...params: unknown[]) => Promise<void>;
  let all: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  if (dialect === 'sqlite') {
    provisionSqliteTenantInvitations(f.path, f.binding);
    where = { path: f.path };
    exec = async (sql, ...params) => {
      f.db.prepare(sql).run(...(params as never[]));
    };
    all = async (sql, ...params) =>
      f.db
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }));
  } else {
    const { url, drop } = await uuidPostgresDatabase('tenant_claims');
    const control = await pgClient(url);
    t.after(async () => {
      await control.end().catch(() => {});
      await drop();
    });
    await migratePostgresTenantStore(url, f.binding);
    await migratePostgresTenantAdministrationJournal(url, f.binding);
    await migratePostgresTenantInvitations(url, f.binding);
    where = { url };
    const numbered = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    exec = async (sql, ...params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    };
    all = async (sql, ...params) => (await control.query(postgresRuntimeSql(numbered(sql)), params)).rows;
  }
  await exec(`INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('north', 'active', '1', 'tenant')`);
  const common = { binding: f.binding, auth: f.auth, invitations: policy(f.users.operator.accountId), deployment: 'claim-tests' };
  const owner =
    'path' in where
      ? await openSqliteTenantAdministration({ ...common, path: where.path })
      : await openTenantAdministration({ ...common, url: where.url });
  f.addCleanup(owner.retire);
  const api = owner.invitations!;
  const { operator } = f.users;
  const issuer = (await api.openIssuer(operator.request, { expectedAccount: operator.accountId }))!;
  const issue = async (to: { email: string } | { accountId: string }) =>
    (
      await api.execute(operator.request, {
        expectedAccount: operator.accountId,
        context: issuer.context,
        idempotencyKey: crypto.randomUUID(),
        intent: {
          operation: 'issueInvitation',
          tenantId: 'north',
          expectedTenantVersion: '1',
          ...to,
          roles: ['reader'],
          redeemUntil: Date.now() + 60_000,
          validUntil: Date.now() + 120_000,
        } as InvitationIntent,
      })
    ).token!;
  // The native auth store's accounts; `users` stays the fixture's signed-in people.
  const nativeUsers = () =>
    f.authDb
      .prepare('SELECT id, email FROM "user" ORDER BY email')
      .all()
      .map((row) => ({ ...row }));
  const memberships = () => all(`SELECT account_id AS account, status FROM "${tables.membership}" ORDER BY status, account_id`);
  const invitations = () => all(`SELECT account_id AS account, status FROM "${INVITATION_TABLES.invitation}" ORDER BY status`);
  const receipts = () => all(`SELECT * FROM "${journal.receipt}" r ORDER BY r.completed_at, r.id`);
  const state = async () => JSON.stringify([nativeUsers(), await memberships(), await invitations(), (await receipts()).length]);
  return { ...f, api, issue, nativeUsers, memberships, invitations, receipts, state, exec };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`account-creating invitations on ${dialect}`, { skip }, () => {
    test('an email invitation reserves for its address, makes no account, and is claimed signed out exactly once', async (t) => {
      const f = await fixture(t, dialect);
      const accounts = f.nativeUsers().length;
      const token = await f.issue({ email: 'newcomer@example.test' });
      assert.deepEqual(await f.memberships(), [{ account: 'email:newcomer@example.test', status: 'invited' }]);
      assert.equal(f.nativeUsers().length, accounts);

      const reply = await f.api.claim!(signedOut(), { token, ...newcomer });
      assert.equal(reply.outcome, 'applied');
      assert.equal(reply.account, 'created');
      assert.equal(reply.email, 'newcomer@example.test');
      assert.equal(reply.result.status, 'accepted');
      assert.equal(reply.result.tenantId, 'north');
      assert.equal(reply.result.invitationId, invitationTokenId(token));
      assert.equal(JSON.stringify(reply).includes(token) || JSON.stringify(reply).includes(newcomer.password), false);
      const made = f.nativeUsers().find((user) => user.email === 'newcomer@example.test');
      assert.ok(made);
      // The account is a row of the account trail: made by its own holder, through the invitation's token.
      const trail = f.authDb
        .prepare('SELECT action, actorId, actorEmail, principal, targetId, targetEmail, before FROM "accountAudit" WHERE targetId = ?')
        .all(made.id)
        .map((row) => ({ ...row }));
      assert.deepEqual(trail, [
        {
          action: 'create',
          actorId: made.id,
          actorEmail: 'newcomer@example.test',
          principal: `invitation:${invitationTokenId(token)}`,
          targetId: made.id,
          targetEmail: 'newcomer@example.test',
          before: null,
        },
      ]);
      assert.deepEqual(await f.memberships(), [
        { account: made.id, status: 'active' },
        { account: 'email:newcomer@example.test', status: 'revoked' },
      ]);
      assert.deepEqual(
        (await f.invitations()).map((row) => row.status),
        ['accepted', 'revoked'],
      );
      const stored = await f.receipts();
      assert.deepEqual(
        stored.map((row) => [row.actor_id, row.operation]),
        [
          [f.users.operator.accountId, 'issueInvitation'],
          [made.id, 'claimInvitation'],
        ],
      );
      assert.equal(JSON.stringify(stored).includes(token) || JSON.stringify(stored).includes(newcomer.password), false);

      // The token was the one-time handoff.
      const before = await f.state();
      await assert.rejects(
        f.api.claim!(signedOut(), { token, name: 'Someone else', password: 'another-password-123' }),
        refusal('unavailable'),
      );
      assert.equal(await f.state(), before);
      // The account signs in with the password it was claimed with.
      const signedIn = await f.callNative('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'newcomer@example.test', password: newcomer.password }),
      });
      assert.equal(signedIn.response.status, 200);
    });

    test('an address that has an account is refused a claim, and its account accepts signed in with the same token', async (t) => {
      const f = await fixture(t, dialect);
      const { target, outsider } = f.users;
      const token = await f.issue({ email: 'target@example.test' });
      const before = await f.state();
      await assert.rejects(f.api.claim!(signedOut(), { token, ...newcomer }), refusal('account_exists'));
      assert.equal(await f.state(), before);
      // Another account, whatever its token, is not the invited address.
      const invitationId = invitationTokenId(token);
      const theirs = await f.api.openRecipient(outsider.request, { expectedAccount: outsider.accountId, invitationId });
      await assert.rejects(
        f.api.preview(outsider.request, { expectedAccount: outsider.accountId, context: theirs.context, token }),
        (error: unknown) => error instanceof TenantInvitationFailure,
      );
      const recipient = await f.api.openRecipient(target.request, { expectedAccount: target.accountId, invitationId });
      const owned = { expectedAccount: target.accountId, context: recipient.context };
      const preview = await f.api.preview(target.request, { ...owned, token });
      assert.equal(preview.intent.operation, 'claimInvitation');
      const accepted = await f.api.execute(target.request, {
        ...owned,
        idempotencyKey: crypto.randomUUID(),
        intent: preview.intent,
        token,
      });
      assert.equal((accepted.result as { status?: string }).status, 'accepted');
      assert.deepEqual(await f.memberships(), [
        { account: target.accountId, status: 'active' },
        { account: 'email:target@example.test', status: 'revoked' },
      ]);
      // And a claim afterwards finds nothing to claim.
      await assert.rejects(f.api.claim!(signedOut(), { token, ...newcomer }), refusal('unavailable'));
    });

    test('every token that cannot be claimed is the same refusal, and the account fields are checked before any token', async (t) => {
      const f = await fixture(t, dialect);
      const email = await f.issue({ email: 'late@example.test' });
      const account = await f.issue({ accountId: f.users.outsider.accountId });
      const revoked = await f.issue({ email: 'gone@example.test' });
      const revokedId = invitationTokenId(revoked);
      await f.exec(`UPDATE "${INVITATION_TABLES.invitation}" SET status = 'revoked', version = '2' WHERE invitation_id = ?`, revokedId);
      await f.exec(`UPDATE "${tables.membership}" SET status = 'revoked', version = '2' WHERE account_id = 'email:gone@example.test'`);
      const before = await f.state();
      const wrongSecret = `${email.slice(0, 42)}${email[42] === 'A' ? 'B' : 'A'}${email.slice(43)}`;
      for (const token of [`twi1.${crypto.randomUUID()}.${'A'.repeat(43)}`, wrongSecret, account, revoked, 'not-a-token']) {
        await assert.rejects(f.api.claim!(signedOut(), { token, ...newcomer }), refusal('unavailable'));
      }
      for (const input of [
        { token: 'not-a-token', name: '', password: newcomer.password },
        { token: email, name: 'N', password: 'short' },
        { token: email, name: 'N', password: 'x'.repeat(129) },
      ]) {
        await assert.rejects(f.api.claim!(signedOut(), input), refusal('invalid_account'));
      }
      // A suspended tenant cannot be joined, however valid the token.
      await f.exec(`UPDATE "${tables.tenant}" SET status = 'suspended', version = '2' WHERE id = 'north'`);
      await assert.rejects(f.api.claim!(signedOut(), { token: email, ...newcomer }), refusal('unavailable'));
      assert.equal(await f.state(), before);
    });

    test('issuance by email is exact, and a claim receipt validates only as the account it made', async (t) => {
      const f = await fixture(t, dialect);
      const { operator } = f.users;
      const issuer = (await f.api.openIssuer(operator.request, { expectedAccount: operator.accountId }))!;
      const refuse = (patch: Record<string, unknown>) =>
        assert.rejects(
          f.api.execute(operator.request, {
            expectedAccount: operator.accountId,
            context: issuer.context,
            idempotencyKey: crypto.randomUUID(),
            intent: {
              operation: 'issueInvitation',
              tenantId: 'north',
              expectedTenantVersion: '1',
              roles: ['reader'],
              redeemUntil: Date.now() + 60_000,
              validUntil: Date.now() + 120_000,
              ...patch,
            } as unknown as InvitationIntent,
          }),
          TenantInvitationFailure,
        );
      await refuse({ email: 'both@example.test', accountId: f.users.target.accountId });
      await refuse({ accountId: 'email:sneaky@example.test' });
      await refuse({ email: 'Mixed@Example.test' });
      await refuse({ email: 'not an address' });
      const token = await f.issue({ email: 'valid@example.test' });
      await f.api.claim!(signedOut(), { token, ...newcomer });
      const row = (await f.receipts()).find((stored) => stored.operation === 'claimInvitation')!;
      const receipt = {
        id: row.id,
        actorId: row.actor_id,
        tenantId: row.tenant_id,
        operation: row.operation,
        operationVersion: Number(row.operation_version),
        idempotencyKey: row.idempotency_key,
        fingerprint: row.fingerprint,
        resultJson: row.result_json,
        requestId: row.request_id,
        completedAt: row.completed_at,
      } as never;
      const audit = {
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        deployment: row.deployment,
        sessionId: row.session_id,
        changeJson: row.change_json,
      } as never;
      validatePair(receipt, audit);
      assert.throws(() => validatePair({ ...(receipt as object), actorId: operator.accountId } as never, audit));
      const result = JSON.parse(row.result_json as string);
      const forged = JSON.stringify({
        ...result,
        after: {
          ...result.after,
          invitation: { ...result.after.invitation, accountId: 'email:valid@example.test' },
          membership: { ...result.after.membership, accountId: 'email:valid@example.test' },
        },
      });
      assert.throws(() =>
        validatePair({ ...(receipt as object), resultJson: forged } as never, { ...(audit as object), changeJson: forged } as never),
      );
    });

    test("the claim route: its own origin, no tenant headers, identical refusals, the public forms' limits", async (t) => {
      const f = await fixture(t, dialect);
      resetPublicFormLimits();
      t.after(() => resetPublicFormLimits());
      const server = createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const handler = createTenantInvitationHttp({
        appId: f.binding.appId,
        invitations: f.api,
        bound: { host: '127.0.0.1', port: address.port },
        assertActive: () => {},
      });
      server.on('request', (req, res) => {
        void handler(req, res);
      });
      const claim = async (body: unknown, options: { headers?: Record<string, string>; query?: string; method?: string } = {}) => {
        const response = await fetch(`${origin}${INVITATION_HTTP_ROOT}/claim${options.query ?? `?app=${f.binding.appId}`}`, {
          method: options.method ?? 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { origin, 'content-type': 'application/json', ...options.headers },
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, text: await response.text(), headers: [...response.headers.keys()] };
      };
      const token = await f.issue({ email: 'route@example.test' });
      const taken = await f.issue({ email: 'operator@example.test' });
      const spare = await f.issue({ email: 'spare@example.test' });
      // Refused before anything is counted: another origin, a tenant header, a stray query, a GET.
      assert.equal((await claim({ token, ...newcomer }, { headers: { origin: 'http://elsewhere.test' } })).status, 403);
      assert.equal((await claim({ token, ...newcomer }, { headers: { 'x-mistri-account': 'someone' } })).status, 400);
      assert.equal((await claim({ token, ...newcomer }, { query: `?app=${f.binding.appId}&tenant=north` })).status, 400);
      assert.equal((await claim({ token, ...newcomer }, { query: '?app=another-app' })).status, 400);
      assert.equal((await claim(undefined, { method: 'GET' })).status, 405);

      const claimed = await claim({ token, ...newcomer });
      assert.equal(claimed.status, 200);
      const body = JSON.parse(claimed.text);
      assert.deepEqual(
        [body.outcome, body.account, body.email, body.result.status],
        ['applied', 'created', 'route@example.test', 'accepted'],
      );
      assert.equal(
        claimed.headers.some((name) => name.startsWith('x-mistri-')),
        false,
      );
      assert.equal(claimed.text.includes(token) || claimed.text.includes(newcomer.password), false);
      // Spent, unknown and wrongly-kept tokens read byte for byte alike.
      const spent = await claim({ token, ...newcomer });
      const unknown = await claim({ token: `twi1.${crypto.randomUUID()}.${'A'.repeat(43)}`, ...newcomer });
      assert.deepEqual([spent.status, unknown.status], [403, 403]);
      assert.equal(spent.text, unknown.text);
      assert.deepEqual(JSON.parse(spent.text), {
        error: 'The invitation operation could not be confirmed.',
        code: 'tenant_invitation_unavailable',
        outcome: 'not_applied',
      });
      const existing = await claim({ token: taken, ...newcomer });
      assert.equal(existing.status, 409);
      assert.equal(JSON.parse(existing.text).code, 'account_exists');
      // Five a minute per client, as for a public form's submissions, but a
      // budget of its own: a form that has spent all of its takes none of these.
      for (let spent = 0; spent < 20; spent++) await publicFormLimiter('submit').take('127.0.0.1');
      assert.equal((await claim({ token: `twi1.${crypto.randomUUID()}.${'A'.repeat(43)}`, ...newcomer })).status, 403);
      // The refusals before the limiter counted nothing; four were counted since.
      const limited = await claim({ token: spare, ...newcomer });
      assert.equal(limited.status, 429);
      assert.equal(JSON.parse(limited.text).code, 'rate_limited');
      assert.deepEqual(await f.memberships().then((rows) => rows.filter((row) => row.account === 'email:spare@example.test')), [
        { account: 'email:spare@example.test', status: 'invited' },
      ]);
    });
  });
}
