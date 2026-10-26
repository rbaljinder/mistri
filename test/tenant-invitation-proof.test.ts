import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  captureAppAuthRuntime,
  createAppAuth,
  type AppAuthRuntimeBinding,
  type VerifiedSessionInstance,
} from '../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureInvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { captureStoredTenantInvitation } from '../packages/mistri/src/server/tenant/tenantInvitationStoreContract.js';
import {
  createInvitationLifetime,
  assertInvitationEligibility,
  observeInvitationEligibility,
} from '../packages/mistri/src/server/tenant/tenantInvitationProof.js';

const policy = (accountId = 'operator') =>
  captureInvitationPolicy({
    id: 'p',
    version: 'v1',
    maxMembershipLifetimeMs: 1000,
    maxRedemptionLifetimeMs: 100,
    maxPendingPerTenant: 10,
    operators: [{ accountId, tenants: ['north'], operations: ['issueInvitation'], roles: ['reader'] }],
  });
const row = (accountId = 'operator') =>
  captureStoredTenantInvitation({
    invitationId: '36c77f92-cf69-412d-ade3-3971490fb83a',
    version: '1',
    tenantId: 'north',
    membershipId: '21a53156-f274-4622-8a68-3f0b82c2c45a',
    accountId,
    inviterId: accountId,
    issuanceOperation: 'issueInvitation',
    roles: ['reader'],
    expectedTenantVersion: '1',
    policyId: 'p',
    policyVersion: 'v1',
    createdAt: 100,
    redeemUntil: 200,
    validUntil: 300,
    status: 'pending',
    digest: 'ab'.repeat(32),
  });
const request = (cookie = '') => ({ headers: { cookie }, aborted: false }) as IncomingMessage;

test('pure: synchronous lifetime retains its exact observation order and expiry cap', async () => {
  // Ordering double only: genuine proof ownership is tested below.
  const calls: string[] = [],
    proof = { identity: { id: 'a' }, sessionId: 's', expiresAt: 500 } as VerifiedSessionInstance;
  const fresh = { ...proof, expiresAt: 150 };
  const auth = {
    synchronous: true,
    assertSessionCurrent: (value: unknown) => calls.push(value === proof ? 'retained' : 'fresh'),
    sessionInstance: async () => {
      calls.push('session');
      return fresh;
    },
    observeSession: async () => {
      throw new Error('sync branch must not add asynchronous observations');
    },
  } as unknown as AppAuthRuntimeBinding;
  let now = 100;
  const lifetime = createInvitationLifetime({
    auth,
    request: request(),
    proof,
    accountId: 'a',
    contextExpiresAt: 500,
    started: now,
    lifetime: 300,
    clock: () => now,
  });
  await lifetime.current();
  assert.deepEqual(calls, ['retained', 'session', 'retained', 'fresh', 'retained']);
  now = 150;
  assert.throws(lifetime.live, TenantContextError);
});

test('pure: async proof observations stop at abort after every await', async () => {
  for (const stop of ['session', 'retained', 'fresh']) {
    const req = request(),
      calls: string[] = [];
    const proof = { identity: { id: 'a' }, sessionId: 's', expiresAt: 500 } as VerifiedSessionInstance,
      fresh = { ...proof };
    const mark = (name: string) => {
      calls.push(name);
      if (name === stop) req.aborted = true;
    };
    const auth = {
      synchronous: false,
      assertSessionCurrent() {},
      sessionInstance: async () => {
        mark('session');
        return fresh;
      },
      observeSession: async (value: unknown) => mark(value === proof ? 'retained' : 'fresh'),
    } as unknown as AppAuthRuntimeBinding;
    const lifetime = createInvitationLifetime({
      auth,
      request: req,
      proof,
      accountId: 'a',
      contextExpiresAt: 500,
      started: 100,
      lifetime: 300,
      clock: () => 100,
    });
    await assert.rejects(lifetime.current(), TenantContextError);
    assert.deepEqual(calls, ['session', 'retained', 'fresh'].slice(0, ['session', 'retained', 'fresh'].indexOf(stop) + 1));
  }
});

test('pure: fresh account/session replacement and clock movement cannot broaden lifetime', async () => {
  for (const change of ['account', 'session', 'backwards', 'expired']) {
    const proof = { identity: { id: 'a' }, sessionId: 's', expiresAt: 500 } as VerifiedSessionInstance;
    let now = 100,
      observations = 0;
    const auth = {
      synchronous: false,
      assertSessionCurrent() {},
      sessionInstance: async () => {
        if (change === 'backwards') now = 99;
        if (change === 'expired') now = 200;
        return { ...proof, identity: { id: change === 'account' ? 'other' : 'a' }, sessionId: change === 'session' ? 'other' : 's' };
      },
      observeSession: async () => {
        observations++;
      },
    } as unknown as AppAuthRuntimeBinding;
    await assert.rejects(
      createInvitationLifetime({
        auth,
        request: request(),
        proof,
        accountId: 'a',
        contextExpiresAt: 200,
        started: 100,
        lifetime: 300,
        clock: () => now,
      }).current(),
      TenantContextError,
    );
    assert.equal(observations, 0);
  }
});

