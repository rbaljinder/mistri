/** Explicit form admission, visitor cookie and actual-use receipt at the real host. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteTenant } from '../packages/mistri/src/server/http/suiteTenant.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';
import { captureAppFlagCatalog } from '../packages/mistri/src/server/flags/appCatalog.js';
import { normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { experimentDeclaration, experimentFlag, experimentOverride, experimentRuntimeFixture } from './support/experimentRuntimeFixture.js';

const NORTH_HOST = 'north.example.test';

for (const tenant of [false, true])
  test(`public ${tenant ? 'tenant intake' : 'ordinary'} form explicitly establishes visitor without public row grants`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-public-experiment-')),
      path = join(dir, 'business.db');
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, address TEXT); INSERT INTO dealer VALUES('north','north-intake-AAAAAAAAAAAAAAAA'); CREATE TABLE triage(id TEXT PRIMARY KEY NOT NULL, name TEXT); CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), version INTEGER NOT NULL, name TEXT)",
    );
    db.close();
    migrateSqliteCommandJournal(path);
    if (tenant) {
      provisionSqliteTenantStore(path, { appId: 'desk', source: { id: 'data', connection: 'data' }, storeId: 'store' });
      const seed = new DatabaseSync(path);
      seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('@platform','active','1','platform')`);
      seed.close();
    }
    const net = createServer();
    await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve));
    const port = (net.address() as { port: number }).port;
    await new Promise<void>((resolve) => net.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        sources: { data: { connection: 'data' } },
        flags: { copy: experimentFlag },
        experiments: { copy: { ...experimentDeclaration(), unit: 'visitor' } },
        auth: {
          store: join(dir, 'auth.db'),
          signUp: 'open',
          ...(tenant ? { rows: 'tenant', tenancy: { profile: 'dealer', platform: { label: 'Platform' } } } : {}),
          roles: {
            user: { read: true, ...(tenant ? { realm: 'tenant' } : {}) },
            ...(tenant ? { operator: { realm: 'platform', read: true } } : {}),
          },
        },
        resources: {
          item: { access: 'write', ...(tenant ? { owner: 'tenant' } : {}) },
          ...(tenant ? { dealer: { owner: 'platform' }, triage: { access: 'write', owner: 'platform' } } : {}),
        },
        views: { items: { kind: 'list', from: 'item' }, apply: { kind: 'form', label: 'Apply', public: true, command: 'submit' } },
        home: 'items',
      }),
    );
    writeFileSync(
      join(dir, 'commands.mjs'),
      `import { shape, text } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandShapes.ts', import.meta.url).href)};
    import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
    export default defineCommands({ submit: defineCommand({ source:'data', target:'item', targets:'none', public:true, input:{ name:{type:'text'} }, output:shape({reference:text()}), handle() {return {reference:'APP-123456789'};} }) });`,
    );
    const policyFile = join(dir, 'policy.mjs');
    if (tenant)
      writeFileSync(
        policyFile,
        `export default {kind:'tenant',appId:'desk',storeId:'store',intake:{address:'address'},ownership:{item:{kind:'tenant',column:'tenant_id'},dealer:{kind:'platform'},triage:{kind:'platform'}},resolveMembershipRows:()=>({item:true,dealer:true,triage:true}),resolveRows:()=>({item:true,dealer:true,triage:true}),resolvePlatformRows:()=>({item:true,dealer:true,triage:true}),resultReferences:{submit:()=>[]}};`,
      );
    const app = await loadApp(dir),
      registry = new Registry();
    registry.add({ id: 'data', name: 'data', url: path, writable: true, source: 'config' });
    const catalog = captureAppFlagCatalog(app.app).catalog,
      experiment = await experimentRuntimeFixture(app.app, tenant ? 'north' : null, true);
    const scope = { appId: 'desk', environment: 'production', tenantId: null };
    const suite = await createSuite(
      [
        {
          id: 'desk',
          ...(tenant ? { public: true } : {}),
          async open(basePath, { allowedHosts }) {
            const host = tenant
              ? await openSuiteTenant({
                  app,
                  allowedHosts,
                  connections: [{ id: 'data', name: 'data', url: path, source: 'config', writable: true }],
                  policyFile,
                  basePath,
                  publicURL: origin,
                  port,
                  environment: { BETTER_AUTH_SECRET: 'public-experiment-secret-at-least-thirty-two-characters' },
                })
              : await openSuiteApp({
                  app,
                  registry,
                  basePath,
                  publicURL: origin,
                  bound: { host: '127.0.0.1', port },
                  environment: { BETTER_AUTH_SECRET: 'public-experiment-secret-at-least-thirty-two-characters' },
                });
            host.attachFlagRuntime!({
              ...scope,
              catalog,
              experiments: experiment.port,
              async readRequestScopes(selected) {
                return {
                  global: normalizeFlagSnapshot({ ...scope, revision: 1, overrides: tenant ? {} : { copy: experimentOverride } }, catalog),
                  tenant: selected.tenantId
                    ? normalizeFlagSnapshot({ ...selected, revision: 1, overrides: { copy: experimentOverride } }, catalog)
                    : null,
                };
              },
            });
            return host;
          },
        },
      ],
      { mounts: { desk: '/desk' }, ...(tenant ? { hosts: [{ host: NORTH_HOST, app: 'desk', tenant: 'north' }] } : {}) },
    );
    t.after(async () => {
      await suite.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => suite.server.listen(port, '127.0.0.1', resolve));
    await suite.start();
    let cookie = '';
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(origin + '/desk' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'x-mistri-experiment-form': 'apply',
          ...(tenant ? { 'x-mistri-experiment-address': 'north-intake-AAAAAAAAAAAAAAAA' } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, body: (await response.json()) as Record<string, any> };
    };
    const passive = await call('/api/flags/evaluate?app=desk');
    assert.equal(passive.response.status, 200);
    assert.equal(passive.body.assignmentReceipts, undefined);
    assert.equal(passive.response.headers.has('set-cookie'), false);
    assert.equal(experiment.obligations.size, 0);
    const refused = await call('/api/experiments/visitor', {}, { 'x-mistri-visitor': 'establish', 'x-mistri-experiment-form': 'items' });
    assert.equal(refused.response.status, 403);
    assert.equal(refused.response.headers.has('set-cookie'), false);
    const started = await call('/api/experiments/visitor', {}, { 'x-mistri-visitor': 'establish' });
    assert.equal(started.response.status, 200, JSON.stringify(started.body));
    cookie = started.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.ok(cookie);
    assert.ok(experiment.port.visitors!.read({ headers: { cookie } } as import('node:http').IncomingMessage), 'issued cookie is readable');
    const values = await call('/api/flags/evaluate?app=desk');
    assert.equal(values.response.status, 200);
    assert.equal(typeof values.body.assignmentReceipts?.copy, 'string', JSON.stringify(values.body));
    assert.equal(experiment.exposures.size, 0);
    assert.equal(experiment.obligations.size, 1);
    const consumed = await call(
      '/api/experiments/exposures?app=desk',
      { receipts: [values.body.assignmentReceipts.copy] },
      { 'x-mistri-app': 'desk' },
    );
    assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
    assert.deepEqual(consumed.body.outcomes, ['recorded']);
    assert.equal([...experiment.exposures.values()][0].unit.kind, 'visitor');
    if (tenant) {
      assert.equal(values.response.headers.has('x-mistri-tenant'), false);
      for (const selector of ['north', 'unknown']) {
        assert.equal((await call(`/api/flags/evaluate?app=desk&tenant=${selector}`)).response.status, 400);
      }
      const moved = await call(
        '/api/experiments/exposures?app=desk',
        { receipts: [values.body.assignmentReceipts.copy] },
        { 'x-mistri-app': 'desk', 'x-mistri-experiment-address': 'unknown-intake-AAAAAAAAAAAAAAAA' },
      );
      assert.ok(
        moved.response.status !== 200 || moved.body.outcomes.every((value: string) => value !== 'recorded' && value !== 'duplicate'),
      );
      assert.equal(experiment.exposures.size, 1);
      /* North's mapped host places the page's flags by north's own intake address, as it places the form; an address
         there too would name a second tenant, and is refused whichever tenant it names. */
      const mapped = (headers: Record<string, string> = {}) =>
        new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
          const host = `${NORTH_HOST}:${port}`;
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path: '/desk/api/flags/evaluate?app=desk',
              headers: { host, origin: `http://${host}`, cookie, 'x-mistri-experiment-form': 'apply', ...headers },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
              });
            },
          );
          req.on('error', reject);
          req.end();
        });
      const placed = await mapped();
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      assert.equal(typeof placed.body.assignmentReceipts?.copy, 'string', 'placed with north, whose flags carry the experiment');
      for (const address of ['north-intake-AAAAAAAAAAAAAAAA', 'unknown-intake-AAAAAAAAAAAAAAAA']) {
        assert.equal((await mapped({ 'x-mistri-experiment-address': address })).status, 400, address);
      }
    }

    assert.equal((await call('/api/flags/evaluate?app=desk', undefined, { 'x-mistri-account': 'forged' })).response.status, 403);
  });
