import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { test } from 'node:test';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';

test('tenant suite event jobs retain App and tenant ownership and drain on shutdown', { timeout: 15_000 }, async (t) => {
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
  const deployments = [];
  const fixtures: Array<{ id: string; database: string; control: { wait?: Promise<void>; entered?: boolean; signal?: AbortSignal } }> = [];
  const environment: NodeJS.ProcessEnv = { SECRET: 'suite-tenant-test-secret-longer-than-thirty-two-characters' };
  for (const id of ['alpha', 'beta']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO item VALUES('same', 'north', '${id}',0), ('hidden', 'south', 'not granted',0);`);
    db.close();
    provisionSqliteTenantStore(database, { appId: id, source: { id: 'data', connection: 'data' }, storeId: 'store' });
    migrateSqliteCommandJournal(database);
    const seed = new DatabaseSync(database);
    seed.exec(
      `INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant'),('@platform','active','1','platform')`,
    );
    seed.close();
    const manifest = {
      id,
      name: id,
      sources: { data: { connection: 'data' } },
      auth: {
        store: join(home, 'auth.db'),
        rows: 'tenant',
        signUp: 'open',
        roles: { member: { read: true, commands: ['advance'] }, clock: { read: true, commands: ['flag'] } },
      },
      resources: { item: { owner: 'tenant', access: 'write', fields: { read: ['id', 'name', 'version'], write: ['name'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    };
    writeFileSync(
      join(home, 'commands.mjs'),
      `import {defineCommand,defineCommands,defineEvent,defineEventProjection,shape,text} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
      export const control={};
      export const changed=defineEvent('item.changed',shape({id:text()}));
      export default defineCommands({
        advance:defineCommand({source:'data',target:'item',input:{},output:{parse(value){return value}},
          events:{changed:defineEventProjection(changed,value=>({id:value.id}))},
          async handle({db,record}){await db.item.update(record,{name:'Queued'});return {id:String(record.id)}}}),
        flag:defineCommand({source:'data',target:'item',input:{},output:{parse(value){return value}},
          async handle({db,record,signal}){if(control.wait){control.entered=true;control.signal=signal;await control.wait;return {}};
            await db.item.update(record,{name:${JSON.stringify(id)}+':Flagged'});return {}}})});`,
    );
    writeFileSync(
      join(home, 'jobs.mjs'),
      `import {defineJobs,defineJob} from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
      import {changed} from './commands.mjs';
      export default defineJobs({flag:defineJob({on:{event:changed,command:'advance'},command:'flag',runAs:'clock',schedule:event=>({key:{id:event.id}})})},
        {principals:{clock:{roles:['clock']}},store:{namespace:${JSON.stringify(id)}}});`,
    );
    const commands = await import(pathToFileURL(join(home, 'commands.mjs')).href);
    const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
    await provisionStores(
      { sqlite: database },
      { app: { tenant: { appId: id, source: { id: 'data', connection: 'data' }, storeId: 'store' }, commands: commands.default }, jobs },
    );
    writeFileSync(join(home, 'app.json'), JSON.stringify(manifest));
    writeFileSync(
      join(home, 'policy.mjs'),
      `export default {kind:'tenant',appId:${JSON.stringify(id)},storeId:'store',
      resultReferences:{advance:()=>[],flag:()=>[]},ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({item:true}),resolveRows:()=>({item:true})};`,
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
      jobs: `./${id}/jobs.mjs`,
      environment: { BETTER_AUTH_SECRET: 'SECRET', DATABASE_URL: id.toUpperCase() },
    });
    fixtures.push({ id, database, control: commands.control });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps: deployments }));
  // Events with no jobs module are kept for a later owner, as serve keeps them: no longer refused (suite-lifts.test.ts).
  writeFileSync(file, JSON.stringify({ port, apps: deployments }));
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

  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'tenant job did not reach expected state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const advance = (id: string, version: number, key: string) =>
    call(`/${id}/api/commands/execute?app=${id}&tenant=north`, contexts[id], {
      command: 'advance',
      commandVersion: 1,
      key: { id: 'same' },
      expectedVersion: version,
      idempotencyKey: key,
      input: {},
    });
  const results = await Promise.all(fixtures.map(({ id }) => advance(id, 0, 'shared-event-request-0001')));
  results.forEach((result) => assert.equal(result.status, 200, result.text));
  for (const { id, database } of fixtures) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      await until(() => db.prepare("SELECT name FROM item WHERE id='same'").get()?.name === id + ':Flagged');
      assert.equal(db.prepare("SELECT name FROM item WHERE id='hidden'").get()?.name, 'not granted');
    } finally {
      db.close();
    }
  }
  // Both job handlers must observe shutdown cancellation before either finishes.
  for (const fixture of fixtures) {
    fixture.control.wait = new Promise<void>((resolve) => releases.push(resolve));
    const db = new DatabaseSync(fixture.database, { readOnly: true });
    let version: number;
    try {
      version = Number(db.prepare("SELECT version FROM item WHERE id='same'").get()?.version);
    } finally {
      db.close();
    }
    const result = await advance(fixture.id, version, 'held-event-request-0001');
    assert.equal(result.status, 200, result.text);
  }
  await until(() => fixtures.every((fixture) => fixture.control.entered));
  let closed = false;
  const closing = active.close().then(() => {
    closed = true;
  });
  await until(() => fixtures.every((fixture) => fixture.control.signal?.aborted));
  assert.equal(closed, false, 'suite must drain both accepted job handlers before closing their stores');
  releases.forEach((release) => release());
  await closing;
});
