import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { ServerResponse, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { provisionSqliteTenantInvitations, INVITATION_TABLES } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  INVITATION_HTTP_HEADER as contextHeader,
  INVITATION_HTTP_ROOT as root,
  INVITATION_ISSUER_OPERATIONS,
  type InvitationAttempt,
  type InvitationPair,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { ADMINISTRATION_HTTP_HEADER, ADMINISTRATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { startTenantInvitations } from '../e2e/support/tenantInvitationServer.js';

type Answer = { status: number; headers: Headers; body: any; text: string };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const pairIntent = (pair: InvitationPair) => ({
  tenantId: pair.invitation.tenantId,
  expectedTenantVersion: pair.invitation.expectedTenantVersion,
  invitationId: pair.invitation.invitationId,
  expectedInvitationVersion: pair.invitation.version,
  membershipId: pair.membership.membershipId,
  expectedMembershipVersion: pair.membership.version,
});

async function fixture(t: TestContext, options: { administration?: boolean; invitations?: boolean } = {}) {
  const f = await tenantAdministrationFixture(t);
  provisionSqliteTenantInvitations(f.path, f.binding);
  f.db.exec(`CREATE TABLE private_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO private_item VALUES ('north-item','north','Private north business row'), ('south-item','south','Private south business row');
    INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant')`);
  const loaded: LoadedApp = {
    path: join(f.directory, 'app.ts'),
    dir: f.directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: f.binding.appId,
        name: 'Invitation HTTP proof',
        auth: { ...f.auth.spec, rows: 'tenant', roles: { reader: { read: true }, manager: { read: true } } },
        sources: { business: { connection: f.binding.source.connection } },
        resources: {
          item: { physical: 'private_item', owner: 'tenant', fields: { read: ['id', 'name'] } },
          business_record: { physical: 'business_record', owner: 'global' },
        },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'private invitation HTTP fixture',
    ),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth: f.auth,
    bound,
    enrollment: {
      policy: {
        kind: 'tenant',
        appId: f.binding.appId,
        storeId: f.binding.storeId,
        ownership: { item: { kind: 'tenant', column: 'tenant_id' }, business_record: { kind: 'global', access: 'read-only' } },
        resolveMembershipRows: () => ({ item: true }),
        resolveRows: () => ({ item: true }),
        ...(options.invitations === false
          ? {}
          : {
              invitations: {
                id: 'PRIVATE_INVITERS',
                version: 'v1',
                maxMembershipLifetimeMs: 600_000,
                maxRedemptionLifetimeMs: 120_000,
                maxPendingPerTenant: 10,
                operators: [
                  {
                    accountId: f.users.operator.accountId,
                    tenants: ['north', 'south'],
                    operations: INVITATION_ISSUER_OPERATIONS,
                    roles: ['reader', 'manager'],
                  },
                ],
              },
            }),
        ...(options.administration
          ? {
              administration: {
                id: 'PRIVATE_ADMINISTRATORS',
                version: 'v1',
                maxMembershipLifetimeMs: 600_000,
                operators: [
                  {
                    accountId: f.users.operator.accountId,
                    tenants: ['north', 'south'],
                    operations: ['revokeMembership' as const],
                    roles: ['reader', 'manager'],
                  },
                ],
              },
            }
          : {}),
      },
      source: { ...f.binding.source, existingPath: f.path },
      deployment: 'private-invitation-http',
      roles: ['reader', 'manager'],
      maxLifetimeMs: 60_000,
    },
  });
  f.addCleanup(async () => {
    owner.server.closeAllConnections();
    await owner.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address !== 'string');
  bound.port = address.port;
  const origin = `http://${bound.host}:${bound.port}`;
  let sequence = 0;
  const identity = (user = f.users.operator) => ({
    cookie: user.cookie,
    [headers.app]: f.binding.appId,
    [headers.account]: user.accountId,
  });
  const url = (operation: string, extra = '') => `${root}/${operation}?app=${f.binding.appId}${extra}`;
  const call = async (path: string, body?: unknown, ownership: Record<string, string> = identity()): Promise<Answer> => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...ownership },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : {} };
  };
  const openIssuer = async (user = f.users.operator) => {
    const answer = await call(url('open-issuer'), {}, identity(user));
    assert.equal(answer.status, 200, answer.text);
    return { answer, session: answer.body.session, owned: { ...identity(user), [contextHeader]: answer.body.session?.context ?? '' } };
  };
  const openRecipient = async (invitationId: string, user = f.users.target) => {
    const answer = await call(url('open-recipient'), { invitationId }, identity(user));
    assert.equal(answer.status, 200, answer.text);
    return { answer, session: answer.body.session, owned: { ...identity(user), [contextHeader]: answer.body.session.context } };
  };
  const issue = async (user = f.users.target, tenantId = 'north') => {
    const issuer = await openIssuer();
    const attempt: InvitationAttempt = {
      idempotencyKey: `issue-${++sequence}`,
      intent: {
        operation: 'issueInvitation',
        tenantId,
        expectedTenantVersion: '1',
        accountId: user.accountId,
        roles: ['reader'],
        redeemUntil: Date.now() + 60_000,
        validUntil: Date.now() + 120_000,
      },
    };
    const answer = await call(url('execute'), attempt, issuer.owned);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(typeof answer.body.token, 'string');
    return { issuer, attempt, answer, token: answer.body.token as string, pair: answer.body.result.change.after as InvitationPair };
  };
  const prepare = async (issued: Awaited<ReturnType<typeof issue>>, user = f.users.target) => {
    const recipient = await openRecipient(issued.pair.invitation.invitationId, user);
    const answer = await call(url('preview'), { token: issued.token }, recipient.owned);
    assert.equal(answer.status, 200, answer.text);
    return {
      recipient,
      answer,
      attempt: { idempotencyKey: `accept-${++sequence}`, intent: answer.body.preview.intent } as InvitationAttempt,
    };
  };
  const discovery = (user = f.users.target) => call(`/api/tenant/bootstrap?app=${f.binding.appId}`, undefined, identity(user));
  const selected = async (user = f.users.target, tenantId = 'north') => {
    const answer = await call(`/api/tenant/context/open?app=${f.binding.appId}&tenant=${tenantId}`, {}, identity(user));
    assert.equal(answer.status, 200, answer.text);
    return {
      ...identity(user),
      [headers.tab]: answer.body.tabId,
      [headers.context]: answer.body.context,
      [headers.revision]: String(answer.body.revision),
    };
  };
  const count = (table: string) => Number(f.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n);
  return { ...f, owner, origin, bound, identity, url, call, openIssuer, openRecipient, issue, prepare, discovery, selected, count };
}
function denied(answer: Answer, outcome = 'not_applied') {
  assert.ok(answer.status >= 400, answer.text);
  assert.equal(answer.body.code, 'tenant_invitation_unavailable');
  assert.equal(answer.body.outcome, outcome);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  for (const name of [...Object.values(headers), contextHeader]) assert.equal(answer.headers.get(name), null);
  assert.doesNotMatch(answer.text, /PRIVATE_|private_item|tenant_id|sessionId|password|digest|stack|sqlite/i);
}
function owned(answer: Answer, expected: Record<string, string>) {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  for (const name of [headers.app, headers.account, contextHeader]) assert.equal(answer.headers.get(name), expected[name] ?? null);
  for (const name of [headers.tenant, headers.context, headers.tab, headers.revision]) assert.equal(answer.headers.get(name), null);
}

