/** The check rules for an API's generic writes (`expose(fields, { create,
 * update, delete })`) and its feed events (`api.events`): each misuse is
 * refused with the code `mistri check` reports, before anything serves.
 * The served behaviour is app-api-writes-events.test.ts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiWriteProblems, withApiWrites } from '../packages/mistri/src/server/api/apiGenericWrites.js';
import {
  apiEventProblems,
  eventFeedAudience,
  parseEventFeedQuery,
  encodeEventCursor,
} from '../packages/mistri/src/server/api/apiEventFeed.js';
import { renderApiAsyncApi } from '../packages/mistri/src/server/api/apiAsyncApi.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: name === 'id' || name === 'revision' ? 'INTEGER' : 'TEXT',
  primaryKey: name === 'id',
  nullable: name === 'note',
  ...extra,
});
const schema: DatabaseSchema = {
  label: 'Logical',
  dialect: 'sqlite',
  readAt: '2000-01-01',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: ['id', 'revision', 'name', 'note', 'code'].map((name) => column(name, name === 'revision' ? { default: '0' } : {})),
    },
    { id: 'audit', name: 'audit', schema: '', isView: false, columns: ['id', 'line'].map((name) => column(name)) },
  ],
};

function app(api: Record<string, unknown>, extra: Record<string, unknown> = {}): AppDef {
  return parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { business: { connection: 'data', default: true } },
      resources: { item: { access: 'write' }, audit: {} },
      auth: { roles: { clerk: { read: true, write: ['item'] }, viewer: { read: true, write: false } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['clerk', 'viewer'], ...api },
      ...extra,
    },
    'fixture',
  );
}
/** The same App as if its rows were a tenant's: all these rules read is `auth.rows`. */
const tenant = (definition: AppDef): AppDef => ({ ...definition, auth: { ...definition.auth!, rows: 'tenant' } });
const codes = (problems: readonly string[]) => problems.map((problem) => /\[([a-z-]+)\]/.exec(problem)?.[1]);

test("a write flag is true or absent, and an event name is a dotted name that is not an effect's", () => {
  assert.throws(() => app({ resources: { item: { fields: ['id', 'name'], create: false } } }), /create/);
  assert.throws(() => app({ resources: { item: { fields: ['id', 'name'], remove: true } } }), /remove/);
  assert.throws(() => app({ resources: { item: { fields: ['id'] } }, events: ['shipped'] }), /event name/);
  assert.throws(() => app({ resources: { item: { fields: ['id'] } }, events: ['effect.notify'] }), /event/);
  assert.throws(() => app({ resources: { item: { fields: ['id'] } }, events: ['item.made', 'item.made'] }), /duplicate/);
});

test('generic writes: each misuse has its code', () => {
  const ok = app({ resources: { item: { fields: ['id', 'revision', 'name', 'note', 'code'], create: true, update: true } } });
  assert.deepEqual(apiWriteProblems(ok, schema), []);
  // A field that is not a column; a create that cannot fill a required column.
  assert.deepEqual(codes(apiWriteProblems(app({ resources: { item: { fields: ['id', 'name', 'note'], create: true } } }), schema)), [
    'api-write-field',
  ]);
  // Delete needs the App's own resources.item.delete.
  assert.ok(
    codes(apiWriteProblems(app({ resources: { item: { fields: ['id', 'name', 'code'], delete: true } } }), schema)).includes(
      'api-write-unsupported',
    ),
  );
  // A resource no API role writes.
  assert.deepEqual(codes(apiWriteProblems(app({ resources: { audit: { fields: ['id', 'line'], update: true } } }), schema)), [
    'api-write-unsupported',
  ]);
  // A tenant App's rows are not every role's: writes serve an App whose roles read all rows.
  assert.ok(
    codes(apiWriteProblems(tenant(app({ resources: { item: { fields: ['id', 'name', 'code'], update: true } } })), schema)).includes(
      'api-write-unsupported',
    ),
  );
  // A command the App already declares under the write's name.
  const taken = defineCommands({ 'update-item': defineCommand({ source: 'business', target: 'item', input: {}, async handle() {} }) });
  assert.deepEqual(codes(apiWriteProblems(app({ resources: { item: { fields: ['id', 'name'], update: true } } }), schema, taken)), [
    'api-write-name-taken',
  ]);
  // Without a commands module the platform's commands are the whole registry.
  assert.deepEqual(
    Object.keys(withApiWrites(app({ resources: { item: { fields: ['id', 'name'], update: true } } }), schema, undefined).registry!),
    ['update-item'],
  );
  assert.deepEqual(Object.keys(defineCommands({})), []);
});

