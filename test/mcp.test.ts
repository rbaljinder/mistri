/**
 * The MCP server, spoken to the way a client speaks to it.
 *
 * One subprocess for the whole suite, driven over stdio with real
 * newline-delimited JSON-RPC — the same bytes an agent's client sends. Not a
 * protocol conformance suite; these pin the four things that matter and
 * break silently: the handshake answers a version we actually know, every
 * declared tool runs, the language's errors keep their suggestions (that is
 * what makes an agent's retry loop converge), and the write path does not
 * exist — asserted against the database file, not against a message.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { makeDemoDatabase } from './make-demo-db.js';

const dir = mkdtempSync(join(tmpdir(), 'tablewalk-mcp-'));
const DB = join(dir, 'demo.db');
/* A second copy the write tests may change, behind a connection whose config
   says so. The read-only copy stays first, and therefore the default — every
   read test runs against a database the write tests cannot have touched. */
const SCRATCH_DB = join(dir, 'scratch.db');
/* The same database one migration later, for the diff. */
const MIGRATED_DB = join(dir, 'migrated.db');
const CONFIG = join(dir, 'tablewalk.json');
/* A reference to a unique column that is not the key: stock moves name their product by sku. */
const CODED_DB = join(dir, 'coded.db');

let child: ChildProcess;
let nextId = 1;
const pending = new Map<number, (message: Record<string, unknown>) => void>();
/** Server-initiated messages, in arrival order — the harness's ear for
    notifications, which carry no id and answer nothing. */
const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin!.write(line);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`No answer to ${method} within 10s`));
    }, 10_000);
  });
}

