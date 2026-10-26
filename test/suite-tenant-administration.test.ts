/** The configured shared suite admits tenant features without conflating App
 * grants, delegated membership, native identity or the two business stores. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { provisionSqliteTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteSupportAudit, verifySqliteSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { supportAuditKey, SUPPORT_AUDIT_KEY_VARIABLE } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { ADMINISTRATION_HTTP_HEADER } from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';
import { INVITATION_HTTP_HEADER } from '../packages/mistri/src/shared/tenantInvitations.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';
import { supportManifest } from './support/tenantSupportFixture.js';

test('CLI shared tenant mounts admit scoped administration, invitations and audited native support', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-tenant-administration-'));
  const ambient = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  const wrongSecret = 'synthetic-ambient-wrong-audit-key-at-least-thirty-two-bytes';
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = wrongSecret;
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    try {
      await suite?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (ambient === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
      else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = ambient;
    }
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const environment: NodeJS.ProcessEnv = { SECRET: 'synthetic-suite-tenant-auth-secret-at-least-thirty-two-bytes' };
  const deployments = [],
    fixtures = [];
  for (const id of ['alpha', 'beta']) {
    const home = join(directory, id);
    mkdirSync(home);
    const path = join(home, 'business.db');
    const binding = { appId: id, source: { id: 'business', connection: 'support-business' }, storeId: `${id}-store` };
    const secret = `synthetic-${id}-support-audit-key-at-least-thirty-two-bytes`,
      key = supportAuditKey(secret);
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
        CREATE TABLE lead(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0);
        INSERT INTO dealer VALUES('north', 'North Motors');
        INSERT INTO lead(id, tenant_id, name) VALUES('same', 'north', '${id} lead');`);
    } finally {
      db.close();
    }
    provisionSqliteTenantStore(path, binding);
    provisionSqliteTenantAdministrationJournal(path, binding);
    provisionSqliteTenantInvitations(path, binding);
    provisionSqliteSupportAudit(path, binding, key);
    const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
      const db = new DatabaseSync(path),
        operations = new TransactionOperations();
      try {
        db.exec('BEGIN IMMEDIATE');
        await run(createSqliteTenantAdministration(db, operations, binding));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      } finally {
        db.close();
      }
    };
    await maintenance(async (admin) => {
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await admin.putPlatform({ status: 'active', expectedVersion: null });
    });
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        ...supportManifest(join(home, 'unused-auth.db')),
        id,
        api: { version: 1, roles: ['dealer_staff'], resources: { lead: { fields: ['id', 'name'] } } },
      }),
    );
    writeFileSync(
      join(home, 'policy.mjs'),
      `export default {
      kind:'tenant', appId:'${id}', storeId:'${binding.storeId}',
      ownership:{dealer:{kind:'platform'},lead:{kind:'tenant',column:'tenant_id'}},
      resolveMembershipRows:()=>({lead:true}), resolveRows:()=>({lead:true}),
      resolvePlatformRows:()=>({dealer:true,lead:true}),
      administration:{id:'${id}-administrators',version:'1',maxMembershipLifetimeMs:600000,operators:[],
        delegates:[{role:'dealer_admin',operations:['revokeMembership'],roles:['dealer_staff']}]},
      invitations:{id:'${id}-inviters',version:'1',maxMembershipLifetimeMs:600000,
        maxRedemptionLifetimeMs:120000,maxPendingPerTenant:10,operators:[],
        delegates:[{role:'dealer_admin',operations:['issueInvitation'],roles:['dealer_staff']}]},
      support:{id:'${id}-support',version:'1',grants:[{platformRole:'reviewer',tenants:'all',dealerRoles:['dealer_staff']}]}
    };`,
    );
    writeFileSync(
      join(home, 'connections.json'),
      JSON.stringify({ connections: [{ name: binding.source.connection, url: '${DATABASE_URL}', writable: true }] }),
    );
    environment[`${id.toUpperCase()}_DATABASE`] = path;
    environment[`${id.toUpperCase()}_AUDIT`] = secret;
    deployments.push({
      id,
      directory: `./${id}`,
      mount: `/${id}`,
      config: `./${id}/connections.json`,
      policy: `./${id}/policy.mjs`,
      environment: { DATABASE_URL: `${id.toUpperCase()}_DATABASE`, MISTRI_AUDIT_KEY: `${id.toUpperCase()}_AUDIT` },
    });
    fixtures.push({ id, path, binding, key, maintenance });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({
      port,
      apps: deployments,
      identity: {
        id: 'shared',
        name: 'Shared suite',
        store: './identity.db',
        grants: './grants.db',
        environment: { BETTER_AUTH_SECRET: 'SECRET' },
      },
    }),
  );
  suite = await startConfiguredSuite(file, environment);
  const call = async (path: string, identity: Record<string, string> = {}, body?: unknown) => {
    const appId = /^\/(alpha|beta)\/api\/tenant\/(administration|invitations)\//.exec(path)?.[1];
    const response = await fetch(suite!.publicURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: suite!.publicURL, 'content-type': 'application/json', ...(appId ? { [headers.app]: appId } : {}), ...identity },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: text ? JSON.parse(text) : {},
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  type Answer = Awaited<ReturnType<typeof call>>;
  const ok = (answer: Answer) => {
    assert.equal(answer.status, 200, answer.text);
    return answer.body;
  };
  const denied = (answer: Answer) => {
    assert.ok(answer.status >= 400 && answer.status < 500, answer.text);
  };
  const operatorCredentials = { name: 'Olivia Operator', email: 'operator@example.test', password: 'suite-operator-password-123' };
  const operator = await call('/api/auth/sign-up/email', {}, operatorCredentials);
  ok(operator);
  const recipient = await call(
    '/api/auth/sign-up/email',
    {},
    { name: 'Sam Staff', email: 'staff@example.test', password: 'suite-staff-password-123' },
  );
  ok(recipient);
  const identity = (account: Answer) => ({ cookie: account.cookie, [headers.account]: account.body.user.id as string });
  const actor = identity(operator),
    target = identity(recipient);
  const grant = (appId: string, account: Answer, roles: string[]) =>
    changeSuiteGrant(file, { appId, subjectId: account.body.user.id, expectedRevision: 0, roles }, environment);
  const route = (id: string, feature: string, operation: string) => `/${id}/api/tenant/${feature}/${operation}?app=${id}`;
  let sequence = 0;
  const supportOpen = (id: string, who = actor) =>
    call(route(id, 'support', 'open'), who, {
      idempotencyKey: `support-${++sequence}`,
      intent: { operation: 'openSupport', tenantId: 'north', dealerRole: 'dealer_staff', reason: 'Investigating a stuck lead' },
    });
  const noAuthority = async (id: string) => {
    denied(await call(route(id, 'administration', 'open'), actor, {}));
    denied(await call(route(id, 'invitations', 'open-issuer'), actor, {}));
    denied(await supportOpen(id));
  };
  assert.deepEqual(ok(await call('/api/suite/apps', actor)).apps, []);
  await noAuthority('alpha'); // Central login is not the first App's grant.
  await grant('alpha', operator, ['admin', 'dealer_admin', 'reviewer']);
  await noAuthority('beta'); // Even alpha's suite administrator cannot enter beta.
  const [alpha] = fixtures;
  const enrollOperator = (fixture: typeof alpha) =>
    fixture.maintenance(async (admin) => {
      await admin.putMembership({
        tenantId: 'north',
        accountId: actor[headers.account],
        membershipId: 'north-operator',
        status: 'active',
        roles: ['dealer_admin'],
        validUntil: Date.now() + 600_000,
        expectedVersion: null,
      });
      await admin.putPlatformMembership({
        accountId: actor[headers.account],
        membershipId: 'platform-operator',
        status: 'active',
        roles: ['reviewer'],
        validUntil: Date.now() + 600_000,
        expectedVersion: null,
      });
    });
  for (const fixture of fixtures) {
    if (fixture.id === 'beta') await grant('beta', operator, ['admin', 'dealer_admin', 'reviewer']);
    assert.equal(ok(await call(route(fixture.id, 'administration', 'open'), actor, {})).session, null);
    assert.equal(ok(await call(route(fixture.id, 'invitations', 'open-issuer'), actor, {})).session, null);
    denied(await supportOpen(fixture.id)); // App roles never substitute for tenant/platform membership.
    await enrollOperator(fixture);
  }
  const opened = ok(await call(route('alpha', 'administration', 'open'), actor, {}));
  assert.ok(opened.session.context);
  const adminHeaders = { ...actor, [ADMINISTRATION_HTTP_HEADER]: opened.session.context as string };
  const tenants = ok(await call(route('alpha', 'administration', 'tenants'), adminHeaders));
  assert.deepEqual(
    tenants.page.items.map((item: { tenantId: string }) => item.tenantId),
    ['north'],
  );
  denied(await call(route('beta', 'administration', 'tenants'), adminHeaders));
  assert.ok(ok(await call(route('beta', 'administration', 'open'), actor, {})).session.context);

  // The invitation belongs to an already existing, explicitly granted account.
  // Its matching email grants no App access by itself.
  await grant('beta', recipient, ['dealer_staff']);
  const issuer = ok(await call(route('alpha', 'invitations', 'open-issuer'), actor, {}));
  const issuerHeaders = { ...actor, [INVITATION_HTTP_HEADER]: issuer.session.context as string };
  const issued = ok(
    await call(route('alpha', 'invitations', 'execute'), issuerHeaders, {
      idempotencyKey: 'invite-existing-email',
      intent: {
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        email: 'staff@example.test',
        roles: ['dealer_staff'],
        redeemUntil: Date.now() + 60_000,
        validUntil: Date.now() + 120_000,
      },
    }),
  );
  const invitationId = issued.result.change.after.invitation.invitationId;
  denied(await call(route('alpha', 'invitations', 'open-recipient'), target, { invitationId }));
  assert.deepEqual(
    ok(await call('/api/suite/apps', target)).apps.map((app: { id: string }) => app.id),
    ['beta'],
  );
  await grant('alpha', recipient, ['dealer_staff']);
  const recipientContext = ok(await call(route('alpha', 'invitations', 'open-recipient'), target, { invitationId }));
  const recipientHeaders = { ...target, [INVITATION_HTTP_HEADER]: recipientContext.session.context as string };
  denied(await call(route('beta', 'invitations', 'preview'), recipientHeaders, { token: issued.token }));
  const betaRecipient = ok(await call(route('beta', 'invitations', 'open-recipient'), target, { invitationId }));
  denied(
    await call(
      route('beta', 'invitations', 'preview'),
      { ...target, [INVITATION_HTTP_HEADER]: betaRecipient.session.context },
      { token: issued.token },
    ),
  );
  const preview = ok(await call(route('alpha', 'invitations', 'preview'), recipientHeaders, { token: issued.token }));
  assert.equal(preview.preview.intent.operation, 'claimInvitation');
  const accepted = ok(
    await call(route('alpha', 'invitations', 'execute'), recipientHeaders, {
      idempotencyKey: 'accept-existing-email',
      intent: preview.preview.intent,
      token: issued.token,
    }),
  );
  assert.equal(accepted.result.status, 'accepted');
  const selected = ok(await call('/alpha/api/tenant/context/open?app=alpha&tenant=north', target, {}));
  const business = {
    ...target,
    [headers.tab]: selected.tabId,
    [headers.context]: selected.context,
    [headers.revision]: String(selected.revision),
  };
  assert.deepEqual(
    ok(await call('/alpha/api/query?app=alpha&tenant=north', business, { table: 'lead' })).rows.map(
      (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
    ),
    [{ id: 'same', name: 'alpha lead' }],
  );
  denied(await call('/beta/api/tenant/context/open?app=beta&tenant=north', target, {}));
  const member = ok(
    await call(route('alpha', 'administration', 'memberships') + '&tenantId=north&operation=revokeMembership', adminHeaders),
  ).page.items[0];
  assert.equal(member.accountId, target[headers.account]);
  const revoked = ok(
    await call(route('alpha', 'administration', 'execute'), adminHeaders, {
      idempotencyKey: 'revoke-invited-member',
      intent: {
        operation: 'revokeMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: member.membershipId,
        expectedMembershipVersion: member.version,
      },
    }),
  );
  assert.equal(revoked.outcome, 'applied');
  denied(await call('/alpha/api/query?app=alpha&tenant=north', business, { table: 'lead' }));

  const support = ok(await supportOpen('alpha'));
  assert.equal(support.receipt.session.operatorName, operatorCredentials.name);
  const native = new DatabaseSync(join(directory, 'identity.db'));
  try {
    assert.equal(native.prepare('SELECT count(*) AS n FROM user').get()!.n, 2, 'invitations never create a global account');
    native
      .prepare('UPDATE session SET createdAt = ? WHERE userId = ?')
      .run(new Date(Date.now() - 310_000).toISOString(), actor[headers.account]);
  } finally {
    native.close();
  }
  const stale = await supportOpen('beta');
  denied(stale);
  assert.equal(stale.body.code, SUPPORT_REFUSAL_CODES.signInRequired);
  const freshLogin = await call('/beta/api/auth/sign-in/email', {}, operatorCredentials);
  ok(freshLogin);
  const fresh = { ...actor, cookie: freshLogin.cookie };
  assert.equal(ok(await supportOpen('beta', fresh)).receipt.session.operatorName, operatorCredentials.name);
  for (const fixture of fixtures) {
    const audit = verifySqliteSupportAudit(fixture.path, fixture.binding, fixture.key);
    assert.equal(audit.sessions, 1);
    assert.ok(audit.entries > 0);
    assert.deepEqual(audit.failed, []);
    denied(await call(`/${fixture.id}/api/apps/${fixture.id}/v1/lead`, { authorization: 'Bearer unavailable-suite-token' }));
  }
  // Signing out at alpha revokes the native login that opened support at beta.
  ok(await call('/alpha/api/auth/sign-out', fresh, {}));
  denied(await call(route('beta', 'support', 'status'), fresh, {}));
  denied(await call(route('beta', 'administration', 'open'), fresh, {}));
  assert.equal((await call('/api/suite/apps', fresh)).status, 401);
  assert.equal(process.env[SUPPORT_AUDIT_KEY_VARIABLE], wrongSecret, 'per-App aliases never bleed into the process environment');
});
