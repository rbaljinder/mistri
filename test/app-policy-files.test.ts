/** File bytes are policy reads: resource, field and row authority still apply,
 * and neither bytes nor metadata leave before the policy invocation settles. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const otherBytes = Buffer.from('PRIVATE_OTHER_ACCOUNT_BYTES');
const appId = 'policy-files';
const account = (id: string, role = 'reader'): Identity => ({ id, who: `${id}@example.test`, role });

async function fixture(t: TestContext, failAfterRead = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-files-'));
  const file = join(directory, 'files.db');
  const db = new DatabaseSync(file);
  for (const table of ['asset', 'public_asset', 'hidden_asset']) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, owner TEXT, file_name TEXT, content_type TEXT, data BLOB)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`);
    insert.run(1, 'alpha', 'photo.png', 'image/png', bytes);
    insert.run(2, 'beta', 'private.txt', 'text/plain', otherBytes);
  }
  db.close();
  const registry = new Registry();
  registry.add({ id: 'files', name: 'Files', url: file, source: 'config', writable: false });
  const opened = await registry.open('files');
  const resource = { file: { content: 'data', name: 'file_name', type: 'content_type' } };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Policy files',
      sources: { files: { connection: 'files', default: true } },
      resources: { asset: resource, public_asset: resource, hidden_asset: resource },
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
    'policy files fixture',
  );
  const control = { identity: account('alpha') as Identity | null, ordinaryQueries: 0, scopedReads: 0 };
  const scopeReads = opened.adapter.scopeReads!.bind(opened.adapter);
  opened.adapter.query = async () => {
    control.ordinaryQueries++;
    throw new Error('Policy file reads must use the scoped adapter.');
  };
  opened.adapter.scopeReads = async (scope) => {
    control.scopedReads++;
    return scopeReads(scope);
  };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export const state = { resolverCalls: 0 };
  export default {
    appId: '${appId}',
    resolveRows(principal) { state.resolverCalls++; return {
      asset: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] },
      public_asset: true, hidden_asset: false
    }; }
  };`,
  );
  const { state } = (await import(pathToFileURL(policyFile).href)) as { state: { resolverCalls: number } };
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  const served: HttpAppPolicy = failAfterRead
    ? {
        ...policy,
        withContext: (request, run) =>
          policy.withContext(request, async (context) => {
            await run(context);
            throw new Error('PRIVATE_SETTLEMENT_FAILURE');
          }),
      }
    : policy;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy: served, pages: [] });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const read = (table: string, id = 1, method = 'GET', headers: Record<string, string> = {}) =>
    fetch(
      `${base}/api/file?${new URLSearchParams({
        app: appId,
        table,
        key: JSON.stringify({ id }),
        inline: '1',
      })}`,
      { method, headers, signal: AbortSignal.timeout(5000) },
    );
  return { control, state, read, base };
}

test('policy file GET and HEAD preserve bytes and headers, kept only to be asked about again', async (t) => {
  const { control, read } = await fixture(t);
  const response = await read('asset');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.match(response.headers.get('etag')!, /^"[\w-]{27}"$/);
  assert.match(response.headers.get('content-disposition')!, /^inline;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const head = await read('asset', 1, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), '');
  assert.equal(control.ordinaryQueries, 0);
  assert.equal(control.scopedReads, 2);
});

test('file reads reauthorize the account, row, resource and content field on every request', async (t) => {
  const { control, read } = await fixture(t);
  for (const id of [2, 99]) {
    const response = await read('asset', id);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /PRIVATE_OTHER|private.txt/);
  }
  /* A browser's copy is revalidated, and a revalidation is a read: its tag
     buys a 304 only where the read would have answered with those bytes. */
  const tag = (await read('asset')).headers.get('etag')!;
  assert.equal((await read('asset', 1, 'GET', { 'if-none-match': tag })).status, 304);
  control.identity = account('beta');
  assert.equal((await read('asset', 1, 'GET', { 'if-none-match': tag })).status, 404, 'a kept copy is asked about as the reader it is now');
  control.identity = account('alpha');
  const hidden = await read('hidden_asset');
  assert.notEqual(hidden.status, 200);
  assert.doesNotMatch(await hidden.text(), /PRIVATE_OTHER|photo.png/);
  control.identity = account('alpha', 'metadata');
  const denied = await read('asset');
  assert.notEqual(denied.status, 200);
  assert.doesNotMatch(await denied.text(), /photo.png|PNG/);
  control.identity = account('beta');
  assert.equal((await read('asset')).status, 404);
  const own = await read('asset', 2);
  assert.equal(own.status, 200);
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), otherBytes);
  assert.equal(control.ordinaryQueries, 0);
  assert.ok(control.scopedReads >= 4);
});

test('public policy media uses only the public grant, and a reader who may not insert cannot upload', async (t) => {
  const { control, state, read, base } = await fixture(t);
  control.identity = null;
  const response = await read('public_asset');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(state.resolverCalls, 0);
  assert.equal(control.ordinaryQueries, 0);
  assert.equal(control.scopedReads, 1);
  const metadata = await fetch(`${base}/api/app?app=${appId}`).then((response) => response.json());
  // Who may add a file is the catalog's insertable, judged by the policy (app-policy-file-uploads.test.ts).
  assert.equal(metadata.app.resources.public_asset.file.upload, undefined);
  assert.notEqual((await read('asset')).status, 200);
  control.identity = account('alpha');
  const upload = await fetch(`${base}/api/file/upload?app=${appId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: appId }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(upload.status, 403);
});

test('failed policy settlement discards file bytes and file-specific headers', async (t) => {
  const { control, read } = await fixture(t, true);
  for (const method of ['GET', 'HEAD']) {
    const response = await read('asset', 1, method);
    assert.equal(response.status, 500);
    assert.match(response.headers.get('content-type')!, /^application\/json/);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PNG|photo.png|PRIVATE_SETTLEMENT/);
  }
  assert.equal(control.ordinaryQueries, 0);
});
