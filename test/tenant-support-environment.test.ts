import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { provisionSqliteTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { captureTenantAdministrationEnrollment, createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { prepareTenantStartup, TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { keyId, SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { binding, SUPPORT_POLICY, supportManifest } from './support/tenantSupportFixture.js';

const FIRST_SECRET = 'synthetic-first-app-audit-secret-at-least-32-bytes';
const SECOND_SECRET = 'synthetic-second-app-audit-secret-at-least-32-bytes';
const AMBIENT_SECRET = 'synthetic-ambient-audit-secret-at-least-32-bytes';

function ambient(t: TestContext, value: string) {
  const saved = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = saved;
  });
}

function fixture(t: TestContext, secret: string) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-support-environment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const key = supportAuditKey(secret),
    db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
      CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0);`);
  } finally {
    db.close();
  }
  provisionSqliteTenantStore(path, binding);
  provisionSqliteTenantAdministrationJournal(path, binding);
  provisionSqliteSupportAudit(path, binding, key);
  const manifest = supportManifest(authPath),
    appPath = join(directory, 'app.json');
  writeFileSync(appPath, JSON.stringify(manifest));
  const loaded: LoadedApp = { path: appPath, dir: directory, pages: [], sources: {}, app: parseAppConfig(manifest, appPath) };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default {
    kind: 'tenant', appId: ${JSON.stringify(binding.appId)}, storeId: ${JSON.stringify(binding.storeId)},
    ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => ({ lead: true }), resolveRows: () => ({ lead: true }),
    resolvePlatformRows: () => ({ dealer: true, lead: true }), support: ${JSON.stringify(SUPPORT_POLICY)}
  };`,
  );
  const connection: ConnectionConfig = { id: binding.source.connection, name: 'Business', url: path, source: 'config', writable: true };
  return { key, loaded, authPath, startup: { loaded, connections: [connection], policyFile } };
}

test('explicit startup environment refuses a missing audit secret even when ambient has a valid one', async (t) => {
  ambient(t, FIRST_SECRET);
  const f = fixture(t, FIRST_SECRET);
  for (const environment of [{}, { [SUPPORT_AUDIT_KEY_VARIABLE]: undefined }, { [SUPPORT_AUDIT_KEY_VARIABLE]: '' }]) {
    await assert.rejects(prepareTenantStartup(f.startup, environment), (error) => {
      assert.ok(error instanceof TenantStartupError);
      assert.match(error.message, /support audit key/);
      assert.ok(!error.message.includes(FIRST_SECRET));
      return true;
    });
  }
});

test('startup captures separate audit keys and auth stores; enrollment and HTTP owners retain genuine handles', async (t) => {
  ambient(t, AMBIENT_SECRET);
  const first = fixture(t, FIRST_SECRET),
    second = fixture(t, SECOND_SECRET);
  // The same authored reference resolves independently for each App's environment.
  for (const f of [first, second]) f.loaded.app.auth!.store = '${SUPPORT_AUTH_STORE}';
  const environments = [first, second].map((f, index) => ({
    [SUPPORT_AUDIT_KEY_VARIABLE]: index === 0 ? FIRST_SECRET : SECOND_SECRET,
    SUPPORT_AUTH_STORE: f.authPath,
  }));
  const pending = [first, second].map((f, index) => prepareTenantStartup(f.startup, environments[index]));
  for (const environment of environments) {
    environment[SUPPORT_AUDIT_KEY_VARIABLE] = AMBIENT_SECRET;
    environment.SUPPORT_AUTH_STORE = 'postgres://invalid/auth';
  }
  const prepared = await Promise.all(pending);
  assert.notEqual(keyId(prepared[0].enrollment.supportAuditKey!), keyId(prepared[1].enrollment.supportAuditKey!));
  const hosts: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>[] = [];
  try {
    for (const [index, f] of [first, second].entries()) {
      const enrollment = prepared[index].enrollment,
        key = enrollment.supportAuditKey!;
      assert.equal(keyId(key), keyId(f.key));
      const options = { ...enrollment, app: f.loaded.app, verifySession: () => null };
      const enrolled = await createTenantEnrollment(options);
      try {
        assert.equal(captureTenantAdministrationEnrollment(enrolled)!.supportAuditKey, key);
      } finally {
        await enrolled.retire();
      }
      // Neither a lookalike handle nor the other App's genuine key is accepted.
      await assert.rejects(createTenantEnrollment({ ...options, supportAuditKey: { ...key } }), TenantContextError);
      await assert.rejects(
        createTenantEnrollment({ ...options, supportAuditKey: prepared[1 - index].enrollment.supportAuditKey }),
        TenantContextError,
      );
      const origin = `http://127.0.0.1:${4901 + index}`;
      const auth = await createAppAuth(f.loaded, {
        baseURL: origin,
        trustedOrigins: [origin],
        environment: {
          BETTER_AUTH_SECRET: 'synthetic-auth-secret-at-least-thirty-two-bytes',
          SUPPORT_AUTH_STORE: f.authPath,
        },
      });
      assert.ok(auth);
      try {
        hosts.push(
          await createTenantAuthenticatedHttpServer({
            loaded: f.loaded,
            auth,
            enrollment,
            bound: { host: '127.0.0.1', port: 4901 + index },
          }),
        );
      } catch (error) {
        auth.close();
        throw error;
      }
    }
    assert.equal(hosts.length, 2);
    assert.equal(process.env[SUPPORT_AUDIT_KEY_VARIABLE], AMBIENT_SECRET);
  } finally {
    await Promise.all(hosts.map((host) => host.retire()));
  }
});
