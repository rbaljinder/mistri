import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { startTenantAssignment } from '../../e2e/support/tenantProofServer.js';
import { provisionSqliteEventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { eventDeliveryPolicy } from './eventDeliveryFixture.js';

/** A genuine native command creates the source evidence. Only its business
 * SQLite snapshot is retained; no auth store or credentials enter publication.
 * The snapshot has no active owner when explicit delivery provisioning runs. */
export async function nativeEventDeliveryFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-event-delivery-native-')),
    path = join(directory, 'source.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await startTenantAssignment({ tenantEvents: true });
  t.after(() => f.stop());
  try {
    const account = f.accounts.manager;
    const login = await fetch(`${f.origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: f.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(login.status, 200, 'native login failed');
    await login.arrayBuffer();
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.ok(cookie.length > 0, 'native cookie missing');
    const call = async (endpoint: string, body: unknown, ownership: Record<string, string> = {}) => {
      const response = await fetch(`${f.origin}${endpoint}?app=${f.appId}&tenant=northstar`, {
        method: 'POST',
        headers: { origin: f.origin, cookie, 'content-type': 'application/json', ...ownership },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      assert.ok(
        !text.includes(account.password) && !text.includes(cookie) && !text.includes(f.database),
        'private response leaked credentials/path',
      );
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const opened = await call('/api/tenant/context/open', {});
    assert.equal(opened.status, 200);
    const c = opened.body;
    assert.equal(c.accountId, account.id);
    assert.equal(c.tenantId, 'northstar');
    const ownership = {
      'x-mistri-account': account.id,
      'x-mistri-tab': String(c.tabId),
      'x-mistri-context': String(c.context),
      'x-mistri-lease-revision': String(c.revision),
    };
    const input = {
      command: 'assignReviewer',
      commandVersion: 2,
      key: { id: f.assignmentRows.north.application },
      expectedVersion: 0,
      idempotencyKey: 'publication-native-assignment-0001',
      input: { reviewer: f.assignmentRows.north.reviewer, reason: 'Disposable private reason excluded from event payload' },
    };
    const result = await call('/api/commands/execute', input, ownership);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'applied');
    assert.equal(result.body.replayed, false);
    const replay = await call('/api/commands/execute', input, ownership);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.receiptId, result.body.receiptId);
    await f.revoke(account.id, 'northstar');
    const revoked = await call('/api/commands/execute', input, ownership);
    assert.ok(revoked.status >= 400 || (Array.isArray(revoked.body.errors) && revoked.body.errors.length > 0));
    const source = new DatabaseSync(f.database, { readOnly: true });
    try {
      source.prepare('VACUUM main INTO ?').run(path);
    } finally {
      source.close();
    }
    await f.stop();
    const base = eventDeliveryPolicy();
    const policy = {
      ...base,
      source: { appId: f.appId, storeId: 'cross-app-proof', sourceId: 'business' },
      routes: [
        {
          scope: 'tenant' as const,
          tenantId: 'northstar',
          commandId: 'assignReviewer',
          commandVersion: 2,
          manifest: [{ name: 'application.reviewer-assigned', version: 1 }],
        },
      ],
    };
    provisionSqliteEventDeliveryStore(path, policy, { stopped: true });
    return { path, policy, receiptId: result.body.receiptId as string, actorId: account.id, applicationId: input.key.id };
  } finally {
    await f.stop();
  }
}
