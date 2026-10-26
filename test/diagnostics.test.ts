import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import {
  diagnosticsFromEnvironment,
  RequestDiagnostics,
  type RequestDiagnostic,
  type RequestMetricsDiagnostic,
} from '../packages/engine/src/server/operations/diagnostics.js';
import { createApp } from './support/createApp.js';

const SECRET = 'private-customer-password-token';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capture() {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const records = () => lines.map((line): RequestDiagnostic | RequestMetricsDiagnostic => JSON.parse(line));
  return {
    output,
    lines,
    events: () => records().filter((event) => event.event === 'http.request'),
    summaries: () => records().filter((event) => event.event === 'http.metrics'),
  };
}

function request(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
}

async function serve(diagnostics?: RequestDiagnostics) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-diagnostics-'));
  const file = join(dir, 'data.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO item VALUES (1, ?)').run(SECRET);
  db.close();
  const registry = new Registry();
  registry.add({ name: 'diagnostics', url: file, writable: true, source: 'session' });
  const bound = { host: '127.0.0.1', port: 0 };
  const server: Server = createApp({ registry, bound, diagnostics });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const base = `http://${bound.host}:${bound.port}`;
  return {
    base,
    file,
    registry,
    server,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      // Test-owned requests must not keep teardown waiting for the server's
      // production request timeout after a failed assertion or an aborted read.
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function completed(diagnostics: RequestDiagnostics, url = '/api/update', method = 'POST') {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.method = method;
  const res = new ServerResponse(req);
  diagnostics.observe(req, res);
  res.emit('finish');
  res.emit('close');
  return res;
}

test('diagnostics require exact opt-in and disabled HTTP responses are unchanged', async () => {
  const log = capture();
  for (const value of [undefined, '', '0', 'false', 'true', 'yes', ' 1']) {
    assert.equal(diagnosticsFromEnvironment(value, log.output), undefined);
  }
  assert.equal(log.output.listenerCount('error'), 0);
  const app = await serve();
  try {
    const response = await request(`${app.base}/api/connections`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), null);
    assert.equal((await response.json()).connections.length, 1);
    assert.deepEqual(log.lines, []);
  } finally {
    await app.close();
  }
});

test('diagnostics fixture teardown closes an unfinished HTTP request', { timeout: 5_000 }, async () => {
  const app = await serve();
  const socket = new Socket();
  let closed = false;
  try {
    const url = new URL(app.base);
    socket.resume();
    socket.connect(Number(url.port), url.hostname);
    await once(socket, 'connect');
    const received = once(app.server, 'request');
    socket.write(`POST /api/update HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 100\r\n\r\n{`);
    await received;
    const disconnected = once(socket, 'close');
    await app.close();
    closed = true;
    await disconnected;
    assert.equal(socket.destroyed, true);
  } finally {
    socket.destroy();
    if (!closed) await app.close();
  }
});

