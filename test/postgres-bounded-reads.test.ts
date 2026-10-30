/**
 * A bounded tenant request on PostgreSQL (withBoundedReads, tenantReadRuntime.ts): its context's reads on one
 * snapshot, the release fence riding the message that ends it (TenantReadSource.togetherFenced), and what must
 * still hold around that.
 *
 * - Nothing but the database is awaited while the snapshot is open: the session is asked before the first read and
 *   after the snapshot has ended, so a session store slow to answer never holds a reader of the pool.
 * - A callback that fails lets the snapshot go unfenced and is denied; a database that fails inside the fence's
 *   message is the database's fault (503), never an answer.
 * - A membership revoked while the request reads — the inbox's store read on the shared snapshot included — denies
 *   the request at the fence.
 * - A context opened inside a bounded one is refused: its own fence would wait on a second reader beside the one
 *   the first snapshot holds.
 * - A whole snapshot begun on an attestation another snapshot replaced since is asked again with the catalog
 *   attested (`MOVED`).
 * - A reserved store's attestation is kept under the catalog fingerprint it was made beside, and forgotten when
 *   the catalog moves or a store read fails the way a moved store fails one.
 *
 * Live and opt-in: TABLEWALK_TEST_PG names a disposable server; the suite works in a database of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { TenantContextError, TenantUnavailableError } from '../packages/engine/src/server/evidence.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { tenantInbox } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { createTenantReadRuntime, withBoundedReads } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, type TenantEngine } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const DATABASE = `bounded_reads_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (LIVE) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'bounded-app', source: { id: 'business', connection: 'bounded-business' }, storeId: 'bounded-store' };
const SETUP = `CREATE TABLE public.br_item (id integer PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
  INSERT INTO public.br_item VALUES (1, 'north', 'One'), (2, 'south', 'Two'), (3, 'north', 'Three');`;
const request = { cookie: 'alice' };
const recipient = 'alice@north.example.invalid';
const items = { table: 'item', limit: 20, offset: 0 };
/* What the inbox's full attestation asks of its store, and only it (postgresInboxReady). */
const READINESS = /SELECT singleton, version FROM/;
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function denied(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError, String(error));
  assert.equal(error.code, 'tenant_context_unavailable');
  return true;
}

interface Sent {
  readonly lease: number;
  readonly text: string;
}
/**
 * Every statement a source connection is asked, by the lease it was asked on: what the tenant sources send, and
 * never the control connection, which is a plain client. `before` runs ahead of a statement, `after` once its
 * answer is in and before its asker hears it.
 */
function wire(
  t: TestContext,
  hooks: { before?(text: string, client: PgQuery): Promise<void> | void; after?(text: string): Promise<void> | void } = {},
): Sent[] {
  const proto = PgConnectionManager.prototype as unknown as { withClient(...args: unknown[]): Promise<unknown> };
  const original = proto.withClient;
  const sent: Sent[] = [];
  let leases = 0;
  t.mock.method(
    proto,
    'withClient',
    function (this: unknown, write: unknown, run: (client: PgQuery, ...more: unknown[]) => Promise<unknown>, ...rest: unknown[]) {
      return original.call(
        this,
        write,
        (client: PgQuery, ...more: unknown[]) => {
          const lease = ++leases;
          const query = async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
            if (hooks.before) await hooks.before(text, client);
            sent.push({ lease, text });
            const result = await (client.query as (...values: unknown[]) => Promise<unknown>)(...args);
            if (hooks.after) await hooks.after(text);
            return result;
          };
          return run({ query } as PgQuery, ...more);
        },
        ...rest,
      );
    },
  );
  return sent;
}
const finishes = (sent: readonly Sent[]) => sent.filter((statement) => statement.text.startsWith('COMMIT; BEGIN'));
/* The lease the context's reads ran on: its first read of the table, never a snapshot's LOCK of it. */
const readLease = (sent: readonly Sent[]) => sent.find((statement) => /_tw_scope/.test(statement.text))!.lease;

