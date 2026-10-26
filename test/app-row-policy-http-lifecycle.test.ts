import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import type { AppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { ResourceReadError } from '../packages/engine/src/server/resourceReadOperations.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'http-policy-lifecycle';
const secret = 'PRIVATE-session-policy-password';
const owners = ['private-operations', 'private-archive'] as const;
const reader: Identity = { id: 'reader-one', who: 'reader@example.test', role: 'reader' };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Lifecycle test did not reach its next boundary')), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext, relations = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-http-policy-lifecycle-'));
  const registry = new Registry();
  let policy: HttpAppPolicy | undefined;
  let server: Server | undefined;
  const events: string[] = [];
  const leases = new Map<string, { acquired: number; released: number }>();
  const reads: string[] = [];
  const contexts: AppPolicyContext[] = [];
  const control = {
    outer: { ...reader } as Identity | null,
    verified: { ...reader } as Identity | null,
    outerFailure: undefined as Error | undefined,
    verifyFailure: undefined as Error | undefined,
    bindFailure: undefined as { owner: string; error: Error; failed: ReturnType<typeof gate> } | undefined,
    outerCalls: 0,
    verifyCalls: 0,
    settled: 0,
    closes: 0,
    outerRequest: undefined as IncomingMessage | undefined,
    block: undefined as
      | { owner: string; method: 'query' | 'count'; table?: string; entered: ReturnType<typeof gate>; held: ReturnType<typeof gate> }
      | undefined,
    readFailure: undefined as
      | { owner: string; method: 'query' | 'count'; table?: string; error: Error; after: Promise<void>; failed: ReturnType<typeof gate> }
      | undefined,
  };
  t.after(async () => {
    control.block?.held.release();
    server?.closeAllConnections();
    try {
      await bounded(policy?.retire() ?? Promise.resolve());
    } finally {
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      await registry.closeAll();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const owner of owners) {
    const file = join(directory, `${owner}.db`);
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE physical_note(id INTEGER PRIMARY KEY, body TEXT, desk INTEGER);
        INSERT INTO physical_note VALUES (1, 'Visible', 1), (2, 'Hidden', 2);`);
      if (relations)
        db.exec(`
        CREATE TABLE physical_reply(id INTEGER PRIMARY KEY, note INTEGER REFERENCES physical_note(id), desk INTEGER);
        CREATE TABLE physical_followup(id INTEGER PRIMARY KEY, note INTEGER REFERENCES physical_note(id), desk INTEGER);
        INSERT INTO physical_reply VALUES (1, 1, 1);
        INSERT INTO physical_followup VALUES (1, 1, 1);`);
    } finally {
      db.close();
    }
    registry.add({ id: owner, name: owner, url: file, source: 'config', writable: false });
    const { adapter } = await registry.open(owner);
    const close = adapter.close.bind(adapter);
    adapter.close = async () => {
      control.closes++;
      await close();
    };
    // Capture the real physical scoped reader BEFORE deployment captures its
    // capabilities. Holding the returned operation proves an actual data read
    // is outstanding, rather than just delaying auth or the route callback.
    const scopeReads = adapter.scopeReads!.bind(adapter);
    adapter.scopeReads = async (scope) => {
      if (control.bindFailure?.owner === owner) {
        control.bindFailure.failed.release();
        throw control.bindFailure.error;
      }
      const scoped = await scopeReads(scope);
      const observe = async <T>(method: 'query' | 'count', table: string, run: () => Promise<T>) => {
        reads.push(`${owner}:${method}`);
        const block = control.block;
        if (block?.owner === owner && block.method === method && (!block.table || block.table === table)) {
          events.push('read:entered');
          block.entered.release();
          await block.held.promise;
        }
        try {
          const failure = control.readFailure;
          if (failure?.owner === owner && failure.method === method && (!failure.table || failure.table === table)) {
            await failure.after;
            failure.failed.release();
            throw failure.error;
          }
          return await run();
        } finally {
          events.push(`read:finished:${owner}:${method}`);
        }
      };
      return {
        ...scoped,
        query: (query) => observe('query', query.table, () => scoped.query(query)),
        count: (table, filter) => observe('count', table, () => scoped.count(table, filter)),
      };
    };
    adapter.query = async () => assert.fail('HTTP used an unscoped physical query');
    adapter.count = async () => assert.fail('HTTP used an unscoped physical count');
  }
  const lease = registry.lease.bind(registry);
  registry.lease = (owner) => {
    const counts = leases.get(owner) ?? { acquired: 0, released: 0 };
    leases.set(owner, counts);
    counts.acquired++;
    const release = lease(owner);
    return () => {
      counts.released++;
      events.push(`release:${owner}`);
      release();
    };
  };
  const resources = { note: 'physical_note', ...(relations ? { reply: 'physical_reply', followup: 'physical_followup' } : {}) };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Lifecycle',
      auth: { providers: ['email'], rows: 'policy', roles: { reader: { read: true }, reviewer: { read: true } } },
      sources: {
        operations: { connection: owners[0], default: true },
        archive: { connection: owners[1] },
      },
      // Each table on both sources, in the order the ceiling lists them.
      resources: Object.fromEntries(
        Object.entries(resources).flatMap(([table, physical]) => [
          [table, { physical }],
          [`archive.${table}`, { physical }],
        ]),
      ),
      views: { notes: { kind: 'list', from: 'note', label: 'Notes' } },
      home: 'notes',
      nav: ['notes'],
    },
    'HTTP lifecycle fixture',
  );
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `
    export const state = { failure: null, calls: 0 };
    export default { appId: ${JSON.stringify(appId)}, resolveRows() {
      state.calls++;
      if (state.failure) throw state.failure;
      const visible = { groups: [[{ column: 'desk', op: '=', value: 1 }]] };
      return Object.fromEntries(${JSON.stringify(Object.keys(resources))}.flatMap(table => [[table, visible], ['archive.' + table, visible]]));
    } };
  `,
  );
  const { state } = (await import(pathToFileURL(file).href)) as { state: { failure: Error | null; calls: number } };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async (request) => {
        control.outerCalls++;
        control.outerRequest = request;
        if (control.outerFailure) throw control.outerFailure;
        return control.outer;
      },
    },
  };
  policy = await loadHttpAppPolicy({
    app,
    registry,
    file,
    verifySession: async (request) => {
      control.verifyCalls++;
      assert.equal(request, control.outerRequest, 'deployment verifies the same HTTP request as outer auth');
      if (control.verifyFailure) throw control.verifyFailure;
      return control.verified;
    },
  });
  const deployed = policy;
  const observed: HttpAppPolicy = {
    ...deployed,
    withContext: (request, run) => {
      const invocation = deployed.withContext(request, async (context) => {
        contexts.push(context);
        return run(context);
      });
      void invocation.then(
        () => {
          control.settled++;
        },
        () => {
          control.settled++;
        },
      );
      return invocation;
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], policy: observed });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const request = async (path = '/api/count', body?: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(3_000),
      headers: { Cookie: 'session=reader', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ app: appId, ...body }) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const heldLeases = () => {
    assert.deepEqual(
      [...leases],
      owners.map((owner) => [owner, { acquired: 1, released: 0 }]),
    );
    assert.equal(control.closes, 0);
  };
  return {
    base,
    server,
    policy: deployed,
    request,
    leases,
    heldLeases,
    control,
    contexts,
    reads,
    events,
    state,
    app,
    host,
    registry,
    bound,
  };
}

test('HTTP enrollment accepts its unchanged ordinary parsed App definition', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(f.policy.matches(f.app), true);
  const server = createApp({ registry: f.registry, bound: f.bound, apps: [f.host], policy: f.policy });
  // An unlistened server still needs close() to detach its dev-client ownership.
  server.close();
});

for (const [method, table, owner] of [
  ['query', 'note', owners[0]],
  ['count', 'archive.note', owners[1]],
] as const) {
  test(
    `HTTP disconnect holds deployment leases through blocked ${method} and retirement drains before one release per source`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t);
      const warmup = await f.request('/api/count', { table });
      assert.equal(warmup.status, 200);
      assert.deepEqual(warmup.body, { count: 1, exact: true });
      f.heldLeases();
      const block = { owner, method, entered: gate(), held: gate() };
      f.control.block = block;
      const disconnected = gate();
      f.server.prependListener('request', (request, response) => {
        if (request.headers['x-lifecycle-disconnect']) response.once('close', disconnected.release);
      });
      const request = httpRequest(`${f.base}/api/${method}`, {
        method: 'POST',
        agent: false,
        headers: { Cookie: 'session=reader', 'Content-Type': 'application/json', 'x-lifecycle-disconnect': 'yes' },
      });
      let receivedResponse = false;
      request.on('response', (response) => {
        receivedResponse = true;
        response.resume();
      });
      const clientError = new Promise<Error>((resolve) => request.once('error', resolve));
      request.end(JSON.stringify({ app: appId, table, limit: 10, offset: 0 }));
      try {
        await bounded(block.entered.promise);
        request.destroy();
        await bounded(disconnected.promise);
        assert.equal(((await bounded(clientError)) as NodeJS.ErrnoException).code, 'ECONNRESET');
        await turn();
        assert.equal(receivedResponse, false);
        assert.equal(f.control.settled, 1, 'only the warmup invocation has settled');
        f.heldLeases();
        let retired = false;
        const retirement = f.policy.retire();
        const repeated = f.policy.retire();
        assert.equal(repeated, retirement);
        void retirement.then(() => {
          retired = true;
        });
        const readsBefore = f.reads.length;
        const verificationsBefore = f.control.verifyCalls;
        const refused = await f.request('/api/count', { table });
        assert.equal(refused.status, 503);
        assert.match(refused.body.error, /policy is unavailable/i);
        assert.equal(f.control.verifyCalls, verificationsBefore);
        assert.equal(f.reads.length, readsBefore);
        await turn();
        assert.equal(retired, false, 'retirement is pending while the disconnected read is held');
        f.heldLeases();
        block.held.release();
        await bounded(Promise.all([retirement, repeated]));
        assert.equal(f.control.settled, 2);
        assert.deepEqual(
          [...f.leases],
          owners.map((id) => [id, { acquired: 1, released: 1 }]),
        );
        const finished = f.events.indexOf(`read:finished:${owner}:${method}`, f.events.indexOf('read:entered'));
        assert.ok(finished >= 0);
        for (const id of owners) assert.ok(f.events.indexOf(`release:${id}`) > finished);
        await f.policy.retire();
        assert.deepEqual(
          [...f.leases],
          owners.map((id) => [id, { acquired: 1, released: 1 }]),
        );
        assert.equal(f.control.closes, 0, 'retirement releases leases without closing registry-owned adapters');
      } finally {
        request.destroy();
        block.held.release();
      }
    },
  );
}

for (const changed of ['identity', 'roles', 'signed-out'] as const) {
  test(`HTTP refuses data when ${changed} changes between outer auth and deployment verification`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.control.verified =
      changed === 'signed-out'
        ? null
        : {
            ...reader,
            ...(changed === 'identity' ? { id: 'reader-two' } : { role: 'reviewer' }),
          };
    const response = await f.request('/api/query', { table: 'note', limit: 10 });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'Access to this resource is denied.', code: 'forbidden' });
    assert.equal(f.control.outerCalls, 1);
    assert.equal(f.control.verifyCalls, 1);
    assert.deepEqual(f.reads, []);
    f.heldLeases();
    f.control.verified = { ...reader };
    const recovered = await f.request('/api/count', { table: 'note' });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.count, 1);
  });
}

test('HTTP compares normalized role sets and expires retained read capabilities after invocation', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.control.outer = { ...reader, role: 'reviewer, reader,reader' };
  f.control.verified = { ...reader, role: 'reader,reviewer' };
  const response = await f.request('/api/query', { table: 'note', limit: 10 });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rows, [{ id: 1, body: 'Visible', desk: 1 }]);
  await turn();
  assert.equal(f.control.settled, 1);
  const [context] = f.contexts;
  const count = context.data.count;
  const readsBefore = f.reads.length;
  await assert.rejects(count('note'), AppAccessDenied);
  await assert.rejects(context.data.query({ table: 'archive.note', limit: 10, offset: 0 }), AppAccessDenied);
  await assert.rejects(
    context.transaction('operations', async () => assert.fail('Expired transaction callback ran')),
    AppAccessDenied,
  );
  assert.equal(f.reads.length, readsBefore);
  f.heldLeases();
  assert.equal((await f.request('/api/count', { table: 'archive.note' })).body.count, 1);
});

for (const path of ['/api/run', '/api/references'] as const) {
  for (const kind of ['Refusal', 'AppAccessDenied', 'ResourceReadError'] as const) {
    test(
      `${path} drains a failed ${kind} and a blocked sibling before sending one private-safe response`,
      { timeout: 10_000 },
      async (t) => {
        const references = path === '/api/references';
        const f = await fixture(t, references);
        const body = references ? { table: 'note', key: { id: 1 } } : { q: 'note', exactCount: true };
        const warmup = await f.request(path, body);
        assert.equal(warmup.status, 200);
        if (references) {
          assert.deepEqual(warmup.body.references.map((entry: { table: string; count: number }) => [entry.table, entry.count]).sort(), [
            ['followup', 1],
            ['reply', 1],
          ]);
        } else {
          assert.equal(warmup.body.total, 1);
          assert.deepEqual(warmup.body.rows, [{ id: 1, body: 'Visible', desk: 1 }]);
        }
        const block = {
          owner: owners[0],
          method: references ? ('count' as const) : ('query' as const),
          table: references ? 'physical_followup' : 'physical_note',
          entered: gate(),
          held: gate(),
        };
        const failure = {
          owner: owners[0],
          method: 'count' as const,
          table: references ? 'physical_reply' : 'physical_note',
          error:
            kind === 'ResourceReadError'
              ? new ResourceReadError(400, secret)
              : kind === 'Refusal'
                ? new Refusal(secret)
                : new AppAccessDenied(),
          after: block.entered.promise,
          failed: gate(),
        };
        f.control.block = block;
        f.control.readFailure = failure;
        let serverResponse!: ServerResponse;
        let finished = 0;
        let responses = 0;
        const responseErrors: Error[] = [];
        f.server.prependOnceListener('request', (_request, response) => {
          serverResponse = response;
          response.on('finish', () => {
            finished++;
          });
          response.on('error', (error) => {
            responseErrors.push(error);
          });
        });
        const request = httpRequest(`${f.base}${path}`, {
          method: 'POST',
          agent: false,
          headers: { Cookie: 'session=reader', 'Content-Type': 'application/json' },
        });
        const received = new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
          request.on('error', reject);
          request.on('response', (response) => {
            responses++;
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, text }));
          });
        });
        // Keep a failed transport observed even if an earlier boundary assertion
        // fails; received is still awaited below and must contain one full reply.
        void received.catch(() => {});
        request.end(JSON.stringify({ app: appId, ...body }));
        try {
          await bounded(Promise.all([block.entered.promise, failure.failed.promise]));
          await turn();
          assert.equal(f.control.settled, 1, 'the failed invocation still owns its blocked read');
          assert.equal(serverResponse.headersSent, false, 'no success or error headers before every read settles');
          assert.equal(serverResponse.writableEnded, false);
          assert.equal(responses, 0);
          assert.equal(finished, 0);
          f.heldLeases();
          block.held.release();
          const response = await bounded(received);
          await turn();
          assert.equal(response.status, kind === 'ResourceReadError' ? 500 : kind === 'Refusal' ? 400 : 403);
          assert.doesNotMatch(
            response.text,
            /PRIVATE-session-policy-password|physical_note|physical_reply|physical_followup|private-operations/,
          );
          const payload = JSON.parse(response.text);
          assert.equal(typeof payload.error, 'string');
          if (kind === 'AppAccessDenied')
            assert.deepEqual(payload, {
              error: 'Access to this resource is denied.',
              code: 'forbidden',
            });
          assert.equal(Object.hasOwn(payload, 'references'), false, "discard the handler's caught-error success payload");
          assert.equal(Object.hasOwn(payload, 'rows'), false);
          assert.equal(responses, 1);
          assert.equal(finished, 1);
          assert.deepEqual(responseErrors, []);
          assert.equal(f.control.settled, 2);
          f.heldLeases();
          f.control.readFailure = undefined;
          f.control.block = undefined;
          const recovered = await f.request('/api/count', { table: 'note' });
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body, { count: 1, exact: true });
          // The node:test runner additionally fails this test file on any
          // uncaught ERR_HTTP_HEADERS_SENT or unhandled rejection after send.
        } finally {
          block.held.release();
          request.destroy();
        }
      },
    );
  }
}

for (const stage of ['outer session', 'deployment session', 'resolver'] as const) {
  for (const kind of ['Error', 'Refusal', 'ResourceReadError'] as const) {
    test(`HTTP keeps ${stage} ${kind} exceptions private and retains deployment leases`, { timeout: 10_000 }, async (t) => {
      const f = await fixture(t);
      const failure =
        kind === 'ResourceReadError'
          ? new ResourceReadError(404, secret)
          : kind === 'Error'
            ? new Error(secret, { cause: new Error('private cause') })
            : new Refusal(secret);
      if (stage === 'outer session') f.control.outerFailure = failure;
      else if (stage === 'deployment session') f.control.verifyFailure = failure;
      else f.state.failure = failure;
      const response = await f.request('/api/query', { table: 'note', limit: 10 });
      assert.ok(response.status >= 400 && response.status < 600);
      assert.doesNotMatch(
        JSON.stringify({ body: response.body, headers: [...response.headers] }),
        /PRIVATE-session-policy-password|private cause|physical_note|private-operations/,
      );
      if (stage !== 'outer session') {
        assert.equal(response.status, 403);
        assert.deepEqual(response.body, { error: 'Access to this resource is denied.', code: 'forbidden' });
      }
      assert.deepEqual(f.reads, []);
      f.heldLeases();
      f.control.outerFailure = undefined;
      f.control.verifyFailure = undefined;
      f.state.failure = null;
      assert.equal((await f.request('/api/count', { table: 'note' })).body.count, 1);
    });
  }
}

for (const method of ['query', 'count'] as const) {
  for (const stage of ['provider', 'binder'] as const) {
    test(
      `scoped HTTP ${method} keeps ${stage} ResourceReadError private and recovers on the same source`,
      { timeout: 10_000 },
      async (t) => {
        const f = await fixture(t);
        const error = new ResourceReadError(404, secret);
        error.cause = new Error('PRIVATE_SCOPED_PROVIDER_CAUSE');
        const failed = gate();
        if (stage === 'binder') f.control.bindFailure = { owner: owners[1], error, failed };
        else f.control.readFailure = { owner: owners[1], method, error, after: Promise.resolve(), failed };
        const response = await f.request(`/api/${method}`, { table: 'archive.note', exactCount: true });
        await bounded(failed.promise);
        assert.equal(response.status, 500, JSON.stringify(response.body));
        assert.deepEqual(response.body, {
          error: 'The data could not be loaded. Try again shortly.',
          code: 'data_unavailable',
        });
        assert.doesNotMatch(
          JSON.stringify({ body: response.body, headers: [...response.headers] }),
          /PRIVATE|physical_note|private-archive|private-operations|Visible|Hidden/,
        );
        assert.equal('rows' in response.body, false);
        assert.equal('count' in response.body, false);
        if (stage === 'binder') assert.deepEqual(f.reads, []);
        else assert.deepEqual(f.reads, [`${owners[1]}:${method}`]);
        f.heldLeases();
        f.control.bindFailure = undefined;
        f.control.readFailure = undefined;
        const recovered = await f.request('/api/count', { table: 'archive.note' });
        assert.equal(recovered.status, 200);
        assert.deepEqual(recovered.body, { count: 1, exact: true });
        f.heldLeases();
      },
    );
  }
}

test('scoped HTTP preserves public column diagnostics and denies unknown resources before binding', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.control.bindFailure = { owner: owners[1], error: new ResourceReadError(404, secret), failed: gate() };
  for (const [path, body] of [
    ['/api/query', { table: 'archive.note', columns: ['missing_column'] }],
    ['/api/count', { table: 'archive.note', filter: { groups: [[{ column: 'missing_column', op: '=', value: 1 }]] } }],
  ] as const) {
    const response = await f.request(path, body);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(response.body.error, /has no column "missing_column"/);
    assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE|physical_note|private-archive/);
  }
  for (const path of ['/api/query', '/api/count']) {
    const response = await f.request(path, { table: 'missing_table' });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'Access to this resource is denied.', code: 'forbidden' });
  }
  assert.deepEqual(f.reads, []);
  f.heldLeases();
});
