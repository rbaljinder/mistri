import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal, type Adapter, type QueryRequest, type QueryResult } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { runTool } from '../packages/tablewalk/src/server/mcp.js';
import {
  readBreakdown,
  readCount,
  readRecords,
  readView,
  type ResourceReader,
} from '../packages/engine/src/server/resourceReadOperations.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

type Reply = Awaited<ReturnType<typeof runTool>>;
type Fixture = {
  adapter: Adapter;
  schema: DatabaseSchema;
  owner: string;
  call(name: string, args?: Record<string, unknown>): Promise<Reply>;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-resource-detail-'));
  const owner = basename(directory);
  const registry = new Registry();
  try {
    for (const source of ['selected', 'default']) {
      const file = join(directory, `${source}.db`);
      const db = new DatabaseSync(file);
      try {
        db.exec(`PRAGMA foreign_keys = ON;
          CREATE TABLE party(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE member(party_id INTEGER PRIMARY KEY REFERENCES party(id), rank INTEGER);
          CREATE TABLE child(id INTEGER PRIMARY KEY, member_id INTEGER REFERENCES member(party_id), name TEXT, updated_at TEXT);
          CREATE INDEX child_updated ON child(updated_at);
          CREATE TABLE search_row(id TEXT PRIMARY KEY, text TEXT NOT NULL);`);
        db.prepare('INSERT INTO party VALUES (1, ?), (2, ?)').run(`${source} Ada`, `${source} Grace`);
        db.exec(`INSERT INTO member VALUES (1, 7), (2, 8);
          INSERT INTO child VALUES (30, 1, 'thirty', '2026-01-01'), (10, 1, 'ten', '2024-01-01'),
            (20, 1, 'twenty', '2026-01-01'), (40, 2, 'forty', '2023-01-01');`);
        const insert = db.prepare('INSERT INTO search_row VALUES (?, ?)');
        for (const id of ['g', 'f', 'e', 'd', 'c', 'b', 'a']) insert.run(id, `needle ${source} ${id}`);
      } finally {
        db.close();
      }
      registry.add({ id: source === 'selected' ? owner : `${owner}-default`, name: source, url: file, source: 'config', writable: false });
    }
    const { adapter, schema } = await registry.open(owner);
    const other = (await registry.open(`${owner}-default`)).adapter;
    registry.setActive(`${owner}-default`);
    for (const method of ['query', 'count', 'estimateCount', 'runView', 'countView', 'runBreakdown', 'countBreakdown'] as const) {
      Reflect.set(other, method, () => assert.fail(`${method} must stay on the named source`));
    }
    await run({ adapter, schema, owner, call: (name, args = {}) => runTool(registry, name, { connection: owner, ...args }) });
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

function success(reply: Reply) {
  assert.equal(reply.isError, false, JSON.stringify(reply));
  assert.ok(reply.structuredContent);
  assert.equal(reply.structuredContent.errors, undefined, JSON.stringify(reply));
  assert.equal(reply.content[0].text, JSON.stringify(reply.structuredContent));
  return reply.structuredContent as Record<string, any>;
}
function labelView(): ViewDef {
  return {
    id: 'detail-label',
    name: 'Member label',
    base: 'member',
    columns: [{ path: 'party_id.name' }],
    filter: { groups: [[{ path: 'party_id', op: '=', value: 1 }]] },
    limit: 1,
  };
}

test('count-free readView runs a real label view without invoking countView or changing its result', async () => {
  await fixture(async (f) => {
    let counted = 0;
    f.adapter.countView = async () => {
      counted++;
      throw new Error('unused label count failed');
    };
    f.adapter.count = async () => assert.fail('label views must not count records');
    f.adapter.estimateCount = async () => assert.fail('label views must not estimate');
    const run = f.adapter.runView!.bind(f.adapter);
    let result: QueryResult | undefined;
    let snapshot: QueryResult | undefined;
    f.adapter.runView = async (...args) => {
      const rows = await run(...args);
      result = rows;
      snapshot = structuredClone(rows);
      return rows;
    };
    const view = labelView();
    const original = structuredClone(view);
    const answer = await readView(f.adapter, f.schema, view, {}, 'none');
    assert.deepEqual(answer.result.rows, [{ 'party_id.name': 'selected Ada' }]);
    assert.equal(answer.total, undefined);
    assert.equal(answer.limit, 1);
    assert.equal(answer.offset, 0);
    assert.equal(answer.more, true, 'count-free full pages retain the conservative heuristic');
    assert.equal(counted, 0);
    assert.deepEqual(view, original);
    assert.deepEqual(result, snapshot);
    assert.equal(answer.result, result);
    await assert.rejects(readView(f.adapter, f.schema, view), /unused label count failed/);
    assert.equal(counted, 1, 'omitted countMode keeps the exact-count contract');
    assert.deepEqual(result, snapshot, 'a failed default count must not mutate the sibling result');
  });
});

test('count-free readView does not acquire an unused countView getter', async () => {
  await fixture(async (f) => {
    let captured = 0;
    Object.defineProperty(f.adapter, 'countView', {
      configurable: true,
      get() {
        captured++;
        throw new Error('unused count capability unavailable');
      },
    });
    const answer = await readView(f.adapter, f.schema, labelView(), {}, 'none');
    assert.deepEqual(answer.result.rows, [{ 'party_id.name': 'selected Ada' }]);
    assert.equal(answer.total, undefined);
    assert.equal(captured, 0);
  });
});

const readerMethods = ['query', 'count', 'estimateCount', 'runView', 'countView', 'runBreakdown', 'countBreakdown'] as const;
/* `called` defaults to `needed`: a method may be captured up front, before
   any driver wait, and then not be needed after all (a breakdown whose page
   held its last group needs no count). */
const captureCases: Array<{
  operation: string;
  needed: Array<keyof ResourceReader>;
  called?: Array<keyof ResourceReader>;
  run(f: Fixture): Promise<void>;
}> = [
  {
    operation: 'count-free records',
    needed: ['query'],
    run: async (f) => {
      const answer = await readRecords(f.adapter, f.schema, { table: 'child', limit: 2, offset: 0 });
      assert.deepEqual(
        answer.result.rows.map((row) => row.id),
        [20, 30],
      );
      assert.equal(answer.total, undefined);
    },
  },
  {
    operation: 'count-free views',
    needed: ['runView'],
    run: async (f) => {
      const answer = await readView(f.adapter, f.schema, labelView(), {}, 'none');
      assert.deepEqual(answer.result.rows, [{ 'party_id.name': 'selected Ada' }]);
      assert.equal(answer.total, undefined);
    },
  },
  {
    operation: 'exact views',
    needed: ['runView', 'countView'],
    run: async (f) => {
      const answer = await readView(f.adapter, f.schema, labelView());
      assert.deepEqual(answer.result.rows, [{ 'party_id.name': 'selected Ada' }]);
      assert.equal(answer.total, 1);
    },
  },
  {
    operation: 'breakdowns',
    needed: ['runBreakdown', 'countBreakdown'],
    called: ['runBreakdown'],
    run: async (f) => {
      const answer = await readBreakdown(f.adapter, f.schema, { base: 'child', by: [{ path: 'member_id' }], measures: [{ fn: 'count' }] });
      assert.equal(answer.result.rows.length, 2);
      assert.equal(answer.total, 2);
    },
  },
  {
    operation: 'breakdowns with a full page',
    needed: ['runBreakdown', 'countBreakdown'],
    run: async (f) => {
      const answer = await readBreakdown(
        f.adapter,
        f.schema,
        { base: 'child', by: [{ path: 'member_id' }], measures: [{ fn: 'count' }] },
        { limit: 1 },
      );
      assert.equal(answer.result.rows.length, 1);
      assert.equal(answer.total, 2);
    },
  },
  {
    operation: 'single-value breakdowns',
    needed: ['runBreakdown'],
    run: async (f) => {
      const answer = await readBreakdown(f.adapter, f.schema, { base: 'child', by: [], measures: [{ fn: 'count' }] });
      assert.equal(answer.result.rows.length, 1);
      assert.equal(answer.total, 1);
    },
  },
  {
    operation: 'forced exact count despite a refusing statistics getter',
    needed: ['count'],
    run: async (f) => {
      assert.deepEqual(await readCount(f.adapter, f.schema, { table: 'child', exact: true }), { count: 4, exact: true });
    },
  },
  {
    operation: 'filtered count despite a refusing statistics getter',
    needed: ['count'],
    run: async (f) => {
      assert.deepEqual(
        await readCount(f.adapter, f.schema, { table: 'child', filter: { groups: [[{ column: 'member_id', op: '=', value: 1 }]] } }),
        { count: 3, exact: true },
      );
    },
  },
  {
    operation: 'exact record totals despite a refusing statistics getter',
    needed: ['query', 'count'],
    run: async (f) => {
      const answer = await readRecords(f.adapter, f.schema, { table: 'child', limit: 2, offset: 0 }, 'exact');
      assert.equal(answer.result.rows.length, 2);
      assert.deepEqual(answer.total, { count: 4, exact: true });
    },
  },
  {
    operation: 'filtered estimated record totals despite a refusing statistics getter',
    needed: ['query', 'count'],
    run: async (f) => {
      const answer = await readRecords(
        f.adapter,
        f.schema,
        { table: 'child', limit: 2, offset: 0, filter: { groups: [[{ column: 'member_id', op: '=', value: 1 }]] } },
        'estimate',
      );
      assert.deepEqual(
        answer.result.rows.map((row) => row.id),
        [20, 30],
      );
      assert.deepEqual(answer.total, { count: 3, exact: true });
    },
  },
];

for (const { operation, needed, called = needed, run } of captureCases) {
  test(`selective capture: ${operation} never acquires unrelated refusing getters`, async () => {
    await fixture(async (f) => {
      const captures: string[] = [];
      const calls: string[] = [];
      for (const method of readerMethods) {
        const original = Reflect.get(f.adapter, method);
        Object.defineProperty(f.adapter, method, {
          configurable: true,
          get() {
            captures.push(method);
            if (!needed.includes(method)) throw new Refusal(`Unrelated ${method} capability denied`);
            assert.ok(typeof original === 'function', `the fixture must provide ${method}`);
            return function (this: Adapter, ...args: unknown[]) {
              assert.equal(this, f.adapter, 'the selected method retains its original receiver');
              calls.push(method);
              return Reflect.apply(original, this, args);
            };
          },
        });
      }
      await run(f);
      assert.deepEqual(captures.sort(), [...needed].sort(), 'only needed methods are captured, each once');
      assert.deepEqual(calls.sort(), [...called].sort());
    });
  });
}

for (const operation of ['count', 'records'] as const) {
  test(`selective capture: requested ${operation} statistics getter refusal still stops execution without fallback`, async () => {
    await fixture(async (f) => {
      const denied = new Refusal('Requested statistics capability expired');
      let getters = 0;
      const calls: string[] = [];
      f.adapter.query = async () => {
        calls.push('query');
        assert.fail('capture must finish before row reads start');
      };
      f.adapter.count = async () => {
        calls.push('count');
        assert.fail('a capability refusal cannot trigger an exact fallback');
      };
      Object.defineProperty(f.adapter, 'estimateCount', {
        configurable: true,
        get() {
          getters++;
          throw denied;
        },
      });
      await assert.rejects(
        operation === 'count'
          ? readCount(f.adapter, f.schema, { table: 'child' })
          : readRecords(f.adapter, f.schema, { table: 'child', limit: 1, offset: 0 }, 'estimate'),
        (error) => error === denied,
      );
      assert.equal(getters, 1);
      assert.deepEqual(calls, []);
    });
  });
}

test('MCP detail keeps walked labels count-free, exact child counts and stable bounded expansion on its named source', async () => {
  await fixture(async (f) => {
    const requests: QueryRequest[] = [];
    const queried = f.adapter.query.bind(f.adapter);
    f.adapter.query = (request) => {
      requests.push(structuredClone(request));
      return queried(request);
    };
    const counted = f.adapter.count.bind(f.adapter);
    const counts: string[] = [];
    f.adapter.count = async (table, filter) => {
      counts.push(table);
      return counted(table, filter);
    };
    f.adapter.countView = async () => assert.fail('MCP label lookup must not add a view count');
    f.adapter.estimateCount = async () => assert.fail('child counts must remain exact');
    const record = success(await f.call('record', { table: 'member', key: { party_id: 1 }, expand: 2 }));
    assert.equal(record.connection, f.owner);
    assert.equal(record.table, 'member');
    assert.equal(record.found, true);
    assert.equal(record.label, 'selected Ada');
    assert.deepEqual(record.row, { party_id: 1, rank: 7 });
    assert.deepEqual(record.key, { party_id: 1 });
    assert.equal(record.link, `/${f.owner}/member/~1`);
    assert.deepEqual(counts, ['child']);
    assert.equal(record.pointedAtBy.length, 1);
    const child = record.pointedAtBy[0];
    assert.equal(child.table, 'child');
    assert.deepEqual(child.via, ['member_id']);
    assert.equal(child.count, 3);
    assert.equal(child.query, 'child member_id = 1');
    assert.deepEqual(
      child.rows.map((row: { id: number }) => row.id),
      [20, 30],
    );
    assert.equal(record.stats.rowsRead, 3);
    assert.deepEqual(
      requests.map((request) => [request.table, request.limit, request.offset]),
      [
        ['member', 1, 0],
        ['child', 2, 0],
      ],
    );
    assert.deepEqual(requests[1].orderBy, [
      { column: 'updated_at', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
    const next = success(await f.call('record', { table: 'member', key: { party_id: 1 }, expand: 2 }));
    assert.deepEqual(next.pointedAtBy, record.pointedAtBy);
    const unexpanded = success(await f.call('record', { table: 'member', key: { party_id: 1 } }));
    assert.equal(unexpanded.pointedAtBy[0].count, 3);
    assert.equal(Object.hasOwn(unexpanded.pointedAtBy[0], 'rows'), false);
    assert.equal(unexpanded.stats.rowsRead, 1);
  });
});

test('MCP detail batches preserve requested root order and missing roots without extra counts', async () => {
  await fixture(async (f) => {
    const count = f.adapter.count.bind(f.adapter);
    let counted = 0;
    f.adapter.count = async (...args) => {
      counted++;
      return count(...args);
    };
    f.adapter.countView = async () => assert.fail('walked labels must not count views');
    const batch = success(
      await f.call('record', { table: 'member', keys: [{ party_id: 2 }, { party_id: 1 }, { party_id: 999 }], expand: 2 }),
    );
    assert.equal(batch.connection, f.owner);
    assert.deepEqual(
      batch.records.map((record: { key: unknown }) => record.key),
      [{ party_id: 2 }, { party_id: 1 }, { party_id: 999 }],
    );
    assert.deepEqual(
      batch.records.map((record: { label?: string }) => record.label),
      ['selected Grace', 'selected Ada', undefined],
    );
    assert.deepEqual(batch.records[2], { key: { party_id: 999 }, found: false });
    assert.deepEqual(
      batch.records[0].pointedAtBy[0].rows.map((row: { id: number }) => row.id),
      [40],
    );
    assert.equal(counted, 2);
    assert.equal(batch.stats.rowsRead, 5, 'two found roots plus three expanded children, not label/count work');
  });
});

test('MCP value sweep retains stable capped evidence, named-source binding and no counts', async () => {
  await fixture(async (f) => {
    const requests: QueryRequest[] = [];
    const query = f.adapter.query.bind(f.adapter);
    f.adapter.query = (request) => {
      requests.push(structuredClone(request));
      return query(request);
    };
    f.adapter.count = async () => assert.fail('value sweeps must not count');
    f.adapter.countView = async () => assert.fail('value sweeps must not count views');
    f.adapter.estimateCount = async () => assert.fail('value sweeps must not estimate');
    const first = success(await f.call('find', { value: 'needle' }));
    assert.equal(first.connection, f.owner);
    assert.deepEqual(
      first.matches.map((match: { key: unknown }) => match.key),
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
    );
    for (const match of first.matches) {
      assert.equal(match.table, 'search_row');
      assert.deepEqual(match.columns, ['text']);
      assert.equal(match.values.text, `needle selected ${match.key.id}`);
    }
    assert.deepEqual(first.moreIn, ['search_row']);
    assert.equal(first.searched, 3);
    assert.equal(first.withoutText, 1);
    assert.equal(first.failed, undefined);
    assert.equal(first.stopped, undefined);
    assert.equal(first.stats.rowsRead, 5);
    const request = requests.find((request) => request.table === 'search_row')!;
    assert.deepEqual(request.orderBy, [{ column: 'id', direction: 'asc' }]);
    assert.equal(request.limit, 6, 'the sweep still fetches one extra row to prove truncation');
    const second = success(await f.call('find', { value: 'needle' }));
    assert.deepEqual(second.matches, first.matches);
    assert.deepEqual(second.moreIn, first.moreIn);
  });
});

test('MCP detail and sweep preserve their existing per-table failure orchestration', async () => {
  await fixture(async (f) => {
    const query = f.adapter.query.bind(f.adapter);
    f.adapter.query = (request) => (request.table === 'search_row' ? Promise.reject(new Error('search rows unavailable')) : query(request));
    f.adapter.count = async () => {
      throw new Error('child counts unavailable');
    };
    const record = success(await f.call('record', { table: 'member', key: { party_id: 1 }, expand: 2 }));
    assert.equal(record.label, 'selected Ada');
    assert.deepEqual(record.pointedAtBy, []);
    assert.equal(record.stats.rowsRead, 1);
    const sweep = success(await f.call('find', { value: 'needle' }));
    assert.deepEqual(sweep.matches, []);
    assert.deepEqual(sweep.failed, [{ table: 'search_row', reason: 'search rows unavailable' }]);
    assert.equal(sweep.searched, 2);
    assert.equal(sweep.stats.rowsRead, 0);
  });
});
