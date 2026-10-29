/**
 * The MCP server's safety items, end to end: `sql` and `explain` refuse
 * tablewalk's own tables — the engine's half included, a view over one that
 * the text never names — every statement runs under a cap, a cancelled call
 * stops what it is running and answers as cancelled, and the counts `query`,
 * `breakdown` and `record` report stop at a bound and say so. SQLite
 * in-process and over stdio; Postgres live when its variable
 * is set (test/live.ts).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { Registry } from '../packages/engine/src/server/connections.js';
import { runTool } from '../packages/tablewalk/src/server/mcp.js';
import {
  onCancel,
  STATEMENT_TIMEOUT_MS,
  statementCap,
  StatementStopped,
  stoppedReason,
} from '../packages/engine/src/adapters/statementControl.js';
import { liveSkip } from './live.js';

type Reply = Awaited<ReturnType<typeof runTool>>;
const answered = (reply: Reply) => {
  assert.equal(reply.isError, false, reply.content[0]?.text);
  return reply.structuredContent!;
};
const refusedWith = (reply: Reply, pattern: RegExp) => {
  assert.equal(reply.isError, true, JSON.stringify(reply.structuredContent));
  assert.match(reply.content[0].text, pattern);
};
/** Resolves with how long `work` took, in ms. */
async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const value = await work();
  return [value, Date.now() - started];
}

/* A statement SQLite needs many seconds for and answers in one row: an
   aggregate over a recursive count, which no LIMIT wrap can shorten. */
const SLOW_SQLITE =
  'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500000000) ' + 'SELECT count(*) AS mcp_cancel_probe FROM n';
/** Processes still running the SQLite statement child, found by its program text. */
function statementChildren(): number {
  const listed = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8' }).stdout ?? '';
  return listed.split('\n').filter((line) => line.includes('SQLITE_OK = 0, SQLITE_READ = 20')).length;
}
async function until(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(50);
  }
  return check();
}

const BOUND = 10_000;

describe('the statement cap and the cancel, as parts', () => {
  test('a caller may lower the cap, never raise it, and not below the floor', () => {
    assert.equal(statementCap(), STATEMENT_TIMEOUT_MS);
    assert.equal(statementCap(Number.NaN), STATEMENT_TIMEOUT_MS);
    assert.equal(statementCap(10), 100);
    assert.equal(statementCap(2_500.7), 2_500);
    assert.equal(statementCap(STATEMENT_TIMEOUT_MS * 10), STATEMENT_TIMEOUT_MS);
  });

  test("each engine's own timeout reads as a timeout; anything else is not a stop", () => {
    assert.equal(stoppedReason(new Error('canceling statement due to statement timeout')), 'timeout');
    assert.equal(stoppedReason(new Error('Query execution was interrupted, maximum statement execution time exceeded')), 'timeout');
    assert.equal(stoppedReason(new Error('Query execution was interrupted (max_statement_time exceeded)')), 'timeout');
    assert.equal(stoppedReason(new StatementStopped('cancelled')), 'cancelled');
    assert.equal(stoppedReason(new Error('canceling statement due to user request')), undefined);
    assert.equal(stoppedReason(new Error('no such table: x')), undefined);
  });

  test('a cancel stops once, at once when it has already happened, and not after it is disarmed', () => {
    let stops = 0;
    const live = new AbortController();
    const disarm = onCancel(live.signal, () => {
      stops += 1;
    });
    live.abort();
    live.abort();
    assert.equal(stops, 1);
    disarm();
    const done = new AbortController();
    done.abort();
    onCancel(done.signal, () => {
      stops += 1;
    });
    assert.equal(stops, 2);
    const later = new AbortController();
    onCancel(later.signal, () => {
      stops += 1;
    })();
    later.abort();
    assert.equal(stops, 2);
  });
});

