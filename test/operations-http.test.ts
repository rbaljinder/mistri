import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { RequestDiagnostics } from '../packages/engine/src/server/operations/diagnostics.js';
import { createApp } from './support/createApp.js';
import { operationsHttpReply, operationsSourceId, readOperationsHttp } from '../packages/mistri/src/server/operations/operationsHttp.js';

/**
 * The operator routes over a real HTTP host with the App's auth stubbed at
 * the session boundary, exactly as the command HTTP proof does. What is
 * proven: the auth gate and the operations grant precede any collection,
 * the reply is private and bounded, and neither identity nor paths leak.
 */
const operator: Identity = { id: 'account-ops', who: 'ops@example.test', role: 'operator' };
const prober: Identity = { id: 'account-probe', who: 'probe@example.test', role: 'probe' };
const viewer: Identity = { id: 'account-view', who: 'viewer@example.test', role: 'viewer' };

async function fixture(
  run: (f: {
    base: string;
    control: { current: Identity | null; sessions: number };
    collected: () => number;
    diagnostics: RequestDiagnostics;
    directory: string;
  }) => Promise<void>,
  options: { diagnostics?: boolean; roles?: Record<string, unknown>; app?: Record<string, unknown> } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-operations-http-'));
  const file = join(directory, 'ops.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE loan(id INTEGER PRIMARY KEY, status TEXT); INSERT INTO loan VALUES (1, 'new');");
  db.close();
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: false, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'ops',
      name: 'Operations',
      sources: { lending: { connection: 'private-db' } },
      resources: { loan: {} },
      auth: {
        roles: options.roles ?? {
          operator: { read: true, operations: ['readiness', 'bundle'] },
          probe: { read: true, operations: ['readiness'] },
          viewer: { read: true, write: true },
        },
      },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
      ...(options.app ?? {}),
    },
    'operations HTTP fixture',
  );
  const control = { current: operator as Identity | null, sessions: 0 };
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => {
        control.sessions++;
        return control.current;
      },
    },
  };
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const diagnostics = new RequestDiagnostics(sink);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], ...(options.diagnostics ? { diagnostics } : {}) });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({
      base: `http://${bound.host}:${bound.port}`,
      control,
      collected: () => diagnostics.snapshot().completed,
      diagnostics,
      directory,
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function get(base: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3_000), ...init });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

const leaks = (text: string, directory: string) => {
  for (const secret of [
    'account-ops',
    'ops@example.test',
    'account-probe',
    'account-view',
    directory,
    '/private/',
    'lending',
    'private-db',
  ]) {
    assert.ok(!text.includes(secret), `reply leaked "${secret}": ${text}`);
  }
};

test('a granted operator reads readiness and the support bundle as private no-store JSON', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    const readiness = await get(f.base, '/api/operations/readiness');
    assert.equal(readiness.status, 200, readiness.text);
    assert.equal(readiness.headers.get('cache-control'), 'no-store');
    assert.equal(readiness.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(readiness.headers.get('x-mistri-account'), 'account-ops', 'the session header stays a stale-tab precondition');
    leaks(readiness.text, f.directory);
    assert.equal(readiness.body!.ok, true);
    assert.equal(readiness.body!.action, 'readiness');
    assert.equal(readiness.body!.scope, 'app');
    assert.equal(Object.hasOwn(readiness.body!, 'sourceId'), false);
    const value = readiness.body!.value as {
      ready: boolean;
      checks: Array<{ name: string; state: string; code: string }>;
      summary: { total: number };
    };
    assert.equal(value.ready, true);
    assert.deepEqual(
      value.checks.map((check) => check.name),
      ['listener', 'sources'],
    );
    assert.ok(value.checks.every((check) => check.state === 'ready' && check.code === 'ok'));
    const support = await get(f.base, '/api/operations/support');
    assert.equal(support.status, 200, support.text);
    assert.equal(support.headers.get('cache-control'), 'no-store');
    leaks(support.text, f.directory);
    const bundle = support.body!.value as { readiness: { ready: boolean }; metrics?: unknown };
    assert.equal(bundle.readiness.ready, true);
    assert.equal(bundle.metrics, undefined, 'without the diagnostics opt-in there are no metrics to bundle');
  });
});

test('with diagnostics enabled the bundle carries fixed-dimension metrics and the sink check', { timeout: 8000 }, async () => {
  await fixture(
    async (f) => {
      await get(f.base, '/api/whoami');
      const readiness = await get(f.base, '/api/operations/readiness');
      const value = readiness.body!.value as { checks: Array<{ name: string; state: string }> };
      assert.deepEqual(
        value.checks.map((check) => [check.name, check.state]),
        [
          ['listener', 'ready'],
          ['sources', 'ready'],
          ['diagnostics', 'ready'],
        ],
      );
      const support = await get(f.base, '/api/operations/support');
      const bundle = support.body!.value as {
        metrics: { started: number; completed: number; series: Array<{ route: string; method: string }> };
      };
      assert.ok(bundle.metrics.started >= 2, JSON.stringify(bundle.metrics));
      assert.ok(bundle.metrics.series.every((series) => typeof series.route === 'string' && typeof series.method === 'string'));
      assert.doesNotMatch(support.text, /account|\/api\/operations\/readiness\?|example\.test/);
    },
    { diagnostics: true },
  );
});

