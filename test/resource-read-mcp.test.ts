import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MAX_LIMIT, Refusal, type Adapter, type QueryResult } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { runTool } from '../packages/tablewalk/src/server/mcp.js';

type Reply = Awaited<ReturnType<typeof runTool>>;
type Kind = 'records' | 'view' | 'breakdown';
type Fixture = {
  adapter: Adapter;
  owner: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<Reply>;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-resource-read-mcp-'));
  const owner = basename(directory);
  const database = new DatabaseSync(join(directory, 'reads.db'));
  const registry = new Registry();
  try {
    database.exec(`
      CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE item (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer(id),
        name TEXT NOT NULL, status TEXT NOT NULL, amount INTEGER NOT NULL);
      INSERT INTO customer VALUES (1, 'Ada'), (2, 'Grace');
    `);
    const insert = database.prepare('INSERT INTO item VALUES (?, ?, ?, ?, ?)');
    for (let id = 24; id > 0; id--) insert.run(id, (id % 2) + 1, `Item ${id}`, `status-${id % 4}`, id * 10);
    registry.add({ id: owner, name: owner, url: join(directory, 'reads.db'), source: 'config' });
    const { adapter } = await registry.open(owner);
    await run({ adapter, owner, call: (name, args = {}) => runTool(registry, name, { connection: owner, ...args }) });
  } finally {
    await registry.closeAll();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function successful(reply: Reply) {
  assert.equal(reply.isError, false, JSON.stringify(reply));
  assert.ok(reply.structuredContent, JSON.stringify(reply));
  assert.equal(reply.structuredContent.errors, undefined, JSON.stringify(reply));
  assert.equal(reply.content[0].text, JSON.stringify(reply.structuredContent));
  return reply.structuredContent;
}

function failed(reply: Reply) {
  assert.equal(reply.isError, true, JSON.stringify(reply));
  assert.equal(reply.structuredContent, undefined);
  assert.equal(reply.content.length, 1);
  assert.equal(reply.content[0].type, 'text');
  assert.doesNotMatch(reply.content[0].text, /Item \d|Ada|Grace/);
}

const cases: Record<Kind, { tool: string; q: string; total: number }> = {
  records: { tool: 'query', q: 'item show id, status sort id asc', total: 24 },
  view: { tool: 'query', q: 'item show id, customer_id.name sort id asc', total: 24 },
  breakdown: { tool: 'breakdown', q: 'item count, sum amount as billed by status sort status asc', total: 4 },
};

function watch(
  adapter: Adapter,
  kind: Kind,
  hooks: {
    beforeRows?: () => Promise<void>;
    afterRows?: (result: QueryResult) => void;
    beforeCount?: () => Promise<void>;
    afterCount?: (count: number) => void;
  },
) {
  function wrapped<A extends unknown[], R>(method: (...args: A) => Promise<R>, before?: () => Promise<void>, after?: (result: R) => void) {
    return async (...args: A): Promise<R> => {
      await before?.();
      const result = await method(...args);
      after?.(result);
      return result;
    };
  }
  if (kind === 'records') {
    adapter.query = wrapped(adapter.query.bind(adapter), hooks.beforeRows, hooks.afterRows);
    adapter.count = wrapped(adapter.count.bind(adapter), hooks.beforeCount, hooks.afterCount);
  } else if (kind === 'view') {
    adapter.runView = wrapped(adapter.runView!.bind(adapter), hooks.beforeRows, hooks.afterRows);
    adapter.countView = wrapped(adapter.countView!.bind(adapter), hooks.beforeCount, hooks.afterCount);
  } else {
    adapter.runBreakdown = wrapped(adapter.runBreakdown!.bind(adapter), hooks.beforeRows, hooks.afterRows);
    adapter.countBreakdown = wrapped(adapter.countBreakdown!.bind(adapter), hooks.beforeCount, hooks.afterCount);
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('MCP record reads use an exact filtered count and stable key ties, preserving explanation and SQL', async () => {
  await fixture(async (f) => {
    let counts = 0;
    watch(f.adapter, 'records', {
      afterCount: () => {
        counts++;
      },
    });
    f.adapter.estimateCount = async () => {
      assert.fail('MCP query must never substitute an estimate');
    };
    const defaultPage = successful(await f.call('query', { q: 'item' }));
    assert.equal(defaultPage.total, 24);
    assert.equal((defaultPage.rows as unknown[]).length, 20);
    const q = 'item amount >= 100 show id, status sort status asc limit 3';
    const answer = successful(await f.call('query', { q }));
    assert.equal(counts, 2);
    assert.equal(answer.connection, f.owner);
    assert.equal(answer.total, 15);
    assert.equal(answer.offset, 0);
    assert.deepEqual(answer.columns, ['id', 'status']);
    assert.deepEqual(
      answer.rows,
      [12, 16, 20].map((id) => ({ id, status: 'status-0' })),
    );
    assert.match(String(answer.explain), /amount|100/);
    assert.equal(answer.link, `/${f.owner}/${encodeURIComponent(q)}`);
    const sql = answer.sql as QueryResult['sql'];
    assert.match(sql.text, /ORDER BY "status" ASC, "id" ASC/);
    assert.deepEqual(sql.params, [100, 3, 0]);
    assert.equal((answer.stats as { rowsRead: number }).rowsRead, 3);
  });
});

for (const kind of Object.keys(cases) as Kind[]) {
  const { tool, q, total } = cases[kind];

  test(`MCP ${kind} preserves default 20, clause/argument precedence, normalized paging and output fields`, async () => {
    await fixture(async (f) => {
      /* A grouped breakdown reads one group past its page: when it does not
         come back, the groups ended there and no count statement is needed. */
      const peek = kind === 'breakdown' ? 1 : 0;
      const defaultPage = successful(await f.call(tool, { q }));
      assert.deepEqual((defaultPage.sql as QueryResult['sql']).params.slice(-2), [20 + peek, 0]);
      assert.equal(defaultPage.total, total);
      assert.equal((defaultPage.rows as unknown[]).length, Math.min(20, total));
      const clause = successful(await f.call(tool, { q: `${q} limit 3` }));
      assert.equal((clause.rows as unknown[]).length, 3);
      const page = successful(await f.call(tool, { q: `${q} limit 3`, limit: '2.9', offset: '1.9' }));
      assert.equal(page.total, total);
      assert.deepEqual(page.rows, (clause.rows as unknown[]).slice(1, 3));
      assert.deepEqual((page.sql as QueryResult['sql']).params.slice(-2), [2 + peek, 1]);
      assert.equal((page.stats as { rowsRead: number }).rowsRead, 2);
      const keys = ['connection', 'rows', 'columns', 'total', 'sql', 'stats'];
      if (kind === 'breakdown') keys.push('resolved', 'offset');
      else keys.push('link');
      if (kind === 'records') keys.push('explain', 'offset');
      assert.deepEqual(Object.keys(page).sort(), keys.sort());
      if (kind !== 'view') assert.equal(page.offset, 1);
      const bounded = successful(await f.call(tool, { q, limit: MAX_LIMIT + 100, offset: -3 }));
      assert.deepEqual((bounded.sql as QueryResult['sql']).params.slice(-2), [MAX_LIMIT, 0]);
      assert.equal((bounded.rows as unknown[]).length, total);
      const empty = successful(await f.call(tool, { q, limit: 1, offset: 100 }));
      assert.deepEqual(empty.rows, []);
      assert.equal(empty.total, total);
    });
  });

  test(`MCP ${kind} rejects malformed pagination before any row or count read`, async () => {
    await fixture(async (f) => {
      let reads = 0;
      watch(f.adapter, kind, {
        beforeRows: async () => {
          reads++;
        },
        beforeCount: async () => {
          reads++;
        },
      });
      for (const field of ['limit', 'offset']) {
        for (const value of [[], {}, true, 'bad-page', NaN, Infinity, -Infinity]) {
          const reply = await f.call(tool, { q, [field]: value });
          failed(reply);
          assert.equal(reads, 0, `${kind} ${field}=${String(value)} must fail closed`);
        }
      }
    });
  });

  // A breakdown asks for its count only after its rows, and only when the page is full (below).
  if (kind !== 'breakdown')
    for (const failing of ['rows', 'count'] as const) {
      test(`MCP ${kind} waits for its sibling after ${failing} rejects and returns no partial result`, async () => {
        await fixture(async (f) => {
          const pending = gate();
          const started = gate();
          const failureSeen = gate();
          let siblingSettled = false;
          let returned = false;
          let rows: QueryResult | undefined;
          let original: QueryResult | undefined;
          const reject = async () => {
            failureSeen.release();
            throw new Refusal('read capability expired');
          };
          const hold = async () => {
            started.release();
            await pending.promise;
          };
          watch(f.adapter, kind, {
            beforeRows: failing === 'rows' ? reject : hold,
            beforeCount: failing === 'count' ? reject : hold,
            afterRows: (result) => {
              rows = result;
              original = structuredClone(result);
              siblingSettled = true;
            },
            afterCount: () => {
              siblingSettled = true;
            },
          });
          const request = f.call(tool, { q, limit: 2 }).then((reply) => {
            returned = true;
            return reply;
          });
          try {
            await Promise.all([started.promise, failureSeen.promise]);
            await nextTurn();
            assert.equal(returned, false, 'the accepted sibling still owns this invocation');
            assert.equal(siblingSettled, false);
          } finally {
            pending.release();
          }
          const reply = await request;
          assert.equal(siblingSettled, true);
          failed(reply);
          assert.match(reply.content[0].text, /read capability expired/);
          assert.deepEqual(rows, original, 'failure must not trim or annotate the adapter result');
          const connections = successful(await f.call('connections'));
          const connection = (connections.connections as Array<{ id: string; rowsReadThisSession: number }>).find(
            (value) => value.id === f.owner,
          )!;
          assert.equal(connection.rowsReadThisSession, 0, 'undelivered rows must not enter egress statistics');
        });
      });
    }
}

for (const failing of ['rows', 'count'] as const) {
  test(`MCP breakdown whose ${failing} rejects returns no partial result, and counts only after its rows`, async () => {
    await fixture(async (f) => {
      const order: string[] = [];
      let original: QueryResult | undefined;
      let rows: QueryResult | undefined;
      const reject = async () => {
        throw new Refusal('read capability expired');
      };
      watch(f.adapter, 'breakdown', {
        beforeRows: async () => {
          order.push('rows');
          if (failing === 'rows') await reject();
        },
        beforeCount: async () => {
          order.push('count');
          if (failing === 'count') await reject();
        },
        afterRows: (result) => {
          rows = result;
          original = structuredClone(result);
        },
      });
      // Two of four groups: the page is full, so the count is needed.
      const reply = await f.call('breakdown', { q: cases.breakdown.q, limit: 2 });
      failed(reply);
      assert.match(reply.content[0].text, /read capability expired/);
      assert.deepEqual(order, failing === 'rows' ? ['rows'] : ['rows', 'count']);
      assert.deepEqual(rows, original, 'failure must not trim or annotate the adapter result');
      const connections = successful(await f.call('connections'));
      const connection = (connections.connections as Array<{ id: string; rowsReadThisSession: number }>).find(
        (value) => value.id === f.owner,
      )!;
      assert.equal(connection.rowsReadThisSession, 0, 'undelivered rows must not enter egress statistics');
    });
  });
}

test('MCP breakdown whose page holds the last group reads no count, and a single value never does', async () => {
  await fixture(async (f) => {
    let counts = 0;
    watch(f.adapter, 'breakdown', {
      beforeCount: async () => {
        counts++;
      },
    });
    const all = successful(await f.call('breakdown', { q: cases.breakdown.q }));
    assert.equal(all.total, 4);
    const scalar = successful(await f.call('breakdown', { q: 'item sum amount as billed' }));
    assert.equal(scalar.total, 1);
    assert.equal(counts, 0);
  });
});

test('MCP dotted views and aggregate views retain real values, exact totals and parser diagnostics', async () => {
  await fixture(async (f) => {
    const view = successful(await f.call('query', { q: cases.view.q, limit: 2 }));
    assert.deepEqual(view.rows, [
      { id: 1, 'customer_id.name': 'Grace' },
      { id: 2, 'customer_id.name': 'Ada' },
    ]);
    const aggregate = successful(
      await f.call('query', {
        q: 'customer show name count item via customer_id as items sort items desc limit 1',
      }),
    );
    assert.equal(aggregate.total, 2);
    assert.equal((aggregate.rows as Array<{ items: number }>)[0].items, 12);
    let reads = 0;
    for (const kind of Object.keys(cases) as Kind[]) {
      watch(f.adapter, kind, {
        beforeRows: async () => {
          reads++;
        },
        beforeCount: async () => {
          reads++;
        },
      });
    }
    for (const [tool, q, message] of [
      ['query', 'item amont = 10', /amount/],
      ['query', 'item show missing_column', /missing_column/],
      ['query', 'item show customer_id.missing_column', /missing_column/],
      ['query', 'customer items > 1 count item via customer_id as items', /a filter runs before it exists/],
      ['query', 'item count by status', /Call `breakdown`/],
      ['breakdown', 'item count by missing_column', /missing_column/],
    ] as const) {
      const reply = await f.call(tool, { q });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      assert.ok(reply.structuredContent);
      assert.equal(reply.structuredContent.rows, undefined);
      assert.match(String(reply.structuredContent.errors), message);
      if (q === 'item amont = 10') assert.ok((reply.structuredContent.columns as string[]).includes('amount'));
    }
    assert.equal(reads, 0, 'invalid text must not broaden into a table read');
  });
});

test('MCP breakdown totals count groups and preserve measure metadata', async () => {
  await fixture(async (f) => {
    const answer = successful(await f.call('breakdown', { q: cases.breakdown.q, limit: 1, offset: 1 }));
    assert.equal(answer.total, 4);
    assert.deepEqual(answer.rows, [{ status: 'status-1', count: 6, billed: 660 }]);
    assert.deepEqual(answer.columns, ['status', 'count', 'billed']);
    const resolved = answer.resolved as Array<{ kind: string; fn?: string }>;
    assert.deepEqual(
      resolved.map((column) => column.kind),
      ['key', 'measure', 'measure'],
    );
    assert.equal(resolved[2].fn, 'sum');
  });
});

for (const kind of ['view', 'breakdown'] as const) {
  test(`MCP ${kind} keeps optional counts absent without dropping a returned row`, async () => {
    await fixture(async (f) => {
      if (kind === 'view') f.adapter.countView = undefined;
      else f.adapter.countBreakdown = undefined;
      const { tool, q } = cases[kind];
      let original: QueryResult | undefined;
      let rows: QueryResult | undefined;
      const capture = (result: QueryResult) => {
        rows = result;
        original = structuredClone(result);
      };
      if (kind === 'view') {
        const run = f.adapter.runView!.bind(f.adapter);
        f.adapter.runView = async (...args) => {
          const result = await run(...args);
          capture(result);
          return result;
        };
      } else {
        const run = f.adapter.runBreakdown!.bind(f.adapter);
        f.adapter.runBreakdown = async (...args) => {
          const result = await run(...args);
          capture(result);
          return result;
        };
      }
      const reply = await f.call(tool, { q, limit: 2 });
      const answer = successful(reply);
      assert.equal(answer.total, undefined);
      assert.equal(Object.hasOwn(JSON.parse(reply.content[0].text), 'total'), false);
      assert.equal((answer.rows as unknown[]).length, 2);
      assert.deepEqual(rows, original);
    });
  });
}

test('MCP exact count retains its captured filter and method if the row reader mutates its own request', async () => {
  await fixture(async (f) => {
    const run = f.adapter.query.bind(f.adapter);
    let counted = 0;
    const count = f.adapter.count.bind(f.adapter);
    f.adapter.count = async (table, filter) => {
      counted++;
      return count(table, filter);
    };
    f.adapter.query = (request) => {
      const result = run(request);
      request.filter!.groups[0][0].value = 0;
      request.offset = 900;
      f.adapter.count = async () => {
        assert.fail('count method must be captured before row reads wait');
      };
      return result;
    };
    const answer = successful(await f.call('query', { q: 'item amount >= 200 show id sort id asc limit 2' }));
    assert.equal(counted, 1);
    assert.equal(answer.total, 5);
    assert.equal(answer.offset, 0);
    assert.deepEqual(answer.rows, [{ id: 20 }, { id: 21 }]);
  });
});
