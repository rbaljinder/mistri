import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { test } from 'node:test';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';

test('tenant suite concurrent commands retain policy, write grants, journal ownership', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-tenant-'));
  let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  const releases: (() => void)[] = [];
  t.after(async () => {
    releases.forEach((release) => release());
    await active?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const deployments = [],
    fixtures = [];
  const environment: NodeJS.ProcessEnv = { SECRET: 'suite-tenant-test-secret-longer-than-thirty-two-characters' };
  for (const id of ['alpha', 'beta']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO item VALUES('same', 'north', '${id}', 0), ('hidden', 'south', 'not granted', 0);`);
    db.close();
    provisionSqliteTenantStore(database, { appId: id, source: { id: 'data', connection: 'data' }, storeId: 'store' });
    const seed = new DatabaseSync(database);
    seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant')`);
    seed.close();
    const manifest = {
      id,
      name: id,
      sources: { data: { connection: 'data' } },
      auth: {
        store: join(home, 'auth.db'),
        rows: 'tenant',
        signUp: 'open',
        roles: { member: { read: true, write: true, commands: ['rename'] }, viewer: { read: true } },
      },
      resources: { item: { owner: 'tenant', access: 'write', fields: { read: ['id', 'name', 'version'], write: ['name'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    };
    writeFileSync(
      join(home, 'commands.mjs'),
      `import {defineCommand,defineCommands} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
      export const control = {};
      export default defineCommands({rename:defineCommand({source:'data',target:'item',read:['item'],write:['item'],
        input:{name:{type:'text'}},validate(input){return {name:input.name}},output:{parse(value){return value}},
        async handle({db,record},input){if(control.wait){control.entered=true;await control.wait}
          await db.item.update(record,{name:input.name}); if(input.name==='rollback') throw Error('rolled back');
          return {name:input.name};}})});`,
    );
    writeFileSync(join(home, 'app.json'), JSON.stringify(manifest));
    writeFileSync(
      join(home, 'policy.mjs'),
      `export default {kind:'tenant',appId:${JSON.stringify(id)},storeId:'store',
      resultReferences:{rename:()=>[]},ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({item:true}),resolveRows:()=>({item:true})};`,
    );
    writeFileSync(
      join(home, 'connections.json'),
      JSON.stringify({ connections: [{ name: 'data', url: '${DATABASE_URL}', writable: true }] }),
    );
    environment[id.toUpperCase()] = database;
    deployments.push({
      id,
      directory: `./${id}`,
      mount: `/${id}`,
      config: `./${id}/connections.json`,
      policy: `./${id}/policy.mjs`,
      environment: { BETTER_AUTH_SECRET: 'SECRET', DATABASE_URL: id.toUpperCase() },
    });
    fixtures.push({ id, database, home, manifest });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps: deployments }));
  await assert.rejects(startConfiguredSuite(file, environment), /could not validate/);
  for (const { home, database } of fixtures) {
    assert.equal(existsSync(join(home, 'auth.db')), false, 'missing command journal must refuse before auth provisioning');
    migrateSqliteCommandJournal(database);
  }
  active = await startConfiguredSuite(file, environment);
  const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(active!.publicURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: active!.publicURL, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: JSON.parse(text),
      text,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const contexts: Record<string, Record<string, string>> = {};
  for (const fixture of fixtures) {
    const { id, database } = fixture;
    const account = await call(
      `/${id}/api/auth/sign-up/email`,
      {},
      { name: 'Reader', email: 'reader@example.test', password: 'test-only-tenant-password' },
    );
    assert.equal(account.status, 200, account.text);
    const headers = { cookie: account.cookie, 'x-mistri-account': account.body.user.id };
    const db = new DatabaseSync(database);
    db.prepare(
      `INSERT INTO "${TENANT_TABLES.membership}" VALUES(?, 'north', ?, 'active', '1', '["member"]', ?, 'member', NULL, NULL, NULL)`,
    ).run('membership', account.body.user.id, Date.now() + 120000);
    db.close();
    const open = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=north`, headers, {});
    assert.equal(open.status, 200, open.text);
    contexts[id] = {
      ...headers,
      'x-mistri-tab': open.body.tabId,
      'x-mistri-context': open.body.context,
      'x-mistri-lease-revision': String(open.body.revision),
    };
    const rows = await call(`/${id}/api/query?app=${id}&tenant=north`, contexts[id], { table: 'item' });
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(rows.body.rows, [{ id: 'same', name: id, version: 0 }]);
    const hidden = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=south`, headers, {});
    assert.ok(hidden.status >= 400, hidden.text);
  }
  const foreign = await call('/beta/api/query?app=beta&tenant=north', contexts.alpha, { table: 'item' });
  assert.ok(foreign.status >= 400, foreign.text);
  const spoof = await call('/beta/api/query?app=alpha&tenant=north', contexts.beta, { table: 'item' });
  assert.ok(spoof.status >= 400, spoof.text);
  const command = {
    command: 'rename',
    commandVersion: 1,
    key: { id: 'same' },
    expectedVersion: 0,
    idempotencyKey: 'shared-command-attempt-0001',
    input: { name: 'Changed' },
  };
  const running = [];
  const controls = [];
  for (const { id, home } of fixtures) {
    const module = await import(pathToFileURL(join(home, 'commands.mjs')).href);
    module.control.wait = new Promise<void>((resolve) => releases.push(resolve));
    controls.push(module.control);
    running.push(
      call(`/${id}/api/commands/execute?app=${id}&tenant=north`, contexts[id], { ...command, input: { name: id + ':Changed' } }),
    );
  }
  const deadline = Date.now() + 3000;
  while (!controls.every((control) => control.entered)) {
    assert.ok(Date.now() < deadline, 'both independent App handlers must enter before either is released');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  releases.forEach((release) => release());
  const results = await Promise.all(running);
  results.forEach((result) => assert.equal(result.status, 200, result.text));
  const foreignCommand = await call('/beta/api/commands/execute?app=beta&tenant=north', contexts.alpha, command);
  assert.ok(foreignCommand.status >= 400, foreignCommand.text);
  for (const { id, database } of fixtures) {
    const replay = await call(`/${id}/api/commands/status?app=${id}&tenant=north`, contexts[id], {
      ...command,
      input: { name: id + ':Changed' },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body.result, { name: id + ':Changed' });
    const rollback = await call(`/${id}/api/commands/execute?app=${id}&tenant=north`, contexts[id], {
      ...command,
      expectedVersion: 1,
      idempotencyKey: 'rollback-attempt-0001',
      input: { name: 'rollback' },
    });
    assert.ok(rollback.status >= 400, rollback.text);
    const unchanged = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(unchanged.prepare("SELECT name FROM item WHERE id='same'").get()?.name, id + ':Changed');
    } finally {
      unchanged.close();
    }
    const hidden = await call(`/${id}/api/commands/execute?app=${id}&tenant=north`, contexts[id], {
      ...command,
      key: { id: 'hidden' },
      idempotencyKey: 'hidden-attempt-0001',
    });
    assert.ok(hidden.status >= 400, hidden.text);
    const update = await call(`/${id}/api/update?app=${id}&tenant=north`, contexts[id], {
      table: 'item',
      key: { id: 'same' },
      values: { name: id + ':Edited' },
    });
    assert.equal(update.status, 200, update.text);
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare("SELECT name FROM item WHERE id='same'").get()?.name, id + ':Edited');
      assert.equal(db.prepare("SELECT name FROM item WHERE id='hidden'").get()?.name, 'not granted');
      assert.equal(db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()?.n, 1);
      // Revoke write and command grants while keeping the native account/session live.
      db.prepare(`UPDATE "${TENANT_TABLES.membership}" SET roles_json='["viewer"]', version='2'`).run();
    } finally {
      db.close();
    }
    const authHeaders = { cookie: contexts[id].cookie, 'x-mistri-account': contexts[id]['x-mistri-account'] };
    const reopen = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=north`, authHeaders, {});
    assert.equal(reopen.status, 200, reopen.text);
    const reader = {
      ...authHeaders,
      'x-mistri-tab': reopen.body.tabId,
      'x-mistri-context': reopen.body.context,
      'x-mistri-lease-revision': String(reopen.body.revision),
    };
    const denied = await call(`/${id}/api/update?app=${id}&tenant=north`, reader, {
      table: 'item',
      key: { id: 'same' },
      values: { name: 'forbidden' },
    });
    assert.ok(denied.status >= 400, denied.text);
    const deniedCommand = await call(`/${id}/api/commands/execute?app=${id}&tenant=north`, reader, {
      ...command,
      expectedVersion: 1,
      idempotencyKey: 'viewer-attempt-0001',
    });
    assert.ok(deniedCommand.status >= 400, deniedCommand.text);
  }
});
