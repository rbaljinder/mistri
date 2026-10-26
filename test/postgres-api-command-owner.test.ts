/** Genuine isolated PG auth/business composition for the command owner; no
 * HTTP activation. The SQLite owner's contract, delivered by native handoff. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PgConnectionManager, PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { issuePostgresApiCommandToken, revokePostgresApiToken } from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { createPostgresApiCommandOwner } from '../packages/mistri/src/server/api/postgresApiCommandOwner.js';
import { ApiCommandUnauthenticated } from '../packages/mistri/src/server/api/sqliteApiCommandOwner.js';
import { parseApiCommandRoute } from '../packages/mistri/src/server/api/apiCommandRoute.js';
import { createPostgresApiCommandHttp } from '../packages/mistri/src/server/api/postgresApiCommandHttp.js';
import { createPostgresApiReadOwner } from '../packages/mistri/src/server/api/postgresApiReadOwner.js';
import { createAppMcpSession, postgresAppMcpCommands, postgresAppMcpReads } from '../packages/mistri/src/server/api/appMcpSession.js';
import { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { liveSkip } from './live.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
type Owner = Awaited<ReturnType<typeof createPostgresApiCommandOwner>>;
type Sent = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;

let attempt = 0;
const request = (id: number, extra: Record<string, unknown> = {}) => ({
  command: 'change',
  commandVersion: 1,
  key: { id },
  expectedVersion: 0,
  input: {},
  idempotencyKey: `pg-owner-attempt-${String(++attempt).padStart(6, '0')}`,
  ...extra,
});
const recovery = (sent: { command: string; idempotencyKey: string }) => ({
  command: sent.command,
  commandVersion: 1,
  idempotencyKey: sent.idempotencyKey,
});

/* Transport doubles: a real body stream and a response that records what the
   transport wrote. Authority, journal and writer are the fixture's genuine ones. */
