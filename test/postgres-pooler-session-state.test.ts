/**
 * What the platform sets on a PostgreSQL session, behind a pooler
 * (TABLEWALK_TEST_PG): the authentication store, startup's separation check
 * and the migration tables' readers.
 *
 * Better Auth names its tables unqualified, so the store's schema has to be on
 * the search path of every statement it sends. A pooler does not carry a
 * startup `options` parameter to the server (PgBouncer refuses it or, with
 * `ignore_startup_parameters = options`, drops it), nor most other startup
 * parameters (`statement_timeout` among them, which node-postgres sends when a
 * client is configured with one); and a transaction-mode one hands each
 * transaction to whichever server connection is free, so a session `SET`
 * lands on one server connection and stays there for the pooler's next
 * client. The proxy here is that pooler's front door: it refuses the startup
 * parameters PgBouncer refuses, drops `options` as PgBouncer configured to
 * tolerate it does, and records every statement a client sends, so the test
 * sees what would reach a pooled server connection.
 */
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { configurePostgresPools, type PgPool } from '../packages/engine/src/adapters/postgresPool.js';
import { openMigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { migratePostgresAuthStore, withPostgresAuthModels } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { accountAuditPlugin } from '../packages/mistri/src/server/auth/accountAudit.js';
import { openPostgresAuthStore } from '../packages/mistri/src/server/auth/authStore.js';
import { assertPostgresAuthStoreServerSeparation } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { identityStorePlugin } from '../packages/mistri/src/server/auth/identityStore.js';
import { liveSkip } from './live.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);

/* What PgBouncer passes to the server from a startup packet by default. Any
   other parameter is refused, except those `ignore_startup_parameters` names,
   which are dropped: `options`, here, as a deployment that tolerates it does. */
const PASSED = new Set(['user', 'database', 'application_name', 'client_encoding', 'DateStyle', 'TimeZone', 'standard_conforming_strings']);
const IGNORED = new Set(['options']);

/** The startup packet as the pooler would send it on, or the parameter it refuses. */
function startup(packet: Buffer): { packet: Buffer } | { refused: string } {
  const pairs: Buffer[] = [];
  let at = 8;
  while (at < packet.length - 1) {
    const keyEnd = packet.indexOf(0, at),
      valueEnd = packet.indexOf(0, keyEnd + 1);
    const key = packet.subarray(at, keyEnd).toString();
    if (PASSED.has(key)) pairs.push(packet.subarray(at, valueEnd + 1));
    else if (!IGNORED.has(key)) return { refused: key };
    at = valueEnd + 1;
  }
  const body = Buffer.concat([packet.subarray(4, 8), ...pairs, Buffer.from([0])]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return { packet: Buffer.concat([length, body]) };
}

/** A FATAL ErrorResponse, as PgBouncer answers a parameter it does not support. */
function fatal(message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C08P01\0M${message}\0\0`);
  const head = Buffer.alloc(5);
  head.write('E');
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

async function pooler(t: TestContext, target: string) {
  const upstream = new URL(target);
  const statements: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const server = connect(Number(upstream.port || 5432), upstream.hostname);
    sockets.add(client).add(server);
    let buffer = Buffer.alloc(0),
      started = false;
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
          const packet = buffer.subarray(0, buffer.readInt32BE(0));
          buffer = buffer.subarray(packet.length);
          started = true;
          const passed = startup(packet);
          if ('refused' in passed) {
            client.end(fatal(`unsupported startup parameter: ${passed.refused}`));
            return;
          }
          server.write(passed.packet);
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const message = buffer.subarray(0, buffer.readInt32BE(1) + 1);
        buffer = buffer.subarray(message.length);
        const type = String.fromCharCode(message[0]);
        if (type === 'Q') statements.push(message.subarray(5, message.length - 1).toString());
        if (type === 'P') {
          const name = message.indexOf(0, 5);
          statements.push(message.subarray(name + 1, message.indexOf(0, name + 1)).toString());
        }
        server.write(message);
      }
    });
    server.pipe(client);
    const end = () => {
      client.destroy();
      server.destroy();
    };
    client.on('error', end).on('close', end);
    server.on('error', end).on('close', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(target);
  url.host = `127.0.0.1:${address.port}`;
  return { url: url.href, statements };
}

/** What Better Auth's Kysely adapter sends: unqualified names (its models' PostgreSQL ones), and a transaction as `begin` … `commit` on one client. */
async function asBetterAuth(pool: PgPool) {
  const users = await pool.query('select count(*)::int as n from "auth_user"');
  assert.deepEqual(users.rows, [{ n: 0 }]);
  const client = await pool.connect();
  try {
    await client.query('begin', []);
    await client.query('select "id" from "auth_session" where "token" = $1', ['none']);
    await client.query('select "id" from "auth_verification" where "identifier" = $1', ['none']);
    await client.query('commit', []);
  } finally {
    client.release();
  }
  // pg-pool's own pool.query, which leases a client and hands it a callback.
  await new Promise<void>((resolve, reject) => {
    (pool as unknown as { query(text: string, cb: (error: Error | null) => void): void }).query(
      'select 1 from "auth_account" limit 1',
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/** Better Auth itself, on the pool it is handed: an account made, then signed in to. */
async function signsIn(pool: PgPool, email: string) {
  const { betterAuth } = await import('better-auth');
  const { admin } = await import('better-auth/plugins');
  const auth = betterAuth(
    withPostgresAuthModels({
      database: pool,
      emailAndPassword: { enabled: true },
      plugins: [admin({ defaultRole: 'user' }), accountAuditPlugin(), identityStorePlugin()],
      secret: 'synthetic-auth-pooler-secret-at-least-thirty-two-characters',
      baseURL: 'http://127.0.0.1:1',
      telemetry: { enabled: false },
    }) as never,
  ) as unknown as {
    api: {
      signUpEmail(input: unknown): Promise<{ user: { id: string } }>;
      signInEmail(input: unknown): Promise<{ user: { id: string } }>;
    };
  };
  const body = { email, password: 'pooler-account-password-123', name: 'Pooler' };
  const made = await auth.api.signUpEmail({ body });
  assert.equal((await auth.api.signInEmail({ body: { email: body.email, password: body.password } })).user.id, made.user.id);
}

for (const mode of ['session', 'transaction'] as const) {
  test(
    `behind a ${mode}-mode pooler, the store's checks connect and Better Auth's unqualified names resolve in its schema`,
    { skip },
    async (t) => {
      const database = await uuidPostgresDatabase('tw_auth_pooler');
      t.after(() => database.drop());
      await migratePostgresAuthStore(database.url);
      configurePostgresPools({ pooler: mode });
      t.after(() => configurePostgresPools({}));
      const front = await pooler(t, database.url);
      const handle = await openPostgresAuthStore(front.url);
      t.after(() => handle.close());
      // Startup's separation check dials each business connection through the same pooler.
      const business = await uuidPostgresDatabase('tw_auth_pooler_app');
      t.after(() => business.drop());
      const app = await pooler(t, business.url);
      await assertPostgresAuthStoreServerSeparation(handle.database as PgPool, [{ url: app.url }]);
      await asBetterAuth(handle.database as PgPool);
      await signsIn(handle.database as PgPool, `pooler-${mode}@example.test`);
      if (mode === 'transaction') {
        // Nothing is set on a session a pooler would hand to its next client.
        const session = front.statements.filter((text) => /(^|;)\s*SET\s+(?!LOCAL\b|TRANSACTION\b)/i.test(text));
        assert.deepEqual(session, []);
        assert.ok(front.statements.some((text) => /SET LOCAL search_path/i.test(text)));
        assert.ok(front.statements.some((text) => /SET LOCAL statement_timeout/i.test(text)));
      }
    },
  );
}

test(
  'behind a transaction-mode pooler the migration tables are read with nothing set on the session, and a migration lock refuses',
  { skip },
  async (t) => {
    const database = await uuidPostgresDatabase('tw_migrate_pooler');
    t.after(() => database.drop());
    const front = await pooler(t, database.url);
    const session = await openMigrationDb(front.url, [], false);
    await session.close();
    assert.ok(
      front.statements.some((text) => /^SET lock_timeout/i.test(text)),
      'on a session of its own a migration bounds its lock wait',
    );
    front.statements.length = 0;
    configurePostgresPools({ pooler: 'transaction' });
    t.after(() => configurePostgresPools({}));
    const db = await openMigrationDb(front.url, [], false);
    try {
      assert.deepEqual(await db.all('SELECT 1 AS one'), [{ one: 1 }]);
      await assert.rejects(
        db.lock('flyway_schema_history', 1000, () => {}),
        /transaction-mode pooler does not keep/,
      );
    } finally {
      await db.close();
    }
    assert.deepEqual(
      front.statements.filter((text) => /(^|;)\s*SET\s+(?!LOCAL\b|TRANSACTION\b)|advisory_lock/i.test(text)),
      [],
    );
    await assert.rejects(openMigrationDb(front.url, ['app'], false), /transaction-mode pooler does not keep/);
  },
);

/* The same, through a real PgBouncer in transaction mode
   (TABLEWALK_TEST_PGBOUNCER, in front of TABLEWALK_TEST_PG's server, every
   database passed through): what the proxy above models, the pooler itself
   refusing what it refuses. It cannot show the statements, only that nothing
   it would refuse or strand was needed. */
const BOUNCER = process.env.TABLEWALK_TEST_PGBOUNCER;
const bounced = (url: string) => {
  const through = new URL(BOUNCER!);
  through.pathname = new URL(url).pathname;
  return through.href;
};

test(
  'through a real transaction-mode PgBouncer, the store connects, Better Auth signs in, and a migration lock refuses',
  { skip: skip || !BOUNCER },
  async (t) => {
    const database = await uuidPostgresDatabase('tw_auth_bouncer');
    t.after(() => database.drop());
    await migratePostgresAuthStore(database.url);
    configurePostgresPools({ pooler: 'transaction' });
    t.after(() => configurePostgresPools({}));
    const handle = await openPostgresAuthStore(bounced(database.url));
    t.after(() => handle.close());
    const business = await uuidPostgresDatabase('tw_auth_bouncer_app');
    t.after(() => business.drop());
    await assertPostgresAuthStoreServerSeparation(handle.database as PgPool, [{ url: bounced(business.url) }]);
    await asBetterAuth(handle.database as PgPool);
    await signsIn(handle.database as PgPool, 'bouncer@example.test');
    const db = await openMigrationDb(bounced(business.url), [], false);
    try {
      assert.deepEqual(await db.all('SELECT 1 AS one'), [{ one: 1 }]);
      await assert.rejects(
        db.lock('flyway_schema_history', 1000, () => {}),
        /transaction-mode pooler does not keep/,
      );
    } finally {
      await db.close();
    }
  },
);
