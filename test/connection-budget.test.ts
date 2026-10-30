/**
 * The connections one process may hold against a PostgreSQL database
 * (connectionBudget.ts): the sum `mistri check --deploy` prints and holds to
 * `--connection-limit`, what a manager and the auth store count, and the
 * warning a start prints when the server would allow fewer. The server's
 * answer is a fake query here; no database is needed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adviseConnectionLimits,
  databaseOf,
  effectiveLimit,
  heldConnections,
  holdConnections,
  limitAdvice,
  managerConnections,
  sayBudget,
} from '../packages/engine/src/adapters/connectionBudget.js';
import { PgConnectionManager, sharedPgConnections } from '../packages/engine/src/adapters/postgresPool.js';
import { configureServerSettings, serverSettings } from '../packages/engine/src/adapters/serverSettings.js';
import {
  declareTenantPool,
  forgetTenantPools,
  tenantAdapter,
  tenantRequestReaders,
} from '../packages/mistri/src/server/tenant/tenantConnections.js';
import { arrivalWidth } from '../packages/mistri/src/server/tenant/tenantArrivals.js';
import { servedHosts } from '../packages/mistri/src/server/build/servedHosts.js';
import { connectionBudgets, type DeployInput } from '../packages/mistri/src/server/build/checkDeploy.js';

const business = { id: 'main', name: 'main', url: 'postgres://u:p@db.example/app', pool: { read: 6, write: 4 } };
const input = (more: Partial<DeployInput> = {}): DeployInput => ({
  app: { id: 'a', connection: 'main' },
  connections: [business],
  cache: false,
  env: {},
  ...more,
});

describe('the sum check --deploy prints', () => {
  test('one process holds readers + writers + the background writer + LISTEN, times the replicas', () => {
    const { rows, findings } = connectionBudgets(input({ replicas: 3 }));
    assert.deepEqual(rows, [
      { database: 'db.example:5432/app', perProcess: 12, processes: 3, total: 36, parts: [{ host: 'adapter', connections: 12 }] },
    ]);
    assert.deepEqual(findings, []);
    assert.match(sayBudget(rows[0]), /^db\.example:5432\/app: 3 processes × 12 connections = 36; a process: adapter 12$/);
  });

  test('read replicas and the sign-in store are counted on their own databases, and one database sums its holders', () => {
    const app = {
      id: 'a',
      connection: 'main',
      auth: { providers: ['email'], store: 'postgres://u:p@auth.example/auth' },
    } as DeployInput['app'];
    const { rows } = connectionBudgets(
      input({ app, connections: [{ ...business, replicas: ['postgres://u:p@ro.example/app'] }], env: { MISTRI_AUTH_POOL: '5' } }),
    );
    assert.deepEqual(
      rows.map((row) => [row.database, row.perProcess]),
      [
        ['db.example:5432/app', 12],
        ['ro.example:5432/app', 6],
        ['auth.example:5432/auth', 5],
      ],
    );
    const shared = connectionBudgets(
      input({ app: { ...app, auth: { ...app.auth!, store: 'postgres://x:y@db.example/app' } } as DeployInput['app'], env: {} }),
    );
    assert.equal(shared.rows[0].perProcess, 16);
  });

  test('the process flags size a connection that names none', () => {
    const { rows } = connectionBudgets(
      input({ connections: [{ id: 'main', name: 'main', url: business.url }], pools: { readers: 2, writers: 3 } }),
    );
    assert.equal(rows[0].perProcess, 2 + 3 + 1 + 1);
  });

  test('--cpus sizes the defaults for the deployment, not this machine, and the line says which count it assumed', () => {
    const bare = [{ id: 'main', name: 'main', url: business.url }];
    const small = connectionBudgets(input({ connections: bare, cpus: 1 })).rows[0];
    const large = connectionBudgets(input({ connections: bare, cpus: 16 })).rows[0];
    assert.equal(small.perProcess, 4 + 4 + 1 + 1, '1 cpu: four writers, four readers');
    assert.equal(large.perProcess, 16 + 16 + 1 + 1, '16 cpus: sixteen of each');
    assert.match(sayBudget(small), /\(at 1 cpus; pass --cpus for the deployment's\)/);
    // Sizes the operator gave do not depend on the cores, so the line does not claim a count.
    assert.equal(connectionBudgets(input({ cpus: 1 })).rows[0].cpus, undefined);
  });

  test('an App that declares jobs and effects counts the one manager their stores share, on the home database', () => {
    const bare = [{ id: 'main', name: 'main', url: business.url }];
    const one = connectionBudgets(input({ connections: bare, cpus: 1 })).rows[0];
    const served = connectionBudgets(input({ connections: bare, cpus: 1, served: { jobs: true, effects: true } })).rows[0];
    // The server's stores hold two readers, two writers and the background writer whatever the App's pools; jobs adds its LISTEN.
    assert.equal(served.perProcess - one.perProcess, 5 + 1);
    assert.deepEqual(
      served.parts!.map((part) => part.host),
      ['adapter', 'server stores', 'jobs LISTEN'],
    );
  });

  test('every store host joins the one server-stores manager; a tenant App shares one manager for its requests', () => {
    for (const fact of ['jobs', 'decisions', 'assistant', 'apiEvents', 'effects', 'mail', 'integrations', 'inbound'] as const)
      assert.deepEqual(servedHosts({ [fact]: true }, 4, 4)[0], { host: 'server stores', connections: 5 }, fact);
    assert.deepEqual(servedHosts({ decisions: true, assistant: true, apiEvents: true, integrations: true, inbound: true }, 4, 4), [
      { host: 'server stores', connections: 5 },
    ]);
    assert.deepEqual(servedHosts({ tenant: true }, 4, 4), [
      { host: 'tenant requests', connections: 9 },
      { host: 'live LISTEN', connections: 1 },
    ]);
    assert.deepEqual(servedHosts({ tenant: true, jobs: true, mail: true }, 6, 5), [
      { host: 'tenant requests', connections: 12 },
      { host: 'live LISTEN', connections: 1 },
      { host: 'server stores', connections: 5 },
      { host: 'jobs LISTEN', connections: 1 },
    ]);
  });

  test('a field deployment, a tenant App with jobs at four readers and four writers, fits a role allowed eighteen', () => {
    /* It printed `1 × 51 = 51 (limit 18): adapter 10 + tenant 41` while each tenant subsystem kept a manager of its own. */
    const { rows, findings } = connectionBudgets(
      input({
        connections: [{ ...business, pool: { read: 4, write: 4 } }],
        replicas: 1,
        cpus: 1,
        connectionLimit: 18,
        served: { tenant: true, jobs: true, mail: true },
      }),
    );
    assert.deepEqual(findings, []);
    assert.match(
      sayBudget(rows[0]),
      /: 1 process × 16 connections = 16 \(limit 18\); a process: tenant requests 9 \+ live LISTEN 1 \+ server stores 5 \+ jobs LISTEN 1$/,
    );
  });

  test('a sign-in store on the same database counts on top: 16 fits eighteen only with MISTRI_AUTH_POOL=2', () => {
    const app = {
      id: 'a',
      connection: 'main',
      auth: { providers: ['email'], store: business.url },
    } as DeployInput['app'];
    const field = (env: Record<string, string>) =>
      connectionBudgets(
        input({
          app,
          connections: [{ ...business, pool: { read: 4, write: 4 } }],
          cpus: 1,
          connectionLimit: 18,
          served: { tenant: true, jobs: true, mail: true },
          env,
        }),
      );
    const stock = field({});
    assert.deepEqual(
      stock.findings.map((found) => found.code),
      ['deploy-connection-limit'],
    );
    assert.match(
      sayBudget(stock.rows[0]),
      /= 20 \(limit 18\); a process: tenant requests 9 \+ live LISTEN 1 \+ server stores 5 \+ jobs LISTEN 1 \+ sign-in store 4$/,
    );
    const fitted = field({ MISTRI_AUTH_POOL: '2' });
    assert.deepEqual(fitted.findings, []);
    assert.match(sayBudget(fitted.rows[0]), /= 18 \(limit 18\).*sign-in store 2$/);
  });

  test('a total past the limit fails, naming the sum; at the limit or without one it does not', () => {
    const over = connectionBudgets(input({ replicas: 3, connectionLimit: 30 }));
    assert.deepEqual(
      over.findings.map((found) => `${found.severity} ${found.code}`),
      ['error deploy-connection-limit'],
    );
    assert.match(over.findings[0].message, /3 processes × 12 connections = 36 \(limit 30\)/);
    assert.deepEqual(connectionBudgets(input({ replicas: 3, connectionLimit: 36 })).findings, []);
    assert.deepEqual(connectionBudgets(input({ replicas: 30 })).findings, []);
  });

  test("a SQLite source or an unset reference is the other findings' business, not a sum", () => {
    assert.deepEqual(connectionBudgets(input({ connections: [{ id: 'main', name: 'main', url: '/data/app.db' }] })).rows, []);
    assert.deepEqual(connectionBudgets(input({ connections: [{ id: 'main', name: 'main', url: '${NOPE}' }] })).rows, []);
  });
});

