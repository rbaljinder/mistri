/** Opt-in, local third-party generation/typecheck; no HTTP or database. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseAppConfig } from '../packages/mistri/src/shared/app.ts';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.ts';
import { planApiReadRequest, planApiItemReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--tools')
  throw new Error('Usage: node --import tsx test/check-api-generated-client.mjs --tools <isolated npm directory>');
const tools = resolve(args[1]);
for (const [name, version] of [
  ['openapi-typescript', '7.13.0'],
  ['openapi-fetch', '0.17.0'],
]) {
  const pkg = JSON.parse(await readFile(join(tools, 'node_modules', name, 'package.json'), 'utf8'));
  assert.equal(pkg.version, version, `Use the documented pinned ${name} version`);
}
const { default: openapiTS, astToString } = await import(pathToFileURL(join(tools, 'node_modules/openapi-typescript/dist/index.mjs')).href);
const clientModule = join(tools, 'node_modules/openapi-fetch/dist/index.mjs');
const { default: createClient, serializeObjectParam, defaultPathSerializer } = await import(pathToFileURL(clientModule).href);
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const directory = await mkdtemp(join(tmpdir(), 'tablewalk-api-client-check-'));
try {
  for (const integers of ['decimal-string', 'number']) {
    const app = parseAppConfig(
      {
        id: 'directory',
        name: 'Directory',
        home: 'items',
        auth: { roles: { reader: { read: true } } },
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'], filters: ['name'], sorts: ['id'] } } },
      },
      'generated-client',
    );
    const schema = {
      label: 'Logical',
      dialect: 'sqlite',
      readAt: '',
      foreignKeys: [],
      tables: [
        {
          id: 'item',
          name: 'item',
          schema: '',
          isView: false,
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
            { name: 'private_value', type: 'TEXT', nullable: true, primaryKey: false },
          ],
        },
      ],
    };
    const document = renderApiReadOpenApi(app, schema, { integers }).document;
    // A newly added column cannot change generated API types accidentally.
    schema.tables[0].columns.push({ name: 'new_private_value', type: 'TEXT', nullable: true, primaryKey: false });
    assert.deepEqual(renderApiReadOpenApi(app, schema, { integers }).document, document);
    // Exercise the exported JSON boundary; the upstream bundler mutates its
    // input object while our renderer deliberately returns immutable metadata.
    const generated = astToString(await openapiTS(JSON.stringify(document)));
    assert.doesNotMatch(generated, /private_value/);
    const stem = integers === 'number' ? 'numeric' : 'lossless';
    await writeFile(join(directory, `${stem}.d.ts`), generated);
    const scalar = integers === 'number' ? 'number' : 'string';
    const id = integers === 'number' ? '42' : '"9007199254740993"';
    const wrong = integers === 'number' ? '"42"' : '42';
    let observed = false;
    const client = createClient({
      baseUrl: 'http://127.0.0.1/unused',
      querySerializer: { array: { style: 'form', explode: false } },
      fetch: async (request) => {
        assert.equal(observed, false);
        observed = true;
        const url = new URL(request.url);
        assert.deepEqual(url.searchParams.getAll('name'), ['A,B']);
        const plan = planApiReadRequest(app, schema, 'list:item', url.search.slice(1), { integers });
        const row = { id: integers === 'number' ? 42 : '9007199254740993', name: 'A', private_value: 'hidden' };
        return new Response(JSON.stringify(plan.envelope.encode({ items: [row], next: null })), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const reply = await client.GET('/item', { params: { query: { name: ['A', 'B'] } } });
    assert.equal(observed, true);
    assert.deepEqual(reply.data.items, [{ id: integers === 'number' ? 42 : '9007199254740993', name: 'A' }]);
    await writeFile(
      join(directory, `${stem}.mts`),
      `
import createClient from ${JSON.stringify(clientModule)};
import type { paths } from './${stem}.js';
const client = createClient<paths>({ baseUrl: 'http://127.0.0.1/unused', querySerializer: { array: { style: 'form', explode: false } }, fetch: () => { throw new Error('Typecheck only'); } });
export async function checkedClient() {
  const list = await client.GET('/item', { params: { query: { limit: 20, name: ['A'] } } });
  if (list.data) for (const row of list.data.items) {
    const key: ${scalar} = row.id;
    const name: string | undefined = row.name;
    // @ts-expect-error Hidden fields are absent, not any.
    row.private_value;
    // @ts-expect-error A sparse nonkey field is not a guaranteed string.
    const full: string = row.name;
    void key; void name; void full;
  }
  const item = await client.GET('/item/{id}', { params: { path: { id: ${id} } } });
  if (item.data) { const full: string = item.data.name; void full; }
  if (item.error) {
    const code: 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'rate_limited' | 'unavailable' = item.error.error.code;
    const message: 'The API request could not be completed.' = item.error.error.message;
    // @ts-expect-error Error bodies do not expose private diagnostics.
    item.error.error.token;
    void code; void message;
  }
  // @ts-expect-error The selected integer representation governs keys.
  await client.GET('/item/{id}', { params: { path: { id: ${wrong} } } });
  // @ts-expect-error Undeclared filters are absent.
  await client.GET('/item', { params: { query: { private_value: 'x' } } });
  // @ts-expect-error There is no generic write operation.
  await client.POST('/item', { body: { name: 'x' } });
  // @ts-expect-error Hidden resources have no client endpoint.
  await client.GET('/private');
}
`,
    );
    app.api.resources.item.fields.push('part');
    schema.tables[0].columns.push({ name: 'part', type: 'TEXT', nullable: false, primaryKey: true });
    const composite = renderApiReadOpenApi(app, schema, { integers }).document;
    const compositeTypes = astToString(await openapiTS(JSON.stringify(composite)));
    assert.doesNotMatch(compositeTypes, /private_value/);
    await writeFile(join(directory, `composite-${stem}.d.ts`), compositeTypes);
    const key = { id: integers === 'number' ? 42 : '9007199254740993', part: 'A,=/雪%' };
    let itemObserved = false;
    const compositeClient = createClient({
      baseUrl: 'http://127.0.0.1/unused',
      pathSerializer: (path, params) => path.replace('{key}', serializeObjectParam('key', params.key, { style: 'simple', explode: true })),
      fetch: async (request) => {
        itemObserved = true;
        const segment = new URL(request.url).pathname.split('/').at(-1);
        const plan = planApiItemReadRequest(app, schema, 'item:item', segment, { integers });
        assert.deepEqual({ ...plan.key }, key);
        return new Response(JSON.stringify(plan.response.encodeRow({ ...key, name: 'A', private_value: 'hidden' })), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const itemReply = await compositeClient.GET('/item/{key}', { params: { path: { key } } });
    assert.equal(itemObserved, true);
    assert.deepEqual(itemReply.data, { ...key, name: 'A' });
    // A types-only client does not read OpenAPI style/explode metadata at
    // runtime. Its default must not be mistaken for the configured proof.
    const ordinary = defaultPathSerializer('/item/{key}', { key }).slice('/item/'.length);
    assert.throws(() => planApiItemReadRequest(app, schema, 'item:item', ordinary, { integers }));
    await writeFile(
      join(directory, `composite-${stem}.mts`),
      `
import createClient, { serializeObjectParam } from ${JSON.stringify(clientModule)};
import type { paths } from './composite-${stem}.js';
const client = createClient<paths>({ baseUrl: 'http://127.0.0.1/unused',
  pathSerializer: (path, params) => path.replace('{key}', serializeObjectParam('key', params.key as Record<string, unknown>, { style: 'simple', explode: true })) });
export async function checkedCompositeClient() {
  const item = await client.GET('/item/{key}', { params: { path: { key: { id: ${id}, part: 'A,=/雪%' } } } });
  if (item.data) { const id: ${scalar} = item.data.id; const part: string = item.data.part; void id; void part; }
  // @ts-expect-error Every composite key member is required.
  await client.GET('/item/{key}', { params: { path: { key: { id: ${id} } } } });
  // @ts-expect-error A pre-encoded segment is not the object contract.
  await client.GET('/item/{key}', { params: { path: { key: 'id=42,part=x' } } });
  // @ts-expect-error Integer representation also governs composite members.
  await client.GET('/item/{key}', { params: { path: { key: { id: ${wrong}, part: 'x' } } } });
}
`,
    );
  }
  execFileSync(
    process.execPath,
    [
      compiler,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--noUncheckedIndexedAccess',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      ...['lossless', 'numeric', 'composite-lossless', 'composite-numeric'].map((stem) => join(directory, `${stem}.mts`)),
    ],
    { stdio: 'inherit' },
  );
  console.log(
    'Generated read clients typecheck for both explicit integer strategies; sparse/full rows and hidden surfaces retain their boundaries. No HTTP calls were made.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