test('native zero-membership accounts see invitation availability and issuer admission before business selection', async (t) => {
  const f = await fixture(t);
  assert.equal(f.count(TENANT_TABLES.membership), 0);
  assert.equal(f.count(INVITATION_TABLES.invitation), 0);
  for (const user of [f.users.operator, f.users.target, f.users.outsider]) {
    const who = await f.call(`/api/whoami?app=${f.binding.appId}`, undefined, f.identity(user));
    assert.equal(who.status, 200);
    assert.equal(who.body.accountId, user.accountId);
    assert.equal(who.body.tenantInvitations, true);
    assert.equal(Object.hasOwn(who.body, 'tenantAdministration'), false);
    assert.deepEqual((await f.discovery(user)).body.memberships, []);
  }
  const issuer = await f.openIssuer();
  owned(issuer.answer, issuer.owned);
  assert.ok(issuer.session.context);
  assert.equal(issuer.session.maxPendingPerTenant, 10);
  const outsider = await f.openIssuer(f.users.outsider);
  assert.equal(outsider.session, null);
  owned(outsider.answer, f.identity(f.users.outsider));
  denied(await f.call(f.url('open-issuer'), {}, { ...f.identity(), cookie: '' }));
  denied(await f.call(f.url('open-issuer'), {}, { ...f.identity(), cookie: f.users.target.cookie }));
});

