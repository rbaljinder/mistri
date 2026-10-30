/**
 * Live sync's hub and stream in one process over SQLite: the filter's shared
 * probe, a replay from a cursor, a pruned cursor's reset, and the stream's
 * caps, authority re-resolution and back-pressure. The route's own tests
 * (live-sync-route.test.ts) hold the security properties end to end.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { LIVE_CHANGE_TABLES, type LiveKey } from '../packages/mistri/src/adapters/live/liveChange.js';
import { provisionSqliteLiveChange } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { bindLiveChanges } from '../packages/mistri/src/server/stores/writeCaptures.js';
import {
  keyText,
  scopeFingerprint,
  type LiveAuthority,
  type LiveDelivery,
  type LiveGrant,
} from '../packages/mistri/src/server/live/liveFilter.js';
import { dropLiveHub, LiveHub, liveHubOf, type LiveTap } from '../packages/mistri/src/server/live/liveHub.js';
import { lendStoreHost, type PostgresStoreHost } from '../packages/engine/src/adapters/storeHost.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { openLiveStream } from '../packages/mistri/src/server/live/liveStream.js';
import type { LivePosition, LiveStore } from '../packages/mistri/src/server/live/liveStore.js';

async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync, hub: LiveHub) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-live-hub-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT);
    INSERT INTO ticket VALUES (1, 'Printer jam', 'open'), (2, 'Badge', 'closed');`);
  provisionSqliteLiveChange(path);
  const adapter = new SqliteAdapter(path);
  bindLiveChanges(adapter, { scoped: true });
  const hub = (await liveHubOf(adapter, { pollMs: 50 }))!;
  assert.ok(hub);
  try {
    await run(adapter, db, hub);
  } finally {
    await dropLiveHub(adapter);
    bindLiveChanges(adapter, undefined);
    await adapter.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const OPEN = { groups: [[{ column: 'status', op: '=' as const, value: 'open' }]] };

function authority(db: DatabaseSync, scope: true | typeof OPEN, probes: { count: number }): LiveAuthority {
  const grant: LiveGrant = { id: 'ticket', key: ['id'], columns: 'all', scope, fingerprint: scopeFingerprint('desk', 'ticket', scope) };
  return {
    actor: '',
    tables: new Map([['ticket', grant]]),
    async probe(_table, keys) {
      probes.count += 1;
      const ids = keys.map((key) => Number(key.id));
      const rows = db.prepare(`SELECT id FROM ticket WHERE status = 'open' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      return new Set(rows.map((row) => keyText({ id: row.id as number })));
    },
  };
}

interface Heard {
  deliveries: Array<{ delivery: LiveDelivery; replay: boolean }>;
  resets: number;
  at?: LivePosition;
}

function tap(make: () => LiveAuthority, cursor?: string): LiveTap & { heard: Heard } {
  const heard: Heard = { deliveries: [], resets: 0 };
  return {
    heard,
    ...(cursor === undefined ? {} : { cursor }),
    authority: async () => make(),
    receive: (delivery, position, replay) => {
      heard.deliveries.push({ delivery, replay });
      heard.at = position;
    },
    placed: (position) => (heard.at = position),
    reset: (position) => {
      heard.resets += 1;
      heard.at = position;
    },
    fail: () => assert.fail('the hub failed'),
  };
}

const keysOf = (delivery: LiveDelivery): LiveKey[] | 'many' => {
  const keys = delivery.tables.get('ticket')?.keys;
  return keys === undefined ? [] : keys === 'many' ? 'many' : [...keys.values()];
};

async function until(test: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await delay(10);
  assert.ok(test(), 'timed out');
}

test('forty readers of one scope share one probe, and each is told only the keys it admits', async () => {
  await fixture(async (adapter, db, hub) => {
    const probes = { count: 0 };
    const scoped = Array.from({ length: 40 }, () => tap(() => authority(db, OPEN, probes)));
    const everyone = tap(() => authority(db, true, probes));
    await Promise.all([...scoped, everyone].map((one) => hub.attach(one)));
    // Ticket 2 opens (in scope after), ticket 1 closes (in scope before); a third stays closed and unseen by the scoped.
    db.exec(`INSERT INTO ticket VALUES (3, 'Quiet', 'closed')`);
    await adapter.transaction(async (tx) => {
      await tx.update({ table: 'ticket', key: { id: 2 }, values: { status: 'open' } });
      await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } });
      await tx.update({ table: 'ticket', key: { id: 3 }, values: { title: 'Still quiet' } });
    });
    await until(() => scoped.every((one) => one.heard.deliveries.length === 1) && everyone.heard.deliveries.length === 1);
    assert.equal(probes.count, 1, 'one probe for forty readers of one scope');
    assert.equal(hub.counters.probes, 1);
    for (const one of scoped)
      assert.deepEqual(
        new Set((keysOf(one.heard.deliveries[0].delivery) as LiveKey[]).map((key) => key.id)),
        new Set([1, 2]),
        'the row that left the scope and the one that entered, never the one outside it',
      );
    assert.deepEqual(new Set((keysOf(everyone.heard.deliveries[0].delivery) as LiveKey[]).map((key) => key.id)), new Set([1, 2, 3]));
    for (const one of [...scoped, everyone]) hub.detach(one);
  });
});

test('a cursor replays what it missed, and a pruned one resets', async () => {
  await fixture(async (adapter, db, hub) => {
    const probes = { count: 0 };
    const first = tap(() => authority(db, true, probes));
    await hub.attach(first);
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { title: 'One' } });
    await until(() => first.heard.deliveries.length === 1);
    const cursor = first.heard.at!.id;
    hub.detach(first);

    await adapter.update({ table: 'ticket', key: { id: 2 }, values: { title: 'Two' } });
    const again = tap(() => authority(db, true, probes), cursor);
    await hub.attach(again);
    assert.equal(again.heard.deliveries.length, 1, 'the replay is told before the attach resolves');
    assert.equal(again.heard.deliveries[0].replay, true);
    assert.deepEqual(keysOf(again.heard.deliveries[0].delivery), [{ id: 2 }]);
    hub.detach(again);

    // Everything older than now is pruned except the newest row: the old cursor is gone, and the reader starts over.
    await adapter.update({ table: 'ticket', key: { id: 2 }, values: { title: 'Three' } });
    db.exec(`UPDATE "${LIVE_CHANGE_TABLES.change}" SET at = 0`);
    await hub.prune();
    const late = tap(() => authority(db, true, probes), cursor);
    await hub.attach(late);
    assert.equal(late.heard.resets, 1);
    assert.equal(late.heard.deliveries.length, 0);
    hub.detach(late);
  });
});

/* A response the stream writes to, whose unread backlog a case sets. */
class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  write(chunk: string) {
    this.body += chunk;
    return true;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

const events = (body: string) =>
  body
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => ({ event: block.slice(7, block.indexOf('\n')), data: JSON.parse(block.slice(block.indexOf('data: ') + 6)) }));

