/**
 * A tenant App on PostgreSQL keeps serving after its database drops a
 * connection: a failover, a restart, a pooler recycling its server
 * connections, an idle timeout, an operator's pg_terminate_backend. The
 * request whose snapshot was on the lost connection is refused as the
 * database's fault (503) and nothing more is said of it; every request after
 * it, every member's, and the live stream are answered again within a bounded
 * time, with no restart.
 *
 * Until rc.1 a ROLLBACK that could not be sent on the dead connection retired
 * the whole private tenant reader (tenantReadSource.ts), and with it every
 * sign-in, read, stream, job and mail pass of the process until it restarted
 * (a field report from a large tenant App behind PgBouncer, five times in
 * forty-five minutes).
 *
 * Three ways in: the backend under one request's snapshot terminated between
 * its statements, in session and in transaction-pooler mode; every backend of
 * the database terminated between requests; and a TCP proxy written here,
 * which adds a round trip's latency and cuts every connection at once while
 * requests are in flight — what the App saw when PgBouncer said "server conn
 * crashed?". Each case owns a UUID-named database beside TABLEWALK_TEST_PG.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, connect as connectTcp, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { configurePostgresPools, PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresLiveChange } from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { tenantWriterReopen } from '../packages/mistri/src/server/tenant/tenantWriterLifecycle.js';
import { pausedTenantWriters } from '../packages/mistri/src/server/tenant/tenantWriterHealth.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/** How long the process may take to answer again after it lost its connections. */
const RECOVERY_MS = 10_000;

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Lease = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };

/* A TCP proxy in front of the server: `latencyMs` on every chunk each way, and `cut()` ends every connection through it.
   `cutAt` arms one cut on the wire rather than on a clock, so it lands where the test says whatever the machine's
   speed: every connection ends when the client sends a chunk carrying those bytes — the statement dropped unsent —
   or, `answered`, once that chunk has reached the server and its connection's next answer comes back, which is lost. */
