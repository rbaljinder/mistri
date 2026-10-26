import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { compareApiReadSpecs } from '../packages/mistri/src/server/api/apiReadSpecCompare.js';

function fixture() {
  const app = parseAppConfig(
    {
      id: 'compare',
      name: 'Compare',
      resources: { item: {} },
      auth: { roles: { reader: { read: true }, other: { read: true } } },
      home: 'items',
      views: { items: { kind: 'list', from: 'item' } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'], filters: ['name'] } } },
    },
    'test',
  );
  const schema: DatabaseSchema = {
    label: '',
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
          { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
          { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
          { name: 'extra', type: 'TEXT', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  return { app, schema, render: () => renderApiReadOpenApi(app, schema, { integers: 'decimal-string' }).document };
}

test('older 200-only documents remain comparable and new error envelopes are checked exactly', () => {
  const current = fixture().render();
  const previous = JSON.parse(JSON.stringify(current));
  for (const path of Object.values(previous.paths) as any[]) {
    path.get.responses = { 200: path.get.responses['200'] };
  }
  assert.ok(compareApiReadSpecs(previous, current).findings.length > 0);
  assert.deepEqual(compareApiReadSpecs(previous, previous).findings, []);
  for (const mutate of [
    (responses: any) => {
      responses['401'].content['application/json'].schema.properties.error.properties.code.const = 'forbidden';
    },
    (responses: any) => {
      responses['404'].content['application/json'].schema.additionalProperties = true;
    },
    (responses: any) => {
      responses['429'].content['application/json'].schema.properties.error.required = ['code'];
    },
    (responses: any) => {
      responses['500'] = responses['503'];
    },
    (responses: any) => {
      delete responses['200'];
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(current));
    mutate(changed.paths['/item'].get.responses);
    assert.throws(() => compareApiReadSpecs(current, changed), /Unsupported App API read document/);
  }
});

test('documentation and unexposed database changes do not require version changes', () => {
  const f = fixture(),
    before = f.render();
  f.app.name = 'Renamed';
  f.app.api!.description = 'Documentation';
  f.schema.tables[0].columns.push({ name: 'unexposed', type: 'TEXT', nullable: true, primaryKey: false });
  assert.deepEqual(compareApiReadSpecs(before, f.render()).findings, []);
});

test('added exposed fields and optional filters are additive', () => {
  const f = fixture(),
    before = f.render();
  f.app.api!.resources.item.fields.push('extra');
  f.app.api!.resources.item.filters.push('extra');
  const result = compareApiReadSpecs(before, f.render());
  assert.equal(result.requiresVersionBump, false);
  assert.ok(result.findings.length > 0 && result.findings.every((f) => f.classification === 'additive'));
});

test('removed fields and operations retain findings after a version increase', () => {
  const f = fixture();
  f.app.api!.views = [{ view: 'items' }];
  const before = f.render();
  f.app.api!.views = [];
  f.app.api!.resources.item.fields = ['id'];
  f.app.api!.resources.item.filters = [];
  let result = compareApiReadSpecs(before, f.render());
  assert.equal(result.requiresVersionBump, true);
  assert.equal(result.versionRequirementMet, false);
  const findings = result.findings;
  f.app.api!.version = 2;
  result = compareApiReadSpecs(before, f.render());
  assert.equal(result.versionStatus, 'increased');
  assert.equal(result.versionRequirementMet, true);
  assert.deepEqual(result.findings, findings);
  assert.ok(findings.some((f) => f.change === 'operation-removed'));
  assert.ok(findings.some((f) => f.change === 'field-removed:name'));
});

test('scalar types, roles, key representation and stricter query parameters require review', () => {
  const f = fixture(),
    before = f.render();
  f.schema.tables[0].columns[1].type = 'INTEGER';
  assert.equal(compareApiReadSpecs(before, f.render()).requiresVersionBump, true);
  const g = fixture();
  g.app.api!.roles = ['other'];
  assert.equal(compareApiReadSpecs(before, g.render()).requiresVersionBump, true);
  assert.equal(
    compareApiReadSpecs(before, renderApiReadOpenApi(g.app, g.schema, { integers: 'number' }).document).requiresVersionBump,
    true,
  );
  const narrowed = structuredClone(before);
  const get = narrowed.paths['/item'].get as { parameters: Array<{ name: string; required?: boolean }> };
  get.parameters.find((p) => p.name === 'name')!.required = true;
  assert.equal(compareApiReadSpecs(before, narrowed).requiresVersionBump, true);
});

test('foreign or unsupported documents refuse rather than claim compatibility', () => {
  const before = fixture().render();
  for (const mutation of [
    (doc: any) => {
      doc.paths['/item'].post = {};
    },
    (doc: any) => {
      doc.components.schemas.Row_6974656d.properties.id = { $ref: 'https://example.test/schema' };
    },
    (doc: any) => {
      doc.openapi = '3.0.0';
    },
    (doc: any) => {
      doc.info.version = '1\n';
    },
    (doc: any) => {
      doc.components.schemas.Row_6974656d.minProperties = 1;
    },
    (doc: any) => {
      doc.components.schemas.Row_6974656d.properties.id.not = {};
    },
  ]) {
    const changed = structuredClone(before);
    mutation(changed);
    assert.throws(() => compareApiReadSpecs(before, changed));
  }
});

test('literal description field names are data, not prose annotations', () => {
  const f = fixture();
  f.schema.tables[0].columns.push({ name: 'description', type: 'TEXT', nullable: false, primaryKey: false });
  f.app.api!.resources.item.fields.push('description');
  const before = f.render();
  f.schema.tables[0].columns.at(-1)!.type = 'INTEGER';
  assert.ok(compareApiReadSpecs(before, f.render()).findings.some((f) => f.change === 'field-contract-changed:description'));
  f.app.api!.resources.item.fields = ['id', 'name'];
  assert.ok(compareApiReadSpecs(before, f.render()).findings.some((f) => f.change === 'field-removed:description'));
});

test('current text/composite keys and date filters are accepted without runtime schema dependencies', () => {
  for (const composite of [false, true]) {
    const f = fixture();
    f.schema.tables[0].columns[0].type = 'TEXT';
    f.schema.tables[0].columns[1].primaryKey = composite;
    f.schema.tables[0].columns[2].type = 'DATE';
    f.app.api!.resources.item.fields.push('extra');
    f.app.api!.resources.item.filters.push('extra');
    const doc = f.render();
    assert.deepEqual(compareApiReadSpecs(doc, doc).findings, []);
  }
});

test('changed row constraints outside properties cannot be silently ignored', () => {
  const before = fixture().render(),
    after = structuredClone(before);
  Object.assign(after.components.schemas.Row_6974656d, { 'x-mistri-max-utf8-bytes': 42 });
  assert.ok(compareApiReadSpecs(before, after).findings.some((f) => f.change === 'row-contract-changed'));
  Object.assign(after.components.schemas.Row_6974656d, { anyOf: [{ properties: { name: { const: 'only this' } } }] });
  assert.ok(compareApiReadSpecs(before, after).findings.some((f) => f.change === 'row-contract-changed'));
});

test('projected row key requirements are validated and changes require review', () => {
  const before = fixture().render(),
    changed = structuredClone(before);
  const projected = changed.components.schemas.ProjectedRow_6974656d as Record<string, unknown>;
  projected.required = ['id', 'name'];
  assert.throws(() => compareApiReadSpecs(before, changed), /Unsupported/);
  projected['x-mistri-primary-key'] = ['id', 'name'];
  const result = compareApiReadSpecs(before, changed);
  assert.ok(result.findings.some((f) => f.change === 'required-field-changed:name'));
  assert.equal(result.requiresVersionBump, true);
  const invalid = structuredClone(before);
  (invalid.paths['/item'].get as any).parameters.find((p: any) => p.name === 'fields').schema.pattern = '.*';
  assert.throws(() => compareApiReadSpecs(before, invalid), /Unsupported/);
});

test('actual rendered standing query, order and tab changes require a version review', () => {
  for (const change of ['query', 'order', 'tab-query', 'tab-order', 'default-tab'] as const) {
    const f = fixture();
    f.app.api!.views = [{ view: 'items' }];
    const view = f.app.views.items;
    if (!('table' in view)) throw new Error('Expected list');
    view.query = 'id > 1';
    view.order = 'id';
    view.tabs = [
      { label: 'First', query: 'id < 1000' },
      { label: 'Second', query: 'id < 2000' },
    ];
    const before = f.render();
    if (change === 'query') view.query = 'id > 100';
    if (change === 'order') view.order = 'id desc';
    if (change === 'tab-query') view.tabs[1].query = 'id < 1500';
    if (change === 'tab-order') view.tabs[1].query = 'id < 2000 sort id desc';
    if (change === 'default-tab') view.tabs.reverse();
    let result = compareApiReadSpecs(before, f.render());
    assert.ok(
      result.findings.some((finding) => finding.path === '/views/items' && finding.change === 'standing-contract-changed'),
      change,
    );
    assert.equal(result.requiresVersionBump, true, change);
    assert.equal(result.versionRequirementMet, false, change);
    f.app.api!.version = 2;
    result = compareApiReadSpecs(before, f.render());
    assert.equal(result.versionRequirementMet, true);
  }
});

test('standing metadata excludes presentation and stays immutable without evaluating relative dates', () => {
  const f = fixture();
  f.app.api!.views = [{ view: 'items' }];
  const view = f.app.views.items;
  if (!('table' in view)) throw new Error('Expected list');
  view.query = 'name = today';
  view.tabs = [{ label: 'First', query: 'id < 1000' }];
  const before = f.render();
  view.label = 'Renamed list';
  view.tabs[0].label = 'FIRST'; // Same addressed tab slug, different presentation.
  f.app.api!.views[0].label = 'API docs';
  f.app.api!.views[0].description = 'Docs';
  const after = f.render();
  assert.deepEqual(compareApiReadSpecs(before, after).findings, []);
  const contract = (after.paths['/views/items'].get as any)['x-mistri-standing-contract'];
  assert.equal(contract.query, 'name = today');
  assert.equal(Object.hasOwn(contract.tabs[0], 'label'), false);
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.tabs));
});

test('malformed standing metadata refuses, while an older preview without metadata requires review', () => {
  const f = fixture();
  f.app.api!.views = [{ view: 'items' }];
  const before = f.render();
  for (const change of [
    (contract: any) => {
      contract.query = null;
    },
    (contract: any) => {
      contract.order = [{ path: 'id', direction: 'sideways' }];
    },
    (contract: any) => {
      contract.defaultTab = 'missing';
    },
    (contract: any) => {
      contract.tabs = [
        { id: 'a', query: '', order: [] },
        { id: 'a', query: '', order: [] },
      ];
      contract.defaultTab = 'a';
    },
    (contract: any) => {
      contract.label = 'Unexpected';
    },
  ]) {
    const after = structuredClone(before);
    change((after.paths['/views/items'].get as any)['x-mistri-standing-contract']);
    assert.throws(() => compareApiReadSpecs(before, after));
  }
  const old = structuredClone(before);
  delete (old.paths['/views/items'].get as any)['x-mistri-standing-contract'];
  assert.equal(compareApiReadSpecs(old, before).requiresVersionBump, true);
});