test('generic writes serve an App bound by connection as they serve one bound by sources', () => {
  const exposure = { resources: { item: { fields: ['id', 'name', 'note', 'code'], create: true, update: true } } };
  const sourced = app(exposure);
  const root = {
    id: 'shop',
    name: 'Shop',
    resources: { item: { access: 'write' }, audit: {} },
    auth: { roles: { clerk: { read: true, write: ['item'] }, viewer: { read: true, write: false } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    api: { version: 1, roles: ['clerk', 'viewer'], ...exposure },
  };
  // `connection: 'business'` is the App's one source, named for its connection.
  const bound = parseAppConfig({ ...root, connection: 'business' }, 'fixture');
  assert.deepEqual(bound.sources, { business: { connection: 'business', default: true } });
  // The whole App, so every layer after the parser — commands, the journal, the API owners — serves the two alike.
  assert.deepEqual(bound, parseAppConfig({ ...root, sources: { business: { connection: 'business', default: true } } }, 'fixture'));
  assert.deepEqual(apiWriteProblems(bound, schema), apiWriteProblems(sourced, schema));
  const ids = (definition: AppDef) => Object.keys(withApiWrites(definition, schema, unrelated).registry!).sort();
  assert.deepEqual(ids(bound), ids(sourced));
  // A connection whose name a source cannot have is told so, and what to write instead.
  const unnamed = parseAppConfig({ ...root, connection: 'shop-data' }, 'fixture');
  const [problem] = apiWriteProblems(unnamed, schema);
  assert.match(
    problem,
    /connection "shop-data" is not a name a source can have \[api-write-unsupported\]\. Name it: sources: \{ main: \{ connection: "shop-data", default: true \} \}/,
  );
});

const unrelated = defineCommands({ touch: defineCommand({ source: 'business', target: 'audit', input: {}, async handle() {} }) });

test('generic writes join the API as commands on the existing routes, with the fields as their input', () => {
  const served = withApiWrites(
    app({ resources: { item: { fields: ['id', 'name', 'note', 'code'], create: true, update: true } } }),
    schema,
    unrelated,
  );
  assert.deepEqual(Object.keys(served.registry!).sort(), ['create-item', 'touch', 'update-item']);
  assert.deepEqual(served.app.api!.commands.map((entry) => entry.command.id).sort(), ['create-item', 'update-item']);
  // Idempotent: the same App and schema serve the same command instances.
  const again = withApiWrites(
    app({ resources: { item: { fields: ['id', 'name', 'note', 'code'], create: true, update: true } } }),
    schema,
    unrelated,
  );
  assert.equal(again.registry!['update-item'], served.registry!['update-item']);
});

const shipped = defineEvent('item.shipped', shape({ id: int(), code: text() }));
const commands = defineCommands({
  ship: defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    output: shape({ id: int(), code: text() }),
    events: { shipped: defineEventProjection(shipped, (output: { id: number; code: string }) => output) },
    async handle({ record }) {
      return { id: Number(record.id), code: String(record.code) };
    },
  }),
});

test('feed events: each misuse has its code', () => {
  assert.deepEqual(apiEventProblems(app({ resources: { item: { fields: ['id'] } }, events: ['item.shipped'] }), commands), []);
  assert.deepEqual(codes(apiEventProblems(app({ resources: { item: { fields: ['id'] } }, events: ['item.lost'] }), commands)), [
    'api-event-unknown',
  ]);
  assert.deepEqual(codes(apiEventProblems(tenant(app({ resources: { item: { fields: ['id'] } }, events: ['item.shipped'] })), commands)), [
    'api-event-unsupported',
  ]);
  // A row-policy App's commands emit events for the server's own consumers; the feed would serve them to every token.
  const policy = app({ resources: { item: { fields: ['id'] } }, events: ['item.shipped'] });
  assert.deepEqual(codes(apiEventProblems({ ...policy, auth: { ...policy.auth!, rows: 'policy' } }, commands)), ['policy-events-feed']);
});

