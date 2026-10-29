import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { resolvePostgresTokenRevokeContext } from '../packages/mistri/src/server/cli/postgresApiTokenContext.js';
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL token maintenance context is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pg-token-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loaded: LoadedApp = {
    path: join(dir, 'app.ts'),
    dir,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'app',
        name: 'App',
        connection: 'primary',
        auth: { store: 'postgresql://auth:synthetic@auth.invalid:5432/auth' },
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'fixture',
    ),
  };
  const connection = (id: string, url: string): ConnectionConfig => ({ id, name: id, url, source: 'argument' });
  const first = connection('primary', 'postgresql://business:synthetic@business.invalid:5432/business');
  return { dir, loaded, first, connection, resolve: (connections = [first]) => resolvePostgresTokenRevokeContext([loaded], connections) };
}
test('PG context freezes every resolved exclusion without API, module execution or database opens', async (t) => {
  const f = fixture(t),
    other = f.connection(
      'unselected',
      'postgresql://other:synthetic@other.invalid:5433/other?sslmode=verify-full&options=-c%20search_path%3Dpublic',
    );
  const result = await f.resolve([f.first, other, f.connection('sqlite', join(f.dir, 'does-not-exist.db'))]);
  assert.deepEqual(Object.keys(result), ['url', 'appId', 'excludeConnections']);
  assert.equal(result.url, f.loaded.app.auth!.store);
  assert.equal(result.appId, 'app');
  assert.deepEqual(
    result.excludeConnections.map((item) => item.url),
    [f.first.url, other.url],
  );
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.excludeConnections));
  assert.ok(result.excludeConnections.every((item) => Object.isFrozen(item) && item.source === 'session'));
  assert.equal(existsSync(f.loaded.path), false);
  assert.equal(existsSync(join(f.dir, 'does-not-exist.db')), false);
});
test('auth braced expansion and business bare expansion are captured once', async (t) => {
  const f = fixture(t),
    names = ['TABLEWALK_CONTEXT_AUTH', 'TABLEWALK_CONTEXT_BUSINESS', 'TABLEWALK_CONTEXT_LITERAL'] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.TABLEWALK_CONTEXT_AUTH = 'postgresql://auth:$TABLEWALK_CONTEXT_LITERAL@auth.invalid:5432/auth';
  process.env.TABLEWALK_CONTEXT_BUSINESS = 'secret$TABLEWALK_CONTEXT_LITERAL';
  process.env.TABLEWALK_CONTEXT_LITERAL = 'must-not-expand-again';
  f.loaded.app.auth!.store = '${TABLEWALK_CONTEXT_AUTH}';
  const result = await f.resolve([
    f.connection('primary', 'postgresql://business:$TABLEWALK_CONTEXT_BUSINESS@business.invalid:5432/business'),
  ]);
  assert.ok(result.url.includes('$TABLEWALK_CONTEXT_LITERAL'));
  assert.ok(result.excludeConnections[0].url.includes('secret$TABLEWALK_CONTEXT_LITERAL'));
  assert.equal(result.excludeConnections[0].source, 'session');
  delete process.env.TABLEWALK_CONTEXT_BUSINESS;
  await assert.rejects(f.resolve([f.connection('primary', '$TABLEWALK_CONTEXT_BUSINESS')]), unavailable);
});
test('references are unambiguous and unsafe/unsupported resolved connections never disappear', async (t) => {
  const f = fixture(t);
  f.loaded.app.connection = 'missing';
  await assert.rejects(f.resolve(), unavailable);
  f.loaded.app.connection = 'primary';
  const collision = f.connection('other', f.first.url);
  collision.name = 'primary';
  await assert.rejects(f.resolve([f.first, collision]), unavailable);
  for (const value of [
    'postgresql:///db',
    'postgresql://host:5432/db',
    'postgresql://user:pw@host/db',
    'postgresql://user:pw@host:5432/',
    'postgresql://user:pw@host:5432/db?host=other',
    'postgresql://user:pw@host:5432/db?user=other',
    'postgresql://user:pw@host:5432/db?sslmode=require&sslmode=disable',
    'postgresql://user:pw@host:5432/db#ignored',
    'sqlite:///file',
    ':memory:',
    'https://unmarked.invalid',
    '~/.db',
    '${INVALID-REFERENCE}',
  ]) {
    await assert.rejects(f.resolve([f.first, { ...f.connection('unselected', value), source: 'session' }]), unavailable);
  }
  await assert.rejects(resolvePostgresTokenRevokeContext([], [f.first]), unavailable);
  await assert.rejects(resolvePostgresTokenRevokeContext([f.loaded, f.loaded], [f.first]), unavailable);
  await assert.rejects(f.resolve([f.first, f.connection('same-target', f.loaded.app.auth!.store!)]), unavailable);
});
test('current authority lock is checked before and after asynchronous resolution', async (t) => {
  const f = fixture(t),
    lockPath = join(f.dir, 'authority.lock'),
    report = authorityReport(f.loaded.app);
  f.loaded.authority = { lockPath, report, lock: report };
  writeFileSync(lockPath, report);
  await f.resolve();
  writeFileSync(lockPath, 'changed');
  await assert.rejects(f.resolve(), unavailable);
  writeFileSync(lockPath, report);
  queueMicrotask(() => writeFileSync(lockPath, 'changed during await'));
  await assert.rejects(f.resolve(), unavailable);
  delete f.loaded.authority;
  await assert.rejects(f.resolve(), unavailable);
});
test('every declared source reference must resolve even when another source is valid', async (t) => {
  const f = fixture(t),
    other = f.connection('other', 'postgresql://other:synthetic@other.invalid:5432/other');
  f.loaded.app.sources = { main: { connection: 'primary', default: true }, extra: { connection: 'other', default: false } };
  await assert.rejects(f.resolve(), unavailable);
  assert.equal((await f.resolve([f.first, other])).excludeConnections.length, 2);
  f.loaded.app.sources.extra.connection = 'missing';
  await assert.rejects(f.resolve([f.first, other]), unavailable);
});