test('HTTP diagnostics correlate generated IDs, timings and statuses without retaining private data', async () => {
  const log = capture();
  const diagnostics = diagnosticsFromEnvironment('1', log.output)!;
  const app = await serve(diagnostics);
  try {
    const first = await request(`${app.base}/api/connections?secret=${SECRET}`, {
      headers: { 'x-request-id': SECRET, authorization: `Bearer ${SECRET}`, cookie: `session=${SECRET}` },
    });
    assert.equal(first.status, 200);
    await first.text();
    const second = await request(`${app.base}/api/schema?conn=${SECRET}`);
    assert.equal(second.status, 404);
    await second.text();
    const invalid = await request(`${app.base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: SECRET,
    });
    assert.equal(invalid.status, 400);
    await invalid.text();
    const rejected = await request(`${app.base}/api/insert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'item', values: { name: SECRET } }),
    });
    assert.equal(rejected.status, 200);
    assert.ok((await rejected.json()).errors.length > 0);
    const unknown = await request(`${app.base}/api/${SECRET}?q=${SECRET}`);
    await unknown.text();
    // Exercise a real non-API response without starting Vite's HTML transform
    // and background file watchers: this test owns diagnostics, not bundling.
    const page = await request(`${app.base}/app/item%20name%20%3D%20${SECRET}`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(page.status, 403);
    await page.text();
    assert.equal(await diagnostics.flush(), true);
    const events = log.events();
    assert.equal(events.length, 6);
    assert.deepEqual(
      events.map((event) => event.route),
      ['api.connections', 'api.schema', 'api.update', 'api.insert', 'api.other', 'web'],
    );
    assert.deepEqual(
      events.map((event) => event.status),
      [200, 404, 400, 200, unknown.status, page.status],
    );
    assert.equal(events[0].requestId, first.headers.get('x-request-id'));
    assert.equal(events[1].requestId, second.headers.get('x-request-id'));
    assert.equal(new Set(events.map((event) => event.requestId)).size, 6);
    for (const event of events) {
      assert.match(event.requestId, UUID);
      assert.equal(event.event, 'http.request');
      assert.equal(event.outcome, 'completed');
      assert.equal(event.droppedTotal, 0);
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));
      assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
      assert.deepEqual(
        Object.keys(event).sort(),
        ['durationMs', 'event', 'method', 'outcome', 'requestId', 'route', 'status', 'timestamp', 'droppedTotal'].sort(),
      );
    }
    assert.ok(!log.lines.join('').includes(SECRET));
    assert.ok(!log.lines.join('').includes('authorization'));
    const summary = log.summaries()[0];
    assert.equal(summary.started, 6);
    assert.equal(summary.completed, 6);
    assert.equal(summary.aborted, 0);
    assert.equal(summary.inFlight, 0);
    assert.equal(summary.series.find((series) => series.route === 'api.insert')!.statusClass, '2xx');
    assert.equal(summary.series.find((series) => series.route === 'api.update')!.statusClass, '4xx');
    assert.equal(summary.health.droppedTotal, 0);
    assert.equal(log.summaries().length, 1);
  } finally {
    await app.close();
  }
});

test('uncaught errors contribute only their HTTP status, not exception messages', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  const app = await serve(diagnostics);
  const original = app.registry.open;
  app.registry.open = async () => {
    throw new Error(SECRET);
  };
  try {
    const response = await request(`${app.base}/api/schema`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, SECRET); // Existing response contract is unchanged.
    assert.equal(await diagnostics.flush(), true);
    assert.equal(log.events()[0].status, 500);
    assert.equal(log.summaries()[0].series[0].statusClass, '5xx');
    assert.ok(!log.lines.join('').includes(SECRET));
  } finally {
    app.registry.open = original;
    await app.close();
  }
});

test('completed and aborted responses emit once, and unknown dimensions stay bounded', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  completed(diagnostics, `/api/auth/callback/${SECRET}`, SECRET);
  completed(diagnostics, 'http://[invalid');
  const req = new IncomingMessage(new Socket());
  req.url = `/app/${SECRET}`;
  const res = new ServerResponse(req);
  diagnostics.observe(req, res);
  res.emit('close');
  res.emit('finish');
  assert.equal(await diagnostics.flush(), true);
  const events = log.events();
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.route),
    ['api.auth', 'unknown', 'web'],
  );
  assert.equal(events[0].method, 'OTHER');
  assert.equal(events[2].outcome, 'aborted');
  assert.equal(events[2].status, null);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.ok(!log.lines.join('').includes(SECRET));
});

