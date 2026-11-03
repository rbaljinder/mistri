import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal, type Adapter, type QueryResult } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import {
  readBreakdown,
  readCount,
  readRecords,
  readView,
  type ResourceReader,
} from '../packages/engine/src/server/resourceReadOperations.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

type Fixture = {
  adapter: Adapter;
  schema: DatabaseSchema;
  owner: string;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-resource-detail-'));
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
    await run({ adapter, schema, owner });
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
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
