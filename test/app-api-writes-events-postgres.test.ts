/** Generic writes, the event feed and the AsyncAPI document through the real
 * CLI on PostgreSQL: UUID-owned business and auth databases on the live
 * server, the token store provisioned and tokens issued with the real
 * `api-token` CLI. Skipped unless TABLEWALK_TEST_PG is set; each case drops
 * the databases it creates and kills the processes it starts. The SQLite
 * cases are app-api-writes-events.test.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { serveApi, tokenCli } from './appApiCli.js';
import { SHOP_TABLES, writeShopApp } from './appApiShop.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

async function pgShop(t: TestContext) {
  const module = 'pg';
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  await control.connect();
  const names = ['auth', 'business'].map((kind) => `tw_api_writes_${kind}_${randomUUID().replaceAll('-', '')}`);
  const owned: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-writes-pg-'));
  let business: Client | undefined;
  t.after(async () => {
    await business?.end().catch(() => {});
    for (const name of owned) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await control.end();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const name of names) {
    await control.query(`CREATE DATABASE "${name}"`);
    owned.push(name);
  }
  const [authUrl, businessUrl] = names.map((name) => {
    const url = new URL(LIVE!);
    url.pathname = `/${name}`;
    return url.href;
  });
  business = new pg.default.Client({ connectionString: businessUrl, statement_timeout: 10000 });
  await business.connect();
  await business.query(SHOP_TABLES.replace(/INTEGER PRIMARY KEY/g, 'SERIAL PRIMARY KEY'));
  // Seeded rows took their ids by hand: the sequences start past them.
  for (const table of ['item', 'ticket', 'vault']) await business.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), 1)`);
  await migratePostgresCommandJournal(businessUrl);
  await provisionStores({ postgres: businessUrl }, { app: { id: 'shop', source: 'business' } });
  await migratePostgresAuthStore(authUrl);
  const accounts = new pg.default.Client({ connectionString: authUrl, statement_timeout: 10000 });
  await accounts.connect();
  try {
    for (const role of ['operator', 'editor', 'auditor']) {
      await accounts.query(
        `INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES($1,$1,$2,true,now(),now(),$1,false)`,
        [role, `${role}@example.test`],
      );
    }
  } finally {
    await accounts.end();
  }
  const { appDir, config, commands } = writeShopApp(directory, { business: businessUrl, authStore: authUrl, physical: true });
  writeFileSync(join(appDir, 'authority.lock'), (await loadApp(appDir)).authority!.report);
  const common = ['--app', appDir, '--config', config, '--store-id', randomUUID()];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const issue = async (role: string, operations: readonly string[] = []) => {
    const issued = await tokenCli([
      'issue',
      ...common,
      '--commands',
      commands,
      '--subject',
      role,
      '--actor',
      role,
      '--role',
      role,
      '--label',
      role,
      '--expires-at',
      new Date(Date.now() + 600000).toISOString(),
      ...operations.flatMap((operation) => ['--operation', operation]),
    ]);
    assert.equal(issued.code, 0, issued.err);
    return (JSON.parse(issued.out) as { result: { token: string } }).result.token;
  };
  const connection = business;
  /* A session of its own on either database: one that holds a transaction open while the test goes on. */
  const session = async (kind: 'auth' | 'business') => {
    const client = new pg.default.Client({ connectionString: kind === 'auth' ? authUrl : businessUrl, statement_timeout: 10000 });
    /* The database is dropped WITH (FORCE) after the case, which ends this session if it is still open. */
    client.on('error', () => {});
    await client.connect();
    t.after(() => client.end().catch(() => {}));
    return client;
  };
  return { appDir, config, commands, issue, session, sql: (text: string) => connection.query(text) };
}

