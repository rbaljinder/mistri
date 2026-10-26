/** The operator-configured suite, including real stores and drained restarts. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  provisionSqlitePublicPlacementJournal,
  provisionPostgresPublicPlacementJournal,
} from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { liveSkip } from './live.js';

const canonical = 'https://staff.example',
  north = 'https://north.example',
  south = 'https://south.example';
const mount = '/suite/site',
  endpoint = `${mount}/api/forms/contact`;
interface Placement {
  binding: string;
  submission: string;
  recoveryUrl: string;
}
interface Response {
  status: number;
  body: any;
  text: string;
  headers: IncomingHttpHeaders;
}
const submit = (p: Placement, name = 'Visitor') => ({
  input: { name },
  submission: p.submission,
  placement: { version: 1, binding: p.binding },
});
const recover = (p: Placement) => ({ submission: p.submission, placement: { version: 1, binding: p.binding } });
const LIVE = process.env.TABLEWALK_PUBLIC_PLACEMENT_TEST_PG ?? process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

async function fixture(t: TestContext, postgres = false) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-placement-')),
    home = join(directory, 'site');
  mkdirSync(home);
  let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  let cleanupStore = async () => {};
  t.after(async () => {
    try {
      await active?.close();
    } finally {
      await cleanupStore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const sql = `CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE lead(id TEXT PRIMARY KEY NOT NULL, dealer TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
    INSERT INTO dealer VALUES('north',1),('south',1);`;
  let database = join(directory, 'business.db');
  let rows: () => Promise<unknown[]>;
  if (postgres) {
    if (!LIVE || new URL(LIVE).port === '57693') throw new Error('An owned PostgreSQL instance is required.');
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE });
    await control.connect();
    const name = `tw_suite_placement_${randomUUID().replaceAll('-', '')}`;
    await control.query(`CREATE DATABASE "${name}"`);
    const url = new URL(LIVE);
    url.pathname = `/${name}`;
    database = url.href;
    const client = new pg.default.Client({ connectionString: database });
    cleanupStore = async () => {
      await client.end();
      await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
    };
    await client.connect();
    await client.query(sql);
    await migratePostgresCommandJournal(database);
    await provisionPostgresPublicPlacementJournal(database);
    rows = async () => (await client.query('SELECT dealer,name FROM lead ORDER BY dealer,name')).rows;
  } else {
    const db = new DatabaseSync(database);
    db.exec(`PRAGMA journal_mode=WAL; ${sql}`);
    cleanupStore = async () => {
      db.close();
    };
    migrateSqliteCommandJournal(database);
    provisionSqlitePublicPlacementJournal(database);
    rows = async () =>
      db
        .prepare('SELECT dealer,name FROM lead ORDER BY dealer,name')
        .all()
        .map((row) => ({ ...row }));
  }
  const commandsFile = join(home, 'commands.mjs');
  writeFileSync(
    commandsFile,
    `import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
    import { shape, text } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandShapes.ts', import.meta.url).href)};
    export const control = {};
    export default defineCommands({ contact: defineCommand({ source:'main', target:'lead', targets:'none', read:['dealer'], public:true,
      input:{name:{type:'text'}}, output:shape({reference:text()}), async handle(ctx,input) {
        assert.equal(ctx.actor.kind,'public'); assert.deepEqual(ctx.actor.roles,[]);
        assert.ok(Object.isFrozen(ctx.placement)); assert.deepEqual(Object.keys(ctx.placement),['tenantId']);
        const id=randomUUID(); await ctx.tx.insert({table:'lead',values:{id,dealer:ctx.placement.tenantId,name:input.name}});
        if(control.wait){control.entered();await control.wait;}
        return {reference:id};
      }
    }) });`,
  );
  const commands = await import(pathToFileURL(commandsFile).href);
  const policyFile = join(home, 'policy.mjs');
  const policyText = `export default {appId:'site',resolveRows(){throw Error('private rows must not run')},
    resolvePublicRows(intent){return intent?{dealer:{groups:[[{column:'id',op:'=',value:intent.tenant}]]}}:{}},
    resultReferences:{}, publicForms:{contact:{kind:'placement',source:'main',resultReferences:()=>[],
      resolvePlacement(intent){return {rows:{dealer:{groups:[[{column:'id',op:'=',value:intent.tenant}]]},
        lead:{groups:[[{column:'dealer',op:'=',value:intent.tenant}]]}},
        anchors:[{table:'dealer',key:{id:intent.tenant},expected:{active:1}}]};}}}};`;
  writeFileSync(policyFile, policyText);
  writeFileSync(
    join(home, 'removed.mjs'),
    `export default {appId:'site',resolveRows(){throw Error('private rows must not run')},resolvePublicRows(){return {}}};`,
  );
  writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
  const other = join(directory, 'other');
  mkdirSync(other);
  writeFileSync(
    join(other, 'app.json'),
    JSON.stringify({
      id: 'other',
      name: 'Other',
      resources: { dealer: {} },
      auth: { store: join(other, 'auth.db'), roles: { staff: { read: true } } },
      views: { dealers: { kind: 'list', from: 'dealer' } },
      home: 'dealers',
    }),
  );
  const file = join(directory, 'suite.json');
  const environment = {
    AUTH_SECRET: 'test-only-suite-placement-auth-secret-over-thirty-two-characters',
    PLACEMENT_KEY: randomBytes(32).toString('base64url'),
  };
  const configure = (removed = false) => {
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id: 'site',
        name: 'Site',
        sources: { main: { connection: 'data' } },
        auth: {
          store: join(home, 'auth.db'),
          signUp: 'open',
          rows: 'policy',
          roles: { staff: { read: true } },
          public: { read: ['dealer'] },
        },
        resources: { dealer: {}, lead: { access: 'write' } },
        views: {
          dealers: { kind: 'list', from: 'dealer' },
          ...(removed ? {} : { contact: { kind: 'form', public: true, label: 'Contact', command: 'contact' } }),
        },
        home: 'dealers',
        nav: ['dealers'],
      }),
    );
    if (removed) rmSync(commandsFile);
    writeFileSync(
      file,
      JSON.stringify({
        port,
        basePath: '/suite',
        publicOrigin: canonical,
        hosts: removed
          ? [{ host: 'south.example', app: 'site', tenant: 'south' }]
          : [
              { host: 'north.example', app: 'site', tenant: 'north' },
              { host: 'south.example', app: 'site', tenant: 'south' },
            ],
        publicPlacement: {
          issuerId: 'suite-placement',
          activeKey: 'one',
          keys: [{ id: 'one', secretEnv: 'PLACEMENT_KEY', issueFrom: 0 }],
          sources: [{ app: 'site', source: 'main', identity: 'business-original' }],
          ...(removed ? { recoveryOrigins: [{ app: 'site', origin: north, recoverUntil: Date.now() + 86_400_000 }] } : {}),
        },
        apps: [
          {
            id: 'site',
            directory: './site',
            config: './site/connections.json',
            policy: removed ? './site/removed.mjs' : './site/policy.mjs',
            mount: '/site',
            environment: { BETTER_AUTH_SECRET: 'AUTH_SECRET' },
          },
          {
            id: 'other',
            directory: './other',
            config: './site/connections.json',
            mount: '/other',
            environment: { BETTER_AUTH_SECRET: 'AUTH_SECRET' },
          },
        ],
      }),
    );
  };
  configure();
  const restart = async (removed = false) => {
    await active?.close();
    resetPublicFormLimits();
    configure(removed);
    active = await startConfiguredSuite(file, environment);
  };
  await restart();
  let cookie = '';
  const call = (
    origin: string,
    path = endpoint,
    body?: unknown,
    options: { method?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: options.method ?? (payload === undefined ? 'GET' : 'POST'),
          headers: {
            host: new URL(origin).host,
            origin,
            cookie,
            'content-type': 'application/json',
            'accept-encoding': 'identity',
            ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
            ...options.headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              /* HTML or HEAD */
            }
            resolve({ status: res.statusCode!, body, text, headers: res.headers });
          });
        },
      );
      req.setTimeout(15_000, () => req.destroy(new Error('Suite placement request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  return {
    call,
    restart,
    rows,
    commands,
    close: () => active!.close(),
    prepare: async (origin = north) => {
      const response = await call(origin);
      assert.equal(response.status, 200, response.text);
      return response.body.placement as Placement;
    },
    staff: async () => {
      const result = await call(canonical, `${mount}/api/auth/sign-up/email`, {
        name: 'Staff',
        email: 'staff@example.test',
        password: 'test-only-password-12345',
      });
      assert.equal(result.status, 200, result.text);
      cookie = (result.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ');
      assert.ok(cookie);
    },
    mutatePolicy: () => writeFileSync(policyFile, `${policyText}\n// changed policy bytes\n`),
  };
}

for (const postgres of [false, true])
  test(
    `configured ${postgres ? 'PostgreSQL' : 'SQLite'} suite owns placement, restart and handler-free receipt recovery`,
    { skip: postgres ? liveSkip('postgres', LIVE) : false, timeout: 90_000 },
    async (t) => {
      const f = await fixture(t, postgres);
      await f.staff();
      const unplaced = await f.call(canonical);
      assert.equal(unplaced.status, 409, unplaced.text);
      assert.equal(unplaced.body.code, 'placement_required');
      const placement = await f.prepare(),
        other = await f.prepare(south);
      assert.equal(placement.recoveryUrl, `${canonical}${endpoint}/receipt`);
      const first = await f.call(north, endpoint, submit(placement));
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(Object.keys(first.body).sort(), ['receipt', 'reference']);
      assert.equal(first.headers['set-cookie'], undefined);
      assert.equal(first.headers['x-mistri-account'], undefined);
      assert.equal(first.headers['cache-control'], 'no-store');
      assert.deepEqual((await f.call(north, endpoint, submit(placement))).body, first.body);
      const second = await f.call(south, endpoint, submit(other, 'South'));
      assert.equal(second.status, 200, second.text);
      assert.equal((await f.call(south, endpoint, submit(placement))).status, 403);
      assert.equal((await f.call(north, '/suite/other/api/forms/contact', submit(placement))).status, 404);
      assert.equal((await f.call(north, '/suite/other/api/app')).status, 404);
      assert.equal((await f.call(north, `${mount}/api/auth/get-session`)).status, 404);
      const page = await f.call(north, `${mount}/form/contact`);
      assert.equal(page.status, 200, page.text.slice(0, 200));
      assert.doesNotMatch(page.text, /pp1\.|"placement"\s*:/);
      assert.equal(page.headers['set-cookie'], undefined);
      const fresh = await f.prepare();
      await f.restart();
      const stale = await f.call(north, endpoint, submit(fresh));
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.body.code, 'placement_changed');
      const receipt = await f.call(canonical, `${endpoint}/receipt`, recover(placement), { headers: { origin: north } });
      assert.equal(receipt.status, 200, receipt.text);
      assert.deepEqual(receipt.body, first.body);
      const current = await f.prepare();
      assert.equal((await f.call(north, endpoint, submit(current, 'After restart'))).status, 200);
      await f.restart(true);
      assert.equal((await f.call(north)).status, 403);
      const preflight = await f.call(canonical, `${endpoint}/receipt`, undefined, {
        method: 'OPTIONS',
        headers: {
          origin: north,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], north);
      const removed = await f.call(canonical, `${endpoint}/receipt`, recover(placement), { headers: { origin: north } });
      assert.equal(removed.status, 200, removed.text);
      assert.deepEqual(removed.body, first.body);
      assert.equal(removed.headers['access-control-allow-origin'], north);
      assert.equal(removed.headers['access-control-allow-credentials'], undefined);
      assert.equal(removed.headers['set-cookie'], undefined);
      assert.deepEqual(await f.rows(), [
        { dealer: 'north', name: 'After restart' },
        { dealer: 'north', name: 'Visitor' },
        { dealer: 'south', name: 'South' },
      ]);
    },
  );

test('configured suite drains an admitted placement write before releasing its stores', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  let entered!: () => void, release!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.commands.control.entered = entered;
  f.commands.control.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.call(north, endpoint, submit(placement));
  await accepted;
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
  } finally {
    release();
  }
  const result = await pending;
  await closing;
  assert.equal(result.status, 503);
  assert.equal(result.body.outcome, 'unknown');
  assert.deepEqual(await f.rows(), []);
});

test('an in-process suite restart refuses a new policy digest paired with a cached old module', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.close();
  f.mutatePolicy();
  await assert.rejects(f.restart(), /Placement policy changed during startup/);
});
