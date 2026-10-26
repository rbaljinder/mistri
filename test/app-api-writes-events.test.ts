/** Generic writes (`expose(fields, { create, update, delete })`), the event
 * feed (`api.events`, `…/$events`) and the AsyncAPI document (`…/$asyncapi`)
 * through the real CLI, over SQLite. Each case builds its own App directory,
 * native auth store, event store and issued tokens, and kills what it starts.
 * The PostgreSQL cases are app-api-writes-events-postgres.test.ts. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { SESSION_SECRET, runCli, serveApi } from './appApiCli.js';
import { SHOP_TABLES, writeShopApp } from './appApiShop.js';

const storeId = '6c2e1d63-8d2f-4d66-8f1b-5b4f4f1d3e22';

async function shop(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-writes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(SHOP_TABLES);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  await provisionStores({ sqlite: business }, { app: { id: 'shop', source: 'business' } });
  const { appDir, config, commands } = writeShopApp(directory, { business, authStore: authPath });
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
    for (const role of ['operator', 'editor', 'auditor']) {
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run(role, role, `${role}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', role);
    }
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'shop', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  const tokens: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    const issue = (role: string, operations?: readonly string[]) =>
      issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        {
          storeId,
          exclusions,
          subjectId: role,
          actorId: role,
          roles: [role],
          label: role,
          expiresAt: Date.now() + 600000,
          ...(operations ? { operations } : {}),
        },
        Date.now(),
      ).token;
    tokens.operator = issue('operator');
    tokens.editor = issue('editor');
    tokens.auditor = issue('auditor');
    tokens.readsOnly = issue('operator', ['item:item', 'list:item']);
    tokens.renamedOnly = issue('auditor', ['event:ticket.renamed']);
  } finally {
    await registry.closeAll();
  }
  const row = (sql: string) => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return { ...check.prepare(sql).get() };
    } finally {
      check.close();
    }
  };
  return { directory, appDir, business, authPath, config, commands, tokens, row };
}

const json = { 'content-type': 'application/json' };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("generic writes: create, update and delete run as commands under the role's own editor rules", { timeout: 120000 }, async (t) => {
  const f = await shop(t);
  const s = await serveApi(t, f, 'shop');
  await s.started;
  const operator = auth(f.tokens.operator);
  // OpenAPI names the three writes on the command routes; a read-only token sees none.
  const paths = Object.keys((await (await fetch(`${s.base}/$openapi`, { headers: operator })).json()).paths);
  for (const path of ['/item/commands/create-item/v1', '/item/{id}/commands/update-item/v1', '/item/{id}/commands/delete-item/v1']) {
    assert.ok(paths.includes(path), JSON.stringify(paths));
  }
  const narrowed = Object.keys((await (await fetch(`${s.base}/$openapi`, { headers: auth(f.tokens.readsOnly) })).json()).paths);
  assert.ok(
    narrowed.every((path) => !path.includes('/commands/')),
    JSON.stringify(narrowed),
  );
  // Create: an Idempotency-Key, no If-Match; the key comes back, and a retry replays.
  const create = () =>
    fetch(`${s.base}/item/commands/create-item/v1`, {
      method: 'POST',
      headers: { ...operator, ...json, 'idempotency-key': 'create-attempt-00000001' },
      body: JSON.stringify({ name: 'Two' }),
    });
  const created = await create(),
    body = await created.json();
  assert.equal(created.status, 200, JSON.stringify(body));
  assert.equal(body.receipt.replayed, false);
  const id = String(body.result.key.id);
  const replay = await create();
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal((await replay.json()).receipt.id, body.receipt.id);
  assert.deepEqual(f.row(`SELECT COUNT(*) AS n FROM item`), { n: 2 });
  // A create that names a field outside the role's write ceiling is the UI's refusal: 403, nothing applied.
  const ceiling = await fetch(`${s.base}/item/commands/create-item/v1`, {
    method: 'POST',
    headers: { ...operator, ...json, 'idempotency-key': 'create-attempt-00000002' },
    body: JSON.stringify({ name: 'Three', note: 'x' }),
  });
  const refusal = await ceiling.json();
  assert.equal(ceiling.status, 403, JSON.stringify(refusal));
  assert.equal(refusal.outcome, 'not_applied');
  // Update: the version comes from prepare, as for any targeted command.
  const prepared = await fetch(`${s.base}/item/${id}/commands/update-item/v1/prepare`, { headers: operator });
  assert.equal(prepared.status, 200);
  const etag = prepared.headers.get('etag')!;
  assert.ok(etag);
  const update = (key: string, values: object, version = etag) =>
    fetch(`${s.base}/item/${id}/commands/update-item/v1`, {
      method: 'POST',
      headers: { ...operator, ...json, 'if-match': version, 'idempotency-key': key },
      body: JSON.stringify(values),
    });
  const denied = await update('update-attempt-00000001', { note: 'hidden' });
  assert.equal(denied.status, 403);
  await denied.body?.cancel();
  const invalid = await update('update-attempt-00000002', { nickname: 'x' });
  assert.equal(invalid.status, 422);
  await invalid.body?.cancel();
  const updated = await update('update-attempt-00000003', { name: 'Deux' });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.deepEqual(f.row(`SELECT name FROM item WHERE id=${Number(id)}`), { name: 'Deux' });
  const stale = await update('update-attempt-00000004', { name: 'Again' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).outcome, 'not_applied');
  // Delete, with a fresh version. As in the UI, deleting needs every field
  // writable: the operator, who writes the name alone, may not; nor a read-only token.
  const fresh = (await fetch(`${s.base}/item/${id}/commands/delete-item/v1/prepare`, { headers: operator })).headers.get('etag')!;
  for (const [token, attempt] of [
    [f.tokens.readsOnly, 'delete-attempt-00000001'],
    [f.tokens.operator, 'delete-attempt-00000002'],
  ]) {
    const forbidden = await fetch(`${s.base}/item/${id}/commands/delete-item/v1`, {
      method: 'POST',
      headers: { ...auth(token), 'if-match': fresh, 'idempotency-key': attempt },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
    await forbidden.body?.cancel();
  }
  const removed = await fetch(`${s.base}/item/${id}/commands/delete-item/v1`, {
    method: 'POST',
    headers: { ...auth(f.tokens.editor), 'if-match': fresh, 'idempotency-key': 'delete-attempt-00000003' },
    body: '{}',
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual(f.row(`SELECT COUNT(*) AS n FROM item`), { n: 1 });
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
});

test(
  'the event feed shows a token only its events, about records its roles read, oldest first behind a cursor',
  { timeout: 120000 },
  async (t) => {
    const f = await shop(t);
    const s = await serveApi(t, f, 'shop');
    await s.started;
    const auditor = auth(f.tokens.auditor);
    const run = async (path: string, key: string, body: object) => {
      const prepared = await fetch(`${s.base}/${path}/prepare`, { headers: auditor });
      assert.equal(prepared.status, 200, await prepared.clone().text());
      const response = await fetch(`${s.base}/${path}`, {
        method: 'POST',
        headers: { ...auditor, ...json, 'if-match': prepared.headers.get('etag')!, 'idempotency-key': key },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
    };
    await run('ticket/1/commands/rename/v1', 'rename-attempt-00000001', { name: 'Uno' });
    await run('vault/1/commands/flag/v1', 'flag-attempt-000000001', {});
    await run('ticket/1/commands/rename/v1', 'rename-attempt-00000002', { name: 'Eins' });
    const feed = async (token: string, query = '') => {
      const response = await fetch(`${s.base}/$events${query}`, { headers: auth(token) });
      return { status: response.status, body: await response.json() };
    };
    // The auditor reads both tables: every event, oldest first, nothing of who did it.
    const all = await feed(f.tokens.auditor);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(
      all.body.items.map((item: { name: string }) => item.name),
      ['ticket.renamed', 'vault.flagged', 'ticket.renamed'],
    );
    assert.deepEqual(all.body.items[0].payload, { id: 1, name: 'Uno' });
    assert.deepEqual(Object.keys(all.body.items[0]).sort(), ['id', 'key', 'name', 'occurredAt', 'payload', 'resource']);
    // The operator's token holds both event operations, but its role never reads the vault: no flag, not even its key.
    const operator = await feed(f.tokens.operator);
    assert.equal(operator.status, 200);
    assert.deepEqual(
      operator.body.items.map((item: { resource: string }) => item.resource),
      ['ticket', 'ticket'],
    );
    assert.equal(JSON.stringify(operator.body).includes('flagged'), false);
    // A token scoped to one event sees that one only; a token with no event operation is refused.
    const narrowed = await feed(f.tokens.renamedOnly);
    assert.deepEqual(
      narrowed.body.items.map((item: { name: string }) => item.name),
      ['ticket.renamed', 'ticket.renamed'],
    );
    assert.equal((await feed(f.tokens.readsOnly)).status, 403);
    // Paging: one at a time, each cursor past the last, ending where the feed stands.
    const first = await feed(f.tokens.auditor, '?limit=1');
    assert.deepEqual(
      first.body.items.map((item: { id: string }) => item.id),
      [all.body.items[0].id],
    );
    const second = await feed(f.tokens.auditor, `?limit=1&after=${first.body.next}`);
    assert.deepEqual(
      second.body.items.map((item: { id: string }) => item.id),
      [all.body.items[1].id],
    );
    const end = await feed(f.tokens.auditor, `?after=${all.body.next}`);
    assert.deepEqual(end.body, { items: [], next: all.body.next });
    assert.equal((await feed(f.tokens.auditor, '?after=bogus')).status, 400);
    assert.equal((await feed(f.tokens.auditor, '?limit=201')).status, 400);
    assert.equal((await feed(f.tokens.auditor, '?since=1')).status, 400);
    // The operator's whole document, without a server: the same feed channel.
    const exported = await runCli([
      '--app',
      f.appDir,
      '--config',
      f.config,
      '--commands',
      f.commands,
      '--export',
      'asyncapi',
      '--api-integers',
      'number',
    ]);
    assert.equal(exported.code, 0, exported.err);
    assert.deepEqual(Object.keys(JSON.parse(exported.out).components.messages).sort(), ['event.ticket.renamed', 'event.vault.flagged']);
    // AsyncAPI: a token's document names the feed events it may read, and no webhook or inbound endpoint.
    const document = await (await fetch(`${s.base}/$asyncapi`, { headers: auth(f.tokens.renamedOnly) })).json();
    assert.equal(document.asyncapi, '3.0.0');
    assert.equal(document.channels.events.address, '/api/apps/shop/v1/$events');
    assert.deepEqual(Object.keys(document.components.messages), ['event.ticket.renamed']);
    assert.deepEqual(document.components.schemas['EventPayload_ticket.renamed'], {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 }, name: { type: 'string' } },
      required: ['id', 'name'],
    });
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);
