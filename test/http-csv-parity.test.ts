import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { draftDescription, readDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { parseApiListParams } from '../packages/mistri/src/server/api/apiListParams.js';

function fixture() {
  const app = parseAppConfig(
    {
      id: 'directory',
      name: 'Directory',
      resources: { person: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person' } },
      api: {
        version: 1,
        roles: ['reader'],
        resources: { person: { fields: ['id', 'name', 'score'], filters: ['name', 'score'], sorts: ['name'] } },
      },
    },
    'csv',
  );
  const schema: DatabaseSchema = {
    label: 'Logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'person',
        name: 'person',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'score', type: 'REAL', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const document = renderApiReadOpenApi(app, schema, { integers: 'number' }).document;
  const description = readDescription(draftDescription(readOpenApi(document)), 'csv');
  const adapter = new HttpAdapter({ base: new URL('https://example.invalid/'), description, label: 'CSV', policy: DEFAULT_POLICY });
  const seen: URLSearchParams[] = [];
  // Observe the request boundary without network or database fixtures.
  Object.defineProperty(adapter, 'request', {
    value: async (_path: string, query: URLSearchParams) => {
      seen.push(new URLSearchParams(query));
      return { status: 200, json: { items: [], next: null } };
    },
  });
  return { adapter, seen, description, document, metadata: { ...app.api!.resources.person, primaryKey: ['id'] } };
}

test('actual exported CSV arrays survive description capture and both request paths', async () => {
  const { adapter, seen, description, metadata } = fixture();
  assert.equal(description.resources[0].filters.name.serialization, 'csv');
  assert.deepEqual(description.resources[0].filters.score.ops, ['=', 'in']);
  assert.deepEqual(description.resources[0].sort, { param: 'sort', values: ['name', '-name'] });
  await adapter.query({
    table: 'person',
    limit: 10,
    offset: 0,
    filter: { groups: [[{ column: 'name', op: 'in', value: ['A&B', '日本語'] }]] },
    orderBy: [{ column: 'name', direction: 'desc' }],
  });
  assert.deepEqual(seen[0].getAll('name'), ['A&B,日本語']);
  assert.equal(seen[0].get('sort'), '-name');
  assert.doesNotThrow(() => parseApiListParams(seen[0].toString(), metadata));
  await adapter.operation('person', 'list', { name: 'A&B,日本語', score: '1.25,2.5' });
  assert.deepEqual(seen[1].getAll('score'), ['1.25,2.5']);
  assert.doesNotThrow(() => parseApiListParams(seen[1].toString(), metadata));
});

test('CSV refuses unrepresentable members before I/O and repeated mode remains unchanged', async () => {
  const { adapter, seen, description } = fixture();
  for (const value of [[], [''], [' '], ['a,b'], ['a..b'], ['\u0000'], ['\ud800'], [null], [1e-7], [Infinity]]) {
    await assert.rejects(
      adapter.query({ table: 'person', limit: 10, offset: 0, filter: { groups: [[{ column: 'name', op: 'in', value: value as never }]] } }),
      /CSV/,
    );
  }
  for (const name of ['', ' ', 'a,,b', 'a, ', 'a..b']) await assert.rejects(adapter.operation('person', 'list', { name }), /CSV/);
  assert.equal(seen.length, 0);
  delete description.resources[0].filters.name.serialization;
  await adapter.query({ table: 'person', limit: 10, offset: 0, filter: { groups: [[{ column: 'name', op: 'in', value: ['a', 'b'] }]] } });
  assert.deepEqual(seen[0].getAll('name'), ['a', 'b']);
  const malformed = structuredClone(description);
  Object.assign(malformed.resources[0].filters.name, { serialization: 'pipe' });
  assert.throws(() => readDescription(malformed, 'csv'), /serialization/);
});

test('sort metadata does not override a different documented pattern', () => {
  const { document } = fixture();
  const changed = structuredClone(document);
  const path = changed.paths['/person'] as { get: { parameters: Array<{ name: string; schema: { pattern?: string } }> } };
  path.get.parameters.find((parameter) => parameter.name === 'sort')!.schema.pattern = '^different$';
  assert.equal(readOpenApi(changed).resources[0].sort, undefined);
});