test('real issue, target/list pages and one-time handoff preserve independent ownership and hide durable secrets', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  owned(issued.answer, issued.issuer.owned);
  const first = await f.call(f.url('targets', '&limit=1'), undefined, issued.issuer.owned);
  owned(first, issued.issuer.owned);
  assert.equal(first.body.page.next, 'north');
  assert.equal(first.body.page.items[0].tenant.version, '1');
  const next = await f.call(f.url('targets', '&after=north&limit=1'), undefined, issued.issuer.owned);
  assert.deepEqual(
    next.body.page.items.map((value: any) => value.tenantId),
    ['south'],
  );
  for (const operation of ['revokeInvitation', 'reissueInvitation']) {
    const page = await f.call(f.url('list', `&tenantId=north&operation=${operation}&limit=1`), undefined, issued.issuer.owned);
    owned(page, issued.issuer.owned);
    assert.deepEqual(page.body.page.items, [issued.pair]);
    assert.equal(page.text.includes(issued.token), false);
    assert.equal(page.text.includes('digest'), false);
  }
  const replay = await f.call(f.url('execute'), issued.attempt, issued.issuer.owned);
  assert.equal(replay.body.result.replayed, true);
  assert.equal(Object.hasOwn(replay.body, 'token'), false);
  const status = await f.call(f.url('status'), issued.attempt, issued.issuer.owned);
  owned(status, issued.issuer.owned);
  assert.equal(status.body.status, 'completed');
  assert.equal(status.text.includes(issued.token), false);
  const durable = JSON.stringify([
    f.db.prepare(`SELECT * FROM "${INVITATION_TABLES.invitation}"`).all(),
    f.db.prepare(`SELECT * FROM "${journal.receipt}"`).all(),
  ]);
  assert.equal(durable.includes(issued.token), false);
  assert.equal(f.count(journal.receipt), 1);
  assert.deepEqual((await f.discovery()).body.memberships, []);
  assert.deepEqual((await f.discovery(f.users.operator)).body.memberships, []);
});

test('invited recipient has no business access; native preview/accept refresh discovery and explicit tenant selection', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    prepared = await f.prepare(issued);
  owned(prepared.recipient.answer, prepared.recipient.owned);
  owned(prepared.answer, prepared.recipient.owned);
  assert.equal(issued.pair.membership.status, 'invited');
  assert.deepEqual((await f.discovery()).body.memberships, []);
  const unavailable = await f.call(`/api/tenant/context/open?app=${f.binding.appId}&tenant=north`, {}, f.identity(f.users.target));
  assert.ok(unavailable.status >= 400);
  assert.doesNotMatch(prepared.answer.text, /inviterId|policyId|digest|receiptId/);
  const accepted = await f.call(f.url('execute'), { ...prepared.attempt, token: issued.token }, prepared.recipient.owned);
  owned(accepted, prepared.recipient.owned);
  assert.equal(accepted.body.result.status, 'accepted');
  assert.equal(Object.hasOwn(accepted.body.result, 'change'), false);
  assert.equal(Object.hasOwn(accepted.body, 'token'), false);
  const discovery = await f.discovery();
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.memberships.length, 1);
  assert.equal(discovery.body.memberships[0].tenantId, 'north');
  const business = await f.selected();
  const rows = await f.call(`/api/query?app=${f.binding.appId}&tenant=north`, { table: 'item' }, business);
  assert.equal(rows.status, 200, rows.text);
  assert.deepEqual(rows.body.rows, [{ id: 'north-item', name: 'Private north business row' }]);
  assert.deepEqual((await f.discovery(f.users.operator)).body.memberships, []);
  assert.equal(f.authDb.prepare('SELECT emailVerified FROM user WHERE id=?').get(f.users.target.accountId)!.emailVerified, 0);
});