function reply() {
  const headers: Record<string, unknown> = {};
  const value = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: 0,
    body: '',
    headers,
    setHeader(name: string, content: unknown) {
      headers[name.toLowerCase()] = content;
    },
    writeHead(status: number, extra: Record<string, unknown> = {}) {
      value.status = status;
      for (const [name, content] of Object.entries(extra)) headers[name.toLowerCase()] = content;
    },
    end(body: string) {
      value.body = body;
      value.writableEnded = true;
    },
  });
  return value;
}
async function httpCall(
  http: ReturnType<typeof createPostgresApiCommandHttp>,
  method: string,
  url: string,
  headers: [string, string][],
  body?: string,
) {
  const all: [string, string][] = [['Host', '127.0.0.1:4111'], ...headers];
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    url,
    method,
    rawHeaders: all.flat(),
    headers: Object.fromEntries(all.map(([name, content]) => [name.toLowerCase(), content])),
    socket: { remoteAddress: '127.0.0.1' },
    aborted: false,
  });
  const res = reply();
  const claimed = await http.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { claimed, status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test(
  'private PG command owner executes, refuses and recovers only inside actual native lifetimes',
  { skip: liveSkip('postgres', LIVE), timeout: 360000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const names = ['auth', 'business'].map((kind) => `tw_command_owner_${kind}_${randomUUID().replaceAll('-', '')}`),
      owned: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'tw-pg-command-owner-')),
      registry = new Registry();
    let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined, db: Client | undefined, accounts: Client | undefined;
    const owners: Owner[] = [];
    try {
      await control.connect();
      for (const name of names) {
        await control.query(`CREATE DATABASE "${name}"`);
        owned.push(name);
      }
      const urls = names.map((name) => {
        const url = new URL(LIVE!);
        url.pathname = '/' + name;
        return url.href;
      });
      db = new pg.default.Client({ connectionString: urls[1], statement_timeout: 10000 });
      await db.connect();
      await db.query(`CREATE TABLE physical_item(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
        INSERT INTO physical_item SELECT n, 0 FROM generate_series(1, 13) AS n`);
      await migratePostgresCommandJournal(urls[1]);
      await migratePostgresAuthStore(urls[0]);
      accounts = new pg.default.Client({ connectionString: urls[0], statement_timeout: 10000 });
      await accounts.connect();
      await accounts.query(`INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES('account','Account','account@example.test',true,now(),now(),'operator',false),
          ('other','Other','other@example.test',true,now(),now(),'operator',false)`);
      const app = parseTestApp(
        {
          id: 'owner',
          name: 'Owner',
          sources: { business: { connection: 'data', default: true } },
          resources: { item: { physical: 'public.physical_item', access: 'write' } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          auth: { store: urls[0], roles: { operator: { read: true, commands: ['change'] } } },
        },
        'fixture',
      );
      // Attached in code: active App files cannot declare command exposure yet.
      app.api = parseTestApi(
        {
          version: 1,
          roles: ['operator'],
          resources: { item: { fields: ['id', 'version'] } },
          commands: [{ id: 'change', version: 1, target: 'item', input: {} }],
        },
        ['operator'],
      )!;
      const hooks = { calls: 0, afterWrite: async () => {}, refusal: undefined as (() => never) | undefined };
      const commands = defineCommands({
        change: defineCommand({
          source: 'business',
          target: 'item',
          input: {},
          output: shape({ ok: bool() }),
          async handle(context) {
            hooks.calls++;
            if (hooks.refusal) hooks.refusal();
            await context.tx.update({
              table: 'item',
              key: { id: Number(context.record.id) },
              values: { version: Number(context.record.version) + 1 },
            });
            await hooks.afterWrite();
            return { ok: true };
          },
        }),
      });
      const loaded = { app, path: join(directory, 'app.ts'), dir: directory, pages: [], sources: {} };
      const envNames = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
      const prior = envNames.map((name) => [name, process.env[name]] as const);
      process.env.BETTER_AUTH_SECRET = 'synthetic-command-owner-secret-at-least-thirty-two-characters';
      delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
      delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      try {
        auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
      } finally {
        for (const [name, value] of prior) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      registry.add({ id: 'data', name: 'data', url: urls[1], source: 'config', writable: true });
      const resources = await loadAppRuntimeResources(registry, { ...app, api: { ...app.api, commands: [] } }, 'data');
      const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
      const storeId = randomUUID(),
        excludeConnections = [{ name: 'data', url: urls[1], source: 'session' as const }];
      await provisionPostgresApiTokenStore(urls[0], { appId: app.id, storeId, excludeConnections });
      const issue = (operations?: readonly string[], subjectId = 'account') =>
        issuePostgresApiCommandToken(
          urls[0],
          app,
          resources.schema,
          commands,
          evidence,
          {
            storeId,
            excludeConnections,
            subjectId,
            actorId: 'account',
            roles: ['operator'],
            label: 'Command fixture',
            expiresAt: Date.now() + 600000,
            ...(operations ? { operations } : {}),
          },
          Date.now,
        );
      const revoke = (tokenId: string) =>
        revokePostgresApiToken(
          urls[0],
          { appId: app.id, storeId, excludeConnections, tokenId, expectedVersion: '1', actorId: 'account' },
          Date.now,
        );
      const host = { app: loaded, auth, pages: [] },
        hosting = { appId: app.id, registry: commands };
      const acquire = async (options: Parameters<typeof createPostgresApiCommandOwner>[3] = {}) => {
        const owner = await createPostgresApiCommandOwner(registry, host, hosting, options);
        owners.push(owner);
        return owner;
      };
      const revision = async (id: number) => (await db!.query('SELECT version FROM physical_item WHERE id=$1', [id])).rows[0].version;
      const receipts = async () =>
        Number((await db!.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', COMMAND_JOURNAL_TABLES.receipt)}`)).rows[0].n);
      // One answer per call, exactly once, or none at all.
      const call = async (owner: Owner, mode: 'execute' | 'recover', credential: unknown, input: unknown, signal?: AbortSignal) => {
        const sent: Sent[] = [];
        const result = await owner[mode](
          credential,
          input,
          (answer) => {
            sent.push(answer);
          },
          signal,
        );
        assert.equal(sent.length, 1);
        return { ...result, status: sent[0].status, headers: sent[0].headers, body: JSON.parse(sent[0].body) };
      };
      const physical = (await registry.open('data')).adapter as PostgresAdapter;
      // The real write client and transaction; an effect runs after COMMIT is acknowledged.
      const afterCommit = (sub: TestContext, effect: () => Promise<void>) => {
        const manager = (physical as unknown as { connections: PgConnectionManager }).connections;
        const original = manager.withWriteClient;
        manager.withWriteClient = function <T>(this: PgConnectionManager, run: (client: PgQuery) => Promise<T>, destroyAfter?: boolean) {
          return original.call(
            this,
            (client) =>
              run({
                query: (async (...args: [string, unknown[]?]) => {
                  const result = await (client.query as (...input: unknown[]) => Promise<unknown>)(...args);
                  if (args[0] === 'COMMIT') await effect();
                  return result;
                }) as PgQuery['query'],
              }),
            destroyAfter,
          );
        } as typeof original;
        sub.after(() => {
          manager.withWriteClient = original;
        });
      };
      const internal = await acquire(),
        token = await issue();

      await t.test('internal wire: account identity executes and recovers across rotation, never token identity', async () => {
        const before = await receipts(),
          sent = request(1);
        const denied = await call(internal, 'execute', (await issue([])).token, sent);
        assert.equal(denied.status, 403);
        assert.deepEqual(denied.body, {
          type: 'urn:mistri:problem:forbidden',
          title: 'This command is not available to this account.',
          status: 403,
          code: 'forbidden',
          outcome: 'not_applied',
        });
        assert.equal(hooks.calls, 0);
        const applied = await call(internal, 'execute', token.token, sent);
        assert.equal(applied.outcome, 'sent');
        assert.equal(applied.stage, 'postgres-command-response');
        assert.equal(applied.body.status, 'applied');
        assert.equal(await revision(1), 1);
        assert.equal(await receipts(), before + 1);
        const rotated = await issue(),
          retired = await issue();
        await revoke(retired.tokenId);
        const recovered = await call(internal, 'recover', rotated.token, recovery(sent));
        assert.equal(recovered.body.receiptId, applied.body.receiptId);
        assert.equal(recovered.body.recovered, true);
        assert.equal(hooks.calls, 1);
        const absent = await call(internal, 'recover', (await issue(undefined, 'other')).token, recovery(sent));
        assert.deepEqual(absent.body, { outcome: 'unknown', status: 'not_found' });
        await assert.rejects(
          internal.execute(retired.token, request(1), () => {}),
          ApiCommandUnauthenticated,
        );
      });

      await t.test('api-v1 wire: receipt envelopes, the replay header, recovery targets, a 404 unknown and route mapping', async () => {
        const owner = await acquire({ wire: 'api-v1', integers: 'decimal-string' }),
          sent = request(2),
          start = hooks.calls;
        const fresh = await call(owner, 'execute', token.token, sent);
        assert.equal(fresh.status, 200);
        assert.deepEqual(fresh.headers, {});
        assert.deepEqual(Object.keys(fresh.body).sort(), ['receipt', 'result']);
        assert.deepEqual(fresh.body.result, { ok: true });
        assert.equal(fresh.body.receipt.status, 'applied');
        assert.equal(fresh.body.receipt.replayed, false);
        const replay = await call(owner, 'execute', token.token, sent);
        assert.deepEqual(replay.headers, { 'idempotent-replayed': 'true' });
        assert.deepEqual(replay.body, { receipt: { ...fresh.body.receipt, replayed: true }, result: { ok: true } });
        assert.equal(hooks.calls, start + 1);
        const recovered = await call(owner, 'recover', token.token, recovery(sent));
        assert.deepEqual(recovered.body, {
          receipt: { id: fresh.body.receipt.id, status: 'applied', recovered: true },
          targets: [{ id: '2' }],
          result: { ok: true },
        });
        const absent = await call(owner, 'recover', (await issue(undefined, 'other')).token, recovery(sent));
        assert.equal(absent.status, 404);
        assert.deepEqual(absent.body, {
          type: 'urn:mistri:problem:not_found',
          title: 'The record was not found.',
          status: 404,
          code: 'not_found',
          outcome: 'unknown',
        });
        const next = request(3),
          envelope = owner.map(
            parseApiCommandRoute('/api/apps/owner/v1/item/3/commands/change/v1'),
            { expectedVersion: 0, idempotencyKey: next.idempotencyKey },
            {},
          );
        assert.deepEqual(envelope, {
          command: 'change',
          commandVersion: 1,
          key: { id: '3' },
          expectedVersion: 0,
          idempotencyKey: next.idempotencyKey,
          input: {},
        });
        assert.equal((await call(owner, 'execute', token.token, envelope)).status, 200);
        assert.equal(await revision(3), 1);
        assert.throws(
          () =>
            internal.map(
              parseApiCommandRoute('/api/apps/owner/v1/item/3/commands/change/v1'),
              { expectedVersion: 0, idempotencyKey: next.idempotencyKey },
              {},
            ),
          { outcome: 'unknown' },
        );
        // The composed document, narrowed by the token's fresh operations, is
        // delivered through the same native handoff.
        const specs: Sent[] = [];
        assert.deepEqual(
          await owner.readSpec((await issue(['command:change'])).token, (answer) => {
            specs.push(answer);
          }),
          { stage: 'postgres-command-response', outcome: 'sent' },
        );
        const narrowed = JSON.parse(specs[0].body);
        assert.equal(narrowed['x-mistri-document'], 'app-api');
        assert.ok(Object.keys(narrowed.paths).length > 0 && Object.keys(narrowed.paths).every((path) => path.includes('/commands/')));
        await assert.rejects(
          internal.readSpec(token.token, () => {}),
          { outcome: 'unknown' },
        );
      });

      await t.test('input, revision, idempotency, exposure and handler refusals map to the design statuses', async () => {
        const before = await receipts(),
          start = hooks.calls;
        const problem = async (input: unknown) => {
          const answer = await call(internal, 'execute', token.token, input);
          return { status: answer.status, ...answer.body };
        };
        const invalid = await problem(request(4, { input: { extra: 1 } }));
        assert.equal(invalid.status, 422);
        assert.equal(invalid.code, 'invalid_input');
        assert.equal(invalid.outcome, 'not_applied');
        const stale = await problem(request(4, { expectedVersion: 5 }));
        assert.equal(stale.status, 409);
        assert.equal(stale.code, 'stale_record');
        const unexposed = await problem(request(4, { command: 'missing' }));
        assert.equal(unexposed.status, 404);
        assert.equal(unexposed.code, 'not_found');
        assert.equal(hooks.calls, start);
        const sent = request(4);
        await call(internal, 'execute', token.token, sent);
        const conflict = await problem({ ...sent, expectedVersion: 1 });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.code, 'idempotency_conflict');
        hooks.refusal = () => refuse('ineligible_state', { field: 'reason', key: { id: 99 } });
        try {
          const refused = await problem(request(5));
          // Refused inside the verified transaction and rolled back: not_applied.
          assert.deepEqual(refused, {
            status: 409,
            type: 'urn:mistri:problem:ineligible_state',
            title: 'This record is not eligible for this command.',
            code: 'ineligible_state',
            outcome: 'not_applied',
            field: 'reason',
          });
        } finally {
          hooks.refusal = undefined;
        }
        assert.equal(await revision(4), 1);
        assert.equal(await revision(5), 0);
        assert.equal(await receipts(), before + 1);
      });

      for (const change of ['revocation', 'demotion'] as const) {
        await t.test(`final native ${change} before COMMIT rolls back record and receipt, and sends nothing`, async () => {
          const dedicated = await issue(),
            before = await receipts();
          hooks.afterWrite = async () => {
            if (change === 'revocation') await revoke(dedicated.tokenId);
            else await accounts!.query(`UPDATE mistri.auth_user SET role='removed' WHERE id='account'`);
          };
          let sends = 0;
          try {
            await assert.rejects(
              internal.execute(dedicated.token, request(6), () => {
                sends++;
              }),
              { outcome: 'unknown' },
            );
          } finally {
            hooks.afterWrite = async () => {};
            await accounts!.query(`UPDATE mistri.auth_user SET role='operator' WHERE id='account'`);
          }
          assert.equal(sends, 0);
          assert.equal(await revision(6), 0);
          assert.equal(await receipts(), before);
        });
      }

      await t.test('revocation after COMMIT never claims rollback and never sends the stale answer', async (sub) => {
        const dedicated = await issue(),
          before = await receipts();
        let armed = true;
        afterCommit(sub, async () => {
          if (armed) {
            armed = false;
            await revoke(dedicated.tokenId);
          }
        });
        let sends = 0;
        await assert.rejects(
          internal.execute(dedicated.token, request(7), () => {
            sends++;
          }),
          { outcome: 'unknown' },
        );
        assert.equal(armed, false);
        assert.equal(sends, 0);
        assert.equal(await revision(7), 1);
        assert.equal(await receipts(), before + 1);
      });

      await t.test('a transport failure after entry is uncertainty, never a retry; invalid callbacks refuse first', async () => {
        const start = hooks.calls;
        for (const send of [async () => {}, function* () {}, new Proxy(() => {}, {})]) {
          await assert.rejects(internal.execute(token.token, request(8), send as never), { outcome: 'unknown' });
        }
        assert.equal(hooks.calls, start);
        let sends = 0;
        const thrown = await internal.execute(token.token, request(8), () => {
          sends++;
          throw new Error('socket closed');
        });
        assert.deepEqual(thrown, { stage: 'postgres-command-response', outcome: 'uncertain' });
        const valued = await internal.execute(token.token, request(9), (() => {
          sends++;
          return 1;
        }) as never);
        assert.deepEqual(valued, { stage: 'postgres-command-response', outcome: 'uncertain' });
        assert.equal(sends, 2);
        assert.equal(await revision(8), 1);
        assert.equal(await revision(9), 1);
      });

      await t.test('an unusable credential is the one owner refusal a transport may answer as unauthenticated', async () => {
        const start = hooks.calls,
          before = await receipts();
        for (const credential of ['not-a-token', '', undefined]) {
          await assert.rejects(
            internal.execute(credential, request(10), () => {}),
            ApiCommandUnauthenticated,
          );
          await assert.rejects(
            internal.recover(credential, recovery(request(10)), () => {}),
            ApiCommandUnauthenticated,
          );
        }
        assert.equal(hooks.calls, start);
        assert.equal(await receipts(), before);
      });

      await t.test('cancellation drains the writer and lease, rolls back, and leaves the owner to siblings', async (sub) => {
        const before = await receipts(),
          start = hooks.calls;
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(internal.execute(token.token, request(11), () => {}, aborted.signal));
        assert.equal(hooks.calls, start);
        let leases = 0;
        const lease = registry.lease.bind(registry);
        sub.mock.method(registry, 'lease', (...args: Parameters<typeof lease>) => {
          leases++;
          const release = lease(...args);
          return () => {
            leases--;
            release();
          };
        });
        let entered!: () => void, resume!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            resume = resolve;
          });
        hooks.afterWrite = async () => {
          entered();
          await gate;
        };
        const controller = new AbortController();
        let settled = false,
          sends = 0;
        const work = internal.execute(
          token.token,
          request(11),
          () => {
            sends++;
          },
          controller.signal,
        );
        const rejected = assert.rejects(work).then(() => {
          settled = true;
        });
        try {
          await started;
          controller.abort();
          await Promise.resolve();
          assert.equal(settled, false);
          assert.equal(leases, 1);
        } finally {
          hooks.afterWrite = async () => {};
          resume();
        }
        await rejected;
        assert.equal(leases, 0);
        assert.equal(sends, 0);
        assert.equal(await revision(11), 0);
        assert.equal(await receipts(), before);
        assert.equal((await call(internal, 'execute', token.token, request(11))).body.status, 'applied');
        assert.equal(await revision(11), 1);
      });

      await t.test('retirement drains an active writer; the wire shape is a construction choice', async () => {
        const owner = await acquire();
        let entered!: () => void, resume!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            resume = resolve;
          });
        hooks.afterWrite = async () => {
          entered();
          await gate;
        };
        const rejected = assert.rejects(owner.execute(token.token, request(12), () => {}));
        let done = false;
        try {
          await started;
          const retired = owner.retire().then(() => {
            done = true;
          });
          await Promise.resolve();
          assert.equal(done, false);
          resume();
          await rejected;
          await retired;
        } finally {
          hooks.afterWrite = async () => {};
          resume();
        }
        assert.equal(await revision(12), 0);
        await assert.rejects(owner.execute(token.token, request(12), () => {}));
        for (const options of [
          { wire: 'api-v2' },
          { wire: 1 },
          Object.defineProperty({}, 'wire', { enumerable: true, get: () => 'api-v1' }),
          new Proxy({}, {}),
          { wire: 'api-v1' },
          { wire: 'api-v1', integers: 'float' },
          { wire: 'internal', integers: 'number' },
        ]) {
          await assert.rejects(createPostgresApiCommandOwner(registry, host, hosting, options as never));
        }
      });

      await t.test(
        'command transport over the PG owner: bearer execute, replay, recovery, problems and post-COMMIT revocation',
        async (sub) => {
          const http = createPostgresApiCommandHttp(registry, host, hosting, {
            bound: { host: '127.0.0.1', port: 4111 },
            integers: 'decimal-string',
            requestsPerMinute: 1000,
          });
          sub.after(() => http.retire());
          const bearer: [string, string] = ['Authorization', `Bearer ${token.token}`];
          const path = '/api/apps/owner/v1/item/13/commands/change/v1';
          const fresh = await httpCall(
            http,
            'POST',
            path,
            [bearer, ['If-Match', '"0"'], ['Idempotency-Key', 'pg-transport-attempt-01']],
            '{}',
          );
          assert.equal(fresh.claimed, true);
          assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
          assert.match(String(fresh.headers['content-type']), /^application\/json/);
          assert.equal(fresh.headers['cache-control'], 'no-store');
          assert.equal(fresh.body.receipt.replayed, false);
          assert.deepEqual(fresh.body.result, { ok: true });
          const replay = await httpCall(
            http,
            'POST',
            path,
            [bearer, ['If-Match', '"0"'], ['Idempotency-Key', 'pg-transport-attempt-01']],
            '{}',
          );
          assert.equal(replay.status, 200);
          assert.equal(replay.headers['idempotent-replayed'], 'true');
          const recovered = await httpCall(http, 'GET', '/api/apps/owner/v1/commands/change/v1/receipts/pg-transport-attempt-01', [bearer]);
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body, {
            receipt: { id: fresh.body.receipt.id, status: 'applied', recovered: true },
            targets: [{ id: '13' }],
            result: { ok: true },
          });
          const next: [string, string] = ['Idempotency-Key', 'pg-transport-attempt-02'];
          let answer = await httpCall(http, 'POST', path, [['If-Match', '"1"'], next], '{}');
          assert.equal(answer.status, 401);
          assert.equal(answer.headers['www-authenticate'], 'Bearer');
          answer = await httpCall(http, 'POST', path, [['Authorization', 'Bearer not-a-token'], ['If-Match', '"1"'], next], '{}');
          assert.equal(answer.status, 401);
          answer = await httpCall(http, 'POST', path, [bearer, ['If-Match', '"5"'], next], '{}');
          assert.equal(answer.status, 409);
          assert.equal(answer.body.code, 'stale_record');
          assert.match(String(answer.headers['content-type']), /^application\/problem\+json/);
          answer = await httpCall(
            http,
            'POST',
            '/api/apps/owner/v1/item/13/commands/missing/v1',
            [bearer, ['If-Match', '"1"'], next],
            '{}',
          );
          assert.equal(answer.status, 404);
          const spec = await httpCall(http, 'GET', '/api/apps/owner/v1/$openapi', [bearer]);
          assert.equal(spec.status, 200);
          assert.equal(spec.body['x-mistri-document'], 'app-api');
          assert.ok(Object.keys(spec.body.paths).some((path) => path.includes('/commands/change/')));
          assert.ok(Object.keys(spec.body.paths).some((path) => !path.includes('/commands/')));
          // Revoked after COMMIT: no stale answer is written, and the outcome stays unknown.
          const dedicated = await issue();
          let armed = true;
          afterCommit(sub, async () => {
            if (armed) {
              armed = false;
              await revoke(dedicated.tokenId);
            }
          });
          answer = await httpCall(
            http,
            'POST',
            path,
            [
              ['Authorization', `Bearer ${dedicated.token}`],
              ['If-Match', '"1"'],
              ['Idempotency-Key', 'pg-transport-attempt-03'],
            ],
            '{}',
          );
          assert.equal(armed, false);
          assert.equal(answer.status, 503);
          assert.equal(answer.body.outcome, 'unknown');
          assert.equal(await revision(13), 2);
          const unclaimed = await httpCall(http, 'GET', '/api/apps/owner/v1/item', [bearer]);
          assert.equal(unclaimed.claimed, false);
          assert.equal(unclaimed.status, 0);
        },
      );

      await t.test('a PG read owner serves the read half of the command-exposing App to command-issued tokens', async (sub) => {
        const reader = await createPostgresApiReadOwner(registry, host, 'decimal-string');
        sub.after(() => reader.retire());
        const sent: { status: number; body: string }[] = [];
        assert.deepEqual(
          await reader.readItem(token.token, 'item:item', '1', (answer) => {
            sent.push(answer);
          }),
          { stage: 'postgres-read-response', outcome: 'sent' },
        );
        assert.equal(sent.length, 1);
        assert.equal(sent[0].status, 200);
        assert.deepEqual(JSON.parse(sent[0].body), { id: '1', version: '1' });
        // A token scoped to the command alone observes no read operation here.
        await assert.rejects(
          reader.readItem((await issue(['command:change'])).token, 'item:item', '1', () => {}),
          { code: 'forbidden' },
        );
        // The composed document is the command transport's, never a read-only half.
        await assert.rejects(
          reader.readSpec(token.token, () => {}),
          { code: 'temporarily_unavailable' },
        );
      });

      await t.test('App MCP session over the PG read owner: narrowed discovery, calls written inside the handoff', async (sub) => {
        const reader = await createPostgresApiReadOwner(registry, host, 'decimal-string');
        sub.after(() => reader.retire());
        const session = async (credential: string, messages: Record<string, unknown>[]) => {
          const input = new PassThrough(),
            written: string[] = [];
          const running = createAppMcpSession({
            input,
            output: {
              write: (chunk: string) => {
                written.push(chunk);
                return true;
              },
            },
            credential,
            version: 'test',
            app,
            schema: resources.schema,
            integers: 'decimal-string',
            deliver: postgresAppMcpReads(reader),
          });
          for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
          input.end();
          await running.done;
          const text = written.join('');
          return {
            text,
            replies: text
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          };
        };
        const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });
        const listed = await session(token.token, [rpc(1, 'initialize'), rpc(2, 'tools/list')]);
        assert.equal(listed.replies[0].result.protocolVersion, '2025-11-25');
        const tools = listed.replies[1].result.tools as { name: string }[];
        assert.equal(tools.length, 2);
        const get = tools.find((tool) => tool.name.startsWith('get_'))!.name,
          list = tools.find((tool) => tool.name.startsWith('list_'))!.name;
        const called = await session(token.token, [
          rpc(3, 'tools/call', { name: get, arguments: { id: '1' } }),
          rpc(4, 'tools/call', { name: list, arguments: { limit: 2 } }),
        ]);
        assert.equal(called.replies[0].result.isError, false);
        assert.equal(called.replies[0].result.structuredContent.id, '1');
        assert.equal(called.replies[1].result.structuredContent.items.length, 2);
        const commandOnly = (await issue(['command:change'])).token;
        const narrowed = await session(commandOnly, [rpc(5, 'tools/list'), rpc(6, 'tools/call', { name: get, arguments: { id: '1' } })]);
        assert.deepEqual(narrowed.replies[0].result.tools, []);
        assert.deepEqual(JSON.parse(narrowed.replies[1].result.content[0].text), { error: { code: 'forbidden' } });
        // Revoked after a listing: the next call refuses, nothing stale is written.
        const dedicated = await issue();
        assert.equal((await session(dedicated.token, [rpc(7, 'tools/list')])).replies[0].result.tools.length, 2);
        await revoke(dedicated.tokenId);
        const revoked = await session(dedicated.token, [rpc(8, 'tools/call', { name: get, arguments: { id: '1' } })]);
        assert.deepEqual(JSON.parse(revoked.replies[0].result.content[0].text), { error: { code: 'unauthenticated' } });
        for (const output of [listed.text, called.text, narrowed.text, revoked.text]) {
          assert.equal(output.includes(token.token) || output.includes(commandOnly) || output.includes(dedicated.token), false);
        }
      });

      await t.test(
        'App MCP command tools over the PG owners: run once under a key, replay, recover and refuse through the handoff',
        async (sub) => {
          const reader = await createPostgresApiReadOwner(registry, host, 'decimal-string');
          const owner = await acquire({ wire: 'api-v1', integers: 'decimal-string' });
          sub.after(() => reader.retire());
          const session = async (messages: Record<string, unknown>[]) => {
            const input = new PassThrough(),
              written: string[] = [];
            const running = createAppMcpSession({
              input,
              output: {
                write: (chunk: string) => {
                  written.push(chunk);
                  return true;
                },
              },
              credential: token.token,
              version: 'test',
              app,
              schema: resources.schema,
              integers: 'decimal-string',
              deliver: postgresAppMcpReads(reader),
              commands: { registry: commands, evidence, deliver: postgresAppMcpCommands(owner) },
            });
            for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
            input.end();
            await running.done;
            return written
              .join('')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
          };
          const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });
          const names = ((await session([rpc(1, 'tools/list')]))[0].result.tools as { name: string }[]).map((tool) => tool.name);
          const run = names.find((name) => name.startsWith('run_change_'))!,
            recover = names.find((name) => name.startsWith('recover_change_'))!;
          assert.ok(run && recover && names.some((name) => name.startsWith('get_')), JSON.stringify(names));
          const prepare = names.find((name) => name.startsWith('prepare_change_'))!;
          const beforePrepare = await receipts(),
            beforeCalls = hooks.calls;
          const prepared = (await session([rpc(10, 'tools/call', { name: prepare, arguments: { key: { id: '12' } } })]))[0].result;
          assert.equal(prepared.isError, false);
          assert.deepEqual(prepared.structuredContent, { version: 0 });
          assert.equal(await receipts(), beforePrepare);
          assert.equal(hooks.calls, beforeCalls);
          const before = await receipts(),
            start = hooks.calls,
            key = 'pg-mcp-attempt-00001';
          const replies = await session([
            rpc(2, 'tools/call', { name: run, arguments: { key: { id: '12' }, version: 0, idempotencyKey: key, input: {} } }),
            rpc(3, 'tools/call', { name: run, arguments: { key: { id: '12' }, version: 0, idempotencyKey: key, input: {} } }),
            rpc(4, 'tools/call', {
              name: run,
              arguments: { key: { id: '12' }, version: 7, idempotencyKey: 'pg-mcp-attempt-00002', input: {} },
            }),
            rpc(5, 'tools/call', { name: recover, arguments: { idempotencyKey: key } }),
          ]);
          const byId = new Map(replies.map((reply) => [reply.id, reply.result]));
          assert.equal(byId.get(2).structuredContent.receipt.replayed, false);
          assert.equal(byId.get(3).structuredContent.receipt.replayed, true);
          assert.equal(hooks.calls, start + 1);
          assert.equal(await revision(12), 1);
          assert.equal(await receipts(), before + 1);
          assert.equal(JSON.parse(byId.get(4).content[0].text).code, 'stale_record');
          assert.equal(byId.get(5).structuredContent.receipt.recovered, true);
          assert.deepEqual(byId.get(5).structuredContent.targets, [{ id: '12' }]);
        },
      );
    } finally {
      await Promise.allSettled(owners.map((owner) => owner.retire()));
      await auth?.close();
      await registry.closeAll();
      await db?.end();
      await accounts?.end();
      for (const name of owned) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