/** A tools/call, unwrapped to its structured result — or asserted broken. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const reply = await call('tools/call', { name, arguments: args });
  const result = reply.result as { structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return result.structuredContent!;
}

before(async () => {
  makeDemoDatabase(DB);
  cpSync(DB, SCRATCH_DB);
  cpSync(DB, MIGRATED_DB);
  {
    const migrated = new DatabaseSync(MIGRATED_DB);
    migrated.exec('ALTER TABLE customer ADD COLUMN loyalty_tier TEXT');
    migrated.exec('ALTER TABLE customer DROP COLUMN email');
    migrated.close();
  }
  {
    const coded = new DatabaseSync(CODED_DB);
    coded.exec(`CREATE TABLE product (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT);
      CREATE TABLE stock_move (id INTEGER PRIMARY KEY, product_sku TEXT REFERENCES product(sku), qty INTEGER);
      INSERT INTO product VALUES (1, 'LNT-01', 'Lantern'), (2, 'RPE-02', 'Rope');
      INSERT INTO stock_move VALUES (1, 'LNT-01', 4), (2, 'LNT-01', -1), (3, 'RPE-02', 2);`);
    coded.close();
  }
  writeFileSync(
    CONFIG,
    JSON.stringify({
      connections: [
        { name: 'readonly', url: DB },
        { name: 'scratch', url: SCRATCH_DB, writable: true },
        { name: 'migrated', url: MIGRATED_DB },
        { name: 'coded', url: CODED_DB },
      ],
      /* The shelf: what a team writes down. An agent that cannot see these
       re-derives them badly. */
      queries: [
        {
          name: 'Big invoices',
          sql: 'select id, total from invoice where total > 500',
          description: 'Anything over five hundred',
          connection: 'readonly',
        },
      ],
      pages: [
        {
          label: 'Customer overview',
          base: 'customer',
          connection: 'readonly',
          sections: [{ kind: 'fields', show: ['name', 'email'] }],
        },
      ],
    }),
  );
  /* Through tsx, the way every other entry point runs: the source imports
     `.ts` files under `.js` specifiers, which node's own type-stripping does
     not resolve. stderr is inherited — it is the server's log channel, and a
     child that dies should say why in the test output. */
  child = spawn(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', CONFIG, '--mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined && message.method) {
        notifications.push({ method: message.method, params: message.params ?? {} });
        continue;
      }
      const resolve = message.id !== undefined ? pending.get(message.id) : undefined;
      if (resolve) {
        pending.delete(message.id!);
        resolve(message as Record<string, unknown>);
      }
    }
  });
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('the MCP server', () => {
  test('the handshake answers a version it knows, and names its tools', async () => {
    const init = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const result = init.result as {
      protocolVersion: string;
      capabilities: { tools?: object; resources?: object };
      serverInfo: { name: string };
    };
    assert.equal(result.protocolVersion, '2025-11-25');
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.resources, 'resources are declared, not just answered');
    assert.equal(result.serverInfo.name, 'tablewalk');

    // A version we have never heard of gets the newest we speak, not an error.
    const listed = await call('tools/list');
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.deepEqual(names, [
      'connections',
      'refresh',
      'schema_summary',
      'tables',
      'table',
      'find',
      'query',
      'breakdown',
      'sql',
      'explain',
      'profile',
      'diff',
      'order',
      'fixture',
      'lint',
      'change_impact',
      'record',
      'update',
      'insert',
      'delete',
      'insert_graph',
      'delete_graph',
      'revert',
    ]);
  });

  test('every tool carries machine-readable hints, and no output schema by default', async () => {
    /* The annotations are what let a client relax: a hint that says
       read-only, idempotent, closed-world is permission to stop prompting a
       human for every look. So the read tools must all say it, the write
       tools must all deny it, and every tool must declare what its answer
       looks like — a drifted hint here is worse than none. */
    const listed = await call('tools/list');
    const tools = (
      listed.result as {
        tools: Array<{
          name: string;
          annotations?: Record<string, unknown>;
          outputSchema?: { type?: string; properties?: Record<string, unknown> };
        }>;
      }
    ).tools;
    for (const t of tools) {
      const writes = ['update', 'insert', 'delete', 'revert', 'insert_graph', 'delete_graph'].includes(t.name);
      /* insert writes without destroying: it adds. The split is the point of
         having two hints instead of one "dangerous" bit. */
      const destroys = ['update', 'delete', 'delete_graph', 'revert'].includes(t.name);
      assert.equal(t.annotations?.readOnlyHint, !writes, `${t.name} says whether it only reads`);
      assert.equal(t.annotations?.destructiveHint, destroys, `${t.name} says whether it destroys`);
      assert.equal(t.annotations?.openWorldHint, false, `${t.name} touches the database, not the world`);
      /* And no `outputSchema`, which is off by default. It was half of an
         8,500-token listing that every agent pays for on connect, before it
         has asked anything — and a contract most of them never read. The
         answers carry the same fields either way; `--output-schema` puts the
         declaration back for a client that validates against it. */
      assert.equal(t.outputSchema, undefined, `${t.name} does not advertise its shape by default`);
    }
  });

  test('tables carries approximate rows, sqlite included', async () => {
    const listed = await tool('tables');
    const tables = listed.tables as Array<{ id: string; approxRows?: number; isView?: boolean }>;
    const customer = tables.find((t) => t.id === 'customer');
    assert.equal(customer?.approxRows, 5, 'the demo customer table has five rows, and says so');
    /* Counting a view runs its query, and a view is allowed to be
       expensive — so views stay honestly uncounted. */
    const view = tables.find((t) => t.isView);
    assert.ok(view, 'the demo schema has a view');
    assert.equal(view!.approxRows, undefined);
  });

  test('schema_summary orients in names and numbers, never column dumps', async () => {
    const summary = await tool('schema_summary');
    assert.equal(summary.dialect, 'sqlite');
    assert.equal(summary.tables, 8);
    assert.ok((summary.deepestWalk as string[]).length >= 2, 'the walk has depth');
    assert.ok((summary.recordsEventsIn as string[]).includes('shipment'));
    /* The whole answer stays orientation-sized. A regression that starts
       serialising TableMeta objects again blows through this immediately. */
    assert.ok(JSON.stringify(summary).length < 2000, 'the summary is a paragraph, not a schema dump');
  });

  test('arguments are checked against the declared shape, and the error names the fix', async () => {
    /* `additionalProperties: false` and `required` were advertised and then
       ignored: a misspelled argument vanished and the error was about the
       one that was missing. Now the stray key is named, with a guess. */
    const stray = await call('tools/call', { name: 'query', arguments: { qeury: 'customer' } });
    const strayResult = stray.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(strayResult.isError, true);
    assert.match(strayResult.content[0].text, /unknown argument "qeury" \(did you mean "q"\?\)\. It takes: q, limit, offset, connection/);

    const missing = await call('tools/call', { name: 'query', arguments: {} });
    assert.match((missing.result as { content: Array<{ text: string }> }).content[0].text, /missing "q", which is required/);

    const typed = await call('tools/call', { name: 'query', arguments: { q: ['customer'] } });
    assert.match((typed.result as { content: Array<{ text: string }> }).content[0].text, /"q" should be string, not an array/);

    // Coercions the handlers already make still pass: a numeric string, a comma list.
    const lenient = await tool('query', { q: 'customer', limit: '2' });
    assert.equal((lenient.rows as unknown[]).length, 2);
    // And `connection` is every tool's, whether or not its own schema spells it out.
    const scoped = await tool('diff', { to: 'demo', connection: 'demo' }).catch((e: Error) => e.message);
    assert.ok(typeof scoped !== 'string' || !/unknown argument "connection"/.test(scoped));
  });

  test('table takes the same argument name as every other table-scoped tool', async () => {
    /* `table`, as `profile`, `lint`, `change_impact`, `record` and `fixture`
       take it, and nothing else: the tool an agent reaches for first has no
       second spelling to learn. */
    const byTable = await tool('table', { table: 'invoice' });
    assert.equal(byTable.table, 'invoice');

    const byName = (await call('tools/call', { name: 'table', arguments: { name: 'invoice' } })).result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(byName.isError, true);
    assert.match(byName.content[0].text, /unknown argument "name"/);

    const neither = (await call('tools/call', { name: 'table', arguments: {} })).result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(neither.isError, true);
    assert.match(neither.content[0].text, /missing "table", which is required/);
  });

  test('table answers both directions of the foreign keys', async () => {
    const table = await tool('table', { table: 'customer' });
    const pointedAtBy = table.pointedAtBy as Array<{ table: string }>;
    assert.ok(
      pointedAtBy.some((r) => r.table === 'invoice'),
      'invoice points at customer',
    );
    assert.ok(String(table.ddl).includes('CREATE TABLE'));
    // An unknown table is a tool error that says where to look, not a crash.
    const reply = await call('tools/call', { name: 'table', arguments: { table: 'nonesuch' } });
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown table "nonesuch"/);
  });

  test('query runs the language, and its own limit clause is honoured', async () => {
    const q = await tool('query', { q: 'invoice total >= 100 sort total desc limit 3' });
    assert.equal((q.rows as unknown[]).length, 3);
    assert.ok(typeof q.total === 'number' && q.total >= 3);
    assert.match((q.sql as { text: string }).text, /SELECT/i);
    /* A path, not a fragment — the UI's links stopped being hash routes. */
    assert.ok(String(q.link).startsWith('/'));
    /* Every answer says what it cost. `rowsWritten` is deliberately absent
       until writes exist, so its appearance will mean something. */
    const stats = q.stats as { ms: number; rowsRead: number };
    assert.ok(typeof stats.ms === 'number' && stats.ms >= 0);
    assert.equal(stats.rowsRead, 3);
    assert.ok(!('rowsWritten' in stats));
  });

  test('an unknown column answers with the real columns, not a dead end', async () => {
    /* "sales_order_id" against "order_id" is too far for a nearest-match
       suggestion; without the column list the agent pays a second round trip
       to \`table\` to learn what it should have typed. */
    const q = await tool('query', { q: 'invoice invoice_number = 7' });
    assert.ok((q.errors as string[]).length >= 1);
    assert.ok((q.columns as string[]).includes('customer_id'));
  });

  test('table says what a column is allowed to hold', async () => {
    const described = await tool('table', { table: 'invoice' });
    const columns = described.columns as Array<{ name: string; allowed?: string[] }>;
    const status = columns.find((c) => c.name === 'status');
    /* A TEXT column with a CHECK is how most schemas spell an enum; without
       reading the check, this is indistinguishable from free text and an
       agent filtering on 'OPEN' gets an empty result that looks like an
       empty table. */
    assert.deepEqual(status?.allowed, ['draft', 'issued', 'paid', 'void']);
    assert.equal(columns.find((c) => c.name === 'total')?.allowed, undefined);
  });

  test('find with a value sweeps the data, and accounts for the sweep', async () => {
    const found = await tool('find', { value: 'Harbour' });
    const matches = found.matches as Array<{ table: string; columns: string[]; key?: { id: number } }>;
    const customer = matches.find((m) => m.table === 'customer');
    assert.ok(customer, 'the value was found where it lives');
    assert.ok(customer!.columns.includes('name'), 'and the matching column is named');
    assert.equal(customer!.key?.id, 1, 'the key makes the match walkable');
    /* Rows that matched left the machine, and the ledger says so. */
    assert.equal((found.stats as { rowsRead: number }).rowsRead, matches.length);
    /* An empty answer is only "not in this database" when nothing failed and
       nothing stopped it, so all three have to be readable. */
    assert.ok(typeof found.searched === 'number' && (found.searched as number) >= 5);
    assert.equal(found.failed, undefined);
    assert.equal(found.stopped, undefined);
  });

  test('a wildcard in the value searched for a wildcard', async () => {
    /* `%` used to match every row and report each one with no columns and no
       values — forty matches naming nothing, and the cap exhausted before
       any real table was reached. */
    const found = await tool('find', { value: '%' });
    assert.deepEqual(found.matches, []);
    assert.equal(found.stopped, undefined, 'and it got all the way through');
  });

  test('diff says which side each difference is on', async () => {
    const changed = await tool('diff', { to: 'migrated' });
    assert.equal(changed.same, false);
    const tables = changed.tables as Array<{ table: string; columnsOnlyLeft?: string[]; columnsOnlyRight?: string[] }>;
    const customer = tables.find((t) => t.table === 'customer')!;
    assert.deepEqual(customer.columnsOnlyLeft, ['email'], 'the column the migration dropped');
    assert.deepEqual(customer.columnsOnlyRight, ['loyalty_tier'], 'and the one it added');
    assert.equal(changed.from, 'readonly');

    /* Two copies of the same database are the same shape, which is the
       answer a deploy check is hoping for. */
    const identical = await tool('diff', { connection: 'readonly', to: 'scratch' });
    assert.equal(identical.same, true);
    assert.deepEqual(identical.tables, []);

    const itself = await call('tools/call', { name: 'diff', arguments: { to: 'readonly' } });
    assert.equal((itself.result as { isError: boolean }).isError, true, 'a connection against itself teaches nothing');
  });

  test('fixture takes a row and everything it needs to exist', async () => {
    const taken = await tool('fixture', { table: 'invoice', key: { id: 1001 } });
    const tables = taken.tables as Array<{ table: string; rows: Array<Record<string, unknown>> }>;
    const order = taken.order as string[];

    /* The rule the whole feature exists to satisfy: inserted in this order,
       nothing dangles. An invoice needs its customer; the customer needs its
       country. */
    assert.ok(order.indexOf('country') < order.indexOf('customer'), order.join(' → '));
    assert.ok(order.indexOf('customer') < order.indexOf('invoice'), order.join(' → '));
    assert.equal(tables.find((t) => t.table === 'invoice')?.rows.length, 1);
    assert.equal(tables.find((t) => t.table === 'customer')?.rows[0].id, 1);

    /* Ready to paste, in the same order, with values as literals — this is a
       document, not a statement the server runs. */
    const sql = String(taken.sql);
    assert.ok(sql.indexOf('INSERT INTO "customer"') < sql.indexOf('INSERT INTO "invoice"'));
    assert.match(sql, /'Harbour Freight'/);

    /* The manager chain is the subtle one: `employee.manager_id` points at
       `employee`, so the rows inside that table have an order of their own —
       Ada before Miles before Rina — and a fixture that inserts a report
       before their manager fails on the constraint this exists to respect. */
    const employees = tables.find((t) => t.table === 'employee')!.rows.map((r) => r.id);
    assert.deepEqual(employees, [1, 2, 3]);
    /* Every row it read left the machine, and the ledger says so. */
    assert.equal((taken.stats as { rowsRead: number }).rowsRead > 0, true);
  });

  test('fixture takes the children too when asked, with their own references', async () => {
    const taken = await tool('fixture', {
      table: 'invoice',
      key: { id: 1001 },
      children: true,
      per_child: 2,
    });
    const tables = taken.tables as Array<{ table: string; rows: unknown[] }>;
    const lines = tables.find((t) => t.table === 'invoice_line');
    assert.ok(lines, 'the rows pointing at it are taken');

    /* And what those children point at comes with them: a line references a
       product, and a fixture missing it does not load. */
    assert.ok(
      tables.some((t) => t.table === 'product'),
      tables.map((t) => t.table).join(', '),
    );
    assert.ok((taken.order as string[]).indexOf('product') < (taken.order as string[]).indexOf('invoice_line'));

    /* Capped per relationship, and it says so rather than implying the
       invoice has exactly two lines. */
    assert.ok((taken.truncated as string[] | undefined)?.some((t) => t.includes('invoice_line')));
  });

  test('order says what has to exist first, and what comes apart first', async () => {
    const plan = await tool('order', { tables: ['invoice', 'customer', 'country'] });
    const insert = plan.insert as string[];
    assert.ok(insert.indexOf('country') < insert.indexOf('customer'));
    assert.ok(insert.indexOf('customer') < insert.indexOf('invoice'));
    assert.deepEqual(plan.remove, [...insert].reverse());

    const requires = plan.requires as Record<string, Array<{ table: string; via: string[]; optional: boolean }>>;
    assert.deepEqual(
      requires.invoice.find((r) => r.table === 'customer'),
      {
        table: 'customer',
        via: ['customer_id'],
        optional: false,
      },
    );

    assert.deepEqual(insert.length, 3, 'only what was asked about is ordered');

    const whole = await tool('order');
    assert.ok((whole.insert as string[]).length > 3, 'omitting tables orders the schema');

    /* A comma-separated string is what a client sends when the schema says
       array, and it is the shape this server's own prompt teaches. */
    const typed = await tool('order', { tables: 'invoice, customer' });
    assert.deepEqual(typed.insert, ['customer', 'invoice']);

    const unknown = await call('tools/call', { name: 'order', arguments: { tables: ['nope'] } });
    assert.equal((unknown.result as { isError: boolean }).isError, true);
  });

  test('lint reports what the shape will cost, filtered as asked', async () => {
    const all = await tool('lint');
    const findings = all.findings as Array<{ rule: string; table: string; severity: string }>;
    /* The demo has an unindexed reference and a keyless table is not there —
       what matters is that a rule fires, is severity-tagged, and names a
       real table. */
    assert.ok(findings.length, 'the demo schema is not perfect');
    assert.ok(
      findings.every((f) => f.rule && f.severity && f.table),
      'each names a rule, a level and a table',
    );
    /* The counts are complete even when the list is a sample — that is the
       whole shape of the answer, and a total that only counted what was
       listed would make a truncated report look like a clean schema. */
    assert.deepEqual(
      (all.counts as Record<string, number>).high +
        (all.counts as Record<string, number>).medium +
        (all.counts as Record<string, number>).low,
      all.total,
    );
    assert.ok((all.shown as number) <= (all.total as number));

    /* `why` belongs to the rule, and is sent once. It used to ride on every
       finding: on a 66-table schema that was three sentences repeated across
       265 findings, a third of a 24,000-token answer, on the tool an agent
       calls to orient itself. */
    const rules = all.rules as Record<string, { why: string; severity: string }>;
    assert.ok(Object.keys(rules).length, 'the rules that fired are named');
    assert.ok(
      findings.every((f) => rules[f.rule]),
      'and every finding names one of them',
    );
    assert.ok(
      findings.every((f) => (f as Record<string, unknown>).why === undefined),
      'no finding carries the sentence itself',
    );
    assert.ok(
      Object.values(rules).every((r) => r.why && r.severity),
      'each rule says what it costs',
    );

    const high = await tool('lint', { severity: 'high' });
    assert.ok((high.findings as Array<{ severity: string }>).every((f) => f.severity === 'high'));

    const one = await tool('lint', { table: 'invoice_line' });
    assert.ok((one.findings as Array<{ table: string }>).every((f) => f.table === 'invoice_line'));

    const unknown = await call('tools/call', { name: 'lint', arguments: { table: 'nope' } });
    assert.equal((unknown.result as { isError: boolean }).isError, true);
  });

  test('lint samples per rule by default, and says so when it withholds', async () => {
    const sampled = await tool('lint');
    const every = await tool('lint', { all: true });

    assert.equal(every.shown, every.total, 'all: true lists everything it counted');
    assert.equal(every.note, undefined, 'and has nothing to admit to');

    if ((sampled.total as number) > (sampled.shown as number)) {
      /* A truncated list that does not admit it reads as a complete one, and
         "no findings past this point" is the wrong thing for an agent to
         conclude about a schema it is about to change. */
      assert.match(String(sampled.note), /more findings? not listed/);
      assert.match(String(sampled.note), /all: true/);
    }

    // At most five of any one rule, however many there are.
    const byRule = new Map<string, number>();
    for (const f of sampled.findings as Array<{ rule: string }>) {
      byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    }
    assert.ok(
      [...byRule.values()].every((n) => n <= 5),
      'no rule floods the sample',
    );
  });

  test('raw SQL against a table that is not there answers like the rest of the tools', async () => {
    for (const name of ['sql', 'explain']) {
      const failed = await call('tools/call', {
        name,
        arguments: { statement: 'SELECT * FROM custmer WHERE id = 1' },
      });
      const text = (failed.result as { content: Array<{ text: string }> }).content[0].text;
      assert.equal((failed.result as { isError: boolean }).isError, true, name);
      /* The engine's diagnosis is kept — it is accurate — and the sentence an
         agent can act on is added to it. */
      assert.match(text, /custmer/, name);
      assert.match(text, /Did you mean "customer"\?/, name);
      assert.match(text, /Ask `tables` for what exists/, name);
    }
  });

  test('a table with more matches than it reported says so', async () => {
    /* Five per table is a cap, and a cap nobody is told about is a count: an
       agent reading five matches in `customer` concludes there are five. */
    const found = await tool('find', { value: 'e' });
    assert.ok((found.moreIn as string[]).length, 'the tables that were cut are named');
    assert.ok((found.matches as unknown[]).length > 0);
  });

  test('a value search accepts a number, and refuses two questions at once', async () => {
    const numeric = await tool('find', { value: 1001 });
    /* Not an error about having been given nothing: a client that does not
       coerce to the declared type sends the number it was searching for. */
    assert.ok(Array.isArray(numeric.matches));

    const both = await call('tools/call', { name: 'find', arguments: { name: 'customer', value: 'Harbour' } });
    const text = (both.result as { content: Array<{ text: string }> }).content[0].text;
    assert.equal((both.result as { isError: boolean }).isError, true);
    assert.match(text, /not both/);

    const neither = await call('tools/call', { name: 'find', arguments: {} });
    assert.equal((neither.result as { isError: boolean }).isError, true);
  });

  test('find says where a name lives, tables and columns both', async () => {
    const found = await tool('find', { name: 'customer' });
    assert.ok((found.tables as Array<{ id: string }>).some((t) => t.id === 'customer'));
    const columns = found.columns as Array<{ table: string; column: string; references?: object }>;
    assert.ok(columns.some((c) => c.table === 'invoice' && c.column === 'customer_id' && c.references));
  });

  test('aggregates ride the view fall-through, as the tool description promises', async () => {
    /* The capability shipped long before the description admitted it: a
       count and a sum per row, correlated, bound, no GROUP BY written. */
    const q = await tool('query', {
      q: 'customer show name count invoice via customer_id as invoices sum invoice.total via customer_id as revenue',
    });
    const rows = q.rows as Array<{ name: string; invoices: number; revenue: number }>;
    const harbour = rows.find((r) => r.name === 'Harbour Freight');
    assert.equal(harbour?.invoices, 2);
    assert.ok(typeof harbour?.revenue === 'number' && harbour.revenue > 0);

    /* And the first thing anyone tries after learning the syntax: sorting by
       the alias. ORDER BY is the one clause late enough to see it. */
    const sorted = await tool('query', {
      q: 'customer show name count invoice via customer_id as invoices sort invoices desc limit 3',
    });
    const counts = (sorted.rows as Array<{ invoices: number }>).map((r) => r.invoices);
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => b - a),
      `not descending: ${counts}`,
    );

    /* A filter cannot see the alias, and the error says why instead of
       calling it "not a column". */
    const filtered = await tool('query', { q: 'customer invoices > 1 count invoice via customer_id as invoices' });
    assert.match(String((filtered.errors as string[])[0]), /a filter runs before it exists/);
  });

  test('refresh makes a table created mid-session visible, as the error suggests', async () => {
    /* The defect this tool closes: schema is introspected once per open, and
       an agent that migrates mid-session kept a picture of the world before
       its own DDL. The database file is written directly — out-of-band, the
       way a migration is. */
    const miss = await call('tools/call', { name: 'table', arguments: { table: 'freshly_made' } });
    const missResult = miss.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(missResult.isError, true);
    assert.match(missResult.content[0].text, /`refresh` if it was just created/);

    const db = new DatabaseSync(DB);
    db.exec('CREATE TABLE freshly_made (id INTEGER PRIMARY KEY, note TEXT)');
    db.close();

    const refreshed = await tool('refresh', {});
    assert.ok((refreshed.tables as number) >= 9, 'the count includes the new table');

    const found = await tool('table', { table: 'freshly_made' });
    assert.deepEqual(found.primaryKey, ['id']);

    const undo = new DatabaseSync(DB);
    undo.exec('DROP TABLE freshly_made');
    undo.close();
    await tool('refresh', {});
  });

  test('a misspelled column keeps its suggestion, which is what retries need', async () => {
    const q = await tool('query', { q: 'customer contry_code = AU' });
    assert.match(String((q.errors as string[])[0]), /Did you mean "country_code"/);
  });

  test('a dotted path runs as a view, the way the query bar treats it', async () => {
    const q = await tool('query', { q: 'invoice show id, customer_id.name limit 2' });
    const rows = q.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.ok('customer_id.name' in rows[0]);
  });

  test('explain answers the plan without running the statement', async () => {
    /* The round trip the tool exists for: a `query` answer's sql — text,
       placeholders, params — fed back verbatim. */
    const q = await tool('query', { q: 'invoice total >= 100 limit 3' });
    const sql = q.sql as { text: string; params: unknown[] };
    const explained = await tool('explain', { statement: sql.text, params: sql.params });
    const plan = explained.plan as string[];
    assert.ok(plan.length >= 1, 'the plan has at least one node');
    assert.match(plan.join('\n'), /invoice/i, 'the plan names the table');
  });

  test('profile says what the columns hold, and what the look cost', async () => {
    const profiled = await tool('profile', { table: 'customer' });
    assert.equal(profiled.source, 'scan', 'sqlite keeps no statistics, so it looked — and says so');
    assert.equal(profiled.rows, 5);
    const columns = profiled.columns as Array<{
      column: string;
      nullFrac?: number;
      distinct?: number;
      common?: Array<{ value: unknown; frac: number }>;
    }>;
    /* One customer has no country: nullFrac carries it exactly. Two share
       AU, so the column repeats and its most common value says which. */
    const country = columns.find((c) => c.column === 'country_code');
    assert.ok(country, 'every column is profiled');
    assert.equal(country!.nullFrac, 1 / 5);
    assert.equal(country!.distinct, 3);
    assert.deepEqual(country!.common?.[0], { value: 'AU', frac: 2 / 5 });
    // A unique column's most common value is noise, so it has none.
    const id = columns.find((c) => c.column === 'id');
    assert.equal(id?.common, undefined);
  });

  test('record answers the row, its name, and what points at it', async () => {
    const record = await tool('record', { table: 'customer', key: { id: 1 } });
    assert.equal(record.found, true);
    assert.ok(record.label, 'the row has a human name');
    const pointed = record.pointedAtBy as Array<{ table: string; count: number; query?: string }>;
    const invoices = pointed.find((p) => p.table === 'invoice');
    assert.ok(invoices && invoices.count > 0);
    /* The relationship carries the query that fetches its rows, ready to
       feed back verbatim — the child's column name is the schema's to know,
       not the agent's to guess. And it runs. */
    assert.equal(invoices!.query, 'invoice customer_id = 1');
    const rows = await tool('query', { q: invoices!.query! });
    assert.equal((rows.rows as unknown[]).length, invoices!.count);
  });

  test("record counts a reference to a column that is not the key by the row's own value", async () => {
    /* Asked by id; the stock moves point at sku, which the key does not carry. */
    const record = await tool('record', { connection: 'coded', table: 'product', key: { id: 1 }, expand: 5 });
    const pointed = record.pointedAtBy as Array<{ table: string; count: number; query?: string; rows?: unknown[] }>;
    const moves = pointed.find((p) => p.table === 'stock_move');
    assert.ok(moves, JSON.stringify(record));
    assert.equal(moves.count, 2);
    assert.equal(moves.query, 'stock_move product_sku = LNT-01');
    assert.equal(moves.rows?.length, 2);
  });

  test('several records in one call, children inlined, the cost added up', async () => {
    /* The chattiest real pattern was record, then a query per relationship,
       times each record. One call now: two customers, their invoices inlined,
       and rowsRead owning every row that entered the context — two roots
       plus their expanded children. */
    const batch = await tool('record', {
      table: 'customer',
      keys: [{ id: 1 }, { id: 4 }],
      expand: 5,
    });
    const records = batch.records as Array<{
      found: boolean;
      label?: unknown;
      pointedAtBy: Array<{ table: string; count: number; rows?: unknown[] }>;
    }>;
    assert.equal(records.length, 2);
    assert.equal(records[0].label, 'Harbour Freight');
    const invoices = records[0].pointedAtBy.find((r) => r.table === 'invoice');
    assert.equal(invoices?.rows?.length, invoices?.count, 'the children arrived inline');
    const expanded = records.reduce((n, r) => n + r.pointedAtBy.reduce((m, rel) => m + (rel.rows?.length ?? 0), 0), 0);
    assert.equal((batch.stats as { rowsRead: number }).rowsRead, 2 + expanded);

    // One key keeps the shape every earlier caller learned.
    const single = await tool('record', { table: 'customer', key: { id: 1 } });
    assert.equal(single.found, true);
    assert.ok(!('records' in single));

    // And neither spelling is optional: no key at all is the caller's bug.
    const neither = await call('tools/call', { name: 'record', arguments: { table: 'customer' } });
    assert.equal((neither.result as { isError: boolean }).isError, true);
  });

  test('sql cannot write, and the database is the witness', async () => {
    const reply = await call('tools/call', {
      name: 'sql',
      arguments: { statement: "UPDATE customer SET name = 'gotcha' WHERE id = 1" },
    });
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    /* The adapter reports the database's refusal as an errors array, not a
       throw — either shape must leave the row untouched, which is the part
       asserted against the file rather than the message. */
    const said = JSON.stringify(result);
    assert.match(said, /read.?only/i);

    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT name FROM customer WHERE id = 1').get() as { name: string };
    db.close();
    assert.notEqual(row.name, 'gotcha');

    // And a read-only aggregate — the reason the tool exists — runs.
    const grouped = await tool('sql', { statement: 'SELECT country_code, COUNT(*) AS n FROM customer GROUP BY country_code' });
    assert.ok((grouped.rows as unknown[]).length >= 1);
  });
});