async function fixture(t: TestContext, trustFor = 60_000) {
  const engine: TenantEngine = await openTenantEngine('postgres', {
    sqlite: '',
    postgres: SETUP,
    tables: ['br_item'],
    database: DATABASE,
  });
  let source: TenantReadSource | undefined;
  const runtimes: Array<ReturnType<typeof createTenantReadRuntime<typeof request>>> = [];
  t.after(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.retire()));
    await source?.close().catch(() => {});
    await engine.close();
  });
  await engine.exec('DROP FUNCTION IF EXISTS public.br_marker()');
  await engine.provisionStore(binding);
  await provisionPostgresInbox(engine.url);
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['reviewer'],
    validUntil: 10_000,
    expectedVersion: null,
  };
  await engine.maintenance(binding, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership(grant);
  });
  for (let n = 1; n <= 3; n += 1)
    await engine.exec(
      `INSERT INTO mistri.inbox_notice (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
       VALUES (?, ?, ?, 'item', ?, ?, '[]', 'bob@north.example.invalid', 'Bob', 'Edit')`,
      [
        tenantInbox(binding.appId, 'north'),
        recipient,
        new Date(Date.UTC(2026, 9, n)).toISOString(),
        JSON.stringify({ id: n }),
        `Item ${n}`,
      ],
    );
  const resources = { item: engine.id('br_item') };
  const physicalSchema = await engine.physicalSchema();
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const time = 1000;
  source = await engine.openRead(ownership, binding, () => time, trustFor);
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Bounded fixture',
      auth: { roles: { reviewer: { read: ['item'] } } },
      sources: { business: { connection: binding.source.connection } },
      resources: { item: { physical: resources.item, fields: { read: ['id', 'name'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'bounded reads test',
  );
  const identity: Identity = { id: 'alice', who: recipient, role: 'reviewer' };
  /* The session store: answers at once, unless a test has it wait (`stall`) or watches when it is asked (`asked`). */
  const session: { stall?: Promise<void>; asked?: () => void } = {};
  const rows: RowScope = { item: true };
  const runtime = createTenantReadRuntime({
    app,
    source,
    deployment: 'bounded-deployment',
    roles: ['reviewer'],
    maxLifetimeMs: 5000,
    verifySession: (input: typeof request) => {
      if (input.cookie !== 'alice') return null;
      session.asked?.();
      return session.stall ? session.stall.then(() => identity) : identity;
    },
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    now: () => time,
  });
  runtimes.push(runtime);
  const names = (result: { rows: Array<Record<string, unknown>> }) => result.rows.map((row) => row.name).sort();
  return {
    engine,
    source,
    runtime,
    session,
    names,
    inbox: { app: tenantInbox(binding.appId, 'north'), recipient, limit: 5 },
    revoke: () => engine.maintenance(binding, (admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
    /* A function in the App's schema: the catalog's digest moves, and nothing the attestation compares does. */
    moveCatalog: () =>
      engine.exec(`CREATE OR REPLACE FUNCTION public.br_marker() RETURNS integer LANGUAGE sql AS 'SELECT ${Date.now() % 1000}'`),
  };
}

describe('bounded tenant reads on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  test('withBoundedReads reads a context on one snapshot and rides its fence on the message that ends it', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items)); // warm: the catalog attested
    const sent = wire(t);
    const plain = await f.runtime.withContext(request, ['north'], async ({ data }) => {
      const [listed, counted] = await Promise.all([data.query(items), data.count('item')]);
      return { names: f.names(listed), count: counted };
    });
    assert.equal(finishes(sent).length, 0, 'unbounded, the fence is a snapshot of its own');
    const unboundedLeases = new Set(sent.map((statement) => statement.lease)).size;
    sent.length = 0;
    const bounded = await withBoundedReads(() =>
      f.runtime.withContext(request, ['north'], async ({ data }) => {
        const [listed, counted] = await Promise.all([data.query(items), data.count('item')]);
        return { names: f.names(listed), count: counted };
      }),
    );
    assert.deepEqual(bounded, plain);
    assert.deepEqual(bounded.names, ['One', 'Three']);
    assert.equal(finishes(sent).length, 1, JSON.stringify(sent));
    const reads = sent.filter((statement) => /_tw_scope/.test(statement.text));
    assert.equal(new Set(reads.map((statement) => statement.lease)).size, 1, 'both reads on one snapshot');
    assert.equal(finishes(sent)[0]!.lease, reads[0]!.lease, 'the fence ends the snapshot the reads were on');
    assert.ok(new Set(sent.map((statement) => statement.lease)).size < unboundedLeases);
  });

  test('the session is never awaited while the bounded snapshot is open, and a stalled one holds no reader', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items));
    const open = new Set<number>();
    const sent = wire(t);
    const track = () => {
      for (const { lease, text } of sent.splice(0)) {
        if (/^\s*BEGIN/.test(text) && !/;\s*COMMIT\s*$/.test(text)) open.add(lease);
        else if (/^\s*(COMMIT|ROLLBACK)\s*$/.test(text) || /^COMMIT; BEGIN[\s\S]*; COMMIT$/.test(text)) open.delete(lease);
      }
    };
    const openWhenAsked: number[] = [];
    f.session.asked = () => {
      track();
      openWhenAsked.push(open.size);
    };
    const result = await withBoundedReads(() =>
      f.runtime.withContext(request, ['north'], async ({ data }) => {
        const listed = await data.query(items);
        const again = await data.query({ ...items, limit: 1 });
        const counted = await data.count('item');
        return { names: f.names(listed), again: again.rows.length, counted };
      }),
    );
    assert.deepEqual({ ...result }, { names: ['One', 'Three'], again: 1, counted: 2 });
    assert.ok(openWhenAsked.length >= 2, `the session was asked ${openWhenAsked.length} times`);
    assert.deepEqual(
      openWhenAsked,
      openWhenAsked.map(() => 0),
      'a session asked with a snapshot open',
    );

    // The session store stops answering once the reads are in: the request waits on it, and no reader does.
    const stalled = gate(),
      reached = gate();
    const pending = withBoundedReads(() =>
      f.runtime.withContext(request, ['north'], async ({ data }) => {
        const listed = await data.query(items);
        f.session.stall = stalled.promise;
        f.session.asked = () => reached.release();
        return f.names(listed);
      }),
    );
    void pending.catch(() => {});
    await reached.promise;
    const idle = await f.engine.all(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
    );
    assert.equal(idle[0]!.n, 0, 'a connection held in a transaction while the session store is asked');
    delete f.session.stall;
    delete f.session.asked;
    stalled.release();
    assert.deepEqual(await pending, ['One', 'Three']);
  });

  test('a callback that fails lets the snapshot go unfenced and is denied', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items));
    const sent = wire(t);
    await assert.rejects(
      withBoundedReads(() =>
        f.runtime.withContext(request, ['north'], async ({ data }) => {
          await data.query(items);
          throw new Error('PRIVATE_SENTINEL: the callback failed');
        }),
      ),
      denied,
    );
    assert.equal(finishes(sent).length, 0, 'no fence for a request that is not answered');
    const shared = readLease(sent);
    const ends = sent.filter((statement) => statement.lease === shared && /^\s*(COMMIT|ROLLBACK)\s*$/.test(statement.text));
    assert.equal(ends.length, 1, JSON.stringify(sent));
    // And the context's source still serves.
    assert.deepEqual(
      await withBoundedReads(() => f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items)))),
      ['One', 'Three'],
    );
  });

  test('a database that fails inside the fence is the database fault, not an answer', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items));
    let armed = true;
    wire(t, {
      async before(text, client) {
        if (!armed || !text.startsWith('COMMIT; BEGIN')) return;
        armed = false;
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await f.engine.exec('SELECT pg_terminate_backend(?)', [pid]);
        for (let i = 0; i < 100; i++) {
          if (!(await f.engine.all('SELECT 1 FROM pg_stat_activity WHERE pid = ?', [pid])).length) break;
          await delay(10);
        }
      },
    });
    await assert.rejects(
      withBoundedReads(() => f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items)))),
      (error: unknown) => {
        assert.ok(error instanceof TenantUnavailableError, String(error));
        assert.equal(error.code, 'tenant_temporarily_unavailable');
        return true;
      },
    );
    assert.equal(armed, false);
    // The lost connection's pool is replaced; the next request is answered.
    assert.deepEqual(
      await withBoundedReads(() => f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items)))),
      ['One', 'Three'],
    );
  });

  test('a membership revoked during an inbox read on the shared snapshot denies the request at the fence', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items));
    const sent = wire(t);
    let read: unknown;
    await assert.rejects(
      withBoundedReads(() =>
        f.runtime.withContext(request, ['north'], async ({ data }) => {
          const listed = await data.query(items);
          await f.revoke();
          // Read on the snapshot the request began, which still shows the notices — and the membership — as they were.
          read = await f.source.readInbox(f.inbox);
          return { names: f.names(listed), notices: read };
        }),
      ),
      denied,
    );
    assert.equal((read as unknown[]).length, 3, 'the store read answered, on the snapshot');
    const shared = readLease(sent);
    const notices = sent.find((statement) => /inbox_notice/.test(statement.text) && /ORDER BY id DESC/.test(statement.text))!;
    assert.equal(notices.lease, shared, 'the inbox read joined the request snapshot');
    assert.equal(finishes(sent).length, 1, 'the fence rode the snapshot end, and refused');
  });

  test('a context opened inside a bounded one is refused; one after it is not', async (t) => {
    const f = await fixture(t);
    await f.runtime.withContext(request, ['north'], ({ data }) => data.query(items));
    let inner: unknown;
    const sent = wire(t);
    // Refused before it reads or admits anything: the outer context's own answer stands.
    const outer = await withBoundedReads(() =>
      f.runtime.withContext(request, ['north'], async ({ data }) => {
        const listed = await data.query(items);
        const before = sent.length;
        try {
          await f.runtime.withContext(request, ['north'], ({ data: nested }) => nested.query(items));
        } catch (error) {
          inner = error;
        }
        assert.equal(sent.length, before, 'the nested context asked the database nothing');
        return f.names(listed);
      }),
    );
    assert.ok(inner instanceof TenantContextError, String(inner));
    assert.deepEqual(outer, ['One', 'Three']);
    assert.equal(finishes(sent).length, 1);
    // Two in turn inside one bounded request: the first bounded, the second as an ordinary context.
    const both = await withBoundedReads(async () => {
      const first = await f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items)));
      const second = await f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items)));
      return [first, second];
    });
    assert.deepEqual(both, [
      ['One', 'Three'],
      ['One', 'Three'],
    ]);
  });

  test('a whole fence begun on an attestation replaced since is asked again with the catalog attested', async (t) => {
    const trustFor = 1500;
    const f = await fixture(t, trustFor);
    let principal: unknown;
    await f.runtime.withContext(request, ['north'], async (context) => {
      principal = context.principal;
      return context.data.query(items);
    });
    const held = gate(),
      reached = gate();
    let holding = false;
    const sent = wire(t, {
      async after(text) {
        if (!holding || !text.startsWith('BEGIN') || !text.endsWith('; COMMIT')) return;
        holding = false;
        reached.release();
        await held.promise;
      },
    });
    holding = true;
    // Asked alone, on the attestation that stands: BEGIN, the LOCK, the membership and COMMIT in one message.
    const fenced = f.source.assertCurrent(principal as Parameters<TenantReadSource['assertCurrent']>[0]);
    void fenced.catch(() => {});
    await reached.promise;
    // The attestation lapses, the catalog moves, and another snapshot attests it anew while the whole one waits.
    await delay(trustFor + 100);
    await f.moveCatalog();
    assert.deepEqual(await f.runtime.withContext(request, ['north'], async ({ data }) => f.names(await data.query(items))), [
      'One',
      'Three',
    ]);
    const since = sent.length;
    held.release();
    await fenced;
    const again = sent.slice(since);
    assert.ok(
      again.some((statement) => statement.text.startsWith('BEGIN') && !statement.text.endsWith('; COMMIT')),
      `asked again in a snapshot whose catalog is checked: ${JSON.stringify(again)}`,
    );
    assert.ok(
      again.some((statement) => /md5\(string_agg/.test(statement.text)),
      'the digest read on the snapshot asked again',
    );
    // And a member whose membership was revoked meanwhile is refused on the same path.
    await f.revoke();
    await assert.rejects(f.source.assertCurrent(principal as Parameters<TenantReadSource['assertCurrent']>[0]), denied);
  });

  test("a reserved store's attestation is kept under its catalog fingerprint and forgotten when either moves", async (t) => {
    const trustFor = 1500;
    const f = await fixture(t, trustFor);
    const sent = wire(t);
    const readiness = async () => {
      const since = sent.length;
      assert.equal((await f.source.readInbox(f.inbox)).length, 3);
      return sent.slice(since).filter((statement) => READINESS.test(statement.text)).length;
    };
    // Attested in full once, then read on the attestation that stands.
    assert.deepEqual([await readiness(), await readiness()], [1, 0]);
    // The catalog moves: its fingerprint is new, and the store is attested in full beside it again, then kept.
    await delay(trustFor + 100);
    await f.moveCatalog();
    assert.deepEqual([await readiness(), await readiness(), await readiness()], [1, 1, 0]);
    // A store read that fails the way a moved store fails one: whatever is read next is attested in full.
    await f.engine.exec('ALTER TABLE mistri.inbox_notice RENAME COLUMN title TO title_moved');
    await assert.rejects(f.source.readInbox(f.inbox));
    await f.engine.exec('ALTER TABLE mistri.inbox_notice RENAME COLUMN title_moved TO title');
    assert.equal(await readiness(), 1);
  });
});