test('the feed says no more of a record than a role reads of it: a field-restricted role reads an event only when it reads every payload field', () => {
  const shop = app(
    { resources: { item: { fields: ['id'] } }, events: ['item.shipped'] },
    {
      auth: {
        roles: {
          clerk: { read: true, write: ['item'] },
          viewer: { read: ['item'], write: false, fields: { item: { read: ['id', 'name'] } } },
        },
      },
    },
  );
  const envelope = (payload: object) => ({
    eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'item.shipped',
    scope: 'app',
    appId: 'shop',
    storeId: 'app:shop',
    resource: 'item',
    key: { id: 1 },
    occurredAt: '2026-10-03T00:00:00.000Z',
    payloadJson: JSON.stringify(payload),
  });
  const sees = (roles: string[], payload: object) =>
    eventFeedAudience(shop, schema, { operations: ['event:item.shipped'], roles })(envelope(payload));
  assert.equal(sees(['clerk'], { id: 1, code: 'X-1' }), true, 'a role that reads the whole record reads its events');
  assert.equal(sees(['viewer'], { id: 1, name: 'Bolt' }), true, 'every payload field is a column the role reads');
  assert.equal(sees(['viewer'], { id: 1, code: 'X-1' }), false, 'code is a column the viewer never reads');
  assert.equal(sees(['viewer'], { id: 1, total: 5 }), false, "a payload field that is no column is not the viewer's to read");
});

test('the feed takes after and limit and nothing else; a cursor is opaque and checked', () => {
  const cursor = encodeEventCursor('0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.deepEqual(parseEventFeedQuery(`after=${cursor}&limit=5`), { after: '0f8fad5b-d9cb-469f-a165-70867728950e', limit: 5 });
  assert.deepEqual(parseEventFeedQuery(''), { limit: 50 });
  for (const query of ['limit=0', 'limit=201', 'limit=1&limit=2', 'after=x', `after=${cursor}x`, 'since=1', 'cursor=a'])
    assert.throws(() => parseEventFeedQuery(query), /API item read/, query);
});

test('AsyncAPI 3: the feed, the webhooks and the inbound endpoints, structurally sound', () => {
  const definition = app({ resources: { item: { fields: ['id'] } }, events: ['item.shipped'] });
  const document = renderApiAsyncApi(definition, commands, { integers: 'decimal-string' }) as Record<string, any>;
  assert.equal(document.asyncapi, '3.0.0');
  assert.equal(document.info.version, '1');
  assert.equal(document.channels.events.address, '/api/apps/shop/v1/$events');
  assert.equal(document.operations.publishEvents.action, 'send');
  // Every $ref resolves inside the document, and every operation names a channel it has.
  const resolve = (ref: string) =>
    ref
      .slice(2)
      .split('/')
      .reduce((node: any, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], document);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') assert.ok(resolve(value as string) !== undefined, value as string);
      else walk(value);
    }
  };
  walk(document);
  for (const operation of Object.values(document.operations) as any[]) assert.ok(['send', 'receive'].includes(operation.action));
  assert.deepEqual(document.components.schemas['EventPayload_item.shipped'].required, ['id', 'code']);
  // An inbound endpoint is a channel the App receives on, with its signature headers.
  const inbound = new Map([
    [
      'carrier-update',
      {
        name: 'carrier-update',
        runAs: 'clerk',
        command: { id: 'ship', version: 1 },
        verify: {
          secretEnv: 'CARRIER_SECRET',
          algorithm: 'sha256',
          signatureHeader: 'x-signature',
          encoding: 'hex',
          prefix: 'sha256=',
          timestampHeader: 'x-timestamp',
          windowMs: 300000,
          signed: 'timestamp-body',
        },
      },
    ],
  ]) as never;
  const whole = renderApiAsyncApi(definition, commands, { integers: 'number', inbound }) as Record<string, any>;
  assert.equal(whole.channels['inbound.carrier-update'].address, '/api/inbound/carrier-update');
  assert.equal(whole.operations['receive.carrier-update'].action, 'receive');
  assert.deepEqual(whole.components.messages['inbound.carrier-update'].headers.required, ['x-signature', 'x-timestamp']);
  // A token's document names only the events it holds.
  const narrowed = renderApiAsyncApi(definition, commands, { integers: 'number', scope: ['item:item'] }) as Record<string, any>;
  assert.deepEqual(narrowed.channels, {});
});

test("an App whose only commands are its API's generic writes loads without a commands module", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadApp } = await import('../packages/mistri/src/server/app/apps.js');
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-crud-'));
  try {
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'shop',
        name: 'Shop',
        connection: 'data',
        resources: { item: { access: 'write' } },
        auth: { roles: { clerk: { read: true, write: ['item'] } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        api: { version: 1, roles: ['clerk'], resources: { item: { fields: ['id', 'name'], create: true } } },
      }),
    );
    const loaded = await loadApp(dir);
    assert.deepEqual(Object.keys(loaded.commands!.registry), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