describe('grouping over MCP', () => {
  test('counts by something, and says which columns are keys and which are measures', async () => {
    const answer = await tool('breakdown', { q: 'invoice count, sum total as billed by status' });
    assert.deepEqual(answer.columns, ['status', 'count', 'billed']);
    const resolved = answer.resolved as Array<{ name: string; kind: string; fn?: string }>;
    assert.deepEqual(
      resolved.map((c) => c.kind),
      ['key', 'measure', 'measure'],
    );
    assert.equal(resolved[2].fn, 'sum');
    // The total is groups, not rows — that is the number a pager needs here.
    assert.equal(answer.total, (answer.rows as unknown[]).length);
    assert.match((answer.sql as { text: string }).text, /GROUP BY/);
  });

  test('a date column is grouped by a period, and the period reads as a label', async () => {
    const answer = await tool('breakdown', { q: 'invoice count by month invoice_date sort count desc' });
    const rows = answer.rows as Array<Record<string, unknown>>;
    assert.ok(rows.every((r) => /^\d{4}-\d{2}$/.test(String(r['month(invoice_date)']))));
  });

  test('a breakdown that does not parse comes back as a message, not an exception', async () => {
    const answer = await tool('breakdown', { q: 'invoice count by nosuchcolumn' });
    assert.ok((answer.errors as string[]).length);
    assert.equal(answer.rows, undefined);
  });

  test('`query` points at `breakdown` rather than failing obscurely', async () => {
    /* The two tools answer different shapes — groups cannot be opened as
       records — so this is a signpost rather than a fall-through. */
    const answer = await tool('query', { q: 'invoice count by status' });
    assert.match((answer.errors as string[])[0], /groups rows.*Call `breakdown`/s);
  });
});