test('pure: eligibility captures required data and checks both accounts without caching', async () => {
  const original = { ...row(), accountId: 'recipient' },
    calls: string[] = [];
  const auth = {
    lookupEligibleAccountCurrent: async (id: string) => {
      calls.push(id);
      original.accountId = 'changed';
      return { accountId: id };
    },
  } as unknown as AppAuthRuntimeBinding;
  await observeInvitationEligibility(original, policy(), auth, () => 110);
  assert.deepEqual(calls, ['operator', 'recipient']);
  for (const missing of ['operator', 'recipient']) {
    calls.length = 0;
    const refusal = {
      lookupEligibleAccountCurrent: async (id: string) => {
        calls.push(id);
        return id === missing ? null : { accountId: id };
      },
    } as unknown as AppAuthRuntimeBinding;
    await assert.rejects(
      observeInvitationEligibility({ ...row(), accountId: 'recipient' }, policy(), refusal, () => 110),
      TenantContextError,
    );
    assert.deepEqual(calls, missing === 'operator' ? ['operator'] : ['operator', 'recipient']);
  }
  let retired = false;
  const interrupted = {
    lookupEligibleAccountCurrent: async (id: string) => {
      retired = true;
      return { accountId: id };
    },
  } as unknown as AppAuthRuntimeBinding;
  await assert.rejects(
    observeInvitationEligibility(row(), policy(), interrupted, () => {
      if (retired) throw new TenantContextError();
      return 110;
    }),
    TenantContextError,
  );
});

test('pure: eligibility rejects stale terms before lookups and rechecks expiry after lookup', async () => {
  let calls = 0,
    now = 110;
  const auth = {
    lookupEligibleAccountCurrent: async (id: string) => {
      calls++;
      now = 200;
      return { accountId: id };
    },
  } as unknown as AppAuthRuntimeBinding;
  await assert.rejects(
    observeInvitationEligibility({ ...row(), policyVersion: 'old' }, policy(), auth, () => now),
    TenantContextError,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    observeInvitationEligibility(row(), policy(), auth, () => now),
    TenantContextError,
  );
  assert.equal(calls, 1, 'recipient lookup must not proceed after redemption expiry');
});

test('genuine native proofs remain binding-owned through inactive async helper observations', async (t) => {
  // SQLite native fixture. Instrumented async scheduling forwards every proof
  // observation to the genuine binding; this is not a claim of PG integration.
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-invitation-proof-'));
  let binding: AppAuthRuntimeBinding | undefined;
  const server = createServer((req, res) => {
    if (!binding) {
      res.writeHead(503);
      res.end();
      return;
    }
    void binding.handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    binding?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    dir: directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'proof-app',
        name: 'Proof App',
        resources: { item: {} },
        auth: { store: 'auth.db', signUp: 'open', roles: { user: { read: true } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'proof fixture',
    ),
  };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-invitation-proof-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    binding = captureAppAuthRuntime(await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] }));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Proof', email: 'proof@example.test', password: 'proof-test-password-123' }),
  });
  await response.json();
  assert.equal(response.status, 200);
  const req = request(
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  );
  const proof = await binding.sessionInstance(req);
  assert.ok(proof);
  const observed: VerifiedSessionInstance[] = [];
  const instrumented: AppAuthRuntimeBinding = Object.create(binding, {
    synchronous: { value: false },
    observeSession: {
      value: async (value: VerifiedSessionInstance) => {
        observed.push(value);
        await binding!.observeSession(value);
      },
    },
  });
  const options = {
    auth: instrumented,
    request: req,
    proof,
    accountId: proof.identity.id,
    contextExpiresAt: proof.expiresAt,
    started: Date.now(),
    lifetime: 60_000,
    clock: Date.now,
  };
  await createInvitationLifetime(options).current();
  assert.equal(observed.length, 2);
  assert.equal(observed[0], proof);
  await assert.rejects(createInvitationLifetime({ ...options, proof: { ...proof } }).current(), TenantContextError);
  await observeInvitationEligibility(row(proof.identity.id), policy(proof.identity.id), binding, () => 110);
  assertInvitationEligibility(row(proof.identity.id), policy(proof.identity.id), 110, binding);
  const db = new DatabaseSync(join(directory, 'auth.db'));
  try {
    db.prepare('UPDATE "user" SET banned=1 WHERE id=?').run(proof.identity.id);
    await assert.rejects(
      observeInvitationEligibility(row(proof.identity.id), policy(proof.identity.id), binding, () => 110),
      TenantContextError,
    );
    await assert.rejects(createInvitationLifetime(options).current(), TenantContextError);
  } finally {
    db.close();
  }
});
