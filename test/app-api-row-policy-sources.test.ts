/** A row-policy App with two sources on two connections, through the real CLI
 * over SQLite: each exposed resource is read on its own source's connection
 * alone (apiSourceLanes.ts), under the token account's policy there — the
 * second source's rows are narrowed exactly as the first's. The lane itself,
 * and its refusal of a resource on another connection, are the policy
 * context's (`readsAt`, app-policy-context.test.ts). */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { SESSION_SECRET, serveApi } from './appApiCli.js';

const storeId = '0d7c1f3e-6a2b-4f0e-9b8d-2c4a6e8f1a35';

async function desk(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-row-policy-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    archive = join(directory, 'archive.db'),
    authPath = join(directory, 'auth.db');
  for (const [file, sql] of [
    [
      business,
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL); ' +
        "INSERT INTO ticket VALUES (1, 'ann', 'Printer'), (2, 'bob', 'Laptop')",
    ],
    [
      archive,
      'CREATE TABLE note(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL); ' +
        "INSERT INTO note VALUES (1, 'bob', 'Bob kept this'), (2, 'ann', 'Ann kept this'), (3, 'ann', 'Ann again')",
    ],
  ]) {
    const db = new DatabaseSync(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json'),
    policy = join(directory, 'policy.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { business: { connection: 'data', default: true }, archive: { connection: 'notes' } },
      resources: { ticket: {}, 'archive.note': {} },
      auth: { store: authPath, rows: 'policy', roles: { agent: { read: ['ticket', 'archive.note'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      api: {
        version: 1,
        roles: ['agent'],
        resources: {
          ticket: { fields: ['id', 'owner', 'title'], sorts: ['id'] },
          'archive.note': { fields: ['id', 'owner', 'body'], sorts: ['id'] },
        },
      },
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { id: 'data', name: 'data', url: business },
        { id: 'notes', name: 'notes', url: archive },
      ],
    }),
  );
  // One policy over both sources: an agent's own rows, by the verified account's id.
  writeFileSync(
    policy,
    `export default { appId: 'desk',
  resolveRows(principal) {
    const own = { groups: [[{ column: 'owner', op: '=', value: principal.id }]] };
    return { ticket: own, 'archive.note': own };
  },
};
`,
  );
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const accounts = new DatabaseSync(authPath);
  try {
    for (const id of ['ann', 'bob'])
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'agent');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business), captureAuthStoreExclusion(archive)];
  provisionSqliteApiTokenStore(authPath, { appId: 'desk', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, source: 'config' });
  registry.add({ id: 'notes', name: 'notes', url: archive, source: 'config' });
  const tokens: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    for (const id of ['ann', 'bob'])
      tokens[id] = issueSqliteApiToken(
        authPath,
        loaded.app,
        resources.schema,
        { storeId, exclusions, subjectId: id, actorId: id, roles: ['agent'], label: id, expiresAt: Date.now() + 600000 },
        Date.now(),
      ).token;
  } finally {
    await registry.closeAll();
  }
  return { appDir, config, policy, tokens };
}

test('a row-policy App reads each source on its own connection, under the account’s policy on both', { timeout: 180000 }, async (t) => {
  const f = await desk(t);
  const served = await serveApi(t, f, 'desk', ['--policy', f.policy]);
  await served.started;
  const get = async (token: string, path: string) => {
    const res = await fetch(`${served.base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };

  // The document names each operation's source; its list paths are found there, not guessed.
  const spec = await get(f.tokens.ann, '/$openapi');
  assert.equal(spec.status, 200, JSON.stringify(spec.body));
  assert.equal(spec.body['x-mistri-consistency'], 'single-source-per-request');
  const lists = Object.fromEntries(
    Object.entries(spec.body.paths as Record<string, { get?: { 'x-mistri-source'?: string } }>)
      .filter(([path, entry]) => !path.includes('{') && entry.get)
      .map(([path, entry]) => [entry.get!['x-mistri-source'], path]),
  );
  assert.deepEqual(Object.keys(lists).sort(), ['archive', 'business'], JSON.stringify(spec.body.paths));
  const ids = async (token: string, source: string) => {
    const listed = await get(token, `${lists[source]}?sort=id`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    return listed.body.items.map((row: { id: string; owner: string }) => [row.id, row.owner]);
  };

  // The default source, narrowed to the account's rows.
  assert.deepEqual(await ids(f.tokens.ann, 'business'), [['1', 'ann']]);
  assert.deepEqual(await ids(f.tokens.bob, 'business'), [['2', 'bob']]);
  // The second source, on its own connection, narrowed by the same policy.
  assert.deepEqual(await ids(f.tokens.ann, 'archive'), [
    ['2', 'ann'],
    ['3', 'ann'],
  ]);
  assert.deepEqual(await ids(f.tokens.bob, 'archive'), [['1', 'bob']]);
  // An item there outside the policy is not found, as on the default source.
  assert.equal((await get(f.tokens.ann, `${lists.archive}/2`)).status, 200);
  assert.equal((await get(f.tokens.ann, `${lists.archive}/1`)).status, 404);
  assert.equal((await get(f.tokens.bob, `${lists.business}/1`)).status, 404);
});