describe('writing over MCP', () => {
  test('a server with no writable connection does not list the write tools', () => {
    /* Listed capability is a promise. A tool that always errors teaches the
       model to stop trusting the list, so a read-only server keeps quiet
       about writing instead of offering it and refusing. One-shot spawn: the
       shared server above has a writable connection by design. */
    const lines = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ].join('\n');
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--db', DB, '--mcp'],
      {
        input: `${lines}\n`,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const listed = out.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.id === 2)
      .result.tools.map((t: { name: string }) => t.name);
    assert.ok(!listed.includes('update') && !listed.includes('delete'), listed.join(', '));
    assert.ok(!listed.includes('insert_graph') && !listed.includes('delete_graph'), listed.join(', '));
  });

  test('the default connection refuses a write, in the words of the config', async () => {
    const reply = await call('tools/call', {
      name: 'update',
      arguments: { table: 'customer', key: { id: 1 }, set: { credit_limit: 1 } },
    });
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /"readonly" is read-only/);

    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare('SELECT credit_limit FROM customer WHERE id = 1').get() as { credit_limit: number };
    db.close();
    assert.notEqual(row.credit_limit, 1);
  });

  test('an update lands, says what it cost, and the next read sees it', async () => {
    /* Issued together, deliberately: the two lines reach the server in one
       breath, which is the pipelining that once let a query read the row
       from before the write it followed. Requests run in arrival order now,
       and this is the test that keeps them doing so. */
    const [updated, read] = await Promise.all([
      tool('update', { connection: 'scratch', table: 'customer', key: { id: 1 }, set: { credit_limit: 7777 } }),
      tool('query', { connection: 'scratch', q: 'customer id = 1 show credit_limit' }),
    ]);
    assert.equal(updated.affected, 1);
    assert.deepEqual(updated.applied, { credit_limit: 7777 });
    assert.equal((updated.stats as { rowsWritten: number }).rowsWritten, 1);
    assert.deepEqual(read.rows, [{ credit_limit: 7777 }]);

    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const row = db.prepare('SELECT credit_limit FROM customer WHERE id = 1').get() as { credit_limit: number };
    db.close();
    assert.equal(row.credit_limit, 7777);
  });

  test('insert answers with the stored row, its key, and what it cost', async () => {
    const added = await tool('insert', {
      connection: 'scratch',
      table: 'customer',
      values: { name: 'MCP Insert Co' },
    });
    assert.equal(added.inserted, true);
    const row = added.row as { name: string; active: number };
    assert.equal(row.name, 'MCP Insert Co');
    assert.equal(row.active, 1, 'defaults arrive filled');
    assert.equal((added.stats as { rowsInserted: number }).rowsInserted, 1);
    assert.ok(String(added.link).startsWith('/'));

    const key = added.key as { id: number };
    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const stored = db.prepare('SELECT name FROM customer WHERE id = ?').get(key.id) as { name: string };
    db.close();
    assert.equal(stored.name, 'MCP Insert Co');
  });

  test('a constraint violation is errors to fix, not a broken tool', async () => {
    const clash = await tool('insert', {
      connection: 'scratch',
      table: 'country',
      values: { code: 'AU', name: 'Again' },
    });
    assert.equal(clash.inserted, false);
    assert.match(String((clash.errors as string[])[0]), /UNIQUE constraint failed/);
    assert.ok(!('rowsInserted' in (clash.stats as object)));
  });

  test('a reference to a row that is not there names the row that is not there', async () => {
    /* SQLite's whole message is "FOREIGN KEY constraint failed" — no column,
       no value, no target, on a table with two of them. The graph is already
       loaded, so the failure path can afford the lookup that turns it into
       something to retry with. */
    const orphan = await tool('insert', {
      connection: 'scratch',
      table: 'invoice',
      values: { customer_id: 9999, invoice_date: '2026-08-23', total: 10 },
    });
    assert.equal(orphan.inserted, false);
    const message = String((orphan.errors as string[])[0]);
    assert.match(message, /FOREIGN KEY constraint failed/, 'the engine keeps the first word');
    assert.match(message, /customer_id = 9999 has no matching customer\.id/);
    assert.match(message, /Insert that customer first/);
  });

  test("a constraint the graph cannot explain keeps the database's own words", async () => {
    /* A UNIQUE violation is not a missing reference, and guessing at one
       would be worse than the bare message. */
    const clash = await tool('insert', {
      connection: 'scratch',
      table: 'country',
      values: { code: 'AU', name: 'Again' },
    });
    assert.match(String((clash.errors as string[])[0]), /^UNIQUE constraint failed/);
  });

  test('delete reports its impact first, and removes nothing until confirmed', async () => {
    const report = await tool('delete', { connection: 'scratch', table: 'customer', key: { id: 1 } });
    assert.equal(report.deleted, false);
    const impact = report.impact as Array<{ table: string; count: number; onDelete?: string }>;
    const invoices = impact.find((i) => i.table === 'invoice');
    assert.ok(invoices && invoices.count > 0, 'the report names what points at the row');
    assert.ok('onDelete' in invoices!, 'and carries the rule beside the count');

    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const still = db.prepare('SELECT COUNT(*) AS n FROM customer WHERE id = 1').get() as { n: number };
    db.close();
    assert.equal(still.n, 1);
  });

  test('confirm deletes, and the database is the witness', async () => {
    const gone = await tool('delete', { connection: 'scratch', table: 'shipment', key: { id: 1 }, confirm: true });
    assert.equal(gone.deleted, true);
    assert.equal((gone.stats as { rowsDeleted: number }).rowsDeleted, 1);

    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const left = db.prepare('SELECT COUNT(*) AS n FROM shipment WHERE id = 1').get() as { n: number };
    db.close();
    assert.equal(left.n, 0);
  });

  /* ---------- a graph, as one thing ---------- */

  /**
   * The claim these make is atomicity, and the only way to test a claim about
   * what did *not* happen is to look at the database afterwards. So every one
   * of them opens the file and counts.
   */
  const scalar = (sql: string): unknown => {
    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    db.close();
    return row ? Object.values(row)[0] : undefined;
  };

  const poke = (sql: string): void => {
    const db = new DatabaseSync(SCRATCH_DB);
    db.exec(sql);
    db.close();
  };

  describe('undo, for writes that already landed', () => {
    /* A transaction protects a call from failing halfway. Nothing protected
       anyone from a call that succeeded and should not have, which is the one
       that actually happens when an agent has write access: nothing errored,
       nothing rolled back, the row is simply wrong now.

       Every assertion here reads the database afterwards, because the claim
       is about what is in it. */

    test('an update is put back, and the database is the witness', async () => {
      const before = scalar('SELECT email FROM customer WHERE id = 1');
      await tool('update', { connection: 'scratch', table: 'customer', key: { id: 1 }, set: { email: 'wrong@example.com' } });
      assert.equal(scalar('SELECT email FROM customer WHERE id = 1'), 'wrong@example.com');

      const listed = await tool('revert', { connection: 'scratch' });
      assert.equal(listed.reverted, false, 'listing changes nothing');
      assert.match(String(listed.note), /confirm: true/);
      assert.equal(scalar('SELECT email FROM customer WHERE id = 1'), 'wrong@example.com');

      const undone = await tool('revert', { connection: 'scratch', confirm: true, expectedId: (listed.next as { id: number }).id });
      assert.equal(undone.reverted, true);
      assert.equal(scalar('SELECT email FROM customer WHERE id = 1'), before);
    });

    test('an insert is undone by removing what it added', async () => {
      const before = count('SELECT COUNT(*) AS n FROM country');
      await tool('insert', { connection: 'scratch', table: 'country', values: { code: 'ZQ', name: 'Zedqueue' } });
      assert.equal(count('SELECT COUNT(*) AS n FROM country'), before + 1);

      const listed = await tool('revert', { connection: 'scratch' });
      const undone = await tool('revert', { connection: 'scratch', confirm: true, expectedId: (listed.next as { id: number }).id });
      assert.equal(undone.reverted, true);
      assert.equal(count('SELECT COUNT(*) AS n FROM country'), before, 'and the row is gone again');
    });

    test('a delete is undone by putting the row back, values and all', async () => {
      await tool('insert', { connection: 'scratch', table: 'country', values: { code: 'ZR', name: 'Zedrow' } });
      await tool('delete', { connection: 'scratch', table: 'country', key: { code: 'ZR' }, confirm: true });
      assert.equal(count("SELECT COUNT(*) AS n FROM country WHERE code = 'ZR'"), 0);

      const listed = await tool('revert', { connection: 'scratch' });
      const undone = await tool('revert', { connection: 'scratch', confirm: true, expectedId: (listed.next as { id: number }).id });
      assert.equal(undone.reverted, true);
      assert.equal(count("SELECT COUNT(*) AS n FROM country WHERE code = 'ZR'"), 1);
      /* Not just the key: a delete is only undone if the row comes back as it
         was. */
      assert.equal(scalar("SELECT name FROM country WHERE code = 'ZR'"), 'Zedrow');

      await tool('delete', { connection: 'scratch', table: 'country', key: { code: 'ZR' }, confirm: true });
    });

    test('a row that changed since is refused, and left alone', async () => {
      /* The rule the browser's undo had and this inherits: putting an old
         value back over a newer one is not an undo, it is a silent overwrite.
         Somebody editing outside this session is the case that makes it
         matter. */
      await tool('update', { connection: 'scratch', table: 'customer', key: { id: 2 }, set: { email: 'ours@example.com' } });
      poke("UPDATE customer SET email = 'theirs@example.com' WHERE id = 2");

      const listed = await tool('revert', { connection: 'scratch' });
      const refused = await tool('revert', { connection: 'scratch', confirm: true, expectedId: (listed.next as { id: number }).id });
      assert.equal(refused.reverted, false);
      assert.match(String((refused.errors as string[])[0]), /changed|removed/);
      assert.equal(scalar('SELECT email FROM customer WHERE id = 2'), 'theirs@example.com', 'and the newer value survived');
    });

    test('the history lists what happened, newest first', async () => {
      await tool('update', { connection: 'scratch', table: 'customer', key: { id: 3 }, set: { email: 'one@example.com' } });
      await tool('update', { connection: 'scratch', table: 'customer', key: { id: 4 }, set: { email: 'two@example.com' } });
      const listed = await tool('revert', { connection: 'scratch' });
      const writes = listed.writes as Array<{ summary: string; revertible: boolean }>;
      assert.ok(writes.length >= 2);
      assert.match(writes[0].summary, /customer 4/, 'newest first');
      assert.ok(writes.every((w) => typeof w.revertible === 'boolean'));
    });

    test('confirmation requires its preview ID and a lost reply cannot undo the older write', async () => {
      await tool('insert', { connection: 'scratch', table: 'country', values: { code: 'ZU', name: 'Older undo target' } });
      await tool('insert', { connection: 'scratch', table: 'country', values: { code: 'ZV', name: 'Newer undo target' } });
      const listed = await tool('revert', { connection: 'scratch' });
      const expectedId = (listed.next as { id: number }).id;
      const missing = await tool('revert', { connection: 'scratch', confirm: true });
      assert.equal(missing.outcome, 'not_applied');
      assert.equal(count("SELECT COUNT(*) AS n FROM country WHERE code IN ('ZU','ZV')"), 2);
      const undone = await tool('revert', { connection: 'scratch', confirm: true, expectedId });
      assert.equal(undone.outcome, 'applied');
      const retried = await tool('revert', { connection: 'scratch', confirm: true, expectedId });
      assert.equal(retried.outcome, 'not_applied');
      assert.equal(count("SELECT COUNT(*) AS n FROM country WHERE code = 'ZU'"), 1);
      const older = await tool('revert', { connection: 'scratch' });
      await tool('revert', { connection: 'scratch', confirm: true, expectedId: (older.next as { id: number }).id });
    });

    test('a read-only connection has nothing to undo, and says so', async () => {
      const refused = await call('tools/call', { name: 'revert', arguments: { confirm: true } });
      const result = refused.result as { isError: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /read-only/);
    });
  });

  const count = (sql: string): number => {
    const db = new DatabaseSync(SCRATCH_DB, { readOnly: true });
    const row = db.prepare(sql).get() as { n: number };
    db.close();
    return row.n;
  };

  test('a graph goes in as one thing, and a child gets its parent’s assigned key', async () => {
    const made = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'country', as: 'zz', values: { code: 'ZZ', name: 'Zedland' } },
        { table: 'customer', as: 'c', values: { name: 'Graph Ltd', country_code: { ref: 'zz', column: 'code' } } },
        /* No id anywhere: `customer.id` is SQLite's to assign, and the
           invoice cannot know it. That is the whole reason labels exist. */
        { table: 'invoice', as: 'inv', values: { customer_id: { ref: 'c' }, invoice_date: '2026-08-24', total: 12.5 } },
      ],
    });

    const inserted = made.inserted as Array<{
      table: string;
      as?: string;
      key: Record<string, number | string>;
      row: Record<string, unknown>;
    }>;
    assert.equal(inserted.length, 3);
    assert.equal((made.stats as { rowsWritten: number }).rowsWritten, 3);
    assert.equal(made.undoId, undefined, 'a graph insert is not journaled: revert cannot undo it');

    const customerId = inserted[1].key.id;
    assert.equal(typeof customerId, 'number', 'the database assigned it');
    assert.equal(inserted[2].row.customer_id, customerId, 'and the child points at it');
    // A default the caller never sent, filled and reported.
    assert.equal(inserted[2].row.status, 'issued');

    // The teardown list comes back children-first, ready to use.
    assert.deepEqual(
      (made.teardown as Array<{ table: string }>).map((r) => r.table),
      ['invoice', 'customer', 'country'],
    );

    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Graph Ltd'`), 1);
  });

  test('a graph that fails part way writes nothing at all', async () => {
    /* The reason this exists. Two good rows and then a foreign key that
       points at nothing: without a transaction the database keeps the two,
       and the next run fails differently because half a fixture is already
       there. */
    const before = count('SELECT COUNT(*) AS n FROM customer');
    const failed = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'country', values: { code: 'YY', name: 'Wyeland' } },
        { table: 'customer', as: 'c', values: { name: 'Doomed Ltd', country_code: 'YY' } },
        { table: 'invoice', values: { customer_id: 999999, invoice_date: '2026-08-24', total: 1 } },
      ],
    });

    const errors = failed.errors as string[];
    assert.ok(errors?.length, 'it reported a failure');
    assert.match(errors[0], /Row 3 \(invoice\)/, 'and said which row');
    assert.match(errors[0], /Nothing was written/);
    assert.deepEqual(failed.inserted, []);

    assert.equal(count('SELECT COUNT(*) AS n FROM customer'), before, 'no customer survived');
    assert.equal(count(`SELECT COUNT(*) AS n FROM country WHERE code = 'YY'`), 0, 'nor the country before it');
  });

  test('a label that is not defined yet is refused before anything is opened', async () => {
    /* Forward references are a misunderstanding about order rather than a
       database problem, so they are caught in the request — the transaction
       is never opened and the answer is a flat no. */
    const refused = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'invoice', values: { customer_id: { ref: 'later' }, invoice_date: '2026-08-24', total: 1 } },
        { table: 'customer', as: 'later', values: { name: 'Too Late Ltd' } },
      ],
    });
    assert.match((refused.errors as string[])[0], /points at "later".*no row before it has a label/s);
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Too Late Ltd'`), 0);
  });

  test('a label used twice is refused, because it could not be pointed at', async () => {
    const refused = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'customer', as: 'c', values: { name: 'One' } },
        { table: 'customer', as: 'c', values: { name: 'Two' } },
      ],
    });
    assert.match((refused.errors as string[])[0], /already the label of row 1/);
  });

  test('a bare ref to a composite key says which columns it could not choose between', async () => {
    const refused = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'invoice_line', as: 'line', values: { invoice_id: 1001, line_no: 90, sku: 'SKU-100' } },
        { table: 'shipment', values: { invoice_id: { ref: 'line' }, line_no: 90, shipped_on: '2026-08-24' } },
      ],
    });
    assert.match((refused.errors as string[])[0], /invoice_id, line_no/);
    assert.match((refused.errors as string[])[0], /column/);
    // And the line it had already inserted went back with it.
    assert.equal(count('SELECT COUNT(*) AS n FROM invoice_line WHERE line_no = 90'), 0);
  });

  test('the teardown list removes the whole graph, in one go', async () => {
    const made = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'country', values: { code: 'XX', name: 'Exland' } },
        { table: 'customer', as: 'c', values: { name: 'Temporary Ltd', country_code: 'XX' } },
        { table: 'invoice', values: { customer_id: { ref: 'c' }, invoice_date: '2026-08-24', total: 3 } },
      ],
    });
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Temporary Ltd'`), 1);

    const gone = await tool('delete_graph', { connection: 'scratch', rows: made.teardown, confirm: true });
    assert.equal((gone.stats as { rowsDeleted: number }).rowsDeleted, 3);
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Temporary Ltd'`), 0);
    assert.equal(count(`SELECT COUNT(*) AS n FROM country WHERE code = 'XX'`), 0);
  });

  test('a teardown reports its impact first, and removes nothing until confirmed', async () => {
    /* The gate `delete` has always had, and this tool did not. Its own
       description used to argue the point away — "these are rows the caller
       already listed" — which is true of the rows and not of what cascades
       off them, and it left the tool that can take the most away as the one
       that took it on the first call. */
    const made = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'customer', as: 'c', values: { name: 'Gated Ltd' } },
        { table: 'invoice', values: { customer_id: { ref: 'c' }, invoice_date: '2026-08-24', total: 9 } },
      ],
    });

    const asked = await tool('delete_graph', { connection: 'scratch', rows: made.teardown });
    assert.equal(asked.deleted, false);
    assert.deepEqual(asked.removed, []);
    assert.match(String(asked.note), /call again with confirm: true/);
    // One entry per row, each carrying what `delete` would have said about it.
    assert.equal((asked.rows as unknown[]).length, 2);
    assert.ok((asked.rows as Array<{ impact: unknown }>).every((r) => r.impact !== undefined));
    assert.equal(
      count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Gated Ltd'`),
      1,
      'and the database is the witness that nothing went',
    );

    const gone = await tool('delete_graph', { connection: 'scratch', rows: made.teardown, confirm: true });
    assert.equal(gone.deleted, true);
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Gated Ltd'`), 0);
  });

  test('a teardown that cannot finish removes nothing', async () => {
    /* The same guarantee pointed the other way, and the reason a teardown is
       one call rather than N: in the wrong order the parent goes first, the
       child's foreign key stops it, and a half-torn-down fixture is exactly
       the mess the insert was careful to avoid. */
    const made = await tool('insert_graph', {
      connection: 'scratch',
      rows: [
        { table: 'customer', as: 'c', values: { name: 'Stubborn Ltd' } },
        { table: 'invoice', values: { customer_id: { ref: 'c' }, invoice_date: '2026-08-24', total: 4 } },
      ],
    });
    // Reversed again: parents first, which is the order that cannot work.
    const wrongWay = [...(made.teardown as Array<unknown>)].reverse();

    const failed = await tool('delete_graph', { connection: 'scratch', rows: wrongWay, confirm: true });
    assert.match((failed.errors as string[])[0], /Nothing was removed/);
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Stubborn Ltd'`), 1, 'still there');

    // And the right way round still works, so the fixture is not stuck.
    await tool('delete_graph', { connection: 'scratch', rows: made.teardown, confirm: true });
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name = 'Stubborn Ltd'`), 0);
  });

  test('`fixture`\u2019s own shape is accepted as it comes', async () => {
    /* The loop the pair exists for: a fixture extracted from one database
       goes into another without an agent rewriting the shape in between.
       `tables` is a whole table at a time, in insert order, which is how the
       extractor reads. */
    const made = await tool('insert_graph', {
      connection: 'scratch',
      tables: [
        { table: 'country', rows: [{ code: 'AA', name: 'Aland' }] },
        { table: 'customer', rows: [{ name: 'Flat Ltd', country_code: 'AA' }, { name: 'Flat Two Ltd' }] },
      ],
    });
    assert.equal((made.stats as { rowsWritten: number }).rowsWritten, 3);
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name LIKE 'Flat%'`), 2);
    await tool('delete_graph', { connection: 'scratch', rows: made.teardown, confirm: true });
    assert.equal(count(`SELECT COUNT(*) AS n FROM customer WHERE name LIKE 'Flat%'`), 0);
  });

  test('rows and tables together is a request with two minds', async () => {
    const reply = await call('tools/call', {
      name: 'insert_graph',
      arguments: {
        connection: 'scratch',
        rows: [{ table: 'country', values: { code: 'BB', name: 'Beeland' } }],
        tables: [{ table: 'country', rows: [{ code: 'CC', name: 'Ceeland' }] }],
      },
    });
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /either `rows` or `tables`, not both/);
    assert.equal(count(`SELECT COUNT(*) AS n FROM country WHERE code IN ('BB','CC')`), 0);
  });

  test('a read-only connection refuses a graph in the words of the config', async () => {
    const reply = await call('tools/call', {
      name: 'insert_graph',
      arguments: { rows: [{ table: 'country', values: { code: 'QQ', name: 'Quland' } }] },
    });
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /"readonly" is read-only/);
  });
});

