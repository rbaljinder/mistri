import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { resolveSqliteTokenRevokeContext } from '../packages/mistri/src/server/cli/apiTokenContext.js';

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tw-token-context-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['auth.db', 'business.db', 'other.db']) writeFileSync(join(dir, file), '');
  const loaded: LoadedApp = {
    path: join(dir, 'app.ts'),
    dir,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'app',
        name: 'App',
        auth: { store: 'auth.db' },
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'fixture',
    ),
  };
  const connection = (id: string, url: string): ConnectionConfig => ({ id, name: id, url, source: 'argument', writable: undefined });
  const first = connection('primary', relative(process.cwd(), join(dir, 'business.db')));
  return { dir, loaded, connection, first, resolve: (connections = [first]) => resolveSqliteTokenRevokeContext([loaded], connections) };
}

test('revoke context needs no API, database open or source module execution and captures every SQLite exclusion', async (t) => {
  const f = fixture(t);
  f.loaded.app.connection = 'primary';
  const result = await f.resolve([
    f.first,
    f.connection('other', join(f.dir, 'other.db')),
    f.connection('remote', 'postgresql://example.invalid/business'),
  ]);
  assert.deepEqual(Object.keys(result), ['path', 'appId', 'exclusions']);
  assert.equal(result.path, join(f.dir, 'auth.db'));
  assert.equal(result.appId, 'app');
  assert.deepEqual(result.exclusions.map((value) => value.path).sort(), [join(f.dir, 'business.db'), join(f.dir, 'other.db')]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.exclusions) && Object.isFrozen(result.exclusions[0]));
  assert.equal(existsSync(f.loaded.path), false, 'trusted definition is not re-executed');
});

test('unknown or ambiguous connections and unsupported path forms refuse without creating files', async (t) => {
  const f = fixture(t),
    other = f.connection('other', join(f.dir, 'other.db'));
  await assert.rejects(f.resolve([f.first, other]));
  f.loaded.app.connection = 'unknown';
  await assert.rejects(f.resolve());
  f.loaded.app.connection = 'primary';
  other.name = 'primary';
  await assert.rejects(f.resolve([f.first, other]));
  delete f.loaded.app.connection;
  for (const url of [
    join(f.dir, 'missing.db'),
    ':memory:',
    'file:business.db?mode=rwc',
    '${UNRESOLVED}',
    '~/.db',
    'http://unsupported',
    'sqlite:business.db',
    'sqlite:///business.db',
  ])
    await assert.rejects(f.resolve([f.connection('primary', url)]));
  assert.equal(existsSync(join(f.dir, 'missing.db')), false);
  await assert.rejects(resolveSqliteTokenRevokeContext([], [f.first]));
  await assert.rejects(resolveSqliteTokenRevokeContext([f.loaded, f.loaded], [f.first]));
});

test('business bare variables cannot capture a literal file while auth bare dollars remain literal', async (t) => {
  const f = fixture(t),
    variable = 'TABLEWALK_TOKEN_CONTEXT_BUSINESS';
  const old = process.env[variable];
  t.after(() => {
    if (old === undefined) delete process.env[variable];
    else process.env[variable] = old;
  });
  const literal = join(f.dir, `$${variable}`);
  writeFileSync(literal, '');
  process.env[variable] = join(f.dir, 'auth.db');
  // The literal business filename really exists; accepting it would exclude
  // the wrong file when the ordinary connection loader expands the variable.
  await assert.rejects(f.resolve([f.connection('primary', literal)]));
  f.loaded.app.auth!.store = literal;
  const result = await f.resolve();
  assert.equal(result.path, literal);
  assert.equal(result.exclusions[0].path, join(f.dir, 'business.db'));
});

test('auth store must exist and cannot alias any configured business file', async (t) => {
  const f = fixture(t);
  f.loaded.app.connection = 'primary';
  const alias = join(f.dir, 'auth-alias.db');
  linkSync(join(f.dir, 'auth.db'), alias);
  await assert.rejects(f.resolve([f.first, f.connection('unselected', alias)]));
  f.loaded.app.auth!.store = 'missing-auth.db';
  await assert.rejects(f.resolve());
  assert.equal(existsSync(join(f.dir, 'missing-auth.db')), false);
  f.loaded.app.auth!.store = 'postgresql://example.invalid/auth';
  await assert.rejects(f.resolve());
});

test('fresh declared lock is checked rather than trusted from cached LoadedApp', async (t) => {
  const f = fixture(t),
    lockPath = join(f.dir, 'authority.lock'),
    report = authorityReport(f.loaded.app);
  f.loaded.authority = { report, lockPath, lock: report };
  writeFileSync(lockPath, report);
  await f.resolve();
  writeFileSync(lockPath, 'changed');
  await assert.rejects(f.resolve());
  writeFileSync(lockPath, report);
  queueMicrotask(() => writeFileSync(lockPath, 'changed during await'));
  await assert.rejects(f.resolve());
  delete f.loaded.authority;
  await assert.rejects(f.resolve(), 'a newly added lock cannot masquerade as absent');
});