test('native recipient, account/App assertions and issuer/recipient contexts cannot substitute for each other', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    target = await f.openRecipient(issued.pair.invitation.invitationId);
  const wrong = await f.openRecipient(issued.pair.invitation.invitationId, f.users.outsider);
  denied(await f.call(f.url('preview'), { token: issued.token }, wrong.owned));
  denied(await f.call(f.url('preview'), { token: issued.token }, { ...target.owned, cookie: f.users.outsider.cookie }));
  denied(await f.call(f.url('preview'), { token: issued.token }, { ...target.owned, [headers.account]: f.users.outsider.accountId }));
  denied(await f.call(f.url('preview'), { token: issued.token }, { ...target.owned, [headers.app]: 'another-app' }));
  denied(await f.call(f.url('preview'), { token: issued.token }, { ...target.owned, [contextHeader]: issued.issuer.session.context }));
  denied(await f.call(f.url('targets'), undefined, target.owned));
  denied(await f.call(f.url('execute'), issued.attempt, target.owned));
  const other = await f.issue(f.users.outsider, 'south');
  denied(await f.call(f.url('preview'), { token: other.token }, target.owned));
  assert.equal(f.count(journal.receipt), 2);
});

test('consumed token and later direct membership revocation retain exact recipient receipt without audit disclosure', async (t) => {
  const f = await fixture(t, { administration: true }),
    issued = await f.issue(),
    prepared = await f.prepare(issued);
  const accepted = await f.call(f.url('execute'), { ...prepared.attempt, token: issued.token }, prepared.recipient.owned);
  owned(accepted, prepared.recipient.owned);
  denied(await f.call(f.url('preview'), { token: issued.token }, prepared.recipient.owned));
  const adminRoot = `${ADMINISTRATION_HTTP_ROOT}`;
  const opened = await f.call(`${adminRoot}/open?app=${f.binding.appId}`, {});
  assert.equal(opened.status, 200, opened.text);
  const revoked = await f.call(
    `${adminRoot}/execute?app=${f.binding.appId}`,
    {
      idempotencyKey: 'direct-revoke',
      intent: {
        operation: 'revokeMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: issued.pair.membership.membershipId,
        expectedMembershipVersion: accepted.body.result.membershipVersion,
      },
    },
    { ...f.identity(), [ADMINISTRATION_HTTP_HEADER]: opened.body.session.context },
  );
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual((await f.discovery()).body.memberships, []);
  const fresh = await f.openRecipient(issued.pair.invitation.invitationId);
  for (const operation of ['execute', 'status']) {
    const recovered = await f.call(f.url(operation), prepared.attempt, fresh.owned);
    owned(recovered, fresh.owned);
    assert.equal(recovered.body.result.receiptId, accepted.body.result.receiptId);
    assert.equal(recovered.body.result.replayed, true);
    assert.doesNotMatch(recovered.text, /token|digest|inviterId|policyId|before|after|change/);
  }
  assert.equal(f.count(journal.receipt), 3);
});

test('reissue invalidates the previous pair/token, and explicit invitation revoke terminates the replacement reservation', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    old = await f.openRecipient(issued.pair.invitation.invitationId);
  const reissue: InvitationAttempt = {
    idempotencyKey: 'reissue',
    intent: {
      operation: 'reissueInvitation',
      ...pairIntent(issued.pair),
      roles: ['reader'],
      redeemUntil: Date.now() + 60_000,
      validUntil: Date.now() + 120_000,
    },
  };
  const replaced = await f.call(f.url('execute'), reissue, issued.issuer.owned);
  owned(replaced, issued.issuer.owned);
  assert.notEqual(replaced.body.token, issued.token);
  assert.notEqual(replaced.body.result.change.after.invitation.invitationId, issued.pair.invitation.invitationId);
  denied(await f.call(f.url('preview'), { token: issued.token }, old.owned));
  const pair: InvitationPair = replaced.body.result.change.after;
  const replacement = await f.openRecipient(pair.invitation.invitationId);
  assert.equal((await f.call(f.url('preview'), { token: replaced.body.token }, replacement.owned)).status, 200);
  const revoked = await f.call(
    f.url('execute'),
    { idempotencyKey: 'revoke', intent: { operation: 'revokeInvitation', ...pairIntent(pair) } },
    issued.issuer.owned,
  );
  owned(revoked, issued.issuer.owned);
  assert.equal(revoked.body.result.change.after.membership.status, 'revoked');
  denied(await f.call(f.url('preview'), { token: replaced.body.token }, replacement.owned));
  const list = await f.call(f.url('list', '&tenantId=north&operation=reissueInvitation'), undefined, issued.issuer.owned);
  assert.deepEqual(list.body.page.items, []);
  assert.deepEqual((await f.discovery()).body.memberships, []);
  assert.equal(f.count(journal.receipt), 3);
});