describe('the CLI export', () => {
  test('prints the same brief the browser downloads, then exits', () => {
    const md = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--db', DB, '--export', 'md'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.match(md.stdout, /customer/);
    assert.match(md.stdout, /invoice/);
    /* stdout is the document: `--export md >> CLAUDE.md` must append a
       brief, and the startup banner belongs to stderr with the rest. */
    assert.ok(md.stdout.startsWith('# '), `stdout opens with the brief, not a banner: ${md.stdout.slice(0, 40)}`);
    assert.match(md.stderr, /8 tables/);

    const mermaid = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--db', DB, '--export', 'mermaid'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.match(mermaid.stdout, /erDiagram/);

    const wrong = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--db', DB, '--export', 'yaml'],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /--export takes md, mermaid or json/);
  });
});

describe('tool profiles', () => {
  /* Twenty-two definitions is a fixed cost every agent pays on connect, and
     most sessions are one job: an agent reading a schema does not need the
     graph writers, one seeding a fixture does not need `explain`. Spawned
     rather than called, because the flag is read at startup — and because the
     thing worth testing is the whole path from argv to the listing. */
  const listing = (args: string[], config: string = CONFIG) => {
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', config, '--mcp', ...args],
      {
        encoding: 'utf8',
        timeout: 60_000,
        input: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
      },
    );
    /* By id, not by content: the `initialize` response also contains the word
       "tools", inside `capabilities`, so matching on that picked the wrong
       line and found no list on it. */
    const line = out.stdout.split('\n').find((l) => l.includes('"id":2'));
    return {
      status: out.status,
      stderr: out.stderr,
      names: line ? (JSON.parse(line) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name) : [],
    };
  };

  test('a profile offers one job\u2019s worth of tools, and full offers them all', () => {
    const all = listing([]);
    const explore = listing(['--tools', 'explore']);
    const migrate = listing(['--tools', 'migrate']);

    assert.ok(all.names.length > explore.names.length, 'a profile is a subset');
    assert.ok(explore.names.includes('query') && explore.names.includes('schema_summary'));
    assert.ok(!explore.names.includes('insert_graph'), 'exploring does not write graphs');
    assert.ok(migrate.names.includes('change_impact') && migrate.names.includes('lint'));
    assert.ok(!migrate.names.includes('sql'), 'migrating is not a SQL console');

    /* In every profile: the call documented as the one to start with, and the
       one an agent needs to recover from a schema that moved under it. */
    for (const names of [explore.names, migrate.names, listing(['--tools', 'seed']).names]) {
      assert.ok(names.includes('connections'), 'connections is always offered');
      assert.ok(names.includes('refresh'), 'refresh is always offered');
    }
  });

  test('a profile narrows what the connection allows, and never widens it', () => {
    /* `seed` names the write tools. Against a server with nothing writable
       they must still not appear: the profile says which job this is, and the
       config says what may be done at all — every filter only ever removes.

       Its own config, because the shared fixture *does* have a writable
       connection, which is what makes `seed` list them there. */
    const readOnly = join(dir, 'read-only.json');
    writeFileSync(readOnly, JSON.stringify({ connections: [{ name: 'ro', url: DB }] }));

    const seeded = listing(['--tools', 'seed'], readOnly);
    assert.ok(seeded.names.includes('fixture'), 'the read half of seeding is still there');
    for (const write of ['insert', 'insert_graph', 'delete_graph', 'update', 'delete']) {
      assert.ok(!seeded.names.includes(write), `${write} needs a writable connection, profile or not`);
    }

    // And the same profile against the writable fixture does offer them.
    assert.ok(listing(['--tools', 'seed']).names.includes('insert_graph'));
  });

  test('a client that can ask the person is asked, and the two-call gate stands aside', async () => {
    /* Elicitation (2025-06-18+): the server puts the question to the human
       through the client instead of trusting a `confirm: true` the model
       wrote itself. A client without the capability keeps the old gate. */
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', CONFIG, '--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: Array<Record<string, unknown>> = [];
    let buffer = '';
    const waiters: Array<(l: Record<string, unknown>) => void> = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push(parsed);
        waiters.splice(0).forEach((w) => w(parsed));
      }
    });
    const next = (pred: (l: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const hit = lines.find(pred);
        if (hit) return resolve(hit);
        const w = (l: Record<string, unknown>) => {
          if (pred(l)) resolve(l);
          else waiters.push(w);
        };
        waiters.push(w);
      });
    const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    try {
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 't', version: '0' } },
      });
      await next((l) => l.id === 1);
      // A row to delete, so the question has something to be about.
      send({
        id: 2,
        method: 'tools/call',
        params: { name: 'insert', arguments: { connection: 'scratch', table: 'country', values: { code: 'EL', name: 'Elicitia' } } },
      });
      const inserted = await next((l) => l.id === 2);
      assert.equal((inserted.result as { isError: boolean }).isError, false, JSON.stringify(inserted));
      // Delete without confirm: the server asks, the "person" declines.
      send({
        id: 3,
        method: 'tools/call',
        params: { name: 'delete', arguments: { connection: 'scratch', table: 'country', key: { code: 'EL' } } },
      });
      const ask1 = await next((l) => l.method === 'elicitation/create');
      assert.match(String((ask1.params as { message: string }).message), /Delete country EL\?/);
      send({ id: ask1.id, result: { action: 'decline' } });
      const declined = await next((l) => l.id === 3);
      const declinedResult = (declined.result as { structuredContent: { deleted: boolean; note: string } }).structuredContent;
      assert.equal(declinedResult.deleted, false);
      assert.match(declinedResult.note, /the person declined/);
      // Asked again, the person accepts.
      send({
        id: 4,
        method: 'tools/call',
        params: { name: 'delete', arguments: { connection: 'scratch', table: 'country', key: { code: 'EL' } } },
      });
      const ask2 = await next((l) => l.method === 'elicitation/create' && l.id !== ask1.id);
      send({ id: ask2.id, result: { action: 'accept', content: { confirm: true } } });
      const accepted = await next((l) => l.id === 4);
      assert.equal((accepted.result as { structuredContent: { deleted: boolean } }).structuredContent.deleted, true);
      // A model that writes confirm:true itself is still asked, and a decline deletes nothing: delete and delete_graph.
      send({
        id: 5,
        method: 'tools/call',
        params: { name: 'insert', arguments: { connection: 'scratch', table: 'country', values: { code: 'EM', name: 'Emptia' } } },
      });
      await next((l) => l.id === 5);
      const forced = (id: number, name: string, args: Record<string, unknown>) =>
        send({ id, method: 'tools/call', params: { name, arguments: { connection: 'scratch', confirm: true, ...args } } });
      forced(6, 'delete', { table: 'country', key: { code: 'EM' } });
      const ask3 = await next((l) => l.method === 'elicitation/create' && l.id !== ask1.id && l.id !== ask2.id);
      send({ id: ask3.id, result: { action: 'decline' } });
      const refused = await next((l) => l.id === 6);
      assert.equal((refused.result as { structuredContent: { deleted: boolean } }).structuredContent.deleted, false);
      forced(7, 'delete_graph', { rows: [{ table: 'country', key: { code: 'EM' } }] });
      const ask4 = await next((l) => l.method === 'elicitation/create' && ![ask1.id, ask2.id, ask3.id].includes(l.id as number));
      assert.match(String((ask4.params as { message: string }).message), /Delete 1 row in one transaction/);
      send({ id: ask4.id, result: { action: 'decline' } });
      const graphRefused = await next((l) => l.id === 7);
      assert.equal((graphRefused.result as { structuredContent: { deleted: boolean } }).structuredContent.deleted, false);
      forced(8, 'delete_graph', { rows: [{ table: 'country', key: { code: 'EM' } }] });
      const ask5 = await next((l) => l.method === 'elicitation/create' && ![ask1.id, ask2.id, ask3.id, ask4.id].includes(l.id as number));
      send({ id: ask5.id, result: { action: 'accept', content: { confirm: true } } });
      const graphDone = await next((l) => l.id === 8);
      const graphResult = (graphDone.result as { structuredContent: { deleted: boolean; undoId?: number } }).structuredContent;
      assert.equal(graphResult.deleted, true, 'the person said yes');
      assert.equal(graphResult.undoId, undefined, 'a graph delete is not journaled');
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  test('a profile is enforced when a tool is called, not only when it is listed', () => {
    /* `--tools explore` hid `delete` from the listing and then ran it for any
       client that knew the name — a filter on the menu, not on the kitchen.
       Against the writable fixture, so the refusal is the profile's and not
       the connection's. */
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', CONFIG, '--mcp', '--tools', 'explore'],
      {
        encoding: 'utf8',
        timeout: 60_000,
        input: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        })}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'delete', arguments: { table: 'customer', key: { id: 1 }, confirm: true } },
        })}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'tables', arguments: {} },
        })}\n`,
      },
    );
    const reply = (id: number) =>
      JSON.parse(out.stdout.split('\n').find((l) => l.includes(`"id":${id}`)) ?? '{}') as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
    const refused = reply(2).result;
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /tool profile/);
    assert.match(refused.content[0].text, /--tools full/);
    // And a tool inside the profile still answers, so this is the profile talking.
    assert.equal(reply(3).result.isError, false);
  });

  test('a name that is not a profile stops the server and says which are', () => {
    /* Falling back to every tool would make a typo a surprise measured in
       tokens rather than in errors. */
    const wrong = listing(['--tools', 'explor']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /not a tool profile/);
    assert.match(wrong.stderr, /full, explore, migrate, seed/);
  });
});

describe('--output-schema puts the contract back', () => {
  /* Off by default because it is half the listing and most agents never read
     it. But it is a real contract — a client that validates
     `structuredContent` needs the declaration — so the flag has to restore it
     completely, not approximately. A spawned server, because the flag is read
     at startup. */
  let child: ReturnType<typeof spawn>;
  let nextId = 1;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();

  const ask = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`No answer to ${method}`));
      }, 10_000);
    });
  };

  before(async () => {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', CONFIG, '--mcp', '--output-schema'],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const resolve = pending.get(message.id as number);
        if (resolve) {
          pending.delete(message.id as number);
          resolve(message);
        }
      }
    });
    await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  });

  after(() => {
    child?.kill();
  });

  test('every tool declares its answer, and what the answer cost', async () => {
    const listed = await ask('tools/list');
    const tools = (
      listed.result as {
        tools: Array<{ name: string; outputSchema?: { type?: string; properties?: Record<string, unknown> } }>;
      }
    ).tools;
    assert.ok(tools.length, 'the flag did not empty the list');
    for (const t of tools) {
      assert.equal(t.outputSchema?.type, 'object', `${t.name} declares its answer's shape`);
      assert.ok(t.outputSchema?.properties?.stats, `${t.name}'s shape includes what it cost`);
    }
  });

  test('and the listing is materially bigger for it, which is the whole point', async () => {
    /* The measurement that set the default. If this ever stops being true the
       default is worth revisiting, so it is pinned rather than remembered. */
    const listed = await ask('tools/list');
    const withSchema = JSON.stringify(listed.result).length;
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    const without = JSON.stringify({ tools: tools.map(({ outputSchema: _s, ...t }) => t) }).length;
    assert.ok(without * 1.5 < withSchema, `outputSchema is ${withSchema - without} of ${withSchema} chars`);
  });
});

