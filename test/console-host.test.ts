import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { consoleHostFixture as fixture } from './fixtures/consoleHost.js';

function hold() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}
test('native Console host is ready-gated, requires explicit grant, and serves existing renderer with empty authorized catalog', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/')).response.status, 503);
  f.consoleHost.start();
  assert.equal((await f.call('/')).response.status, 403, 'native admin has no implicit Console grant');
  f.grant('mistri-console', ['admitted']);
  const page = await f.call('/');
  assert.equal(page.response.status, 200, page.text);
  assert.match(page.response.headers.get('content-type')!, /text\/html/);
  assert.match(page.text, /mistri-console/);
  assert.doesNotMatch(page.text, /private\.invalid|postgresql:|identity\.db|session_token/);
  assert.equal(page.response.headers.get('cache-control'), 'private, no-store');
  const client = await f.call('/addressMount.js');
  assert.equal(client.response.status, 200, client.text);
  assert.match(client.response.headers.get('content-type')!, /javascript/);
  assert.match(client.text, /readMountJson/);
  const app = await f.call('/api/app');
  assert.equal(app.response.status, 200, app.text);
  assert.equal(app.json().app.id, 'mistri-console');
  const catalog = await f.call('/api/query', { table: 'targets', limit: 25, offset: 0 });
  assert.equal(catalog.response.status, 200, catalog.text);
  assert.deepEqual(catalog.json().rows, []);
  assert.equal(f.state.reads, 0);
  const schema = await f.call('/api/schema');
  assert.equal(schema.response.status, 200, schema.text);
  assert.deepEqual(
    schema.json().tables.map((table: { id: string }) => table.id),
    ['targets', 'flags', 'history', 'results'],
  );
  f.grant('mistri-console', []);
  assert.equal((await f.call('/')).response.status, 403);
  assert.equal((await f.call('/api/schema')).response.status, 403);
});

test('target grants are independently resolved from the same native session; no other owner IDs or generic operations', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  f.grant('shop', ['reader']);
  const catalog = await f.call('/api/query', { table: 'targets', limit: 25, offset: 0 });
  assert.equal(catalog.response.status, 200, catalog.text);
  assert.equal(catalog.json().rows[0].appId, 'shop');
  const flags = await f.call('/api/query?targetApp=shop', { table: 'flags', limit: 25, offset: 0 });
  assert.equal(flags.response.status, 200, flags.text);
  assert.deepEqual(
    flags.json().rows.map((row: { flagId: string }) => row.flagId),
    ['feature'],
  );
  assert.doesNotMatch(flags.text, /secret|private\.invalid/);
  for (const route of ['/api/update', '/api/insert', '/api/delete', '/api/sql', '/api/commands/execute', '/api/connections']) {
    assert.equal((await f.call(route, {})).response.status, 403, route);
  }
  assert.equal((await f.call('/_mistri/observe')).response.status, 403);
  assert.equal((await f.call('/api/query?targetApp=foreign', { table: 'flags', limit: 25, offset: 0 })).response.status, 403);
  assert.equal((await f.call('/api/query?targetApp=shop&tenant=foreign', { table: 'flags', limit: 25, offset: 0 })).response.status, 403);
  assert.equal((await f.call('/api/schema', undefined, 'alice', { 'x-mistri-account': 'bob' })).response.status, 409);
  f.grant('mistri-console', ['admitted'], 'bob');
  const bob = await f.call('/api/query', { table: 'targets', limit: 25, offset: 0 }, 'bob');
  assert.deepEqual(bob.json().rows, []);
  const forged = await f.call('/api/query', { table: 'targets', limit: 25, offset: 0 }, 'bob', {
    'x-console-target': 'shop',
    'x-mistri-role': 'admin',
  });
  assert.deepEqual(forged.json().rows, []);
});

test('held HTTP reads discard bytes after Console/target grant or native session revocation', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  for (const kind of ['console', 'target', 'session']) {
    f.grant('mistri-console', ['admitted']);
    f.grant('shop', ['reader']);
    f.state.read = hold();
    const pending = f.call('/api/query?targetApp=shop', { table: 'flags', limit: 25, offset: 0 });
    await f.state.read.entered;
    if (kind === 'session') f.db.prepare('DELETE FROM session WHERE userId = ?').run('alice');
    else f.grant(kind === 'console' ? 'mistri-console' : 'shop', []);
    f.state.read.release();
    const response = await pending;
    assert.equal(response.response.status, 403, response.text);
    assert.doesNotMatch(response.text, /feature|secret/);
    f.state.read = undefined;
  }
});