test('lost issuance HTTP acknowledgement recovers the exact receipt, never the original token', async (t) => {
  const f = await fixture(t),
    issuer = await f.openIssuer();
  const attempt: InvitationAttempt = {
    idempotencyKey: 'lost-issue-ack',
    intent: {
      operation: 'issueInvitation',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.target.accountId,
      roles: ['reader'],
      redeemUntil: Date.now() + 60_000,
      validUntil: Date.now() + 120_000,
    },
  };
  const writeHead = ServerResponse.prototype.writeHead;
  let failed = false;
  const mocked = t.mock.method(
    ServerResponse.prototype,
    'writeHead',
    function (this: ServerResponse, ...args: Parameters<typeof writeHead>) {
      if (!failed && args[0] === 200) {
        failed = true;
        throw new Error('PRIVATE_LOST_ACK');
      }
      return Reflect.apply(writeHead, this, args);
    },
  );
  try {
    denied(await f.call(f.url('execute'), attempt, issuer.owned), 'unknown');
  } finally {
    mocked.mock.restore();
  }
  assert.equal(failed, true);
  assert.equal(f.count(journal.receipt), 1);
  assert.equal(f.count(INVITATION_TABLES.invitation), 1);
  const recovered = await f.call(f.url('status'), attempt, issuer.owned);
  owned(recovered, issuer.owned);
  assert.equal(recovered.body.status, 'completed');
  assert.equal(recovered.body.outcome, 'applied');
  assert.equal(Object.hasOwn(recovered.body, 'token'), false);
  assert.equal(recovered.text.includes('digest'), false);
  assert.equal(recovered.body.result.receiptId, f.db.prepare(`SELECT id FROM "${journal.receipt}"`).get()!.id);
  const missing = await f.call(f.url('status'), { ...attempt, idempotencyKey: 'never-dispatched' }, issuer.owned);
  assert.deepEqual(missing.body, { status: 'not_found', outcome: 'unknown', result: null });
});

test('same-account fresh native login invalidates old invitation context and fresh context recovers exact history', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  const login = await f.callNative('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'tenant-administration-operator-password-123',
    }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  denied(await f.call(f.url('execute'), issued.attempt, { ...issued.issuer.owned, cookie }));
  denied(await f.call(f.url('status'), issued.attempt, { ...issued.issuer.owned, cookie }), 'unknown');
  const fresh = await f.openIssuer({ ...f.users.operator, cookie });
  const recovered = await f.call(f.url('status'), issued.attempt, fresh.owned);
  owned(recovered, fresh.owned);
  assert.equal(recovered.body.result.receiptId, issued.answer.body.result.receiptId);
  assert.equal(f.count(journal.receipt), 1);
});

test('the real host retires partial invitation JSON readers before closing native auth', async (t) => {
  const f = await fixture(t),
    issuer = await f.openIssuer(),
    accepted = gate();
  f.owner.server.once('request', () => accepted.release());
  const request = httpRequest({
    hostname: f.bound.host,
    port: f.bound.port,
    path: f.url('execute'),
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', ...issuer.owned },
  });
  const closed = new Promise<void>((resolve) => {
    request.on('error', () => resolve());
    request.on('close', () => resolve());
  });
  request.write('{"idempotencyKey":');
  await accepted.promise;
  const retiring = f.owner.retire();
  assert.equal(retiring, f.owner.retire());
  await retiring;
  await closed;
  assert.throws(() => captureAppAuthRuntime(f.auth), TenantContextError);
  assert.equal(f.count(journal.receipt), 0);
  assert.equal(f.count(INVITATION_TABLES.invitation), 0);
});

