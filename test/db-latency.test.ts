/**
 * `--db-latency <ms>` / `MISTRI_DEV_DB_LATENCY` (adapters/dbLatency.ts): every
 * database round trip waits first, a pipelined batch pays once, and the wait
 * is refused where it would be paid for nothing: NODE_ENV=production, and the
 * serve of a build.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, describe, test } from 'node:test';
import {
  configureDbLatency,
  delayFlights,
  dbLatency,
  refuseForBuild,
  roundTrip,
  setDbLatency,
} from '../packages/engine/src/adapters/dbLatency.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { pipelined, transactionHandle } from '../packages/engine/src/adapters/postgresTransactionHandle.js';
import { liveSkip } from './live.js';

afterEach(() => setDbLatency(0));

describe('configureDbLatency', () => {
  test('the flag wins over the variable, and neither is set by default', () => {
    assert.equal(configureDbLatency(undefined, {}), 0);
    assert.equal(configureDbLatency(undefined, { MISTRI_DEV_DB_LATENCY: '15' }), 15);
    assert.equal(configureDbLatency('20', { MISTRI_DEV_DB_LATENCY: '15' }), 20);
    assert.equal(dbLatency(), 20);
  });

  test('a value that is not a number of milliseconds is refused, naming where it came from', () => {
    assert.throws(() => configureDbLatency('fast', {}), /--db-latency takes the milliseconds/);
    assert.throws(() => configureDbLatency('', {}), /--db-latency takes/, 'a flag without its value');
    assert.throws(() => configureDbLatency(undefined, { MISTRI_DEV_DB_LATENCY: '-5' }), /MISTRI_DEV_DB_LATENCY takes/);
    assert.throws(() => configureDbLatency('9000', {}), /0 to 5000/);
  });

  test('production refuses it, by the flag and by the variable', () => {
    assert.throws(() => configureDbLatency('20', { NODE_ENV: 'production' }), /NODE_ENV is production/);
    assert.throws(() => configureDbLatency(undefined, { NODE_ENV: 'production', MISTRI_DEV_DB_LATENCY: '20' }), /NODE_ENV is production/);
    assert.equal(dbLatency(), 0);
    assert.equal(configureDbLatency(undefined, { NODE_ENV: 'production' }), 0, 'none asked, none refused');
  });

  test('the serve of a build refuses it and clears it', () => {
    refuseForBuild();
    setDbLatency(20);
    assert.throws(refuseForBuild, /refused when serving a build/);
    assert.equal(dbLatency(), 0);
  });
});

describe('delay', () => {
  test('a message waits the latency before it leaves, in order, and two written together leave together', async () => {
    const left: Array<[string, number]> = [];
    const stream = { write: (chunk: unknown) => (left.push([String(chunk), performance.now()]), true) };
    const client = { connection: { stream } };
    setDbLatency(60);
    delayFlights(client);
    const start = performance.now();
    stream.write('a');
    stream.write('b');
    assert.equal(left.length, 0, 'nothing leaves at once');
    await new Promise((done) => setTimeout(done, 150));
    assert.deepEqual(
      left.map(([text]) => text),
      ['a', 'b'],
    );
    assert.ok(
      left.every(([, at]) => at - start >= 55 && at - start < 140),
      'each waited one latency, not one each after the other',
    );
  });

  test('nothing is installed while the wait is off, and a client is held once', () => {
    const write = () => true;
    const client = { connection: { stream: { write } } };
    delayFlights(client);
    assert.equal(client.connection.stream.write, write);
    setDbLatency(10);
    delayFlights(client);
    const held = client.connection.stream.write;
    delayFlights(client);
    assert.equal(client.connection.stream.write, held);
    delayFlights({});
  });

  test('a SQLite statement call waits one round trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-latency-'));
    new DatabaseSync(join(dir, 'a.db')).close();
    const adapter = new SqliteAdapter(join(dir, 'a.db'));
    try {
      setDbLatency(80);
      const start = performance.now();
      await adapter.runSql!({ text: 'SELECT 1', limit: 10 });
      const took = performance.now() - start;
      assert.ok(took >= 75 && took < 400, `one statement, one wait: ${took}ms`);
      setDbLatency(0);
      const quick = performance.now();
      await adapter.runSql!({ text: 'SELECT 1', limit: 10 });
      assert.ok(performance.now() - quick < 60);
      const waited = performance.now();
      setDbLatency(40);
      await roundTrip();
      assert.ok(performance.now() - waited >= 35);
    } finally {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);

describe('against a real PostgreSQL', { skip }, () => {
  test('a pipelined snapshot pays the latency once, a client that does not pipeline pays it a statement', async () => {
    const manager = new PgConnectionManager(LIVE!);
    const statements = ['SELECT 1 AS a', 'SELECT 2 AS a', 'SELECT 3 AS a', 'SELECT 4 AS a'];
    setDbLatency(120);
    const run = async (client: PgQuery) => {
      const handle = transactionHandle(client);
      await handle.query('BEGIN');
      try {
        const start = performance.now();
        await pipelined(handle, statements);
        return performance.now() - start;
      } finally {
        await handle.query('ROLLBACK');
      }
    };
    try {
      await manager.withWriteClient(run); // warm the connection: the first lease dials
      const pipelinedMs = await manager.withWriteClient(run);
      assert.ok(pipelinedMs >= 115 && pipelinedMs < 240, `four statements, one flight: ${pipelinedMs}ms`);
      const oneAtATime = await manager.withReadClient(run);
      assert.ok(oneAtATime >= 4 * 115, `a reader's four statements, four flights: ${oneAtATime}ms`);
    } finally {
      await manager.close();
    }
  });
});

describe('mistri --db-latency', () => {
  const ROOT = resolve('.');
  const work = mkdtempSync(join(tmpdir(), 'mistri-latency-cli-'));
  after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const dir = join(work, 'app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(dir, 'app.ts'), "export default { id: 'a', name: 'A', resources: {}, views: {}, home: 'x' };\n");
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; err: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
        { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg'), ...env }, timeout: 120_000, killSignal: 'SIGKILL' },
        (error, _out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, err }),
      );
    });

  test('NODE_ENV=production refuses the flag and the variable before anything is served', async () => {
    const flag = await run(['--app', dir, '--db', join(work, 'x.db'), '--db-latency', '20'], { NODE_ENV: 'production' });
    assert.equal(flag.code, 2, flag.err);
    assert.match(flag.err, /--db-latency slows every database round trip.*NODE_ENV is production/);
    const variable = await run(['--app', dir, '--db', join(work, 'x.db')], { NODE_ENV: 'production', MISTRI_DEV_DB_LATENCY: '20' });
    assert.equal(variable.code, 2, variable.err);
    assert.match(variable.err, /MISTRI_DEV_DB_LATENCY slows/);
  });

  test('a value that is not milliseconds is refused', async () => {
    const ran = await run(['--app', dir, '--db', join(work, 'x.db'), '--db-latency', 'soon']);
    assert.equal(ran.code, 2, ran.err);
    assert.match(ran.err, /--db-latency takes the milliseconds/);
  });
});
