import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { scratch } from './support/scratch.js';
import { VALIDATE, validating } from './support/validation.js';

const entry = resolve('packages/mistri/src/server/index.ts');
function fixture(t: TestContext) {
  const { directory, stopping } = scratch(t, 'tablewalk-tenant-startup-cli-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const appFile = join(appDir, 'app.json'),
    data = join(directory, 'data.db'),
    auth = join(directory, 'auth.db');
  const config = join(directory, 'config.json'),
    policy = join(directory, 'policy.mjs');
  const imported = join(directory, 'policy-imported'),
    invoked = join(directory, 'policy-invoked');
  const db = new DatabaseSync(data);
  db.exec('CREATE TABLE private_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT)');
  db.close();
  provisionSqliteTenantStore(data, { appId: 'tenant-cli', source: { id: 'business', connection: 'business-db' }, storeId: 'store' });
  const app = {
    id: 'tenant-cli',
    name: 'Tenant CLI',
    auth: { store: auth, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
    sources: { business: { connection: 'business-db' } },
    resources: { item: { physical: 'private_item', owner: 'tenant' } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    nav: ['items'],
  };
  writeFileSync(appFile, JSON.stringify(app));
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'business-db', url: data }] }));
  writeFileSync(
    policy,
    `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(imported)}, 'yes');
    const rows = () => { writeFileSync(${JSON.stringify(invoked)}, 'yes'); return { item: true }; };
    export default { kind:'tenant', appId:'tenant-cli', storeId:'store',
      ownership:{item:{kind:'tenant',column:'tenant_id'}}, resolveMembershipRows:rows, resolveRows:rows };
  `,
  );
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: 'synthetic-tenant-cli-secret-at-least-thirty-two-characters',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const args = ['--import', 'tsx', entry, '--config', config, '--app', appDir, '--policy', policy];
  return { directory, appDir, appFile, app, auth, data, config, policy, imported, invoked, env, args, stopping };
}
type Fixture = ReturnType<typeof fixture>;
function cli(f: Fixture, extra: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = validating(extra, f.env);
    execFile(
      process.execPath,
      [...f.args, ...child.args],
      { env: child.env, timeout: 20000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error?.killed) return reject(new Error(`Tenant CLI timed out: ${stdout}\n${stderr}`));
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

test('tenant CLI check validates the existing store without auth provisioning or policy invocation', async (t) => {
  const f = fixture(t),
    result = await cli(f, [VALIDATE]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Tenant CLI: ok\n');
  assert.equal(existsSync(f.imported), true);
  assert.equal(existsSync(f.invoked), false);
  assert.equal(existsSync(f.auth), false);
});

/* A member who writes a tenant table can Save and add but not Delete without the policy's authorizeDeletedRecord. */
function writing(f: Fixture, deletes: boolean) {
  writeFileSync(
    f.appFile,
    JSON.stringify({
      ...f.app,
      auth: { ...f.app.auth, roles: { member: { read: true, write: true } } },
      resources: { item: { ...f.app.resources.item, access: 'write' } },
    }),
  );
  writeFileSync(f.config, JSON.stringify({ connections: [{ name: 'business-db', url: f.data, writable: true }] }));
  if (deletes)
    writeFileSync(
      f.policy,
      readFileSync(f.policy, 'utf8').replace('resolveRows:rows }', 'resolveRows:rows, authorizeDeletedRecord:() => true }'),
    );
}

test('tenant CLI check warns that a written tenant table cannot be deleted without authorizeDeletedRecord', async (t) => {
  const f = fixture(t);
  writing(f, false);
  const result = await cli(f, [VALIDATE]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Tenant CLI: ok\n {2}warning: table "item" \[tenant-delete-unauthorized\]: role "member" writes it/);
});

test('tenant CLI check does not warn when the policy authorizes deleted records', async (t) => {
  const f = fixture(t);
  writing(f, true);
  const result = await cli(f, [VALIDATE]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Tenant CLI: ok\n');
});

for (const args of [
  ['--mcp'],
  ['--export', 'json'],
  ['--lint', 'json'],
  ['--diff', 'other'],
  ['--demo'],
  ['--auth-proxy-header', 'X-Identity'],
  ['--auth-proxy-from', '10.0.0.7'],
  ['--db', '/not/a/real/tenant.db'],
]) {
  test(`tenant CLI rejects incompatible mode ${args.join(' ')} before policy/auth`, async (t) => {
    const f = fixture(t),
      result = await cli(f, args);
    // MCP, a JSON export, lint and diff are the database browser's: mistri names that command, a usage error.
    const browsers = ['--mcp', '--export', '--lint', '--diff'].includes(args[0]);
    assert.equal(result.code, browsers ? 2 : 1, result.stderr);
    if (browsers) assert.match(result.stderr, /is the database browser's, a command of its own: npx tablewalk/);
    assert.doesNotMatch(result.stdout, /Listening on|: ok/);
    assert.equal(existsSync(f.imported), false);
    assert.equal(existsSync(f.auth), false);
  });
}

test('tenant CLI missing file is not created, and public row-policy factory is not used', async (t) => {
  const f = fixture(t),
    missing = join(f.directory, 'missing.db');
  writeFileSync(f.config, JSON.stringify({ connections: [{ name: 'business-db', url: missing }] }));
  const result = await cli(f, [VALIDATE]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(f.imported), false);
  assert.equal(existsSync(f.auth), false);
});

test('auth alias installed during a paused policy import cannot migrate business data', { timeout: 30000 }, async (t) => {
  const f = fixture(t),
    ready = join(f.directory, 'import-paused'),
    resume = join(f.directory, 'import-resume');
  const original = readFileSync(f.data);
  writeFileSync(
    f.policy,
    `import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    ${readFileSync(f.policy, 'utf8')}
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    while (!existsSync(${JSON.stringify(resume)})) await delay(10);
  `,
  );
  const child = spawn(process.execPath, f.args, { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const ended = once(child, 'exit');
  f.stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  });
  for (let tries = 0; !existsSync(ready) && tries < 200; tries++) {
    assert.equal(child.exitCode, null, output);
    await delay(20);
  }
  assert.equal(existsSync(ready), true, output);
  symlinkSync(f.data, f.auth);
  writeFileSync(resume, 'resume');
  const [code] = await ended;
  assert.equal(code, 1, output);
  assert.doesNotMatch(output, /Listening on/);
  assert.deepEqual(readFileSync(f.data), original);
  const db = new DatabaseSync(f.data, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('user','session','account')").get()?.n, 0);
  } finally {
    db.close();
  }
});

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
async function launch(f: Fixture) {
  const number = await port(),
    origin = `http://127.0.0.1:${number}`;
  const child = spawn(process.execPath, [...f.args, '--port', String(number)], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const ended = once(child, 'exit');
  f.stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  for (let tries = 0; tries < 200; tries++) {
    if (output.includes('Listening on')) return { child, origin, ended, output: () => output };
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
    await delay(50);
  }
  child.kill('SIGKILL');
  throw new Error(`Tenant CLI never listened: ${output}`);
}

for (const writable of [false, true])
  test(`public tenant host enforces native auth and connection write opt-in (${writable})`, { timeout: 30000 }, async (t) => {
    const f = fixture(t);
    if (writable) {
      writeFileSync(
        f.appFile,
        JSON.stringify({
          ...f.app,
          resources: { item: { ...f.app.resources.item, access: 'write', fields: { read: ['id', 'name'], write: ['id', 'name'] } } },
          auth: { ...f.app.auth, roles: { member: { read: true, write: true } } },
        }),
      );
      writeFileSync(f.config, JSON.stringify({ connections: [{ name: 'business-db', url: f.data, writable: true }] }));
    }
    const live = await launch(f);
    const call = (path: string, options: RequestInit = {}) => fetch(live.origin + path, { ...options, signal: AbortSignal.timeout(5000) });
    const who = await call('/api/whoami?app=tenant-cli');
    assert.equal(who.status, 200);
    assert.deepEqual(await who.json(), {
      signedIn: false,
      accountId: null,
      appId: 'tenant-cli',
      who: null,
      header: null,
      signIn: { providers: ['email'], signUp: 'open', app: 'Tenant CLI', look: { id: 'tenant-cli', name: 'Tenant CLI' } },
      tenant: true,
      appName: 'Tenant CLI',
    });
    for (const path of ['/api/schema', '/api/connections', '/api/sql', '/api/runtime']) {
      const response = await call(path);
      assert.ok(response.status >= 400, path);
      assert.doesNotMatch(await response.text(), /private_item|tenant_id|store|\.db/);
    }
    const signup = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: live.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New account', email: 'new@tenant.example.test', password: 'Disposable-tenant-CLI-password-123!' }),
    });
    assert.equal(signup.status, 200, await signup.text());
    const cookie = signup.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const signed = await call('/api/whoami?app=tenant-cli', { headers: { cookie } });
    const account = (await signed.json()) as { signedIn: boolean; accountId: string };
    assert.equal(account.signedIn, true);
    // Signup/auth writes must not trip the source-code watcher.
    assert.equal(live.child.exitCode, null);
    assert.equal(existsSync(f.invoked), false, 'an account does not acquire membership by signing up');
    const db = new DatabaseSync(f.data);
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      const admin = createSqliteTenantAdministration(db, operations, {
        appId: 'tenant-cli',
        source: { id: 'business', connection: 'business-db' },
        storeId: 'store',
      });
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId: 'north',
        accountId: account.accountId,
        membershipId: 'north-new',
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 3600000,
        expectedVersion: null,
      });
      await operations.finish();
      db.exec("INSERT INTO private_item VALUES ('north-id','north','North'),('south-id','south','PRIVATE_SOUTH'); COMMIT");
    } finally {
      db.close();
    }
    const headers = { cookie, origin: live.origin, 'content-type': 'application/json', 'x-mistri-account': account.accountId };
    const opened = await call('/api/tenant/context/open?app=tenant-cli&tenant=north', { method: 'POST', headers, body: '{}' });
    assert.equal(opened.status, 200);
    const context = (await opened.json()) as { context: string; tabId: string; revision: number };
    assert.equal(context.revision, 1);
    const selected = {
      ...headers,
      'x-mistri-tab': context.tabId,
      'x-mistri-context': context.context,
      'x-mistri-lease-revision': String(context.revision),
    };
    const query = await call('/api/query?app=tenant-cli&tenant=north', { method: 'POST', headers: selected, body: '{"table":"item"}' });
    assert.equal(query.status, 200);
    const result = await query.text();
    assert.match(result, /North/);
    assert.doesNotMatch(result, /PRIVATE_SOUTH|private_item/);
    assert.equal(query.headers.get('x-mistri-lease-revision'), '1');
    const renewed = await call('/api/tenant/context/renew?app=tenant-cli&tenant=north', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: context.tabId, expectedContext: context.context, expectedRevision: context.revision }),
    });
    assert.equal(renewed.status, 200);
    const receipt = (await renewed.json()) as { context: string; tabId: string; revision: number };
    assert.equal(receipt.context, context.context);
    assert.equal(receipt.tabId, context.tabId);
    assert.equal(receipt.revision, 2);
    selected['x-mistri-lease-revision'] = String(receipt.revision);
    const schema = await call('/api/schema?app=tenant-cli&tenant=north', { headers: selected });
    assert.equal(schema.status, 200);
    if (!writable) assert.doesNotMatch(await schema.text(), /"writable":true/);
    const update = await call('/api/update?app=tenant-cli&tenant=north', {
      method: 'POST',
      headers: selected,
      body: JSON.stringify({ table: 'item', key: { id: 'north-id' }, values: { name: 'Must refuse' } }),
    });
    if (writable) assert.equal(update.status, 200, await update.text());
    else assert.ok(update.status >= 400);
    const check = new DatabaseSync(f.data, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT name FROM private_item WHERE id='north-id'").get()?.name, writable ? 'Must refuse' : 'North');
    } finally {
      check.close();
    }
    live.child.kill('SIGTERM');
    const [code] = await live.ended;
    assert.equal(code, 0, live.output());
  });

