import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  dashboard,
  defineApp,
  defineFeature,
  expose,
  listView,
  type DraftApiConfig,
  type ApiConfig,
  type ApiFeatureConfig,
  type AppConfig,
  type TypedAppConfig,
  type TypedFeature,
  type SchemaShape,
} from '@mistriwork/mistri/app';
import { withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { catalogOf, parseTestApi, parseTestApp } from './support/commandCatalog.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
ajv.addSchema(read('theme'));
ajv.addSchema(read('page'));
ajv.addSchema(read('app'));
const validate = ajv.compile({ $ref: 'app.schema.json#/$defs/apiDraft' });
const base = () => ({
  version: 1,
  roles: ['reader'],
  resources: { lead: expose(['id', 'status'], { filters: ['status'], sorts: ['id'] }) },
});

test('draft expose produces literal read metadata accepted by runtime and real JSON Schema', () => {
  const raw: DraftApiConfig = {
    ...base(),
    views: ['leads', { view: 'archive', label: 'Archive' }],
    commands: ['refresh', { command: 'qualify', description: 'Qualify a lead' }],
  };
  assert.equal(validate(raw), true, JSON.stringify(validate.errors));
  // The names resolve from the App's commands module, as loading the App resolves them.
  const commands = catalogOf({ refresh: {}, qualify: { target: 'lead' } });
  assert.equal(withCommandCatalog(commands, () => parseTestApi(raw, ['reader']))!.commands.length, 2);
  assert.deepEqual(expose(['id']), { fields: ['id'] });
  assert.deepEqual(base().resources.lead, { fields: ['id', 'status'], filters: ['status'], sorts: ['id'] });
});

test('draft schema and runtime take generic writes as true only, refuse actions, and malformed read metadata', () => {
  for (const key of ['create', 'update', 'delete']) {
    const raw = { ...base(), resources: { lead: { fields: ['id'], [key]: false } } };
    assert.equal(validate(raw), false, key);
    assert.throws(() => parseTestApi(raw, ['reader']), new RegExp(key));
    assert.throws(() => expose(['id'], { [key]: false } as never), /true or absent/);
    assert.equal(validate({ ...base(), resources: { lead: { fields: ['id'], [key]: true } } }), true, key);
    assert.deepEqual(expose(['id'], { [key]: true } as never), { [key]: true, fields: ['id'] });
  }
  {
    const raw = { ...base(), resources: { lead: { fields: ['id'], actions: false } } };
    assert.equal(validate(raw), false);
    assert.throws(() => parseTestApi(raw, ['reader']), /not supported/);
    assert.throws(() => expose(['id'], { actions: false } as never), /Unsupported exposure option/);
  }
  for (const fields of [[], true, ['id', 'id'], ['*'], ['id;drop']]) {
    const raw = { ...base(), resources: { lead: { fields } } };
    assert.equal(validate(raw), false);
    assert.throws(() => parseTestApi(raw, ['reader']));
  }
  for (const raw of [
    { ...base(), version: 0 },
    { ...base(), publicSpec: 'true' },
    { ...base(), roles: [] },
    { ...base(), description: ' ' },
  ]) {
    assert.equal(validate(raw), false);
    assert.throws(() => parseTestApi(raw, ['reader']));
  }
});

test('schema syntax cannot substitute for runtime cross-reference authority checks', () => {
  for (const raw of [
    { ...base(), roles: ['other'] },
    { ...base(), resources: { lead: { fields: ['id'], filters: ['hidden'] } } },
    { ...base(), views: ['leads', 'leads'] },
  ]) {
    assert.equal(validate(raw), true);
    assert.throws(() => parseTestApi(raw, ['reader']));
  }
});

test('active read metadata is accepted by App schema and runtime without enabling commands', () => {
  const app = {
    name: 'Reads',
    home: 'leads',
    resources: { lead: {} },
    auth: { roles: { reader: { read: true } } },
    views: { leads: { kind: 'list', from: 'lead' } },
    api: base(),
  };
  const validateApp = ajv.getSchema('app.schema.json')!;
  assert.equal(validateApp(app), true, JSON.stringify(validateApp.errors));
  assert.deepEqual(parseTestApp(app, 'reads').api, parseTestApi(base(), ['reader']));
  // A command is named, a form's as well as a record's: a form's is served at its resource's command route, and
  // serving one no signed-in form runs is refused where the catalog is checked (api-command-catalog.test.ts).
  const withCommand = { ...app, api: { ...base(), commands: ['refresh'] } };
  assert.equal(validateApp(withCommand), true, JSON.stringify(validateApp.errors));
  assert.equal(parseTestApp(withCommand, 'reads', { refresh: {} }).api!.commands.length, 1);
  const targeted = { ...app, api: { ...base(), commands: ['qualify'] } };
  assert.equal(validateApp(targeted), true, JSON.stringify(validateApp.errors));
  assert.equal(parseTestApp(targeted, 'reads', { qualify: { target: 'lead' } }).api!.commands.length, 1);
  assert.equal(
    validateApp({ ...app, api: { ...base(), commands: [{ id: 'qualify', version: 1, input: {} }] } }),
    false,
    'a command is named, never spelled out',
  );
  const feature = { ...app, features: [{ id: 'extra', api: { resources: { lead: expose(['id']) } } }] };
  assert.equal(validateApp(feature), true, JSON.stringify(validateApp.errors));
  assert.ok(parseTestApp(feature, 'reads').api);
  for (const [key, value] of Object.entries({ version: 1, roles: ['reader'], publicSpec: false, description: 'Root only' })) {
    const invalid = { ...app, features: [{ id: 'extra', api: { [key]: value } }] };
    assert.equal(validateApp(invalid), false, key);
  }
});

// Checked by the repository typecheck; never executed.
function authoringTypes() {
  const root = {
    name: 'References',
    resources: { lead: {} },
    auth: { roles: { reader: { read: true as const } } },
    views: { leads: listView('Leads', 'lead'), dashboard: dashboard('Dashboard', []) },
    home: 'leads' as const,
  };
  const contributed = defineFeature({ id: 'lists', views: { archive: listView('Archive', 'lead') }, api: { views: ['archive'] } });
  defineApp({
    ...root,
    features: [contributed],
    api: { version: 1, roles: ['reader'], views: ['leads', { view: 'archive', label: 'Archive' }], resources: { lead: expose(['id']) } },
  });
  // @ts-expect-error API role must be declared by the root
  defineApp({ ...root, api: { version: 1, roles: ['missing'] } });
  // @ts-expect-error API views must be list views, not dashboards
  defineApp({ ...root, api: { version: 1, roles: ['reader'], views: ['dashboard'] } });
  // @ts-expect-error wrapped API view references are checked too
  defineApp({ ...root, api: { version: 1, roles: ['reader'], views: [{ view: 'missing' }] } });
  // @ts-expect-error exposure resources must have root declarations
  defineApp({ ...root, api: { version: 1, roles: ['reader'], resources: { missing: expose(['id']) } } });
  const badFeature = defineFeature({ id: 'wrong', api: { views: ['missing'] } });
  // @ts-expect-error feature API references are checked where all contributors are known
  defineApp({ ...root, features: [badFeature], api: { version: 1, roles: ['reader'] } });
  // @ts-expect-error generic feature inference must not admit root API knobs
  defineFeature({ id: 'wrong', api: { views: ['leads'], roles: ['reader'] } });
  // @ts-expect-error feature version is root-owned even when equal
  defineFeature({ id: 'wrong', api: { views: ['leads'], version: 1 } });
  // @ts-expect-error feature public specification visibility is root-owned
  defineFeature({ id: 'wrong', api: { views: ['leads'], publicSpec: false } });
  // @ts-expect-error root documentation belongs to the root API block
  defineFeature({ id: 'wrong', api: { views: ['leads'], description: 'Root docs' } });
  const unbound = defineFeature({ id: 'wrong', resources: { missing: {} }, api: { resources: { missing: expose(['id']) } } });
  // @ts-expect-error a feature cannot supply its own missing root resource declaration
  defineApp({ ...root, features: [unbound], api: { version: 1, roles: ['reader'] } });
  // @ts-expect-error direct features are checked as well as defineFeature results
  defineApp({ ...root, features: [{ id: 'wrong', api: { views: ['leads'], version: 1 } }], api: { version: 1, roles: ['reader'] } });
  const wide: ApiConfig = { version: 1, roles: ['runtime'], views: ['runtime'], resources: { runtime: expose(['id']) } };
  defineApp({ ...root, api: wide });
  const wideFeature: ApiFeatureConfig = { views: ['runtime'], resources: { runtime: expose(['id']) } };
  defineApp({ ...root, features: [defineFeature({ id: 'wide', api: wideFeature })], api: wide });
  defineApp(root);
  const api: ApiConfig = base();
  const feature: ApiFeatureConfig = { resources: { lead: expose(['id']) } };
  const app: AppConfig = { name: 'Reads', home: 'leads', api, features: [{ id: 'extra', api: feature }] };
  void app;
  const targetedApi: ApiConfig = { ...base(), commands: ['qualify', { command: 'qualify', label: 'Qualify' }] };
  void targetedApi;
  // @ts-expect-error a command is named, never declared in the App
  const commandApi: ApiConfig = { ...base(), commands: [{ id: 'refresh', version: 1, input: {} }] };
  void commandApi;
  // @ts-expect-error a feature cannot declare API roles
  const featureRoles: ApiFeatureConfig = { roles: ['reader'] };
  void featureRoles;
  const value = expose(['id', 'status'], { filters: ['status'], sorts: ['id'] });
  const literal: 'status' = value.fields[1];
  void literal;
  // @ts-expect-error filters must name one of the literal fields
  expose(['id'], { filters: ['hidden'] });
  // Generic writes are opted into, each true or absent.
  expose(['id'], { create: true, update: true, delete: true });
  // @ts-expect-error a write flag is true or absent, never false
  expose(['id'], { delete: false });
  // @ts-expect-error options cannot replace the explicit projection
  expose(['id'], { fields: ['hidden'] });
  // @ts-expect-error projection must not be empty
  expose([]);
}
void authoringTypes;

function schemaAuthoringTypes() {
  type Tables = { lead: 'id' | 'status' | 'owner_id'; person: 'id' | 'name' };
  const valid = {
    name: 'Typed API',
    home: 'leads',
    resources: { lead: {} },
    auth: { roles: { reader: { read: true as const } } },
    views: { leads: listView('Leads', 'lead') },
    api: {
      version: 1,
      roles: ['reader'],
      resources: { lead: expose(['id', 'status', 'owner_id.name'], { filters: ['status'], sorts: ['id'] }) },
    },
  } satisfies TypedAppConfig<Tables>;
  defineApp(valid);
  defineFeature({ id: 'api', api: { resources: { lead: expose(['id', 'owner_id.name']) } } } satisfies TypedFeature<Tables>);
  // @ts-expect-error unknown bare projection column
  const badField: TypedAppConfig<Tables> = { ...valid, api: { ...valid.api, resources: { lead: expose(['missing']) } } };
  void badField;
  // @ts-expect-error unknown local segment of a reference path
  const badPath: TypedAppConfig<Tables> = { ...valid, api: { ...valid.api, resources: { lead: expose(['missing.name']) } } };
  void badPath;
  // @ts-expect-error another table's column is not this resource's column
  const otherColumn: TypedAppConfig<Tables> = { ...valid, api: { ...valid.api, resources: { lead: expose(['name']) } } };
  void otherColumn;
  // prettier-ignore
  // @ts-expect-error raw filter names are schema-checked without the expose helper too
  const badFilter: TypedAppConfig<Tables> = { ...valid, api: { ...valid.api, resources: { lead: { fields: ['id'], filters: ['missing'] } } } };
  void badFilter;
  void badFilter;
  // @ts-expect-error raw sort names are schema-checked too
  const badSort: TypedFeature<Tables> = { id: 'api', api: { resources: { lead: { fields: ['id'], sorts: ['missing'] } } } };
  void badSort;
  // @ts-expect-error logical resource names are schema names, not arbitrary physical bindings
  const badResource: TypedFeature<Tables> = { id: 'api', api: { resources: { physical_lead: expose(['id']) } } };
  void badResource;
  const wide: TypedAppConfig<SchemaShape> = { ...valid, api: { ...valid.api, resources: { runtime: expose(['runtime.field']) } } };
  void wide;
  // A generated column map cannot verify the target of owner_id; runtime does.
  const deferred: TypedFeature<Tables> = { id: 'api', api: { resources: { lead: expose(['owner_id.runtime_target']) } } };
  void deferred;
}
void schemaAuthoringTypes;