test('a slow sink has a bounded queue, reports dropped records, and cannot delay a write response', async () => {
  let release: (() => void) | undefined;
  const lines: string[] = [];
  let hold = true;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      if (hold) release = done;
      else done();
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const app = await serve(diagnostics);
  try {
    completed(diagnostics);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100; i += 1) completed(diagnostics);
    assert.equal(lines.length, 1);
    assert.equal(diagnostics.droppedTotal, 37);
    assert.equal(diagnostics.snapshot().completed, 101);
    assert.equal(await diagnostics.flush(5), false);
    const response = await request(`${app.base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'item', key: { id: 1 }, values: { name: 'saved despite backpressure' } }),
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).affected, 1);
    assert.equal(lines.length, 1);
    hold = false;
    release!();
    assert.equal(await diagnostics.flush(), true);
    assert.equal(lines.length, 65);
    assert.equal(JSON.parse(lines.at(-2)!).droppedTotal, 38);
    const summary: RequestMetricsDiagnostic = JSON.parse(lines.at(-1)!);
    assert.equal(summary.event, 'http.metrics');
    assert.equal(summary.completed, 102);
    assert.equal(summary.health.droppedTotal, 38);
    assert.equal(summary.health.queuedRecords, 0);
    assert.equal(await diagnostics.flush(), true);
    assert.equal(lines.length, 65);
  } finally {
    await app.close();
  }
});

test('a failed diagnostic sink cannot change a committed database write', async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error(SECRET));
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const app = await serve(diagnostics);
  try {
    const response = await request(`${app.base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'item', key: { id: 1 }, values: { name: 'saved' } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).affected, 1);
    assert.equal(await diagnostics.flush(), false);
    assert.equal(diagnostics.droppedTotal, 1);
    const db = new DatabaseSync(app.file);
    try {
      assert.equal(db.prepare('SELECT name FROM item WHERE id = 1').get()!.name, 'saved');
    } finally {
      db.close();
    }
    completed(diagnostics);
    assert.equal(diagnostics.droppedTotal, 2);
    assert.equal(diagnostics.snapshot().completed, 2);
    assert.equal(diagnostics.snapshot().health.failed, true);
  } finally {
    await app.close();
  }
});

test('synchronous sink failures disable output and do not double-count failed records', async () => {
  const output = new Writable({
    write() {
      throw new Error(SECRET);
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  completed(diagnostics);
  completed(diagnostics);
  assert.equal(await diagnostics.flush(), false);
  assert.equal(diagnostics.droppedTotal, 2);
  output.emit('error', new Error(SECRET));
  assert.equal(diagnostics.droppedTotal, 2);
  completed(diagnostics);
  assert.equal(diagnostics.droppedTotal, 3);
});

test('metrics observe in-flight requests and settle finish/close only once with captured labels', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = `/api/update?private=${SECRET}`;
  const res = new ServerResponse(req);
  diagnostics.observe(req, res);
  req.method = SECRET;
  req.url = SECRET;
  const before = diagnostics.snapshot();
  assert.equal(before.started, 1);
  assert.equal(before.inFlight, 1);
  assert.deepEqual(before.series, []);
  // Flush offers a snapshot; it does not wait for this request to end.
  assert.equal(await diagnostics.flush(), true);
  assert.equal(log.summaries()[0].inFlight, 1);
  res.writeHead(503);
  res.emit('close');
  res.emit('finish');
  res.emit('close');
  assert.equal(await diagnostics.flush(), true);
  const after = diagnostics.snapshot();
  assert.equal(after.aborted, 1);
  assert.equal(after.completed, 0);
  assert.equal(after.inFlight, 0);
  assert.equal(after.series[0].method, 'POST');
  assert.equal(after.series[0].route, 'api.update');
  assert.equal(after.series[0].statusClass, '5xx');
  assert.equal(log.events().length, 1);
  assert.equal(before.inFlight, 1);
  for (const value of [after, after.health, after.series, after.series[0], after.series[0].durationBuckets]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.ok(!JSON.stringify(after).includes(String(res.getHeader('x-request-id'))));
  assert.ok(!log.lines.join('').includes(SECRET));
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('close after writable completion retains completed outcome even without a finish event', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  diagnostics.observe(req, res);
  Object.defineProperty(res, 'writableFinished', { value: true });
  res.emit('close');
  res.emit('finish');
  assert.equal(await diagnostics.flush(), true);
  assert.equal(diagnostics.snapshot().completed, 1);
  assert.equal(diagnostics.snapshot().aborted, 0);
  assert.equal(log.events().length, 1);
});

test('summaries require explicit flush and unchanged overlapping/repeated calls coalesce', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  completed(diagnostics);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(log.events().length, 1);
  assert.equal(log.summaries().length, 0);
  const first = diagnostics.flush();
  for (let i = 0; i < 1_000; i += 1) assert.equal(diagnostics.flush(), first);
  assert.equal(await first, true);
  assert.equal(log.summaries().length, 1);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(log.summaries().length, 1);
  completed(diagnostics);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(log.summaries().length, 2);
  assert.equal(log.summaries()[0].completed, 1);
  assert.equal(log.summaries()[1].completed, 2);
});

test('empty flush emits one zero summary and does not end the owned stream', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(log.lines.length, 1);
  assert.equal(log.summaries()[0].started, 0);
  assert.equal(log.output.writableEnded, false);
  assert.deepEqual(log.summaries()[0].health, {
    droppedTotal: 0,
    failed: false,
    queuedRecords: 0,
    writingRecord: false,
    writingSummary: false,
    summaryPending: false,
    summaryDroppedTotal: 0,
  });
});

test('a timed-out summary remains one write and a later flush can finish waiting', async () => {
  let release: (() => void) | undefined;
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      release = done;
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const first = diagnostics.flush(5);
  assert.equal(diagnostics.flush(1_000), first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await first, false);
  assert.equal(lines.length, 1);
  assert.equal(diagnostics.snapshot().health.writingSummary, true);
  assert.equal(diagnostics.snapshot().health.summaryPending, false);
  assert.equal(await diagnostics.flush(5), false);
  assert.equal(lines.length, 1);
  const last = diagnostics.flush();
  release!();
  assert.equal(await last, true);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(lines.length, 1);
  assert.equal(diagnostics.snapshot().health.summaryDroppedTotal, 0);
});

test('requests arriving during a summary write require another explicit flush for their summary', async () => {
  let release: (() => void) | undefined;
  const lines: string[] = [];
  let hold = true;
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      if (hold) release = done;
      else done();
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const first = diagnostics.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 100; i += 1) completed(diagnostics);
  assert.equal(diagnostics.snapshot().health.queuedRecords, 64);
  assert.equal(diagnostics.snapshot().health.writingSummary, true);
  assert.equal(diagnostics.droppedTotal, 36);
  hold = false;
  release!();
  assert.equal(await first, true);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    ['http.metrics', ...Array(64).fill('http.request')],
  );
  assert.equal(await diagnostics.flush(), true);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    ['http.metrics', ...Array(64).fill('http.request'), 'http.metrics'],
  );
  assert.equal(JSON.parse(lines.at(-1)!).completed, 100);
  assert.equal(JSON.parse(lines.at(-1)!).health.droppedTotal, 36);
});

