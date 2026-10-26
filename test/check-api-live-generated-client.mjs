/** Opt-in real SQLite/native-auth/loopback generated-client integration.
 * Run sequentially with fixture suites. Never installs dependencies itself. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseAppConfig } from '../packages/mistri/src/shared/app.ts';
import { Registry } from '../packages/engine/src/server/connections.ts';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.ts';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.ts';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.ts';
import { issueSqliteApiToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.ts';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.ts';
import { createApp, apiReadLifetimes } from '../packages/mistri/src/server/http/server.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--tools')
  throw new Error('Usage: node --import tsx test/check-api-live-generated-client.mjs --tools <isolated npm directory>');
const tools = resolve(args[1]);
for (const [name, version] of [
  ['openapi-typescript', '7.13.0'],
  ['openapi-fetch', '0.17.0'],
]) {
  assert.equal(JSON.parse(await readFile(join(tools, 'node_modules', name, 'package.json'), 'utf8')).version, version);
}
const { default: openapiTS, astToString } = await import(pathToFileURL(join(tools, 'node_modules/openapi-typescript/dist/index.mjs')).href);
const clientModule = join(tools, 'node_modules/openapi-fetch/dist/index.mjs');
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const directory = await mkdtemp(join(tmpdir(), 'tablewalk-api-live-client-'));
const storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
try {
  for (const integers of ['decimal-string', 'number']) {
    const file = join(directory, `${integers}.db`),
      authFile = join(directory, `${integers}-auth.db`);
    const ids = integers === 'number' ? [1, 2, 3] : ['9007199254740993', '9007199254740994', '9007199254740995'];
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL, hidden TEXT)');
      for (const [index, id] of ids.entries()) db.prepare('INSERT INTO item VALUES(?,?,?)').run(BigInt(id), `Row ${index}`, 'never public');
    } finally {
      db.close();
    }
    const app = parseAppConfig(
      {
        id: 'directory',
        name: 'Directory',
        connection: 'data',
        home: 'items',
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        auth: { store: authFile, roles: { reader: { read: true } } },
        api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } },
      },
      'live-generated-client',
    );
    const loaded = { app, path: join(directory, 'app.json'), dir: directory, pages: [], sources: {} };
    const registry = new Registry();
    registry.add({ id: 'data', name: 'data', url: file, source: 'config' });
    let auth, server;
    const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'];
    const saved = names.map((name) => [name, process.env[name]]);
    try {
      process.env.BETTER_AUTH_SECRET = 'synthetic-live-client-secret-at-least-thirty-two-characters';
      delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
      delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      try {
        auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      const native = new DatabaseSync(authFile);
      try {
        native
          .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
          .run('account', 'Account', 'account@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'reader');
      } finally {
        native.close();
      }
      provisionSqliteApiTokenStore(authFile, { appId: app.id, storeId, exclusions: [] });
      const { schema } = await loadAppRuntimeResources(registry, app, 'data');
      const document = renderApiReadOpenApi(app, schema, { integers }).document;
      const generated = astToString(await openapiTS(JSON.stringify(document)));
      assert.doesNotMatch(generated, /hidden/);
      await writeFile(join(directory, 'schema.d.ts'), generated);
      const source = `import createClient from ${JSON.stringify(clientModule)};
import type { paths } from './schema.js';
export function client(baseUrl: string, token?: string) {
  return createClient<paths>({ baseUrl, headers: token ? { Authorization: 'Bearer ' + token } : {} });
}
export async function page(baseUrl: string, token: string, cursor?: string) {
  const response = await client(baseUrl, token).GET('/item', { params: { query: { limit: 2, sort: 'id', ...(cursor ? { cursor } : {}) } } });
  if (response.data) for (const row of response.data.items) {
    const key: ${integers === 'number' ? 'number' : 'string'} = row.id;
    // @ts-expect-error Hidden fields are absent from generated wire types.
    row.hidden;
    void key;
  }
  if (response.error) {
    const code: string = response.error.error.code;
    // @ts-expect-error Sanitized errors do not expose SQL diagnostics.
    response.error.sql;
    void code;
  }
  return response;
}
export function item(baseUrl: string, token: string, id: ${integers === 'number' ? 'number' : 'string'}) {
  return client(baseUrl, token).GET('/item/{id}', { params: { path: { id } } });
}
`;
      const moduleFile = join(directory, `${integers}.mts`);
      await writeFile(moduleFile, source);
      execFileSync(
        process.execPath,
        [
          compiler,
          '--noEmit',
          '--ignoreConfig',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          moduleFile,
        ],
        { stdio: 'inherit' },
      );
      const generatedClient = await import(pathToFileURL(moduleFile).href);
      const token = issueSqliteApiToken(
        authFile,
        app,
        schema,
        {
          storeId,
          exclusions: [],
          subjectId: 'account',
          actorId: 'account',
          roles: ['reader'],
          label: 'Generated client',
          expiresAt: Date.now() + 60000,
        },
        Date.now(),
      );
      const bound = { host: '127.0.0.1', port: 0 };
      server = createApp({ registry, apps: [{ app: loaded, auth, pages: [] }], bound, apiReads: { integers, requestsPerMinute: 100 } });
      await new Promise((resolve) => server.listen(0, bound.host, resolve));
      bound.port = server.address().port;
      const base = `http://127.0.0.1:${bound.port}/api/apps/directory/v1`;
      const first = await generatedClient.page(base, token.token);
      assert.equal(first.response.status, 200);
      assert.equal(first.data.items.length, 2);
      assert.equal(typeof first.data.next, 'string');
      const second = await generatedClient.page(base, token.token, first.data.next);
      assert.equal(second.response.status, 200);
      assert.equal(second.data.next, null);
      assert.deepEqual(
        [...first.data.items, ...second.data.items].map((row) => row.id),
        ids,
      );
      assert.deepEqual((await generatedClient.item(base, token.token, ids[0])).data, { id: ids[0], name: 'Row 0' });
      const missing = await generatedClient.item(base, token.token, integers === 'number' ? 99 : '99');
      assert.equal(missing.response.status, 404);
      assert.equal(missing.error.error.code, 'not_found');
      const anonymous = await generatedClient.client(base).GET('/item');
      assert.equal(anonymous.response.status, 401);
      assert.equal(anonymous.error.error.code, 'unauthenticated');
      revokeSqliteApiToken(
        authFile,
        { appId: app.id, storeId, exclusions: [], tokenId: token.tokenId, expectedVersion: '1', actorId: 'account' },
        Date.now(),
      );
      assert.equal((await generatedClient.page(base, token.token)).response.status, 401);
      console.log(`${integers}: generated/typechecked client passed real loopback pagination, item, 404, bearer and revocation checks`);
    } finally {
      if (server) {
        await apiReadLifetimes.get(server)?.retire();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await registry.closeAll();
      auth?.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
