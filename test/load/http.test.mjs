import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { post, createAgent, workload } from './http.mjs';

const fixture = { issues: [{ id: 1, name: 'Known issue', status: 'backlog', priority: 'normal' }] };

test('workload assertions reject wrong rows, totals and falsely successful counts', () => {
  for (const iteration of [0, 2, 3]) {
    const item = workload(fixture, 0, iteration);
    const good = { table: 'issue', total: 1, exactTotal: true, rows: fixture.issues };
    assert.doesNotThrow(() => item.check(good));
    assert.throws(() => item.check({ ...good, rows: [] }));
    assert.throws(() => item.check({ ...good, total: 999 }));
    assert.throws(() => item.check({ ...good, rows: [{ ...fixture.issues[0], name: 'Another database' }] }));
    assert.throws(() => item.check({ errors: [{ message: 'Query failed' }] }));
  }
  const count = workload(fixture, 0, 1);
  assert.doesNotThrow(() => count.check({ count: 1, exact: true }));
  assert.throws(() => count.check({ count: 1, exact: false }));
  assert.throws(() => count.check({ count: 2, exact: true }));
});

test('transport refuses non-loopback origins and unsupported endpoints synchronously', () => {
  for (const origin of ['https://example.test', 'http://localhost:4111', 'http://127.0.0.1:4111/path', 'http://user@127.0.0.1:4111']) {
    assert.throws(() => post(origin, '/api/run', {}, {}), /Only owned loopback/);
  }
  assert.throws(() => post('http://127.0.0.1:4111', '/api/update', {}, {}), /Only owned loopback/);
});

test('transport rejects redirects and HTTP-200 semantic errors, and enforces request deadlines', async () => {
  let mode = 'redirect',
    count = 0;
  const server = createServer((req, res) => {
    count++;
    req.resume();
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/must-not-follow' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-mistri-app': 'thread' });
    res.end(JSON.stringify(mode === 'errors' ? { errors: [{ message: 'Invalid query' }] } : { count: 1, exact: true }));
  });
  const agent = createAgent();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const options = { agent, timeoutMs: 100 };
    await assert.rejects(post(origin, '/api/count', {}, options), /HTTP 302/);
    assert.equal(count, 1, 'No redirected request was issued');
    mode = 'errors';
    await assert.rejects(post(origin, '/api/count', {}, options), /semantic errors/);
    mode = 'valid';
    assert.deepEqual(await post(origin, '/api/count', {}, options), { count: 1, exact: true });
    mode = 'timeout';
    await assert.rejects(post(origin, '/api/count', {}, options), /deadline exceeded/);
    await assert.rejects(post(origin, '/api/count', {}, { ...options, signal: AbortSignal.abort() }), /abort/i);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