test('summary export failure cannot change a committed write or count it as a dropped request record', async () => {
  const output = new Writable({
    write(chunk, _encoding, done) {
      done(JSON.parse(String(chunk)).event === 'http.metrics' ? new Error(SECRET) : undefined);
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const app = await serve(diagnostics);
  try {
    const response = await request(`${app.base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'item', key: { id: 1 }, values: { name: 'summary failed, write saved' } }),
    });
    assert.equal((await response.json()).affected, 1);
    assert.equal(await diagnostics.flush(), false);
    assert.equal(diagnostics.snapshot().health.failed, true);
    assert.equal(diagnostics.snapshot().health.droppedTotal, 0);
    assert.equal(diagnostics.snapshot().health.summaryDroppedTotal, 1);
    output.emit('error', new Error(SECRET));
    assert.equal(await diagnostics.flush(), false);
    assert.equal(diagnostics.snapshot().health.summaryDroppedTotal, 1);
    const db = new DatabaseSync(app.file);
    try {
      assert.equal(db.prepare('SELECT name FROM item WHERE id = 1').get()!.name, 'summary failed, write saved');
    } finally {
      db.close();
    }
    completed(diagnostics);
    assert.equal(diagnostics.snapshot().completed, 2);
    assert.equal(diagnostics.droppedTotal, 1);
  } finally {
    await app.close();
  }
});

test('overlapping flushes capture newer requests once after an older summary drains', async () => {
  let release: (() => void) | undefined;
  const lines: string[] = [];
  let hold = true;
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      if (hold) release = done;
      else done();
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const first = diagnostics.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  completed(diagnostics);
  for (let i = 0; i < 100; i += 1) assert.equal(diagnostics.flush(), first);
  assert.equal(diagnostics.snapshot().health.summaryPending, true);
  completed(diagnostics);
  assert.equal(diagnostics.flush(), first);
  hold = false;
  release!();
  assert.equal(await first, true);
  const records = lines.map((line): RequestDiagnostic | RequestMetricsDiagnostic => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.event),
    ['http.metrics', 'http.request', 'http.request', 'http.metrics'],
  );
  assert.deepEqual(
    records.filter((record) => record.event === 'http.metrics').map((summary) => summary.completed),
    [0, 2],
  );
  assert.equal(await diagnostics.flush(), true);
  assert.equal(lines.length, 4);
});

test('failure accounts for an active summary and one coalesced newer summary exactly once', async () => {
  let release: ((error?: Error | null) => void) | undefined;
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      release = done;
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  const first = diagnostics.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  completed(diagnostics);
  for (let i = 0; i < 100; i += 1) assert.equal(diagnostics.flush(), first);
  release!(new Error(SECRET));
  assert.equal(await first, false);
  output.emit('error', new Error(SECRET));
  assert.equal(await diagnostics.flush(), false);
  assert.equal(diagnostics.snapshot().completed, 1);
  assert.equal(diagnostics.snapshot().health.summaryDroppedTotal, 2);
  assert.equal(diagnostics.droppedTotal, 1);
  assert.equal(diagnostics.snapshot().health.summaryPending, false);
  assert.equal(diagnostics.snapshot().health.writingSummary, false);
  assert.equal(lines.length, 1);
});

test('a thrown summary write and late callback cannot revive or double-count a failed sink', async () => {
  let release: (() => void) | undefined;
  const output = new Writable({
    write(_chunk, _encoding, done) {
      release = done;
      throw new Error(SECRET);
    },
  });
  const diagnostics = new RequestDiagnostics(output);
  assert.equal(await diagnostics.flush(), false);
  output.emit('error', new Error(SECRET));
  release!();
  assert.equal(await diagnostics.flush(), false);
  assert.equal(diagnostics.snapshot().health.summaryDroppedTotal, 1);
  assert.equal(diagnostics.droppedTotal, 0);
});

test('instrumentation setup failure is a diagnostic drop without a fictional observed request', async () => {
  const log = capture();
  const diagnostics = new RequestDiagnostics(log.output);
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  res.writeHead(200);
  assert.doesNotThrow(() => diagnostics.observe(req, res));
  assert.equal(await diagnostics.flush(), true);
  assert.equal(log.summaries()[0].started, 0);
  assert.equal(log.summaries()[0].health.droppedTotal, 1);
  assert.equal(log.events().length, 0);
});

test('the real CLI wires environment opt-in and flushes on shutdown', { timeout: 20_000 }, async () => {
  for (const enabled of ['0', '1']) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', '--port', String(port)],
      {
        env: { ...process.env, DATABASE_URL: '', TABLEWALK_OPEN: '0', TABLEWALK_DIAGNOSTICS: enabled },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, 'exit');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', () => {
          if (stdout.includes('Listening on')) resolve();
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`CLI exited before listening: ${stderr}`)));
      });
      const response = await request(`http://127.0.0.1:${port}/api/connections?secret=${SECRET}`, {
        headers: { 'x-request-id': SECRET },
      });
      await response.text();
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0);
      const records = stderr
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line): RequestDiagnostic | RequestMetricsDiagnostic => JSON.parse(line));
      const events = records.filter((event) => event.event === 'http.request');
      const summaries = records.filter((event) => event.event === 'http.metrics');
      if (enabled === '1') {
        assert.equal(events.length, 1);
        assert.equal(events[0].requestId, response.headers.get('x-request-id'));
        assert.match(events[0].requestId, UUID);
        assert.equal(events[0].route, 'api.connections');
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].completed, 1);
        assert.equal(summaries[0].series[0].statusClass, '2xx');
        assert.equal(summaries[0].health.failed, false);
        assert.ok(!JSON.stringify(records).includes(SECRET));
      } else {
        assert.deepEqual(records, []);
        assert.equal(response.headers.get('x-request-id'), null);
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }
});