test('Console grant is reobserved after a request body is held', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  const body = JSON.stringify({ table: 'targets', limit: 25, offset: 0 });
  const pending = new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      f.base + '/api/query',
      {
        method: 'POST',
        headers: {
          cookie: f.cookie('alice'),
          origin: f.origin,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 1));
    // The body remains incomplete across admission; the final grant check is
    // required regardless of which asynchronous native observation finishes first.
    setTimeout(() => {
      f.grant('mistri-console', []);
      req.end(body.slice(1));
    }, 30);
  });
  assert.equal((await pending).status, 403);
});

test('concurrent request-bound adapters cannot borrow another account target grants', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  f.grant('shop', ['reader']);
  f.grant('mistri-console', ['admitted'], 'bob');
  f.state.read = hold();
  const alice = f.call('/api/query?targetApp=shop', { table: 'flags', limit: 25, offset: 0 });
  await f.state.read.entered;
  const bob = await f.call('/api/query', { table: 'targets', limit: 25, offset: 0 }, 'bob');
  assert.equal(bob.response.status, 200, bob.text);
  assert.deepEqual(bob.json().rows, []);
  f.state.read.release();
  const result = await alice;
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.json().rows[0].flagId, 'feature');
});

test('a public storefront host intent cannot enter Console with a valid native cookie', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  const router = createTenantHostRouter([{ host: '127.0.0.1', app: 'shop', tenant: 'foreign' }]);
  f.consoleHost.server.prependListener('request', (req) => {
    router.accept(req);
  });
  assert.equal((await f.call('/')).response.status, 403);
  assert.equal((await f.call('/api/schema')).response.status, 403);
});

async function controls(f: Awaited<ReturnType<typeof fixture>>, role: string) {
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  f.grant('shop', [role]);
  const catalog = await f.call('/api/console/catalog');
  assert.equal(catalog.response.status, 200, catalog.text);
  const scope = catalog.json().targets[0].scopes[0].id as string;
  const flags = await f.call(`/api/console/scopes/${scope}/flags`);
  assert.equal(flags.response.status, 200, flags.text);
  assert.deepEqual(
    flags.json().items.map((item: { flagId: string }) => item.flagId),
    ['feature'],
  );
  return { scope, id: flags.json().items[0].id as string };
}