const json = { 'content-type': 'application/json' };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test(
  "PostgreSQL: generic writes under the role's editor rules, and a feed that shows a token only what its roles read",
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgShop(t);
    const operator = await f.issue('operator'),
      editor = await f.issue('editor'),
      auditor = await f.issue('auditor');
    const s = await serveApi(t, f, 'shop');
    await s.started;
    // Create, replay, a field past the ceiling.
    const create = (token: string, key: string, values: object) =>
      fetch(`${s.base}/item/commands/create-item/v1`, {
        method: 'POST',
        headers: { ...auth(token), ...json, 'idempotency-key': key },
        body: JSON.stringify(values),
      });
    const created = await create(operator, 'pg-create-attempt-0001', { name: 'Two' }),
      body = await created.json();
    assert.equal(created.status, 200, JSON.stringify(body));
    const id = String(body.result.key.id);
    const replay = await create(operator, 'pg-create-attempt-0001', { name: 'Two' });
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    await replay.body?.cancel();
    const ceiling = await create(operator, 'pg-create-attempt-0002', { name: 'Three', note: 'x' });
    assert.equal(ceiling.status, 403);
    await ceiling.body?.cancel();
    assert.equal((await f.sql('SELECT count(*)::int AS n FROM item')).rows[0].n, 2);
    // Update and delete with the version prepare gives.
    const etag = async () =>
      (await fetch(`${s.base}/item/${id}/commands/update-item/v1/prepare`, { headers: auth(operator) })).headers.get('etag')!;
    const version = await etag();
    const update = (key: string) =>
      fetch(`${s.base}/item/${id}/commands/update-item/v1`, {
        method: 'POST',
        headers: { ...auth(operator), ...json, 'if-match': version, 'idempotency-key': key },
        body: JSON.stringify({ name: 'Deux' }),
      });
    assert.equal((await update('pg-update-attempt-0001')).status, 200);
    const stale = await update('pg-update-attempt-0002');
    assert.equal(stale.status, 409);
    await stale.body?.cancel();
    const removed = await fetch(`${s.base}/item/${id}/commands/delete-item/v1`, {
      method: 'POST',
      headers: { ...auth(editor), 'if-match': await etag(), 'idempotency-key': 'pg-delete-attempt-0001' },
      body: '{}',
    });
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal((await f.sql('SELECT count(*)::int AS n FROM item')).rows[0].n, 1);
    // Events: the auditor renames a ticket and flags the vault.
    const run = async (path: string, key: string, values: object) => {
      const prepared = await fetch(`${s.base}/${path}/prepare`, { headers: auth(auditor) });
      const response = await fetch(`${s.base}/${path}`, {
        method: 'POST',
        headers: { ...auth(auditor), ...json, 'if-match': prepared.headers.get('etag')!, 'idempotency-key': key },
        body: JSON.stringify(values),
      });
      assert.equal(response.status, 200, await response.clone().text());
    };
    await run('ticket/1/commands/rename/v1', 'pg-rename-attempt-0001', { name: 'Uno' });
    await run('vault/1/commands/flag/v1', 'pg-flag-attempt-00001', {});
    const feed = async (token: string, query = '') => {
      const response = await fetch(`${s.base}/$events${query}`, { headers: auth(token) });
      return { status: response.status, body: await response.json() };
    };
    const all = await feed(auditor);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(
      all.body.items.map((item: { name: string }) => item.name),
      ['ticket.renamed', 'vault.flagged'],
    );
    const seen = await feed(operator);
    assert.deepEqual(
      seen.body.items.map((item: { name: string }) => item.name),
      ['ticket.renamed'],
    );
    assert.equal(JSON.stringify(seen.body).includes('flagged'), false);
    const first = await feed(auditor, '?limit=1');
    const rest = await feed(auditor, `?after=${first.body.next}`);
    assert.deepEqual(
      [...first.body.items, ...rest.body.items].map((item: { id: string }) => item.id),
      all.body.items.map((item: { id: string }) => item.id),
    );
    /* The feed reads below this database's horizon, not the server's: a transaction held open in another database
       (here the auth store's) writes no batch here and holds nothing back; one held open in this database may still
       commit a batch below the next, so the feed waits for it. */
    const names = async () => (await feed(auditor)).body.items.map((item: { name: string }) => item.name);
    const away = await f.session('auth'),
      here = await f.session('business');
    await away.query('BEGIN');
    await away.query('SELECT pg_current_xact_id()');
    await run('ticket/1/commands/rename/v1', 'pg-rename-attempt-0002', { name: 'Dos' });
    assert.equal((await names()).length, 3, 'shown while another database holds a transaction open');
    await here.query('BEGIN');
    await here.query('SELECT pg_current_xact_id()');
    await run('ticket/1/commands/rename/v1', 'pg-rename-attempt-0003', { name: 'Tres' });
    assert.equal((await names()).length, 3, 'held behind the older transaction open in this database');
    await here.query('ROLLBACK');
    assert.equal((await names()).length, 4, 'shown once that transaction ended');
    await away.query('ROLLBACK');
    const document = await (await fetch(`${s.base}/$asyncapi`, { headers: auth(operator) })).json();
    assert.equal(document.asyncapi, '3.0.0');
    assert.deepEqual(Object.keys(document.components.messages).sort(), ['event.ticket.renamed', 'event.vault.flagged']);
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);