test('native auth remains live while an admitted invitation writer drains during retirement', async (t) => {
  const f = await fixture(t),
    issuer = await f.openIssuer(),
    entered = gate(),
    release = gate();
  const original = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  const mocked = t.mock.method(
    SqliteAdapter.prototype,
    'runtimeMaintenanceTransaction',
    async function (this: SqliteAdapter, ...args: Parameters<typeof original>) {
      entered.release();
      await release.promise;
      return Reflect.apply(original, this, args);
    },
  );
  const attempt: InvitationAttempt = {
    idempotencyKey: 'retiring-issue',
    intent: {
      operation: 'issueInvitation',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.target.accountId,
      roles: ['reader'],
      redeemUntil: Date.now() + 60_000,
      validUntil: Date.now() + 120_000,
    },
  };
  const pending = f.call(f.url('execute'), attempt, issuer.owned);
  try {
    await entered.promise;
    const retiring = f.owner.retire();
    let drained = false;
    void retiring.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    captureAppAuthRuntime(f.auth).assertCurrent();
    release.release();
    denied(await pending);
    // call() has consumed the response; close only the newly idle connection,
    // preserving the assertion that native auth outlives the held writer.
    f.owner.server.closeIdleConnections();
    await retiring;
    assert.throws(() => captureAppAuthRuntime(f.auth), TenantContextError);
    assert.equal(f.count(journal.receipt), 0);
  } finally {
    release.release();
    mocked.mock.restore();
  }
});

test('accepted native schema exposes only logical business resources and invitation contexts cannot enter business routes', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    prepared = await f.prepare(issued);
  assert.equal((await f.call(f.url('execute'), { ...prepared.attempt, token: issued.token }, prepared.recipient.owned)).status, 200);
  const business = await f.selected();
  const schema = await f.call(`/api/schema?app=${f.binding.appId}&tenant=north`, undefined, business);
  assert.equal(schema.status, 200, schema.text);
  assert.doesNotMatch(schema.text, /__mistri_|private_item|tenant_id|digest|result_json/);
  for (const table of [INVITATION_TABLES.invitation, journal.receipt, TENANT_TABLES.membership]) {
    const deniedRead = await f.call(`/api/query?app=${f.binding.appId}&tenant=north`, { table }, business);
    assert.ok(deniedRead.status >= 400);
    assert.equal(deniedRead.text.includes(issued.token), false);
  }
  const crossing = await f.call(`/api/tenant/bootstrap?app=${f.binding.appId}`, undefined, prepared.recipient.owned);
  assert.ok(crossing.status >= 400);
  assert.equal(crossing.headers.get(contextHeader), null);
});

test('omitted invitation policy has no WHOAMI capability and its private prefix refuses all admission', async (t) => {
  const f = await fixture(t, { invitations: false });
  const who = await f.call(`/api/whoami?app=${f.binding.appId}`);
  assert.equal(who.status, 200);
  assert.equal(Object.hasOwn(who.body, 'tenantInvitations'), false);
  denied(await f.call(f.url('open-issuer'), {}));
  denied(await f.call(f.url('status'), {}, { ...f.identity(), [contextHeader]: 'invented' }), 'unknown');
  assert.equal(f.count(journal.receipt), 0);
});