test('canonical Console discovery offers kill-only actions without exposing values, owners or history', async (t) => {
  const f = await fixture(t),
    { scope, id } = await controls(f, 'killer');
  const detail = await f.call(`/api/console/flags/${id}`);
  assert.equal(detail.response.status, 200, detail.text);
  assert.deepEqual(detail.json().actions, ['kill']);
  for (const key of ['value', 'control', 'owner', 'variants', 'type', 'default']) assert.equal(key in detail.json(), false, key);
  assert.equal((await f.call(`/api/console/flags/${id}/history`)).response.status, 403);
  const catalog = await f.call(`/api/console/catalog?scope=${scope}`);
  assert.equal(catalog.json().targets[0].scopes[0].id, scope, 'deep-linked opaque selection remains selected');
  const page = await f.call(`/api/console/scopes/${scope}/flags?flag=${id}`);
  assert.equal(page.json().items[0].id, id);
  const changed = await f.call(`/api/console/flags/${id}/kill`, { expectedRevision: 0, reason: 'incident' }, 'alice', {
    'x-mistri-account': 'alice',
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.deepEqual(changed.json(), { flagId: 'feature', revision: 1, operation: 'kill', outcome: 'applied' });
  assert.equal(f.state.overrides.feature.disabled, true);
  assert.equal(
    (
      await f.call(`/api/console/flags/${id}/set`, { expectedRevision: 1, reason: 'enable', override: { value: true } }, 'alice', {
        'x-mistri-account': 'alice',
      })
    ).response.status,
    403,
  );
});

test('manage-only edits use declared type without reading current values; conflict and unknown outcomes are explicit', async (t) => {
  const f = await fixture(t),
    { id } = await controls(f, 'manager');
  const detail = await f.call(`/api/console/flags/${id}`);
  assert.deepEqual(detail.json().actions, ['manage']);
  assert.equal(detail.json().type, 'boolean');
  assert.equal('value' in detail.json(), false);
  assert.equal('owner' in detail.json(), false);
  const body = { expectedRevision: 0, reason: 'enable', override: { value: true } },
    headers = { 'x-mistri-account': 'alice' };
  for (const key of ['tenantId', 'environment', 'appId', 'roles', 'actorId']) {
    assert.equal((await f.call(`/api/console/flags/${id}/set`, { ...body, [key]: 'forged' }, 'alice', headers)).response.status, 403);
  }
  assert.equal(f.state.entries.length, 0);
  f.state.revision = 1;
  const conflict = await f.call(`/api/console/flags/${id}/set`, body, 'alice', headers);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json().code, 'revision_conflict');
  assert.deepEqual(body.override, { value: true });
  assert.equal(f.state.entries.length, 0);
  f.state.revision = 0;
  f.state.unknown = true;
  const unknown = await f.call(`/api/console/flags/${id}/set`, body, 'alice', headers);
  assert.equal(unknown.response.status, 503);
  assert.equal(unknown.json().outcome, 'unknown');
  assert.equal(f.state.entries.length, 1, 'exactly one attempt committed; no retry');
});

test('canonical mutation fences Console revocation under the management commit lock', async (t) => {
  const f = await fixture(t),
    { id } = await controls(f, 'killer');
  f.state.commit = hold();
  const pending = f.call(`/api/console/flags/${id}/kill`, { expectedRevision: 0, reason: 'incident' }, 'alice', {
    'x-mistri-account': 'alice',
  });
  await f.state.commit.entered;
  f.grant('mistri-console', []);
  f.state.commit.release();
  const result = await pending;
  assert.equal(result.response.status, 403, result.text);
  assert.equal(f.state.entries.length, 0);
  assert.equal(f.state.revision, 0);
});

test('canonical mutation rejects held-body Console revocation and cross-account opaque handles', async (t) => {
  const f = await fixture(t),
    { id } = await controls(f, 'killer');
  f.grant('mistri-console', ['admitted'], 'bob');
  f.grant('shop', ['killer'], 'bob');
  assert.equal((await f.call(`/api/console/flags/${id}`, undefined, 'bob')).response.status, 403);
  assert.equal((await f.call(`/api/console/flags/${id}`, undefined, 'alice', { 'x-mistri-account': 'bob' })).response.status, 409);
  const body = JSON.stringify({ expectedRevision: 0, reason: 'incident' });
  f.state.read = hold();
  let sendBody!: () => void;
  const pending = new Promise<number>((resolve, reject) => {
    const req = request(
      f.base + `/api/console/flags/${id}/kill`,
      {
        method: 'POST',
        headers: {
          cookie: f.cookie('alice'),
          origin: f.origin,
          'x-mistri-account': 'alice',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 1));
    sendBody = () => req.end(body.slice(1));
  });
  await f.state.read.entered;
  f.state.read.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.grant('mistri-console', []);
  sendBody();
  assert.equal(await pending, 403);
  assert.equal(f.state.entries.length, 0);
});

test('existing component pipeline serves the lazy Console room and fixed mounted endpoint', async (t) => {
  const f = await fixture(t);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  const app = await f.call('/api/app');
  const text = app.text;
  assert.match(text, /console-controls/);
  assert.match(text, /\/tools\/_mistri\/console\/api\/console/);
  const href = JSON.stringify(app.json()).match(/\/mistri-console\/_components\/console-controls-[a-f0-9]+\.js/)?.[0];
  assert.ok(href, text);
  const module = await f.call(href.replace('/mistri-console', ''));
  assert.equal(module.response.status, 200, module.text);
  assert.match(module.text, /Refetch current record/);
  assert.doesNotMatch(module.text, /private\.invalid|identity\.db|BETTER_AUTH_SECRET/);
});

test('Console editor projects complete targeting only to viewers and commits explicit replacement with rollout', async (t) => {
  const f = await fixture(t),
    { id } = await controls(f, 'reader');
  f.state.overrides.feature = { value: true, rollout: 25, rules: [{ audiences: ['northReaders'], value: false }] };
  const record = (await f.call(`/api/console/flags/${id}`)).json();
  assert.equal(record.scope, 'global');
  assert.deepEqual(record.control.rules, f.state.overrides.feature.rules);
  assert.equal(record.control.rollout, 25);
  f.grant('shop', ['manager']);
  const hidden = (await f.call(`/api/console/flags/${id}`)).json();
  assert.equal(record.defaultValue, false);
  assert.equal(record.safeValue, false);
  for (const key of ['control', 'roles', 'segments', 'value', 'owner', 'defaultValue', 'safeValue'])
    assert.equal(key in hidden, false, key);
  f.grant('shop', ['reader', 'manager']);
  const override = { ...f.state.overrides.feature, value: false, rollout: 50 };
  const changed = await f.call(`/api/console/flags/${id}/set`, { expectedRevision: 0, override, reason: 'next cohort' }, 'alice', {
    'x-mistri-account': 'alice',
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.deepEqual(f.state.overrides.feature, override);
});