function stream(
  hub: LiveHub,
  db: DatabaseSync,
  options: { account?: string; resolve?: () => Promise<readonly LiveAuthority[]>; limits?: object } = {},
) {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const res = new FakeResponse();
  const probes = { count: 0 };
  const opened = openLiveStream({
    req,
    res: res as unknown as ServerResponse,
    account: options.account ?? 'maya',
    hubs: [hub],
    authority: [authority(db, true, probes)],
    resolve: options.resolve ?? (async () => [authority(db, true, probes)]),
    limits: { coalesceMs: 20, ...options.limits },
  });
  return { res, opened };
}

test('a stream is refused past the per-account cap, ends when its authority fails, and is dropped when its reader stalls', async () => {
  await fixture(async (adapter, db, hub) => {
    // The cap: the third stream of one account is answered 503 with Retry-After.
    const one = stream(hub, db, { limits: { perAccount: 2 } });
    const two = stream(hub, db, { limits: { perAccount: 2 } });
    const three = stream(hub, db, { limits: { perAccount: 2 } });
    await Promise.all([one.opened, two.opened, three.opened]);
    assert.equal(one.res.status, 200);
    assert.equal(two.res.status, 200);
    assert.equal(three.res.status, 503);
    assert.equal(three.res.headers['retry-after'], '30');
    assert.deepEqual(events(one.res.body)[0], { event: 'hello', data: { cursor: events(one.res.body)[0].data.cursor } });
    one.res.destroy();
    two.res.destroy();
    const after = stream(hub, db, { limits: { perAccount: 2 } });
    await after.opened;
    assert.equal(after.res.status, 200, 'a closed stream frees its place');
    after.res.destroy();

    // Authority: re-resolved once stale; a session that no longer resolves ends the stream with a reason.
    let valid = true;
    const expiring = stream(hub, db, {
      account: 'sam',
      limits: { authorityMs: 30 },
      resolve: async () => {
        if (!valid) throw new Error('signed out');
        return [authority(db, true, { count: 0 })];
      },
    });
    await expiring.opened;
    valid = false;
    await until(() => expiring.res.writableEnded);
    assert.deepEqual(events(expiring.res.body).at(-1), { event: 'end', data: { reason: 'authority' } });

    // Back-pressure: a reader 64 KiB behind for longer than the stall limit is dropped without a word.
    const stalled = stream(hub, db, { account: 'kim', limits: { stalledMs: 0 } });
    await stalled.opened;
    const told = stream(hub, db, { account: 'lee' });
    await told.opened;
    stalled.res.writableLength = 65 * 1024;
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { title: 'Again' } });
    await until(() => events(told.res.body).some((event) => event.event === 'change'));
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { title: 'And again' } });
    await until(() => stalled.res.destroyed);
    assert.ok(!events(stalled.res.body).some((event) => event.event === 'change' || event.event === 'end'));
    const change = events(told.res.body).find((event) => event.event === 'change')!;
    assert.deepEqual(change.data.tables, { ticket: { keys: [{ id: 1 }], kinds: ['update'] } });
    told.res.destroy();
  });
});

