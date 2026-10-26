import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';

export function createAgent() {
  return new Agent({ keepAlive: true, maxSockets: 1 });
}

export function post(origin, path, body, { timeoutMs, signal, agent }) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/api/run', '/api/count'].includes(path)
  ) {
    throw new Error('Only owned loopback resource endpoints are supported');
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, app: 'thread' });
    let timer;
    const req = request(
      new URL(path, origin),
      { method: 'POST', agent, signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin } },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error('Response exceeds 2 MiB'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200, `HTTP ${res.statusCode}`);
            assert.equal(res.headers['x-mistri-app'], 'thread', 'Wrong app identity');
            const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.ok(reply && typeof reply === 'object', 'Missing response object');
            assert.ok(
              !reply.error && (!reply.errors || (Array.isArray(reply.errors) && reply.errors.length === 0)),
              'API reported semantic errors',
            );
            resolve(reply);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    timer = setTimeout(() => req.destroy(new Error(`HTTP deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
    req.end(data);
  });
}

export function workload(fixture, user, iteration) {
  const rows = fixture.issues;
  const kind = iteration % 4;
  if (kind === 1)
    return {
      path: '/api/count',
      operation: 'count-all',
      body: { table: 'issue', exactCount: true },
      check: (reply) => {
        assert.equal(reply.count, rows.length);
        assert.equal(reply.exact, true);
      },
    };
  const detail = kind === 2;
  const filtered = kind === 3;
  const id = ((iteration * 17 + user * 31) % rows.length) + 1;
  const expected = detail ? rows.filter((row) => row.id === id) : filtered ? rows.filter((row) => row.status === 'backlog') : rows;
  const q = detail ? `issue id = ${id}` : filtered ? 'issue status = backlog' : 'issue';
  return {
    path: '/api/run',
    operation: detail ? 'detail' : filtered ? 'filtered-list' : 'list',
    body: { q, columns: ['id', 'name', 'status', 'priority'], limit: 25, exactCount: true },
    check: (reply) => {
      assert.equal(reply.table, 'issue');
      assert.equal(reply.total, expected.length);
      assert.equal(reply.exactTotal, true);
      assert.ok(Array.isArray(reply.rows), 'Missing rows');
      assert.equal(reply.rows.length, Math.min(25, expected.length));
      assert.equal(new Set(reply.rows.map((row) => row.id)).size, reply.rows.length, 'Duplicate issue rows');
      for (const row of reply.rows)
        assert.deepEqual(
          row,
          expected.find((candidate) => candidate.id === row.id),
        );
    },
  };
}

export async function verifyFixture(server, fixture, options, signal) {
  assert.ok(server.alive(), 'Owned child is not alive');
  const agent = createAgent();
  try {
    const reply = await post(
      server.origin,
      '/api/run',
      { q: 'issue id = 1', columns: ['id', 'description'], exactCount: true },
      { timeoutMs: options.requestTimeoutMs, signal, agent },
    );
    assert.deepEqual(reply.rows, [{ id: 1, description: fixture.marker }], 'Server does not own this run’s fixture');
    assert.equal(reply.total, 1);
    const count = workload(fixture, 0, 1);
    count.check(await post(server.origin, count.path, count.body, { timeoutMs: options.requestTimeoutMs, signal, agent }));
    assert.ok(server.alive(), 'Owned child exited during verification');
  } finally {
    agent.destroy();
  }
}