describe('a shape-only connection', () => {
  /* The README's boundary as a property of the connection rather than a
     sentence asking to be believed: shape answers, row values do not. A
     second server, because the flag is read at startup. */
  const SHAPE_CONFIG = join(dir, 'shape.json');
  let shape: ChildProcess;
  let shapeId = 1;
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();

  const ask = (method: string, params: Record<string, unknown> = {}) => {
    const id = shapeId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      waiting.set(id, resolve);
      shape.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`No answer to ${method}`));
      }, 10_000);
    });
  };

  before(async () => {
    writeFileSync(
      SHAPE_CONFIG,
      JSON.stringify({
        connections: [{ name: 'prod-shape', url: DB, rows: false }],
      }),
    );
    shape = spawn(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', SHAPE_CONFIG, '--mcp'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buffer = '';
    shape.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number };
        const resolve = message.id !== undefined ? waiting.get(message.id) : undefined;
        if (resolve) {
          waiting.delete(message.id!);
          resolve(message as Record<string, unknown>);
        }
      }
    });
    await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  });

  after(() => {
    shape?.kill();
  });

  test('does not offer the tools whose whole answer is rows', async () => {
    const listed = await ask('tools/list');
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(!names.includes('query') && !names.includes('sql') && !names.includes('record'));
    /* A breakdown's group keys are row values — `by status` answers with the
       statuses — so it belongs on this side of the line, not with `profile`. */
    assert.ok(!names.includes('breakdown'));
    /* Shape still answers — that is what the connection is for. */
    assert.ok(names.includes('tables') && names.includes('table') && names.includes('lint'));
    assert.ok(names.includes('find'), 'find has a name mode, which is shape');
  });

  test('refuses a row read even when the tool is asked for by name', async () => {
    /* The list is a courtesy; the boundary is at the adapter, so a client
       working from a stale list gets refused rather than served. */
    const asked = await ask('tools/call', { name: 'query', arguments: { q: 'customer limit 1' } });
    const result = asked.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /shape-only/);

    const grouped = await ask('tools/call', {
      name: 'breakdown',
      arguments: { q: 'invoice count by status' },
    });
    const groupedResult = grouped.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(groupedResult.isError, true);
    assert.match(groupedResult.content[0].text, /shape-only/);
  });

  test('answers the shape, and the numbers that are not row values', async () => {
    const listed = await ask('tools/call', { name: 'tables', arguments: {} });
    const tables = (listed.result as { structuredContent: { tables: Array<{ id: string; approxRows?: number }> } }).structuredContent
      .tables;
    assert.ok(tables.find((t) => t.id === 'customer')?.approxRows === 5, 'a count is not a row');

    const profiled = await ask('tools/call', { name: 'profile', arguments: { table: 'customer' } });
    const profile = (
      profiled.result as {
        structuredContent: { redacted?: string; columns: Array<Record<string, unknown>> };
      }
    ).structuredContent;
    /* Null fractions decide a LEFT join and carry nothing out of a row; a
       minimum, a maximum and the most common values carry rows. */
    assert.ok(profile.columns.every((c) => !('min' in c) && !('max' in c) && !('common' in c)));
    assert.ok(profile.columns.some((c) => typeof c.nullFrac === 'number'));
    assert.match(String(profile.redacted), /shape-only/);
  });
});

