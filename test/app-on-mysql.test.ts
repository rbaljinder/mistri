import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { appDialectProblems, assertAppDialects } from '../packages/mistri/src/server/app/appDialect.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* An App runs on PostgreSQL or SQLite; MySQL/MariaDB is for browsing (site/docs/status). The registry is a stub: the
   dialect is read off the connection's URL scheme, so nothing is dialed. */
const registry = (...connections: Array<{ id: string; name: string; dialect: string }>) =>
  ({ list: () => connections, active: connections[0]?.id ?? null }) as never;
const on = (connection: string) =>
  parseAppConfig(
    { name: 'Atlas', connection, resources: { incident: {} }, views: { i: { kind: 'list', from: 'incident' } }, home: 'i' },
    'app.ts',
  );

test("an App whose connection is MySQL or MariaDB is refused, in the status page's words and with its code", () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const problems = appDialectProblems(on('atlas'), registry({ id: 'c1', name: 'atlas', dialect }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\[app-on-mysql\]/);
    assert.match(
      problems[0],
      /An App runs on PostgreSQL or SQLite\. MySQL\/MariaDB is supported for browsing, in the database browser and its MCP server\./,
    );
    assert.throws(() => assertAppDialects([on('atlas')], registry({ id: 'c1', name: 'atlas', dialect })), /\[app-on-mysql\]/);
  }
});

test('PostgreSQL and SQLite carry an App, and so does a MySQL connection the App does not use', () => {
  for (const dialect of ['postgres', 'sqlite'])
    assert.deepEqual(appDialectProblems(on('atlas'), registry({ id: 'c1', name: 'atlas', dialect })), []);
  assert.deepEqual(
    appDialectProblems(
      on('atlas'),
      registry({ id: 'c1', name: 'atlas', dialect: 'sqlite' }, { id: 'c2', name: 'legacy', dialect: 'mysql' }),
    ),
    [],
  );
});

test('each source of an App is judged by its connection', () => {
  const app = parseAppConfig(
    {
      name: 'Atlas',
      sources: { main: { connection: 'pg', default: true }, legacy: { connection: 'old' } },
      resources: { incident: {} },
      views: { i: { kind: 'list', from: 'incident' } },
      home: 'i',
    },
    'app.ts',
  );
  const problems = appDialectProblems(
    app,
    registry({ id: 'c1', name: 'pg', dialect: 'postgres' }, { id: 'c2', name: 'old', dialect: 'mysql' }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /source "legacy"/);
});

const work = mkdtempSync(join(tmpdir(), 'tablewalk-app-on-mysql-'));
after(() => rmSync(work, { recursive: true, force: true }));
const run = (args: string[]) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...args],
      { cwd: resolve('.'), timeout: 120_000 },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out: out + err }),
    ),
  );

test('`check` and startup both refuse a sample App pointed at MySQL', async () => {
  const config = join(work, 'mistri.json');
  // Nothing listens there: the refusal comes from the URL's scheme, before any database is dialed.
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'tick', url: 'mysql://reader@127.0.0.1:1/tick' }] }));
  const checked = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--brief']);
  assert.notEqual(checked.code, 0);
  assert.match(checked.out, /^app-on-mysql /m);
  const started = await run(['--app', 'examples/apps/tick', '--config', config, '--port', '0']);
  assert.equal(started.code, 1);
  assert.match(started.out, /\[app-on-mysql\]/);
});
