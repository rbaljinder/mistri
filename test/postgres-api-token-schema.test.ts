/** Real Registry/logical mapping, mocked adapter I/O: no PostgreSQL server. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { Registry, type ConnectionConfig } from '../packages/engine/src/server/connections.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { loadPostgresTokenSchema } from '../packages/mistri/src/server/cli/postgresApiTokenSchema.js';
const physical: DatabaseSchema = {
  label: 'Physical',
  dialect: 'postgres',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'people',
      name: 'people',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'name', type: 'text', primaryKey: false, nullable: false },
      ],
    },
  ],
};
function loaded(): LoadedApp {
  return {
    path: '/unused/app.ts',
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'directory',
        name: 'Directory',
        connection: 'data',
        resources: { person: { physical: 'people' } },
        auth: { roles: { reader: { read: true } } },
        views: { people: { kind: 'list', from: 'person' } },
        home: 'people',
        api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'name'] } } },
      },
      'fixture',
    ),
  };
}
const config: ConnectionConfig = { id: 'data', name: 'business', url: '${UNRESOLVED_ORIGINAL}', source: 'config', writable: true };
const target = { name: 'business', url: 'postgresql://u:$TABLEWALK_SCHEMA_NEVER_EXPAND@unused.invalid:5432/business', source: 'session' };
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL token issuance schema is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
test('captured dollar URL is added to a real Registry as already resolved and maps logical schema read-only', async (t) => {
  const previous = process.env.TABLEWALK_SCHEMA_NEVER_EXPAND;
  delete process.env.TABLEWALK_SCHEMA_NEVER_EXPAND;
  t.after(() => {
    if (previous === undefined) delete process.env.TABLEWALK_SCHEMA_NEVER_EXPAND;
    else process.env.TABLEWALK_SCHEMA_NEVER_EXPAND = previous;
  });
  let opens = 0,
    closes = 0;
  t.mock.method(PostgresAdapter.prototype, 'introspect', async () => {
    opens++;
    return physical;
  });
  t.mock.method(PostgresAdapter.prototype, 'privileges', async () => ({ superuser: false, writes: [], create: false }));
  const close = PostgresAdapter.prototype.close;
  t.mock.method(PostgresAdapter.prototype, 'close', async function (this: PostgresAdapter) {
    closes++;
    await close.call(this);
  });
  const add = Registry.prototype.add;
  let captured: { url: string; resolved: boolean; writable: boolean | undefined } | undefined;
  t.mock.method(
    Registry.prototype,
    'add',
    function (this: Registry, input: Parameters<Registry['add']>[0], options: Parameters<Registry['add']>[1]) {
      captured = { url: input.url, resolved: options?.resolved === true, writable: input.writable };
      return add.call(this, input, options);
    },
  );
  const schema = await loadPostgresTokenSchema(loaded(), [config], [target]);
  assert.deepEqual(captured, { url: target.url, resolved: true, writable: false });
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.ok(schema.tables.some((table) => table.id === 'person'));
});
test('adapter closes on catalog refusal and failed introspection; errors stay opaque', async (t) => {
  let closes = 0;
  const close = PostgresAdapter.prototype.close;
  t.mock.method(PostgresAdapter.prototype, 'close', async function (this: PostgresAdapter) {
    closes++;
    await close.call(this);
  });
  const introspect = t.mock.method(PostgresAdapter.prototype, 'introspect', async () => physical);
  t.mock.method(PostgresAdapter.prototype, 'privileges', async () => ({ superuser: false, writes: [], create: false }));
  const invalid = loaded();
  invalid.app.api!.resources.person.fields.push('missing');
  await assert.rejects(loadPostgresTokenSchema(invalid, [config], [target]), unavailable);
  assert.equal(closes, 1);
  introspect.mock.mockImplementation(async () => {
    throw new Error('PRIVATE native error');
  });
  await assert.rejects(loadPostgresTokenSchema(loaded(), [config], [target]), unavailable);
  assert.equal(closes, 2);
});
test('ambiguous name mapping, missing capture and unsupported API scope refuse before adapter acquisition', async (t) => {
  let opens = 0;
  t.mock.method(PostgresAdapter.prototype, 'introspect', async () => {
    opens++;
    throw new Error('must not acquire');
  });
  for (const targets of [
    [],
    [target, target],
    [{ ...target, source: 'config' }],
    [{ ...target, name: 'other' }],
    [{ ...target, url: 'sqlite:///business.db' }],
  ]) {
    await assert.rejects(loadPostgresTokenSchema(loaded(), [config], targets), unavailable);
  }
  await assert.rejects(loadPostgresTokenSchema(loaded(), [config, { ...config, id: 'other' }], [target]), unavailable);
  await assert.rejects(loadPostgresTokenSchema(loaded(), [config, { ...config, id: 'other', name: 'data' }], [target]), unavailable);
  const noApi = loaded();
  delete noApi.app.api;
  await assert.rejects(loadPostgresTokenSchema(noApi, [config], [target]), unavailable);
  const multiple = loaded();
  multiple.app.sources = {
    first: { connection: 'data', default: true },
    second: { connection: 'second', default: false },
  };
  await assert.rejects(loadPostgresTokenSchema(multiple, [config], [target]), unavailable);
  assert.equal(opens, 0);
});