describe('what a process holds', () => {
  test("a manager holds readers + writers + 1 from its making to its close; a replica's readers go to the replica", async () => {
    const before = new Map(heldConnections());
    const manager = new PgConnectionManager('postgres://u:p@held.example/app', undefined, undefined, {
      readers: 5,
      writers: 3,
      replicas: ['postgres://u:p@held-ro.example/app'],
    });
    assert.equal(heldConnections().get('held.example:5432/app'), managerConnections(5, 1)); // writes are serial here, so the three writers asked for are one
    assert.equal(heldConnections().get('held-ro.example:5432/app'), 5);
    await manager.close();
    assert.equal(heldConnections().get('held.example:5432/app'), before.get('held.example:5432/app'));
    assert.equal(heldConnections().has('held-ro.example:5432/app'), false);
  });

  test('holders of one database and pool shape share one manager, counted once; the last close ends it', async (t) => {
    const url = 'postgres://u:p@shared.example/app';
    const database = 'shared.example:5432/app';
    const first = sharedPgConnections(url, { readers: 3 });
    const second = sharedPgConnections(url, { readers: 3 });
    assert.ok(first instanceof PgConnectionManager);
    assert.equal(heldConnections().get(database), managerConnections(3, 1));
    // Another shape is another manager: a holder never borrows pools sized for someone else.
    const piped = sharedPgConnections(url, { readers: 3, pipelineReads: true });
    assert.equal(heldConnections().get(database), 2 * managerConnections(3, 1));
    await piped.close();
    await first.close();
    await first.close(); // once per holder, however often it is called
    assert.equal(heldConnections().get(database), managerConnections(3, 1));
    assert.equal(second.withWriteClient, second.withWriteClient, 'a method is bound once per handle');
    // A method replaced on the class after the handle was taken (a test's mock) is the one a handle calls.
    const before = second.withReadClient;
    const mocked = t.mock.method(PgConnectionManager.prototype, 'withReadClient', async () => 'mocked');
    assert.equal(await second.withReadClient(async () => 'real'), 'mocked');
    mocked.mock.restore();
    assert.equal(second.withReadClient, before);
    await second.close();
    assert.equal(heldConnections().has(database), false);
    // After the last holder, the next one opens a manager of its own.
    const again = sharedPgConnections(url, { readers: 3 });
    assert.equal(heldConnections().get(database), managerConnections(3, 1));
    await again.close();
  });

  test('a hold is released once, however often it is called', () => {
    const release = holdConnections('postgres://u:p@twice.example/x', 4);
    holdConnections('postgres://u:p@twice.example/x', 2);
    release();
    release();
    assert.equal(heldConnections().get('twice.example:5432/x'), 2);
  });

  test('two URLs of one database are one, credentials aside', () => {
    assert.equal(databaseOf('postgres://a:b@h.example:5432/d'), databaseOf('postgresql://c:d@h.example/d?sslmode=require'));
  });
});