test('a flush that met a backlog is asked again, so a reader that catches up is told without a drain or a heartbeat', async () => {
  await fixture(async (adapter, db, hub) => {
    const slow = stream(hub, db, { account: 'ray', limits: { stalledMs: 60_000 } });
    await slow.opened;
    slow.res.writableLength = 65 * 1024;
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { title: 'While behind' } });
    // Held while the reader is behind: nothing is written over the backlog.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!events(slow.res.body).some((event) => event.event === 'change'));
    // The reader catches up, and no 'drain' is emitted: the stalled flush's own retry delivers it.
    const caughtUp = Date.now();
    slow.res.writableLength = 0;
    await until(() => events(slow.res.body).some((event) => event.event === 'change'), 1_000);
    assert.ok(Date.now() - caughtUp < 1_000, 'told within a second of catching up, not at the 25 s heartbeat');
    assert.deepEqual(events(slow.res.body).find((event) => event.event === 'change')!.data.tables, {
      ticket: { keys: [{ id: 1 }], kinds: ['update'] },
    });
    assert.equal(slow.res.destroyed, false);
    slow.res.destroy();
  });
});

test('a reader that never catches up is dropped once the stall limit passes, without a drain to ask', async () => {
  await fixture(async (adapter, db, hub) => {
    const stuck = stream(hub, db, { account: 'zoe', limits: { stalledMs: 150 } });
    await stuck.opened;
    stuck.res.writableLength = 65 * 1024;
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { title: 'Never read' } });
    await until(() => stuck.res.destroyed, 2_000);
    assert.ok(!events(stuck.res.body).some((event) => event.event === 'change' || event.event === 'end'));
  });
});