describe('the CLI lint', () => {
  const lint = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--db', DB, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });

  test('reports on the shape and exits, with nothing on stdout but the report', () => {
    const text = lint(['--lint']);
    assert.equal(text.status, 0, 'no threshold, no failure');
    assert.match(text.stdout, /finding/);
    assert.ok(!text.stdout.includes('Listening on'), 'a build step does not start a server');

    const json = lint(['--lint', 'json']);
    const parsed = JSON.parse(json.stdout) as { counts: Record<string, number>; findings: unknown[] };
    assert.equal(parsed.findings.length, parsed.counts.high + parsed.counts.medium + parsed.counts.low);
  });

  test('fails the build at the severity it was given, and not below it', () => {
    /* `--fail-on medium` means medium *and* worse, which is the reading that
       makes a threshold useful rather than a filter. */
    const medium = lint(['--lint', '--fail-on', 'medium']);
    assert.equal(medium.status, 1);

    const nonsense = lint(['--lint', '--fail-on', 'sometimes']);
    assert.equal(nonsense.status, 1);
    assert.match(nonsense.stderr, /high, medium or low/);

    /* The flag after `--lint` is a flag, not a format: eating it would leave
       the lint running in a format nobody asked for and the build unguarded. */
    const noFormat = lint(['--lint', '--fail-on', 'low']);
    assert.equal(noFormat.status, 1);
    assert.ok(!noFormat.stderr.includes('takes text or json'));
  });
});