describe("a tenant App's request pool", () => {
  const url = 'postgres://u:p@tenant-pool.example/app';
  const replica = 'postgres://u:p@tenant-pool-ro.example/app';
  const database = 'tenant-pool.example:5432/app';
  const keyed = serverSettings().writeOrder;
  const settings = { ...serverSettings() };

  test("honors the connection's pool, and check --deploy prints the number it opens", async (t) => {
    configureServerSettings({ writeOrder: 'keyed', readers: 7, writers: 6 });
    t.after(() => {
      configureServerSettings({ ...settings, writeOrder: keyed });
      forgetTenantPools();
    });
    declareTenantPool(url, { read: 2, write: 2 });
    const adapters = [tenantAdapter(url, 'reader'), tenantAdapter(url, 'writer')];
    // One manager for every holder, of the connection's size and not the process's (--read-pool 7, --write-pool 6).
    assert.equal(heldConnections().get(database), managerConnections(2, 2));
    const { rows } = connectionBudgets(
      input({
        connections: [{ id: 'main', name: 'main', url, pool: { read: 2, write: 2 } }],
        served: { tenant: true },
        pools: { readers: 7, writers: 6 },
      }),
    );
    const [requests] = rows[0].parts!.filter((part) => part.host === 'tenant requests');
    assert.equal(requests.connections, heldConnections().get(database));
    await Promise.all(adapters.map((adapter) => adapter.close()));
    assert.equal(heldConnections().has(database), false);
    // The arrival gate halves the readers it was given, not the process's.
    assert.equal(tenantRequestReaders(), 2);
    assert.equal(arrivalWidth(), 1);
  });

  test("a pool that names one side takes the other from the process's settings, as an ordinary App's does", async (t) => {
    configureServerSettings({ writeOrder: 'keyed', readers: 7, writers: 6 });
    t.after(() => {
      configureServerSettings({ ...settings, writeOrder: keyed });
      forgetTenantPools();
    });
    declareTenantPool(url, { read: 3 });
    const adapter = tenantAdapter(url, 'reader');
    assert.equal(heldConnections().get(database), managerConnections(3, 6));
    await adapter.close();
  });

  test('a replica holds its readers and no writer, which is what check --deploy counts', async (t) => {
    configureServerSettings({ writeOrder: 'keyed' });
    t.after(() => {
      configureServerSettings({ ...settings, writeOrder: keyed });
      forgetTenantPools();
    });
    declareTenantPool(url, { read: 3, write: 2 });
    declareTenantPool(replica, { read: 3 });
    const adapter = tenantAdapter(replica, 'replica', true);
    assert.equal(heldConnections().get('tenant-pool-ro.example:5432/app'), 3);
    await adapter.close();
    const { rows } = connectionBudgets(
      input({
        connections: [{ id: 'main', name: 'main', url, replicas: [replica], pool: { read: 3, write: 2 } }],
        served: { tenant: true },
      }),
    );
    assert.equal(rows.find((row) => row.database === 'tenant-pool-ro.example:5432/app')!.perProcess, 3);
  });
});