async function proxy(target: URL, latencyMs: number) {
  const sockets = new Set<Socket>();
  let armed: { bytes: Buffer; answered: boolean; fired: () => void; server?: Socket } | undefined;
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  const fire = () => {
    const { fired } = armed!;
    armed = undefined;
    cut();
    fired();
  };
  const relay = (from: Socket, to: Socket, toServer: boolean) =>
    from.on('data', (chunk: Buffer) => {
      if (armed && !toServer && armed.server === from) return fire();
      if (armed && toServer && !armed.server && chunk.includes(armed.bytes)) {
        if (!armed.answered) return fire();
        armed.server = to;
      }
      from.pause();
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
        from.resume();
      }, latencyMs);
    });
  const server = createTcpServer((inbound) => {
    const outbound = connectTcp(Number(target.port || 5432), target.hostname);
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        inbound.destroy();
        outbound.destroy();
      });
    }
    relay(inbound, outbound, true);
    relay(outbound, inbound, false);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.href,
    get open() {
      return sockets.size;
    },
    cut,
    /** Arms the cut; the answer says, once asked, whether it fired, and disarms it if it had not. */
    cutAt(text: string, answered: boolean): () => boolean {
      let hit = false;
      armed = { bytes: Buffer.from(text), answered, fired: () => (hit = true) };
      return () => {
        if (!hit) armed = undefined;
        return hit;
      };
    },
    async close() {
      cut();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A tenant App over its own database, served by the tenant host, `through` a proxy when asked. */
async function start(t: TestContext, name: string, options: { through?: (url: string) => Promise<string> } = {}) {
  const appId = `recover-${name}`;
  const binding = { appId, source: { id: 'business', connection: `${appId}-db` }, storeId: `${appId}-store` };
  const app = parseTestApp(
    {
      id: appId,
      name: 'Recover',
      live: true,
      auth: { rows: 'tenant', roles: { agent: { read: true, write: ['ticket'] } } },
      sources: { business: { connection: binding.source.connection } },
      resources: {
        ticket: { owner: 'tenant', access: 'write', fields: { read: ['id', 'title'], write: ['id', 'title'] } },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      nav: ['tickets'],
      home: 'tickets',
    },
    'recovery fixture',
  );
  const rows: RowScope = { ticket: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId,
    storeId: binding.storeId,
    ownership: { ticket: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
  });
  const database = await uuidPostgresDatabase('tw_tenant_recover');
  const closing: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close().catch(() => {});
    await database.drop();
  });
  const control = await pgClient(database.url);
  closing.push(() => control.end());
  await control.query(`CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
    INSERT INTO ticket VALUES ('north-1', 'north', 'Printer jammed'), ('north-2', 'north', 'Screen flickers'), ('south-1', 'south', 'Badge lost');`);
  await migratePostgresTenantStore(database.url, binding);
  await migratePostgresCommandJournal(database.url);
  await provisionPostgresLiveChange(database.url);
  await control.query('BEGIN');
  const operations = new TransactionOperations();
  const store = createPostgresTenantAdministration(control, operations, binding);
  for (const tenantId of ['north', 'south']) {
    await store.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await store.putMembership({
      tenantId,
      accountId: 'eve',
      membershipId: `${tenantId}-eve`,
      status: 'active',
      roles: ['agent'],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
  }
  await operations.finish();
  await control.query('COMMIT');

  const url = options.through ? await options.through(database.url) : database.url;
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, url },
    deployment: `${appId}-deployment`,
    roles: ['agent'],
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
  });
  closing.push(() => enrollment.retire());
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: () => ({
      identity: { id: 'eve', who: 'eve@example.invalid' },
      sessionId: 'session-eve',
      expiresAt: Date.now() + 3_600_000,
    }),
  });
  closing.push(() => owner.retire());
  const dispatch = owner.server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
  const front = createServer(dispatch);
  closing.push(async () => {
    const stopped = new Promise<void>((resolve) => front.close(() => resolve()));
    front.closeAllConnections();
    await stopped;
  });
  front.listen(0, bound.host);
  await once(front, 'listening');
  bound.port = (front.address() as { port: number }).port;
  const origin = `http://${bound.host}:${bound.port}`;

  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  const leaseHeaders = (lease: Lease) => ({
    'x-mistri-tab': lease.tabId,
    'x-mistri-context': lease.context,
    'x-mistri-lease-revision': String(lease.revision),
    'x-mistri-account': lease.accountId,
  });
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const open = (tenant: string) => call(select('/api/tenant/context/open', tenant), {});
  const list = (lease: Lease) =>
    call(select('/api/run', lease.tenantId), { q: 'ticket', limit: 50, offset: 0, count: 'none' }, leaseHeaders(lease));
  const rename = (lease: Lease, id: string, title: string) =>
    call(select('/api/update', lease.tenantId), { table: 'ticket', key: { id }, values: { title } }, leaseHeaders(lease));
  /** A lease, opened again until the host answers: what a page does after a 503. */
  const lease = async (tenant: string): Promise<Lease> => {
    const reply = await eventually(() => open(tenant));
    return reply.body as unknown as Lease;
  };
  /** The live stream on a lease: its events as they arrive. */
  const follow = async (lease: Lease) => {
    const controller = new AbortController();
    const response = await fetch(`${origin}${select('/api/live', lease.tenantId)}`, {
      headers: leaseHeaders(lease),
      signal: controller.signal,
    });
    let text = '';
    const reading = (async () => {
      if (response.status !== 200 || !response.body) return;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) text += decoder.decode(chunk as Uint8Array, { stream: true });
      } catch {
        /* aborted or cut */
      }
    })();
    closing.push(async () => {
      controller.abort();
      await reading;
    });
    const events = () =>
      text
        .split('\n\n')
        .filter((block) => block.startsWith('event: '))
        .map((block) => block.slice(7, block.indexOf('\n')));
    const until = async (event: string, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!events().includes(event) && Date.now() < deadline) await delay(20);
      return events().includes(event);
    };
    return { status: response.status, events, until, stop: () => controller.abort() };
  };
  /** The live route's bare answer on a lease: its status and when it says to come back. */
  const knock = async (lease: Lease) => {
    const response = await fetch(`${origin}${select('/api/live', lease.tenantId)}`, {
      headers: leaseHeaders(lease),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return { status: response.status, retryAfter: response.headers.get('retry-after') };
  };
  return { appId, url: database.url, control, open, lease, list, rename, follow, knock };
}

/** Asked again until it answers 200, for at most RECOVERY_MS: the bound on recovery every case holds. */
async function eventually(ask: () => Promise<Answer>): Promise<Answer> {
  const deadline = Date.now() + RECOVERY_MS;
  let last: Answer | undefined;
  for (;;) {
    last = await ask();
    if (last.status === 200) return last;
    assert.ok(Date.now() < deadline, `no recovery within ${RECOVERY_MS} ms; the last answer was ${last.status} ${last.text}`);
    await delay(100);
  }
}

/* Every backend of this database but the control connection's. */
async function terminateAll(control: Control): Promise<number> {
  const { rows } = await control.query(
    `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  return rows.length;
}

/**
 * Arm one read lease to lose its backend between its statements: after the
 * snapshot's BEGIN, its next statement first terminates the backend it runs
 * on, so that statement and then the ROLLBACK fail on a dead connection —
 * the transaction outcome the reader cannot confirm. Every lease goes
 * through the manager's one private method, as tenantDialects.ts intercepts
 * it; the arguments are passed on whole.
 */
function loseNextSnapshot(t: TestContext, control: Control) {
  const proto = PgConnectionManager.prototype as unknown as {
    withClient(write: boolean, run: (client: PgQuery, ...more: unknown[]) => Promise<unknown>, ...rest: unknown[]): Promise<unknown>;
  };
  const original = proto.withClient;
  const state = { armed: false, fired: 0 };
  t.mock.method(
    proto,
    'withClient',
    function (this: unknown, write: boolean, run: (client: PgQuery, ...more: unknown[]) => Promise<unknown>, ...rest: unknown[]) {
      if (write || !state.armed) return original.call(this, write, run, ...rest);
      return original.call(
        this,
        write,
        (client: PgQuery, ...more: unknown[]) => {
          let began = false;
          const query = async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
            if (!began) {
              began = /^\s*BEGIN/i.test(text);
            } else if (state.armed && !/^\s*(ROLLBACK|COMMIT)/i.test(text)) {
              state.armed = false;
              state.fired++;
              const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
              await control.query('SELECT pg_terminate_backend($1)', [pid]);
              for (let i = 0; i < 100; i++) {
                const { rows } = await control.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
                if (!rows.length) break;
                await delay(10);
              }
            }
            return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
          return run({ query } as PgQuery, ...more);
        },
        ...rest,
      );
    },
  );
  return state;
}

for (const pooler of ['session', 'transaction'] as const) {
  test(
    `a backend lost under one read's snapshot refuses that read alone, and the next ones are answered (${pooler} pooler)`,
    { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
    async (t) => {
      configurePostgresPools({ pooler });
      t.after(() => configurePostgresPools({ pooler: 'session' }));
      const f = await start(t, `snapshot-${pooler}`);
      const north = await f.lease('north');
      assert.equal((await f.list(north)).status, 200);

      const lost = loseNextSnapshot(t, f.control);
      lost.armed = true;
      const refused = await f.list(north);
      assert.equal(lost.fired, 1, 'the snapshot lost its backend');
      assert.equal(refused.status, 503, refused.text);
      assert.equal(refused.body.code, 'tenant_temporarily_unavailable');
      assert.doesNotMatch(refused.text, /terminat|administrator|ROLLBACK|postgres/i);

      // The same lease, a new lease, another tenant's, and the live stream: all answered again.
      const after = await eventually(() => f.list(north));
      assert.deepEqual((after.body.rows as Array<{ id: string }>).map((row) => row.id).sort(), ['north-1', 'north-2']);
      const south = await f.lease('south');
      assert.equal((await eventually(() => f.list(south))).status, 200);
      const stream = await f.follow(await f.lease('north'));
      assert.equal(stream.status, 200);
      assert.ok(await stream.until('hello'), stream.events().join(','));
    },
  );
}

/* A field report: while a writer an uncertain write had closed was reopening,
   its hub was gone and the live route answered 204, which a browser reads as
   live sync off for the rest of the page load (729 such answers in four
   minutes). The writer is back in a moment, and the route says so: 503, with
   when to ask again, and the stream is answered again once it has reopened. */
test(
  'while a closed writer reopens, the live route says to come back, and the stream returns',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const backoff = { ...tenantWriterReopen };
    Object.assign(tenantWriterReopen, { firstMs: 1500, maxMs: 1500 });
    t.after(() => Object.assign(tenantWriterReopen, backoff));
    t.mock.method(console, 'error', () => {});
    const f = await start(t, 'reopen');
    const north = await f.lease('north');
    const before = await f.follow(north);
    assert.ok(await before.until('hello'));
    // The writer's next checkout fails before its transaction is entered: it closes and reopens.
    const proto = PgConnectionManager.prototype as unknown as { withClient(write: boolean, ...rest: unknown[]): Promise<unknown> };
    const original = proto.withClient;
    let cut = 0;
    const fault = t.mock.method(proto, 'withClient', function (this: unknown, write: boolean, ...rest: unknown[]) {
      if (write && cut === 0) {
        cut++;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      }
      return original.call(this, write, ...rest);
    });
    assert.equal((await f.rename(north, 'north-1', 'Printer fixed')).status, 503);
    fault.mock.restore();
    assert.deepEqual(pausedTenantWriters(), [`${f.appId}/business`]);
    assert.deepEqual(await f.knock(north), { status: 503, retryAfter: '1' });
    const deadline = Date.now() + RECOVERY_MS;
    while (pausedTenantWriters().length && Date.now() < deadline) await delay(50);
    const stream = await f.follow(north);
    assert.equal(stream.status, 200);
    assert.ok(await stream.until('hello'));
  },
);

test(
  'every backend of the database terminated between requests: reads, writes, leases and the live stream come back',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const f = await start(t, 'between');
    const north = await f.lease('north');
    const before = await f.follow(north);
    assert.ok(await before.until('hello'));
    assert.equal((await f.list(north)).status, 200);
    assert.equal((await f.rename(north, 'north-1', 'Printer fixed')).status, 200);

    assert.ok((await terminateAll(f.control)) > 0, 'the App held backends to end');
    // Twice: a second wave lands on whatever reconnected after the first.
    await eventually(() => f.list(north));
    assert.ok((await terminateAll(f.control)) >= 0);

    const listed = await eventually(() => f.list(north));
    assert.ok((listed.body.rows as Array<{ title: string }>).some((row) => row.title === 'Printer fixed'));
    assert.equal((await eventually(() => f.rename(north, 'north-2', 'Screen replaced'))).status, 200);
    const again = await f.lease('north');
    const stream = await f.follow(again);
    assert.equal(stream.status, 200);
    assert.ok(await stream.until('hello'));
    // A change after the loss reaches the new stream: the hub reads again.
    assert.equal((await eventually(() => f.rename(again, 'north-1', 'Printer replaced'))).status, 200);
    assert.ok(await stream.until('change', RECOVERY_MS), stream.events().join(','));
  },
);