describe('resources: the reference shelf', () => {
  test('the schema brief is listed per connection, tables come as a template', async () => {
    const listed = await call('resources/list');
    const resources = (listed.result as { resources: Array<{ uri: string; mimeType: string }> }).resources;
    assert.ok(resources.some((r) => r.uri === 'tablewalk://readonly/schema'));
    assert.ok(resources.every((r) => r.mimeType === 'text/markdown'));

    const templates = await call('resources/templates/list');
    const ts = (templates.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
    assert.equal(ts[0].uriTemplate, 'tablewalk://{connection}/table/{table}');
  });

  test('reading the brief and a table answers markdown worth attaching', async () => {
    const brief = await call('resources/read', { uri: 'tablewalk://readonly/schema' });
    const briefText = (brief.result as { contents: Array<{ text: string }> }).contents[0].text;
    assert.match(briefText, /customer/);
    assert.match(briefText, /invoice/);

    const table = await call('resources/read', { uri: 'tablewalk://readonly/table/customer' });
    const text = (table.result as { contents: Array<{ text: string }> }).contents[0].text;
    assert.match(text, /CREATE TABLE "customer"/);
    assert.match(text, /Pointed at by:/);
    assert.match(text, /invoice via customer_id/);
  });

  test("the team's own questions are on the shelf too", async () => {
    const listed = await call('resources/list');
    const resources = (listed.result as { resources: Array<{ uri: string }> }).resources;
    assert.ok(resources.some((r) => r.uri === 'tablewalk://readonly/queries'));
    assert.ok(resources.some((r) => r.uri === 'tablewalk://readonly/pages'));
    /* The other connection has neither, and an empty document per connection
       is noise in every client's picker. */
    assert.ok(!resources.some((r) => r.uri === 'tablewalk://scratch/queries'));

    const queries = await call('resources/read', { uri: 'tablewalk://readonly/queries' });
    const text = (queries.result as { contents: Array<{ text: string }> }).contents[0].text;
    assert.match(text, /## Big invoices/);
    assert.match(text, /Anything over five hundred/);
    assert.match(text, /select id, total from invoice/);

    const pages = await call('resources/read', { uri: 'tablewalk://readonly/pages' });
    const pageText = (pages.result as { contents: Array<{ text: string }> }).contents[0].text;
    assert.match(pageText, /Customer overview/);
    assert.match(pageText, /customer/);
  });

  test('a uri that names nothing is the resource error, not a crash', async () => {
    const missing = await call('resources/read', { uri: 'tablewalk://readonly/table/nonesuch' });
    const error = (missing as { error?: { code: number; message: string } }).error;
    assert.equal(error?.code, -32002);
    assert.match(error!.message, /nonesuch/);
  });
});

describe('the trust boundary, as a number', () => {
  test('connections carries rows read this session, and timeout_ms is accepted', async () => {
    const before = await tool('connections', {});
    const readBefore = (before.connections as Array<{ id: string; rowsReadThisSession: number }>).find(
      (c) => c.id === 'readonly',
    )!.rowsReadThisSession;

    const q = await tool('query', { q: 'customer limit 3' });
    assert.equal((q.stats as { rowsRead: number }).rowsRead, 3);

    const after = await tool('connections', {});
    const readAfter = (after.connections as Array<{ id: string; rowsReadThisSession: number }>).find(
      (c) => c.id === 'readonly',
    )!.rowsReadThisSession;
    assert.equal(readAfter, readBefore + 3, 'the ledger moved by exactly what left');

    /* SQLite cannot interrupt a statement; the argument is accepted and the
       description says where it is honoured. Accepting it here is what lets
       an agent use one calling convention across dialects. */
    const timed = await tool('sql', { statement: 'SELECT 1 AS one', timeout_ms: 500 });
    assert.equal((timed.rows as unknown[][]).length, 1);
  });
});

describe('completions and subscriptions', () => {
  test('template arguments complete from the catalog, prefix-matched', async () => {
    const conn = await call('completion/complete', {
      ref: { type: 'ref/resource', uri: 'tablewalk://{connection}/table/{table}' },
      argument: { name: 'connection', value: 'read' },
    });
    assert.deepEqual((conn.result as { completion: { values: string[] } }).completion.values, ['readonly']);

    const table = await call('completion/complete', {
      ref: { type: 'ref/resource', uri: 'tablewalk://{connection}/table/{table}' },
      argument: { name: 'table', value: 'cust' },
      context: { arguments: { connection: 'readonly' } },
    });
    const values = (table.result as { completion: { values: string[] } }).completion.values;
    assert.ok(values.includes('customer') && values.includes('customer_totals'), values.join(', '));
  });

  test('a subscribed brief announces its refresh, after the answer', async () => {
    await call('resources/subscribe', { uri: 'tablewalk://readonly/schema' });
    const before = notifications.length;
    await tool('refresh', {});
    /* Written right after the answer, but pipes chunk as they please — the
       notification may arrive a read later. A short poll, not a sleep. */
    let updated;
    for (let waited = 0; waited < 1000 && !updated; waited += 25) {
      updated = notifications.slice(before).find((n) => n.method === 'notifications/resources/updated');
      if (!updated) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(updated, 'the subscribed uri was announced');
    assert.equal(updated!.params.uri, 'tablewalk://readonly/schema');

    await call('resources/unsubscribe', { uri: 'tablewalk://readonly/schema' });
    const after = notifications.length;
    await tool('refresh', {});
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!notifications.slice(after).some((n) => n.method === 'notifications/resources/updated'), 'unsubscribed means unannounced');
  });
});

describe('prompts: the packaged walks', () => {
  test('the three workflows are listed with their arguments', async () => {
    const listed = await call('prompts/list');
    const prompts = (listed.result as { prompts: Array<{ name: string; arguments: Array<{ name: string; required?: boolean }> }> }).prompts;
    assert.deepEqual(
      prompts.map((p) => p.name),
      ['orient', 'pre-migration-check', 'investigate-row'],
    );
    const check = prompts.find((p) => p.name === 'pre-migration-check')!;
    assert.ok(check.arguments.find((a) => a.name === 'tables')?.required);
  });

  test('orient arrives with the brief embedded, not instructions to fetch it', async () => {
    const got = await call('prompts/get', { name: 'orient', arguments: {} });
    const messages = (got.result as { messages: Array<{ content: { type: string; resource?: { text: string }; text?: string } }> })
      .messages;
    const embedded = messages.find((m) => m.content.type === 'resource');
    assert.ok(embedded, 'the schema brief is attached');
    assert.match(embedded!.content.resource!.text, /customer/);
    const plan = messages.find((m) => m.content.type === 'text');
    assert.match(plan!.content.text!, /refresh/);
  });

  test('the migration check embeds a brief per named table, and demands names', async () => {
    const got = await call('prompts/get', {
      name: 'pre-migration-check',
      arguments: { tables: 'customer, invoice' },
    });
    const messages = (got.result as { messages: Array<{ content: { type: string; resource?: { uri: string } } }> }).messages;
    const uris = messages.filter((m) => m.content.type === 'resource').map((m) => m.content.resource!.uri);
    /* The prompts are where the tool-chaining knowledge lives, so one that
       teaches the tools of six months ago teaches the long way round. */
    const advice = messages.find((m) => m.content.type === 'text');
    const text = String((advice?.content as { text?: string })?.text ?? '');
    assert.match(text, /`order \{tables:/);
    assert.match(text, /`lint`/);
    assert.deepEqual(uris, ['tablewalk://readonly/table/customer', 'tablewalk://readonly/table/invoice']);

    const missing = await call('prompts/get', { name: 'pre-migration-check', arguments: {} });
    assert.match(String((missing as { error?: { message: string } }).error?.message), /Which tables/);
  });

  test('prompt arguments complete from the catalog too', async () => {
    const tables = await call('completion/complete', {
      ref: { type: 'ref/prompt', name: 'pre-migration-check' },
      argument: { name: 'tables', value: 'inv' },
    });
    const values = (tables.result as { completion: { values: string[] } }).completion.values;
    assert.ok(values.includes('invoice') && values.includes('invoice_line'), values.join(', '));
  });
});

describe('invocation through a bin shim', () => {
  test('a symlink that does not look like server/index still boots', () => {
    /* npm's bin shim is a symlink called `tablewalk`, and the old guard —
       does argv[1] *look like* server/index — matched nothing through it:
       npx tablewalk exited 0 having done exactly that. The guard resolves
       the symlink now, and this symlink's name is chosen to fail the old
       test on purpose. */
    const link = join(dir, 'tablewalk-shim.ts');
    try {
      symlinkSync(join(process.cwd(), 'packages/tablewalk/src/server/index.ts'), link);
    } catch {
      /* exists */
    }
    const out = spawnSync('npx', ['tsx', link, '--no-config', '--db', DB, '--export', 'mermaid'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(out.stdout, /erDiagram/, `the shim booted nothing: ${out.stderr.slice(0, 120)}`);
  });
});