describe('the warning at start', () => {
  const server = (role_limit: number | null, usable: number) => ({ query: async () => ({ rows: [{ role_limit, usable }] }) });

  test('names both numbers and the flags when the ceiling is past the smaller limit', async () => {
    const line = await limitAdvice('db.example:5432/app', 41, server(30, 97));
    assert.match(line!, /may open 41 connections to db\.example:5432\/app/);
    assert.match(line!, /role's limit allows 30/);
    assert.match(line!, /--read-pool/);
    assert.match(line!, /--write-pool/);
    assert.match((await limitAdvice('db.example:5432/app', 41, server(-1, 20)))!, /max_connections.* allows 20/);
  });

  test('says nothing when it fits, when the role has no limit and the server is roomy, or when nothing is known', async () => {
    assert.equal(await limitAdvice('d', 30, server(30, 97)), undefined);
    assert.equal(await limitAdvice('d', 90, server(-1, 97)), undefined);
    assert.equal(await limitAdvice('d', 90, { query: async () => ({ rows: [] }) }), undefined);
    assert.equal(effectiveLimit(-1, undefined), undefined);
    assert.equal(effectiveLimit(-1, 97), 97);
    assert.equal(effectiveLimit(10, 97), 10);
  });

  test('asks each database once, by a holder that can ask, and a failing question is silent', async () => {
    const asked: string[] = [];
    const releases = [
      holdConnections('postgres://u:p@advise.example/one', 30, async () => ({
        query: async (text: string) => {
          asked.push(text);
          return { rows: [{ role_limit: 20, usable: 90 }] };
        },
      })),
      holdConnections('postgres://u:p@advise.example/one', 5, async () => {
        throw new Error('never asked: the first holder answers');
      }),
      holdConnections('postgres://u:p@advise-down.example/two', 500, async () => {
        throw new Error('unreachable');
      }),
    ];
    const said: string[] = [];
    await adviseConnectionLimits((line) => said.push(line));
    releases.forEach((release) => release());
    assert.equal(asked.length, 1);
    assert.match(asked[0], /rolconnlimit/);
    assert.equal(said.length, 1);
    assert.match(said[0], /may open 35 connections to advise\.example:5432\/one/);
  });
});