test(
  'a pooler that cuts every connection mid-request, over a link with latency: the process answers again without a restart',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    let link: Awaited<ReturnType<typeof proxy>> | undefined;
    const f = await start(t, 'proxy', {
      through: async (url) => {
        link = await proxy(new URL(url), 5);
        t.after(() => link!.close());
        return link.url;
      },
    });
    const north = await f.lease('north');
    assert.equal((await f.list(north)).status, 200);
    const stream = await f.follow(north);
    assert.ok(await stream.until('hello'));

    for (let round = 0; round < 3; round++) {
      // Several reads and a write in flight, then every connection cut under them.
      const flight = [...Array.from({ length: 6 }, () => f.list(north)), f.rename(north, 'north-2', `Screen ${round}`)].map((asked) =>
        asked.catch((error: unknown) => ({ status: 0, text: String(error), body: {} }) as Answer),
      );
      await delay(15 + round * 10);
      assert.ok(link!.open > 0);
      link!.cut();
      const answers = await Promise.all(flight);
      for (const answer of answers)
        assert.ok(
          [200, 409, 503].includes(answer.status),
          `a cut is the database's fault, never the request's: ${answer.status} ${answer.text}`,
        );
      await eventually(() => f.list(north));
    }

    /* A save cut on the wire, deterministically, at each step it takes: its BEGIN dropped unsent, and run with its
       answer lost; then its UPDATE, both ways. Nothing committed in any of them, and the database failing is said as
       the database's, never as the person refused (a 403 told them they could not edit a record they could). Cut
       before the BEGIN was answered, it is a 503, not applied. Cut inside the transaction, its ROLLBACK goes
       unanswered, and an unanswered ROLLBACK is an unknown outcome by the adapters' contract: the write is
       unconfirmed (200, outcome unknown), for the client to reconcile. */
    const opening = 'BEGIN; LOCK TABLE "public"."ticket" IN ROW EXCLUSIVE MODE';
    for (const [label, bytes, answered] of [
      ['its BEGIN unsent', opening, false],
      ['its BEGIN run, the answer lost', opening, true],
      ['its UPDATE unsent', 'UPDATE "public"."ticket"', false],
      ['its UPDATE run, the answer lost', 'UPDATE "public"."ticket"', true],
    ] as const) {
      // A writer a cut closed reopens itself first (tenantWriterLifecycle.ts): the next save then reaches the wire.
      await eventually(() => f.rename(north, 'north-1', `Printer, before ${label}`));
      const fired = link!.cutAt(bytes, answered);
      const saved = await f.rename(north, 'north-2', `Screen, ${label}`);
      const said = `${label}: ${saved.status} ${saved.text}`;
      assert.ok(fired(), `${label}: the save never sent it, ${said}`);
      if (bytes === opening) {
        assert.equal(saved.status, 503, said);
        assert.equal(saved.body.outcome, 'not_applied', said);
      } else {
        assert.equal(saved.status, 200, said);
        assert.equal(saved.body.outcome, 'unknown', said);
      }
      const listed = await eventually(() => f.list(north));
      assert.ok(
        !(listed.body.rows as Array<{ title: string }>).some((row) => row.title === `Screen, ${label}`),
        `${label}: nothing committed`,
      );
    }

    const again = await f.lease('north');
    assert.equal((await eventually(() => f.list(again))).status, 200);
    // The live stream is the reopened writer's to bind again: until it has, the route says to come back (503).
    let fresh = await f.follow(again);
    for (const deadline = Date.now() + RECOVERY_MS; fresh.status === 503 && Date.now() < deadline;) {
      await delay(100);
      fresh = await f.follow(again);
    }
    assert.equal(fresh.status, 200);
    assert.ok(await fresh.until('hello'));
    assert.equal((await eventually(() => f.rename(again, 'north-1', 'Printer after the cut'))).status, 200);
    assert.ok(await fresh.until('change', RECOVERY_MS), fresh.events().join(','));
  },
);