test('public tenant host retires on authored source change instead of hot-swapping access', { timeout: 30000 }, async (t) => {
  const f = fixture(t),
    live = await launch(f);
  writeFileSync(f.policy, 'export default {};');
  const [code] = await live.ended;
  assert.equal(code, 0, live.output());
  assert.match(live.output(), /deployment files changed/);
});

/* An App directory with a free-form page and a catalog is what a service-desk App is: the
   loader names their files (pageFiles, messageFiles), and tenant startup took
   its keys from a list without them, so every such App was refused with the
   bare "tenant context could not be verified". Started for real here, and
   the page's compiled code served to a signed-in reader. */
test('a tenant App with a free-form page and a message catalog starts and serves the page', { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.appDir, 'pages'));
  mkdirSync(join(f.appDir, 'messages'));
  writeFileSync(
    join(f.appDir, 'pages', 'board.page.tsx'),
    `import { definePage, Empty } from '@mistriwork/mistri/page';
export default definePage({ label: 'Board', reads: ['item'], component: () => <Empty title="TENANT_BOARD_PAGE" /> });
`,
  );
  // An App said in Spanish: its own catalog is the one it needs.
  writeFileSync(
    join(f.appDir, 'messages', 'es.ts'),
    `export default { kind: 'messages', locale: 'es', entries: { 'item.plural': 'Elementos' } };\n`,
  );
  writeFileSync(
    f.appFile,
    JSON.stringify({ ...f.app, ui: { locale: 'es-ES' }, views: { items: { ...f.app.views.items, label: { message: 'item.plural' } } } }),
  );
  const loaded = await loadApp(f.appDir);
  assert.deepEqual([loaded.pageFiles, loaded.messageFiles], [['pages/board.page.tsx'], ['messages/es.ts']]);
  const file = Object.keys(loaded.components?.files ?? {}).find((name) => name.endsWith('.js'));
  assert.ok(file, 'the page is compiled as a component');
  const live = await launch(f);
  const call = (path: string, options: RequestInit = {}) => fetch(live.origin + path, { ...options, signal: AbortSignal.timeout(5000) });
  const signup = await call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: live.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reader', email: 'reader@tenant.example.test', password: 'Disposable-tenant-CLI-password-123!' }),
  });
  assert.equal(signup.status, 200, await signup.text());
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const page = await call(`/_components/${file}`, { headers: { cookie } });
  assert.equal(page.status, 200, live.output());
  assert.match(await page.text(), /TENANT_BOARD_PAGE/);
  live.child.kill('SIGTERM');
  const [code] = await live.ended;
  assert.equal(code, 0, live.output());
});
