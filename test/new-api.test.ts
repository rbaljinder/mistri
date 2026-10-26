/** `mistri new --api <name>`: the App it writes passes `mistri check`
 * as written, takes the token its README describes, serves, and answers a
 * read, a generic create, its command and the event feed. Everything runs
 * through the real CLI in a temporary directory outside the checkout, with
 * `tablewalk` linked in as a project would install it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { SESSION_SECRET, runCli, serveApi, tokenCli } from './appApiCli.js';
import { installTablewalk } from './support/installedTablewalk.js';
import { VALIDATE } from './support/validation.js';

test('new --api writes an API App that checks, takes a token, serves and answers', { timeout: 300000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-new-api-'));
  const saved = process.env.XDG_CONFIG_HOME;
  // The App's sign-in store lives in the config directory: this test's own.
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  const dir = join(directory, 'notes');
  const made = await runCli(['new', '--api', 'Field Notes', dir]);
  assert.equal(made.code, 0, made.err);
  for (const file of [
    'app.ts',
    'commands.ts',
    'README.md',
    'package.json',
    'tsconfig.json',
    '.oxfmtrc.json',
    'mistri.json',
    'field-notes.db',
    'db/schema.sql',
    'db/migrations/V1__task.sql',
  ]) {
    assert.ok(existsSync(join(dir, file)), file);
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies.oxfmt);
  assert.ok(pkg.devDependencies['@types/node']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).compilerOptions.types, ['node']);
  assert.equal(pkg.scripts['format:check'], 'oxfmt --check "**/*.ts"');
  // The schema loop: schema.sql is what is wanted, V1 is how the database got there, and its history says so.
  assert.equal(pkg.scripts['schema:diff'], 'mistri migrate diff --config mistri.json');
  assert.equal(pkg.scripts['schema:check'], 'mistri migrate check --config mistri.json');
  assert.match(readFileSync(join(dir, 'db', 'schema.sql'), 'utf8'), /^-- The schema this App wants[\s\S]*CREATE TABLE task \(/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mistri.json'), 'utf8')).connections[0].migrations, { dir: 'db/migrations' });
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.mistri\/$/m);
  const data = new DatabaseSync(join(dir, 'field-notes.db'), { readOnly: true });
  try {
    assert.deepEqual(
      data
        .prepare('SELECT version, script, success FROM __mistri_schema_history ORDER BY installed_rank')
        .all()
        .map((row) => ({ ...row })),
      [{ version: '1', script: 'V1__task.sql', success: 1 }],
    );
  } finally {
    data.close();
  }
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /api-token issue .*--store-id/s);
  assert.match(readme, /--operation event:task\.completed/);
  // A second run never writes over the first.
  assert.notEqual((await runCli(['new', '--api', 'Field Notes', dir])).code, 0);
  // As an installed project resolves it.
  installTablewalk(join(dir, 'node_modules'));
  const config = join(dir, 'mistri.json'),
    commands = join(dir, 'commands.ts');
  const checked = await runCli(['check', '--app', dir, '--config', config, '--json']);
  const report = JSON.parse(checked.out);
  assert.equal(report.ok, true, checked.out);
  // The README's token recipe: lock the authority, make the first account, provision, issue.
  const locked = await runCli(['--app', dir, '--config', config, '--commands', commands, VALIDATE, '--write-authority']);
  assert.equal(locked.code, 0, locked.err);
  const loaded = await loadApp(dir);
  const env = { BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    if (env.BETTER_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET;
  }
  const store = join(directory, 'config', 'mistri', 'auth', 'field-notes.db');
  const accounts = new DatabaseSync(store);
  try {
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('first-client', 'First client', 'client@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'admin');
  } finally {
    accounts.close();
  }
  const common = ['--app', dir, '--config', config, '--store-id', randomUUID()];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const issued = await tokenCli([
    'issue',
    ...common,
    '--commands',
    commands,
    '--subject',
    'first-client',
    '--actor',
    'first-client',
    '--role',
    'admin',
    '--label',
    'First client',
    '--expires-at',
    new Date(Date.now() + 600000).toISOString(),
    ...['list:task', 'item:task', 'command:create-task', 'command:update-task', 'command:complete', 'event:task.completed'].flatMap(
      (operation) => ['--operation', operation],
    ),
  ]);
  assert.equal(issued.code, 0, issued.err);
  const token = (JSON.parse(issued.out) as { result: { token: string } }).result.token;
  // Serve and call it, as the README's curl lines do.
  const s = await serveApi(t, { config, appDir: dir, commands }, 'field-notes');
  await s.started;
  const bearer = { authorization: `Bearer ${token}` };
  const list = await (await fetch(`${s.base}/task`, { headers: bearer })).json();
  assert.deepEqual(
    list.items.map((item: { title: string }) => item.title),
    ['Write the first client'],
  );
  const created = await fetch(`${s.base}/task/commands/create-task/v1`, {
    method: 'POST',
    headers: { ...bearer, 'idempotency-key': 'create-task-000001', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Call the bank' }),
  });
  const receipt = await created.json();
  assert.equal(created.status, 200, JSON.stringify(receipt));
  const id = receipt.result.key.id;
  const prepared = await fetch(`${s.base}/task/${id}/commands/complete/v1/prepare`, { headers: bearer });
  const completed = await fetch(`${s.base}/task/${id}/commands/complete/v1`, {
    method: 'POST',
    headers: { ...bearer, 'if-match': prepared.headers.get('etag')!, 'idempotency-key': 'complete-task-00001' },
    body: '{}',
  });
  assert.equal(completed.status, 200, await completed.clone().text());
  const fed = await fetch(`${s.base}/$events`, { headers: bearer });
  const feed = await fed.json();
  assert.equal(fed.status, 200, JSON.stringify(feed));
  assert.deepEqual(
    feed.items.map((item: { name: string; payload: unknown }) => [item.name, item.payload]),
    [['task.completed', { id: Number(id), title: 'Call the bank' }]],
  );
  const spec = await (await fetch(`${s.base}/$openapi`, { headers: bearer })).json();
  assert.ok(Object.keys(spec.paths).includes('/task/commands/create-task/v1'));
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
});