test('a change waits for every healthy replica to replay it, and past the wait is marked for the primary', async () => {
  let replayed = false;
  const adapter = {} as Adapter;
  lendStoreHost(adapter, {
    dialect: 'postgres',
    withReadClient: async (work: (client: unknown) => Promise<unknown>) => work({ query: async () => ({ rows: [{ lsn: '0/10' }] }) }),
    onHealthyReplicas: async (work: (client: unknown) => Promise<unknown>) => [
      await work({ query: async () => ({ rows: [{ caught: true }] }) }),
      await work({ query: async () => ({ rows: [{ caught: replayed }] }) }),
    ],
  } as unknown as PostgresStoreHost);
  let rows = 0;
  const change = { id: '1', at: 0, actor: '', tenant: null, entries: [{ table: 'ticket', kind: 'update' as const, keys: [{ id: 1 }] }] };
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: '0' }),
    read: async (from) => (rows > Number(from.id) ? [{ change: { ...change, id: String(rows) }, position: { id: String(rows) } }] : []),
    locate: async (cursor) => ({ id: cursor }),
    prune: async () => 0,
  };
  const hub = new LiveHub(adapter, store, { pollMs: 20, replicaWaitMs: 300 });
  const primaries: boolean[] = [];
  const one: LiveTap = {
    authority: async () => ({
      actor: '',
      tables: new Map([['ticket', { id: 'ticket', key: ['id'], columns: 'all' as const, scope: true as const, fingerprint: '' }]]),
      probe: async () => new Set<string>(),
    }),
    receive: (_delivery, _position, _replay, primary) => primaries.push(primary),
    placed: () => {},
    reset: () => assert.fail('reset'),
    fail: () => assert.fail('failed'),
  };
  try {
    await hub.attach(one);
    // One replica stays behind past the wait: the change is told, marked for the primary.
    rows = 1;
    await until(() => primaries.length === 1);
    assert.deepEqual(primaries, [true]);
    // Both have it within the wait: told unmarked.
    replayed = true;
    rows = 2;
    await until(() => primaries.length === 2);
    assert.deepEqual(primaries, [true, false]);
  } finally {
    hub.detach(one);
    await hub.close();
  }
});

/* Nothing in live sync may end the server: an unhandled rejection or an uncaught exception does, and the visual
   matrix's Tick server died mid-run with live sync on. Every fault below is logged and kept to the hub. */
async function noProcessFaults(run: () => Promise<void>): Promise<unknown[]> {
  const faults: unknown[] = [];
  const record = (error: unknown) => faults.push(error);
  const logged = console.error;
  console.error = () => {};
  process.on('unhandledRejection', record);
  process.on('uncaughtException', record);
  try {
    await run();
    await delay(100);
  } finally {
    process.off('unhandledRejection', record);
    process.off('uncaughtException', record);
    console.error = logged;
  }
  return faults;
}

test('a subscriber whose callbacks throw is ended alone, and nothing reaches the process', async () => {
  await fixture(async (adapter, db, hub) => {
    const probes = { count: 0 };
    const faults = await noProcessFaults(async () => {
      const broken: LiveTap = {
        ...tap(() => authority(db, true, probes)),
        receive: () => {
          throw new Error('receive');
        },
        fail: () => {
          throw new Error('fail');
        },
      };
      const steady = tap(() => authority(db, true, probes));
      await hub.attach(broken);
      await hub.attach(steady);
      await adapter.transaction(async (tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { title: 'One' } }));
      await until(() => steady.heard.deliveries.length === 1);
      assert.equal(hub.subscribers, 1, 'the one that threw is detached');
      await adapter.transaction(async (tx) => tx.update({ table: 'ticket', key: { id: 2 }, values: { title: 'Two' } }));
      await until(() => steady.heard.deliveries.length === 2);
      hub.detach(steady);
    });
    assert.deepEqual(faults, []);
  });
});

test('a store that throws on every read, poll and prune ends its subscribers and never the process', async () => {
  const broken = async (): Promise<never> => {
    throw new Error('the store is gone');
  };
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: '0' }),
    read: broken,
    locate: broken,
    prune: broken,
    moved: broken,
  };
  const hub = new LiveHub({} as Adapter, store, { pollMs: 20 });
  let failed = 0;
  const faults = await noProcessFaults(async () => {
    await hub.attach({
      authority: async () => ({ actor: '', tables: new Map(), probe: async () => new Set<string>() }),
      receive: () => {},
      placed: () => {},
      reset: () => {},
      fail: () => {
        failed += 1;
        throw new Error('fail');
      },
    });
    await until(() => failed === 1);
    assert.equal(await hub.prune(), 0);
    await hub.close();
  });
  assert.deepEqual(faults, []);
});