describe('MCP safety on SQLite', () => {
  let directory: string;
  let owner: string;
  let file: string;
  const registry = new Registry();
  const call = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    runTool(registry, name, { connection: owner, ...args }, { signal });

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-mcp-safety-'));
    owner = basename(directory);
    file = join(directory, 'safety.db');
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), note TEXT);
      CREATE TABLE numbers (n INTEGER PRIMARY KEY);
      CREATE TABLE __mistri_command_audit (id INTEGER PRIMARY KEY, secret TEXT);
      CREATE VIEW innocent AS SELECT id, secret FROM __mistri_command_audit;
      INSERT INTO parent VALUES (1, 'Many'), (2, 'Few');
      INSERT INTO __mistri_command_audit VALUES (1, 'not for agents');
      BEGIN;
    `);
    const child = database.prepare('INSERT INTO child (parent_id, note) VALUES (?, ?)');
    const number = database.prepare('INSERT INTO numbers VALUES (?)');
    for (let i = 1; i <= BOUND + 50; i++) {
      child.run(1, `note ${i}`);
      number.run(i);
    }
    for (let i = 1; i <= 3; i++) child.run(2, `few ${i}`);
    database.exec('COMMIT');
    database.close();
    registry.add({ id: owner, name: owner, url: file, source: 'config' });
    await registry.open(owner);
  });

  after(async () => {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });

  test('sql and explain refuse the runtime tables, however the statement reaches them', async () => {
    const attempts = [
      'select * from __mistri_command_audit',
      'select * from "__MISTRI_COMMAND_AUDIT"',
      'select * from main.[__mistri_command_audit]',
      'with a as (select * from __mistri_command_audit) select * from a',
      'select * from parent where exists (select 1 from `__mistri_command_audit`)',
    ];
    for (const statement of attempts) {
      refusedWith(await call('sql', { statement }), /__mistri_command_audit/i);
      refusedWith(await call('explain', { statement }), /__mistri_command_audit/i);
    }
  });

  test("a view over a runtime table is refused by the engine's own account, the text never naming it", async () => {
    refusedWith(await call('sql', { statement: 'select * from innocent' }), /"__mistri_command_audit"/);
    refusedWith(await call('sql', { statement: 'select p.name, (select count(*) from innocent) from parent p' }), /__mistri_command_audit/);
    refusedWith(await call('explain', { statement: 'select * from innocent where id = ?', params: [1] }), /__mistri_command_audit/);
  });

  test('ordinary statements still run, and still teach', async () => {
    const rows = answered(await call('sql', { statement: 'select id, name from parent order by id' }));
    assert.deepEqual(rows.rows, [
      [1, 'Many'],
      [2, 'Few'],
    ]);
    const plan = answered(await call('explain', { statement: 'select * from child where parent_id = ?', params: [1] }));
    assert.ok((plan.plan as string[]).length);
    refusedWith(await call('sql', { statement: 'select * from nonesuch' }), /no such table: nonesuch.*Ask `tables`/s);
  });

  test('a statement past its cap is stopped, and the answer says what to do', async () => {
    const [reply, ms] = await timed(() => call('sql', { statement: SLOW_SQLITE, timeout_ms: 300 }));
    refusedWith(reply, /300 ms cap.*narrow the question/s);
    assert.ok(ms < 5_000, `answered in ${ms} ms`);
    if (process.platform !== 'win32') assert.ok(await until(() => statementChildren() === 0), "the statement's process is gone");
  });

  test('a cancelled statement stops, and the call answers as cancelled', async () => {
    const controller = new AbortController();
    const running = timed(() => call('sql', { statement: SLOW_SQLITE }, controller.signal));
    if (process.platform !== 'win32') assert.ok(await until(() => statementChildren() === 1), 'the statement is running');
    controller.abort();
    const [reply, ms] = await running;
    refusedWith(reply, /^Cancelled/);
    assert.ok(ms < 5_000, `answered in ${ms} ms`);
    if (process.platform !== 'win32') assert.ok(await until(() => statementChildren() === 0), "the statement's process is gone");
    answered(await call('sql', { statement: 'select 1 as still_here' }));
  });

  test('a call cancelled before its turn runs nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    refusedWith(await call('query', { q: 'parent' }, controller.signal), /^Cancelled/);
    refusedWith(await call('sql', { statement: 'select 1' }, controller.signal), /^Cancelled/);
  });

  test('query counts to its bound and says when it stopped there', async () => {
    const many = answered(await call('query', { q: 'child parent_id = 1', limit: 1 }));
    assert.equal(many.total, BOUND);
    assert.equal(many.cappedTotal, true);
    const few = answered(await call('query', { q: 'child parent_id = 2' }));
    assert.equal(few.total, 3);
    assert.equal(few.cappedTotal, undefined);
    // A dotted path runs as a view, and its count is bounded the same way.
    const viewed = answered(await call('query', { q: 'child show id, parent_id.name', limit: 1 }));
    assert.equal(viewed.total, BOUND);
    assert.equal(viewed.cappedTotal, true);
  });

  test('breakdown counts groups to the same bound', async () => {
    const groups = answered(await call('breakdown', { q: 'numbers count by n', limit: 2 }));
    assert.equal(groups.total, BOUND);
    assert.equal(groups.cappedTotal, true);
    const two = answered(await call('breakdown', { q: 'child count by parent_id' }));
    assert.equal(two.total, 2);
    assert.equal(two.cappedTotal, undefined);
  });

  test('record counts what points at a row to the bound, per relationship', async () => {
    const many = answered(await call('record', { table: 'parent', key: { id: 1 } }));
    const pointing = (many.pointedAtBy as Array<{ table: string; count: number; capped?: true }>).find((r) => r.table === 'child')!;
    assert.equal(pointing.count, BOUND);
    assert.equal(pointing.capped, true);
    const few = answered(await call('record', { table: 'parent', key: { id: 2 } }));
    const three = (few.pointedAtBy as Array<{ table: string; count: number; capped?: true }>).find((r) => r.table === 'child')!;
    assert.equal(three.count, 3);
    assert.equal(three.capped, undefined);
  });
});

describe('MCP cancellation over stdio', () => {
  let directory: string;
  let child: ChildProcess;
  let nextId = 1;
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      replies.set(id, resolve);
      setTimeout(() => replies.delete(id) && reject(new Error(`No answer to ${method} ${id} within 20s`)), 20_000);
    });
    send({ id, method, params });
    return { id, reply };
  };
  const toolText = async (pending: { reply: Promise<Record<string, unknown>> }) => {
    const { result } = (await pending.reply) as { result: { isError: boolean; content: Array<{ text: string }> } };
    return { isError: result.isError, text: result.content[0].text };
  };

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-mcp-cancel-'));
    const file = join(directory, 'cancel.db');
    const database = new DatabaseSync(file);
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2);');
    database.close();
    child = spawn(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--db', file, '--mcp'], {
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
        const message = JSON.parse(line) as { id?: number };
        const resolve = typeof message.id === 'number' ? replies.get(message.id) : undefined;
        if (resolve) {
          replies.delete(message.id!);
          resolve(message as Record<string, unknown>);
        }
      }
    });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }).reply;
    send({ method: 'notifications/initialized' });
  });

  after(() => {
    child?.kill();
    rmSync(directory, { recursive: true, force: true });
  });

  test('notifications/cancelled stops the running call, and the loop answers the next one', async () => {
    const slow = request('tools/call', { name: 'sql', arguments: { statement: SLOW_SQLITE } });
    if (process.platform !== 'win32') assert.ok(await until(() => statementChildren() === 1, 10_000), 'the statement is running');
    const started = Date.now();
    send({ method: 'notifications/cancelled', params: { requestId: slow.id, reason: 'the user moved on' } });
    const stopped = await toolText(slow);
    assert.equal(stopped.isError, true);
    assert.match(stopped.text, /^Cancelled/);
    assert.ok(Date.now() - started < 5_000);
    if (process.platform !== 'win32') assert.ok(await until(() => statementChildren() === 0), "the statement's process is gone");
    const next = await toolText(request('tools/call', { name: 'sql', arguments: { statement: 'select count(*) as n from t' } }));
    assert.equal(next.isError, false, next.text);
  });

  test('a call withdrawn while it waits its turn answers as cancelled and never runs', async () => {
    const slow = request('tools/call', { name: 'sql', arguments: { statement: SLOW_SQLITE } });
    const queued = request('tools/call', { name: 'query', arguments: { q: 't' } });
    send({ method: 'notifications/cancelled', params: { requestId: queued.id } });
    send({ method: 'notifications/cancelled', params: { requestId: slow.id } });
    assert.match((await toolText(slow)).text, /^Cancelled/);
    const withdrawn = await toolText(queued);
    assert.equal(withdrawn.isError, true);
    assert.match(withdrawn.text, /^Cancelled/);
    const ping = await request('ping').reply;
    assert.deepEqual(ping.result, {});
  });
});

/* ---------- live engines ---------- */

const PG = process.env.TABLEWALK_TEST_PG;

describe('MCP safety on Postgres', { skip: liveSkip('postgres', PG) }, () => {
  const registry = new Registry();
  type Setup = { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> };
  let control: Setup;
  const call = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    runTool(registry, name, { connection: 'pg', ...args }, { signal });
  const active = async (marker: string) =>
    Number(
      (
        await control.query(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE '%${marker}%'`,
        )
      ).rows[0].n,
    );

  before(async () => {
    const specifier = 'pg';
    type ClientClass = new (options: Record<string, unknown>) => Setup & { connect(): Promise<void> };
    const pg = (await import(specifier)) as { Client?: ClientClass; default?: { Client: ClientClass } };
    const Client = pg.Client ?? pg.default!.Client;
    const client = new Client({ connectionString: PG, statement_timeout: 20_000 });
    await client.connect();
    control = client;
    await control.query('DROP VIEW IF EXISTS public.mcp_safety_innocent, public.mcp_safety_slow');
    await control.query('DROP TABLE IF EXISTS public."__mistri_mcp_safety"');
    await control.query('CREATE TABLE public."__mistri_mcp_safety" (id int PRIMARY KEY, secret text)');
    await control.query('CREATE VIEW public.mcp_safety_innocent AS SELECT id, secret FROM public."__mistri_mcp_safety"');
    /* pg_sleep answers void, which no view column may be; counted, it is a
       number that still sleeps once for every row evaluated. */
    await control.query(
      'CREATE VIEW public.mcp_safety_slow AS SELECT g AS id, ' +
        '(SELECT count(*) FROM pg_sleep(0.2)) AS mcp_slow_probe FROM generate_series(1, 400) g',
    );
    registry.add({ id: 'pg', name: 'pg', url: PG!, source: 'config' });
    await registry.open('pg');
  });

  after(async () => {
    await registry.closeAll();
    await control.query('DROP VIEW IF EXISTS public.mcp_safety_innocent, public.mcp_safety_slow');
    await control.query('DROP TABLE IF EXISTS public."__mistri_mcp_safety"');
    await control.end();
  });

  test('sql and explain refuse the runtime tables and the sign-in schema, by text and by plan', async () => {
    for (const statement of [
      'select * from "__mistri_mcp_safety"',
      'with a as (select * from public.__MISTRI_MCP_SAFETY) select * from a',
      'select * from mistri.auth_user',
      "select query_to_xml('select 1', true, false, '')",
    ]) {
      assert.equal((await call('sql', { statement })).isError, true, statement);
      assert.equal((await call('explain', { statement })).isError, true, statement);
    }
    // The text names only a view; the plan names what it reads.
    refusedWith(await call('sql', { statement: 'select * from mcp_safety_innocent' }), /__mistri_mcp_safety/);
    refusedWith(
      await call('explain', { statement: 'select * from mcp_safety_innocent where id = $1', params: [1] }),
      /__mistri_mcp_safety/,
    );
    refusedWith(await call('sql', { statement: 'show search_path' }), /planner can explain/);
    answered(await call('sql', { statement: 'select 1 as fine' }));
  });

  test('a statement past its cap is stopped by the database, and says so', async () => {
    const [reply, ms] = await timed(() => call('sql', { statement: 'select pg_sleep(5) as mcp_timeout_probe', timeout_ms: 300 }));
    refusedWith(reply, /statement timeout.*narrow the question/s);
    assert.ok(ms < 4_000, `answered in ${ms} ms`);
  });

  test('a cancelled sql call cancels its backend', async () => {
    const controller = new AbortController();
    const running = timed(() => call('sql', { statement: 'select pg_sleep(10) as mcp_cancel_probe' }, controller.signal));
    assert.ok(await until(async () => (await active('mcp_cancel_probe')) === 1), 'the statement is running');
    controller.abort();
    const [reply, ms] = await running;
    refusedWith(reply, /^Cancelled/);
    assert.ok(ms < 5_000, `answered in ${ms} ms`);
    assert.ok(await until(async () => (await active('mcp_cancel_probe')) === 0), 'the backend stopped');
  });

  test('a cancelled query cancels the read it is running through the pool', async () => {
    const controller = new AbortController();
    const running = timed(() => call('query', { q: 'mcp_safety_slow' }, controller.signal));
    assert.ok(await until(async () => (await active('mcp_safety_slow')) >= 1), 'the read is running');
    controller.abort();
    const [reply, ms] = await running;
    refusedWith(reply, /^Cancelled/);
    assert.ok(ms < 5_000, `answered in ${ms} ms`);
    assert.ok(await until(async () => (await active('mcp_safety_slow')) === 0), 'the backend stopped');
    answered(await call('query', { q: 'mcp_safety_innocent' }));
  });
});
