/**
 * What a developer sees of each request's cost (serverTiming.ts, `--dev`): the
 * Server-Timing header on without MISTRI_SERVER_TIMING, one terminal line a
 * request that touched the database (round trips, database ms, CPU ms), and
 * one warning naming the route when it made more round trips than its budget.
 * The process entry stays out of a development response, token or none.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import {
  ROUND_TRIP_BUDGETS,
  budgetOf,
  costLines,
  setServerTimingDev,
  timeClient,
  timeRequests,
} from '../packages/engine/src/adapters/telemetry/serverTiming.js';

const cost = (over: Partial<Parameters<typeof costLines>[0]> = {}) =>
  costLines({ method: 'GET', route: '/api/view/run', status: 200, roundTrips: 2, dbMs: 31.04, cpuMs: 4.2, ...over });

describe('costLines', () => {
  test('a request within its budget is one line: round trips, database ms, CPU ms', () => {
    assert.deepEqual(cost(), ['mistri: GET /api/view/run 200: 2 round trips, db 31 ms, cpu 4.2 ms']);
    assert.deepEqual(cost({ roundTrips: 1 }), ['mistri: GET /api/view/run 200: 1 round trip, db 31 ms, cpu 4.2 ms']);
  });

  test('the budgets are 3 for a read, 6 for a command, 16 for the first page, and only more than that warns', () => {
    assert.deepEqual(ROUND_TRIP_BUDGETS, { read: 3, command: 6, entry: 16 });
    assert.equal(cost({ roundTrips: 3 }).length, 1);
    const read = cost({ roundTrips: 4 });
    assert.equal(read.length, 2);
    assert.match(
      read[1]!,
      /warning: GET \/api\/view\/run made 4 round trips; a read should make at most 3\. https:\/\/mistriwork\.dev\/docs\/performance-by-default\/$/,
    );
    assert.equal(cost({ method: 'POST', route: '/api/commands/:', roundTrips: 6 }).length, 1);
    assert.match(
      cost({ method: 'POST', route: '/api/commands/:', roundTrips: 7 })[1]!,
      /POST \/api\/commands\/: made 7 round trips; a command should make at most 6/,
    );
    assert.equal(cost({ route: 'page', roundTrips: 16 }).length, 1);
    assert.match(cost({ route: 'page', roundTrips: 17 })[1]!, /GET page made 17 round trips; an App's first page should make at most 16/);
  });

  test('an asset answers to no budget', () => {
    assert.equal(budgetOf('GET', '/assets'), undefined);
    assert.equal(cost({ route: '/assets', roundTrips: 40 }).length, 1);
  });
});

describe('a development server', () => {
  test('answers with Server-Timing and logs its cost, over budget warned, with no process entry', async () => {
    process.env.MISTRI_SERVER_TIMING_TOKEN = '';
    setServerTimingDev();
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(' '));
    const writes: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
    const client = { pipeline: false, query: () => new Promise((done) => setTimeout(() => done({ rows: [] }), 5)) };
    timeClient(client, 'app');
    const server = timeRequests(
      createServer(async (req, res) => {
        const flights = req.url?.includes('many') ? 5 : req.url?.includes('none') ? 0 : 2;
        for (let i = 0; i < flights; i += 1) await client.query();
        res.end('ok');
      }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const quick = await fetch(`${base}/api/view/run`);
      await quick.text();
      assert.match(quick.headers.get('server-timing') ?? '', /db-app;dur=[\d.]+;desc="flights=2 max=1"/);
      assert.doesNotMatch(quick.headers.get('server-timing') ?? '', /proc/, 'the process entry is never in a development response');
      await (await fetch(`${base}/api/view/many`)).text();
      await (await fetch(`${base}/api/none`)).text();
      const mine = lines.filter((line) => line.startsWith('mistri: '));
      assert.equal(mine.length, 3, mine.join('\n'));
      assert.match(mine[0]!, /^mistri: GET \/api\/view\/run 200: 2 round trips, db [\d.]+ ms, cpu [\d.]+ ms$/);
      assert.match(mine[1]!, /GET \/api\/view\/many 200: 5 round trips/);
      assert.match(mine[2]!, /warning: GET \/api\/view\/many made 5 round trips; a read should make at most 3\./);
      assert.ok(!writes.some((line) => line.includes('server-timing')), "the JSON log line is the operator's, not development's");
    } finally {
      console.error = error;
      process.stderr.write = write;
      server.close();
    }
  });
});
