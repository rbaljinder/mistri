/** Live PostgreSQL proof for policy media. It owns one UUID schema and drops
 * only that schema; set TABLEWALK_TEST_ROW_PG to a disposable server URL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const LIVE = process.env.TABLEWALK_TEST_ROW_PG;
const appId = 'policy-media-live';
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const privateBytes = Buffer.from('PRIVATE_POSTGRES_MEDIA_BYTES');
const account = (id: string, role = 'reader'): Identity => ({ id, who: `${id}@example.test`, role });

interface Client {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
async function client(): Promise<Client> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    Client?: new (options: object) => Client;
    default?: { Client?: new (options: object) => Client };
  };
  const Client = pg.Client ?? pg.default?.Client;
  assert.ok(Client);
  const opened = new Client({ connectionString: LIVE, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  await opened.connect();
  return opened;
}

test(
  'live PostgreSQL policy media scopes GET and HEAD bytes, public reads, and settlement failure',
  {
    skip: !LIVE && 'Set TABLEWALK_TEST_ROW_PG to an explicitly disposable PostgreSQL server.',
    timeout: 60_000,
  },
  async () => {
    const schema = `tw_policy_media_${randomUUID().replaceAll('-', '')}`;
    const quoted = `"${schema}"`;
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-media-pg-'));
    const registry = new Registry();
    let control: Client | undefined;
    let policy: HttpAppPolicy | undefined;
    let server: Server | undefined;
    let failedServer: Server | undefined;
    let created = false;
    try {
      control = await client();
      await control.query(`CREATE SCHEMA ${quoted}`);
      created = true;
      for (const table of ['asset', 'public_asset', 'hidden_asset']) {
        await control.query(
          `CREATE TABLE ${quoted}."${table}" (id integer PRIMARY KEY, owner text NOT NULL, file_name text NOT NULL, content_type text, data bytea NOT NULL)`,
        );
        await control.query(
          `INSERT INTO ${quoted}."${table}" (id, owner, file_name, content_type, data) VALUES
        (1, 'alpha', 'photo.png', 'image/png', $1), (2, 'beta', 'private.txt', 'text/plain', $2)`,
          [bytes, privateBytes],
        );
      }
      registry.add({ id: 'media', name: 'Policy media', url: LIVE!, schemas: [schema], source: 'config', writable: false });
      const resource = (table: string) => ({
        physical: `${schema}.${table}`,
        file: { content: 'data', name: 'file_name', type: 'content_type' },
      });
      const app = parseAppConfig(
        {
          id: appId,
          name: 'Live policy media',
          sources: { media: { connection: 'media', default: true } },
          resources: { asset: resource('asset'), public_asset: resource('public_asset'), hidden_asset: resource('hidden_asset') },
          auth: {
            rows: 'policy',
            public: { read: ['public_asset'] },
            roles: {
              reader: { read: ['asset', 'public_asset'] },
              metadata: { read: ['asset'], fields: { asset: { read: ['id', 'owner', 'file_name', 'content_type'] } } },
            },
          },
          views: { assets: { kind: 'list', from: 'asset' } },
          home: 'assets',
        },
        'live policy media fixture',
      );
      const state = { identity: account('alpha') as Identity | null };
      const host: AppHost = {
        app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
        pages: [],
        auth: {
          spec: app.auth!,
          store: join(directory, 'auth.db'),
          close: async () => {},
          session: async () => state.identity,
          handler: async () => {},
        },
      };
      const policyFile = join(directory, 'policy.mjs');
      writeFileSync(
        policyFile,
        `export const state = { resolverCalls: 0 };
      export default { appId: ${JSON.stringify(appId)}, resolveRows(principal) {
        state.resolverCalls++; return {
          asset: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] }, public_asset: true, hidden_asset: false
        };
      } };`,
      );
      const module = (await import(pathToFileURL(policyFile).href)) as { state: { resolverCalls: number } };
      policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => state.identity });
      const bound = { host: '127.0.0.1', port: 0 };
      server = createApp({ registry, bound, apps: [host], policy });
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      const read = (table: string, id = 1, method = 'GET') =>
        fetch(
          `http://${bound.host}:${bound.port}/api/file?${new URLSearchParams({
            app: appId,
            table,
            key: JSON.stringify({ id }),
            inline: '1',
          })}`,
          { method, signal: AbortSignal.timeout(10_000) },
        );

      const get = await read('asset');
      assert.equal(get.status, 200);
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
      assert.equal(get.headers.get('cache-control'), 'private, no-cache');
      assert.match(get.headers.get('content-disposition')!, /^inline;/);
      const head = await read('asset', 1, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.byteLength));
      assert.equal(await head.text(), '');
      assert.equal((await read('asset', 2)).status, 404, 'the other account row is scope-hidden');
      state.identity = account('alpha', 'metadata');
      assert.notEqual((await read('asset')).status, 200, 'a field ceiling without bytes cannot form a file rule');
      state.identity = null;
      const resolverCalls = module.state.resolverCalls;
      const publicRead = await read('public_asset');
      assert.equal(publicRead.status, 200);
      assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()), bytes);
      assert.equal(module.state.resolverCalls, resolverCalls, 'the public request does not call the account row resolver');
      assert.notEqual((await read('asset')).status, 200, 'public grant does not include account media');

      const failing: HttpAppPolicy = {
        ...policy,
        withContext: (request, run) =>
          policy!.withContext(request, async (context) => {
            await run(context);
            throw new Error('PRIVATE_POLICY_MEDIA_SETTLEMENT');
          }),
      };
      failedServer = createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, apps: [host], policy: failing });
      failedServer.listen(0, '127.0.0.1');
      await once(failedServer, 'listening');
      const failedAddress = failedServer.address();
      assert.ok(failedAddress && typeof failedAddress === 'object');
      state.identity = account('alpha');
      const failed = await fetch(
        `http://127.0.0.1:${failedAddress.port}/api/file?${new URLSearchParams({ app: appId, table: 'asset', key: JSON.stringify({ id: 1 }) })}`,
      );
      assert.equal(failed.status, 500);
      assert.equal(failed.headers.get('content-disposition'), null);
      assert.doesNotMatch(await failed.text(), /PRIVATE_POLICY_MEDIA_SETTLEMENT|photo\.png|PNG/);
      failedServer.closeAllConnections();
      await new Promise<void>((resolve) => failedServer!.close(() => resolve()));
      failedServer = undefined;
    } finally {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (failedServer?.listening) {
        failedServer.closeAllConnections();
        await new Promise<void>((resolve) => failedServer!.close(() => resolve()));
      }
      await policy?.retire();
      await registry.closeAll();
      try {
        if (created) await control?.query(`DROP SCHEMA ${quoted} CASCADE`);
      } finally {
        await control?.end();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
