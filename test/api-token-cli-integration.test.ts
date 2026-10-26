import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { issueSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { runApiTokenMaintenance } from '../packages/mistri/src/server/cli/apiTokenMaintenance.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

test('real private CLI maintenance loads locked App/config and provisions, inspects and revokes without secret output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-token-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appPath = join(dir, 'app.json'),
    configPath = join(dir, 'connections.json');
  const authPath = join(dir, 'auth.db'),
    businessPath = join(dir, 'business.db');
  const raw = {
    id: 'app',
    name: 'App',
    connection: 'business',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { store: 'auth.db', roles: { reader: { read: true } } },
    api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
  };
  writeFileSync(appPath, JSON.stringify(raw));
  writeFileSync(configPath, JSON.stringify({ connections: [{ name: 'business', url: businessPath }] }));
  const business = new DatabaseSync(businessPath);
  business.exec('CREATE TABLE item(id INTEGER PRIMARY KEY)');
  business.close();
  const loaded = await loadApp(appPath);
  assert.ok(loaded.authority);
  writeFileSync(join(dir, 'authority.lock'), loaded.authority.report);
  const env = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = env.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-cli-token-fixture-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    const runtime = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
    runtime.close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const db = new DatabaseSync(authPath);
  for (const id of ['subject', 'actor'])
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)').run(
      id,
      id,
      id + '@example.test',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'reader',
    );
  db.close();
  const storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
  const common = ['--app', appPath, '--config', configPath, '--store-id', storeId];
  const provision = await runApiTokenMaintenance(['provision', ...common]);
  assert.equal(provision.verb, 'provision');
  assert.ok(provision.result && 'migrated' in provision.result && provision.result.migrated);
  const schema: DatabaseSchema = {
    label: 'Local',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
      },
    ],
  };
  const now = Date.now();
  const issued = issueSqliteApiToken(
    authPath,
    loaded.app,
    schema,
    {
      storeId,
      exclusions: [captureAuthStoreExclusion(businessPath)],
      subjectId: 'subject',
      actorId: 'actor',
      roles: ['reader'],
      label: 'CLI integration',
      expiresAt: now + 60000,
    },
    now,
  );
  const token = ['--token-id', issued.tokenId];
  const first = await runApiTokenMaintenance(['inspect', ...common, ...token]);
  assert.equal(first.verb, 'inspect');
  assert.ok(first.result && 'record' in first.result);
  assert.equal(first.result.version, '1');
  const revoked = await runApiTokenMaintenance(['revoke', ...common, ...token, '--expected-version', '1', '--actor', 'actor']);
  assert.deepEqual(revoked, { verb: 'revoke', result: { tokenId: issued.tokenId, version: '2' } });
  const after = await runApiTokenMaintenance(['inspect', ...common, ...token]);
  assert.ok(after.result && 'record' in after.result);
  assert.equal(after.result.record.revokedBy, 'actor');
  const locators: string[] = [];
  const cliIssued = await runApiTokenMaintenance(
    [
      'issue',
      ...common,
      '--subject',
      'subject',
      '--actor',
      'actor',
      '--role',
      'reader',
      '--label',
      'CLI issued',
      '--expires-at',
      new Date(Date.now() + 60000).toISOString(),
      '--deny-all-operations',
    ],
    undefined,
    (id) => locators.push(id),
  );
  assert.equal(cliIssued.verb, 'issue');
  assert.ok(cliIssued.result && 'token' in cliIssued.result);
  assert.deepEqual(locators, [cliIssued.result.tokenId]);
  const cliInspected = await runApiTokenMaintenance(['inspect', ...common, '--token-id', cliIssued.result.tokenId]);
  assert.ok(cliInspected.result && 'record' in cliInspected.result);
  assert.deepEqual(cliInspected.result.record.operations, []);
  assert.ok(!JSON.stringify(cliInspected).includes(cliIssued.result.token));
  const invoke = (args: string[]) =>
    new Promise<{ out: string; err: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url)), 'api-token', ...args],
        { timeout: 20000, killSignal: 'SIGKILL' },
        (error, out, err) => {
          if (error) reject(new Error('Token CLI subprocess failed (output withheld).'));
          else resolve({ out, err });
        },
      );
    });
  const processIssued = await invoke([
    'issue',
    ...common,
    '--subject',
    'subject',
    '--actor',
    'actor',
    '--role',
    'reader',
    '--label',
    'process issue',
    '--expires-at',
    new Date(Date.now() + 60000).toISOString(),
  ]);
  const processEnvelope = JSON.parse(processIssued.out);
  assert.equal(processEnvelope.verb, 'issue');
  const processValue = processEnvelope.result;
  assert.equal(typeof processValue.token, 'string');
  assert.ok(!processIssued.err.includes(processValue.token));
  const processInspected = await invoke(['inspect', ...common, '--token-id', processValue.tokenId]);
  const processRevoked = await invoke([
    'revoke',
    ...common,
    '--token-id',
    processValue.tokenId,
    '--expected-version',
    '1',
    '--actor',
    'actor',
  ]);
  for (const response of [processInspected, processRevoked]) {
    assert.ok(!response.out.includes(processValue.token));
    assert.ok(!response.err.includes(processValue.token));
    assert.ok(!response.out.includes('"digest"'));
    assert.ok(!response.out.includes('"token"'));
  }
  for (const result of [provision, first, revoked, after]) {
    const encoded = JSON.stringify(result);
    assert.ok(!encoded.includes(issued.token));
    assert.ok(!encoded.includes('"digest"'));
    assert.ok(!encoded.includes('"token"'));
  }
  await assert.rejects(runApiTokenMaintenance(['inspect', ...common.slice(0, -1), '36c77f92-cf69-412d-ade3-3971490fb83a', ...token]));
  writeFileSync(appPath, JSON.stringify({ ...raw, auth: { ...raw.auth, store: 'missing.db' } }));
  const changed = await loadApp(appPath, { lock: 'report' });
  writeFileSync(join(dir, 'authority.lock'), changed.authority!.report);
  await assert.rejects(runApiTokenMaintenance(['provision', ...common]));
  assert.equal(existsSync(join(dir, 'missing.db')), false);
});