test('the last subscriber leaving mid-pass while another joins ends neither the pass nor the newcomer', async () => {
  /* The store dereferences its position as PostgreSQL's does (`from.xact`): a pass that went on after the hub
     stopped read from `undefined`, failed with "reading 'xact'", and ended every subscriber, the newcomer too. */
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reads: Array<LivePosition | undefined> = [];
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: '0' }),
    read: async (from) => {
      reads.push(from);
      void (from as { xact?: string }).xact;
      return [];
    },
    locate: async (cursor) => {
      await gate;
      return { id: cursor };
    },
    prune: async () => 0,
  };
  const hub = new LiveHub({} as Adapter, store, { pollMs: 10_000 });
  const logged: unknown[] = [];
  const faults = await noProcessFaults(async () => {
    const error = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      const quiet = { authority: async () => ({ actor: '', tables: new Map(), probe: async () => new Set<string>() }) };
      const leaving: LiveTap = { ...quiet, cursor: '0', receive: () => {}, placed: () => {}, reset: () => {}, fail: () => {} };
      let failed = 0,
        placed = 0;
      const newcomer: LiveTap = {
        ...quiet,
        receive: () => {},
        placed: () => (placed += 1),
        reset: () => {},
        fail: () => (failed += 1),
      };
      void hub.attach(leaving);
      await until(() => reads.length === 0 && hub.subscribers === 1);
      await delay(20);
      // The pass waits in the leaving one's join: it goes, the hub stops, and another joins.
      hub.detach(leaving);
      const joined = hub.attach(newcomer);
      release();
      await joined;
      await delay(50);
      assert.equal(failed, 0, 'the newcomer was not ended');
      assert.equal(placed, 1);
      assert.equal(hub.subscribers, 1);
      assert.ok(reads.length > 0 && reads.every((from) => from !== undefined), 'no read from an undefined position');
      hub.detach(newcomer);
    } finally {
      console.error = error;
      await hub.close();
    }
  });
  assert.deepEqual(faults, []);
  assert.deepEqual(logged, [], 'nothing was logged as a live sync fault');
});

test('a subscriber that leaves before its pass, as the last one, is not kept until the next arrives', async () => {
  /* The hub stops with its last subscriber; one still waiting to join stayed in its line, and with it the stream it
     wrote to, until another subscriber's pass took it out — in a quiet process, indefinitely. */
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: '0' }),
    read: async () => [],
    locate: async (cursor) => ({ id: cursor }),
    prune: async () => 0,
  };
  const hub = new LiveHub({} as Adapter, store, { pollMs: 10_000 });
  const quiet = { authority: async () => ({ actor: '', tables: new Map(), probe: async () => new Set<string>() }) };
  const leaving: LiveTap = { ...quiet, receive: () => {}, placed: () => {}, reset: () => {}, fail: () => {} };
  try {
    void hub.attach(leaving);
    hub.detach(leaving);
    assert.equal((hub as unknown as { joining: unknown[] }).joining.length, 0);
  } finally {
    await hub.close();
  }
});

test('a subscriber that leaves before its pass settles its attach, whether it was the last one or not', async () => {
  /* A choice cache holds its attach as `listening` until it settles (forms/choiceCache.ts); a tap that detached before
     its pass left that promise pending for good, and the cache with it. */
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: '0' }),
    read: async () => [],
    locate: async (cursor) => ({ id: cursor }),
    prune: async () => 0,
  };
  const hub = new LiveHub({} as Adapter, store, { pollMs: 10_000 });
  const quiet = { authority: async () => ({ actor: '', tables: new Map(), probe: async () => new Set<string>() }) };
  const make = (): LiveTap => ({ ...quiet, receive: () => {}, placed: () => {}, reset: () => {}, fail: () => {} });
  const settled = (promise: Promise<void>) => Promise.race([promise.then(() => true), delay(500).then(() => false)]);
  try {
    const last = make();
    assert.equal(
      await settled(
        (() => {
          const p = hub.attach(last);
          hub.detach(last);
          return p;
        })(),
      ),
      true,
      'the last one leaving',
    );
    const stays = make();
    const leaves = make();
    const pending = [hub.attach(stays), hub.attach(leaves)];
    hub.detach(leaves);
    assert.equal(await settled(pending[1]), true, 'one of two leaving');
    assert.equal(await settled(pending[0]), true, 'the one that stays is placed');
  } finally {
    await hub.close();
  }
});