test(
  'the auth gate and the grant precede collection: signed-out, ungranted and partial grants are refused without detail',
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      f.control.current = null;
      const signedOut = await get(f.base, '/api/operations/readiness');
      assert.equal(signedOut.status, 401);
      assert.equal(signedOut.headers.get('cache-control'), 'no-store');
      f.control.current = viewer;
      const denied = await get(f.base, '/api/operations/readiness');
      assert.equal(denied.status, 403);
      assert.deepEqual(denied.body, { ok: false, error: 'not_authorized' });
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      leaks(denied.text, f.directory);
      f.control.current = prober;
      const partial = await get(f.base, '/api/operations/support');
      assert.equal(partial.status, 403);
      assert.deepEqual(partial.body, { ok: false, error: 'not_authorized' });
      const allowed = await get(f.base, '/api/operations/readiness');
      assert.equal(allowed.status, 200);
      f.control.current = { ...operator, role: 'operator,viewer' };
      const union = await get(f.base, '/api/operations/support');
      assert.equal(union.status, 200, 'roles union their grants');
      f.control.current = { ...operator, role: '' };
      const roleless = await get(f.base, '/api/operations/readiness');
      assert.equal(roleless.status, 403);
    });
  },
);

test('only GET and HEAD answer; other methods, stale accounts and unknown operations are refused', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    const posted = await get(f.base, '/api/operations/readiness', {
      method: 'POST',
      headers: { origin: f.base, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(posted.status, 405);
    const head = await fetch(`${f.base}/api/operations/readiness`, { method: 'HEAD', signal: AbortSignal.timeout(3_000) });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'no-store');
    await head.arrayBuffer();
    const stale = await get(f.base, '/api/operations/readiness', { headers: { 'x-mistri-account': 'account-other' } });
    assert.equal(stale.status, 409);
    const unknown = await get(f.base, '/api/operations/metrics');
    assert.notEqual(unknown.status, 200);
    assert.ok(unknown.status === 404 || unknown.status === 400, String(unknown.status));
  });
});

test('a standalone host without App auth has no operator route at all', { timeout: 8000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-operations-standalone-'));
  const file = join(directory, 'plain.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY);');
  db.close();
  const registry = new Registry();
  registry.add({ id: 'plain', name: 'Plain', url: file, writable: false, source: 'config' });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const reply = await get(`http://${bound.host}:${address.port}`, '/api/operations/readiness');
    assert.equal(reply.status, 404);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(reply.text, /ready|checks/);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the read helper binds the grant to the actor and the request, and collects only after it', async () => {
  const app = parseAppConfig(
    {
      id: 'ops',
      name: 'Operations',
      sources: { lending: { connection: 'private-db' } },
      resources: { loan: {} },
      auth: { roles: { operator: { read: true, operations: ['readiness'] } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    },
    'helper',
  );
  let collected = 0;
  const collect = () => {
    collected++;
    return { checks: [{ name: 'listener', state: 'ready' as const, code: 'ok' as const }] };
  };
  assert.equal(operationsSourceId(app), 'lending');
  const denied = await readOperationsHttp({ app, action: 'support', actor: { id: 'a', roles: ['operator'] }, collect });
  assert.deepEqual(denied, { ok: false, cacheControl: 'no-store', error: 'not_authorized' });
  assert.equal(collected, 0, 'an ungranted read never collects');
  const granted = await readOperationsHttp({ app, action: 'readiness', actor: { id: 'a', roles: ['operator'] }, collect });
  assert.equal(granted.ok, true);
  assert.equal(collected, 1);
  let now = 1_000_000;
  const expired = await readOperationsHttp({
    app,
    action: 'readiness',
    actor: { id: 'a', roles: ['operator'] },
    now: () => now,
    collect: () => {
      now += 10_000;
      return collect();
    },
  });
  assert.deepEqual(
    expired,
    { ok: false, cacheControl: 'no-store', error: 'not_authorized' },
    'a collector slower than the grant cannot return a result',
  );
  const broken = await readOperationsHttp({
    app,
    action: 'readiness',
    actor: { id: 'a', roles: ['operator'] },
    collect: () => {
      throw new Error('secret path /private/x');
    },
  });
  assert.deepEqual(broken, { ok: false, cacheControl: 'no-store', error: 'unavailable' });
  assert.deepEqual(operationsHttpReply(broken), { status: 503, body: { ok: false, error: 'unavailable' } });
  assert.equal(operationsHttpReply(granted).status, 200);
  const nameless = parseAppConfig(
    {
      id: 'bad-id',
      name: 'Odd',
      resources: { loan: {} },
      auth: { roles: { operator: { operations: ['readiness'] } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: [],
    },
    'odd',
  );
  assert.equal(operationsSourceId(nameless), undefined, 'a hyphenated id is not a source identifier');
  assert.deepEqual(await readOperationsHttp({ app: nameless, action: 'readiness', actor: { id: 'a', roles: ['operator'] }, collect }), {
    ok: false,
    cacheControl: 'no-store',
    error: 'unavailable',
  });
});