test('private browser child bootstraps real accounts, serves invitation-only native HTTP and removes its owned stores on stop', async (t) => {
  const f = await startTenantInvitations();
  t.after(f.stop);
  const before = f.snapshot();
  assert.equal(before.business.length, 2);
  assert.equal(before.tenants.length, 2);
  assert.equal(before.memberships.length, 0);
  assert.equal(before.invitations.length, 0);
  assert.equal(before.receipts.length, 0);
  assert.deepEqual(
    before.tenants.map((row) => [row.id, row.status, row.version]),
    [
      ['north', 'active', '1'],
      ['south', 'active', '1'],
    ],
  );
  for (const account of Object.values(f.accounts)) assert.equal(typeof account.id, 'string');
  const login = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.accounts.operator.email, password: f.accounts.operator.password }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(login.status, 200);
  await login.json();
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const identity = { cookie, [headers.app]: f.appId, [headers.account]: f.accounts.operator.id };
  const who = await fetch(`${f.origin}/api/whoami?app=${f.appId}`, { headers: identity, signal: AbortSignal.timeout(10_000) });
  const value = await who.json();
  assert.equal(who.status, 200);
  assert.equal(value.tenantInvitations, true);
  assert.equal(Object.hasOwn(value, 'tenantAdministration'), false);
  assert.equal(value.appName, f.appName);
  const opened = await fetch(`${f.origin}${root}/open-issuer?app=${f.appId}`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json', ...identity },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(opened.status, 200);
  const session = (await opened.json()).session;
  assert.equal(session.accountId, f.accounts.operator.id);
  assert.equal(opened.headers.get(contextHeader), session.context);
  const stopping = f.stop();
  assert.equal(stopping, f.stop());
  await stopping;
  assert.equal(existsSync(f.database), false);
  assert.equal(existsSync(f.authDatabase), false);
  await assert.rejects(fetch(`${f.origin}/api/whoami?app=${f.appId}`, { signal: AbortSignal.timeout(1_000) }));
});

test('an email invitation is claimed over the transport by the account whose address it names', async (t) => {
  /* The browser's path, which the owner's own tests never took: preview
     returns a claimInvitation intent, and the execute that redeems it carries
     the one-time token exactly as an acceptance does. The transport used to
     admit a token only for acceptInvitation, so this answered 400. */
  const f = await fixture(t);
  const issuer = await f.openIssuer();
  const invited = 'target@example.test';
  const issue: InvitationAttempt = {
    idempotencyKey: 'issue-by-email',
    intent: {
      operation: 'issueInvitation',
      tenantId: 'north',
      expectedTenantVersion: '1',
      email: invited,
      roles: ['reader'],
      redeemUntil: Date.now() + 60_000,
      validUntil: Date.now() + 120_000,
    },
  };
  const issued = await f.call(f.url('execute'), issue, issuer.owned);
  assert.equal(issued.status, 200, issued.text);
  const pair = issued.body.result.change.after as InvitationPair;
  assert.equal(pair.invitation.accountId, `email:${invited}`);
  const token = issued.body.token as string;

  const recipient = await f.openRecipient(pair.invitation.invitationId, f.users.target);
  const preview = await f.call(f.url('preview'), { token }, recipient.owned);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.body.preview.intent.operation, 'claimInvitation');

  const accepted = await f.call(
    f.url('execute'),
    { idempotencyKey: 'claim-by-email', intent: preview.body.preview.intent, token },
    recipient.owned,
  );
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.result.status, 'accepted');
  assert.equal(accepted.body.result.tenantId, 'north');
  assert.equal(accepted.body.result.invitationId, pair.invitation.invitationId);
  assert.equal(Object.hasOwn(accepted.body, 'token'), false);
  assert.equal(accepted.text.includes(token), false);
  // The placeholder ends and the account's membership begins, on the same terms.
  assert.deepEqual(
    f.db
      .prepare(`SELECT account_id, status, roles_json FROM "${TENANT_TABLES.membership}" ORDER BY status`)
      .all()
      .map((row) => [row.account_id, row.status, row.roles_json]),
    [
      [f.users.target.accountId, 'active', '["reader"]'],
      [`email:${invited}`, 'revoked', '["reader"]'],
    ],
  );
  // The claimed token is spent, and an issuer's step still may not carry one.
  const again = await f.call(
    f.url('execute'),
    { idempotencyKey: 'claim-again', intent: preview.body.preview.intent, token },
    recipient.owned,
  );
  assert.equal(again.status, 403, again.text);
  const issuerToken = await f.call(f.url('execute'), { ...issue, idempotencyKey: 'issue-with-token', token }, issuer.owned);
  assert.equal(issuerToken.status, 400, issuerToken.text);
});
