import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { parseAppApi } from '../packages/mistri/src/shared/appApi.js';
import { catalogOf, parseTestApi, parseTestApp } from './support/commandCatalog.js';

const base = () => ({
  version: 1,
  roles: ['reader'],
  resources: { lead: { fields: ['id', 'status', 'owner_id.name'], filters: ['status'], sorts: ['id'] } },
});
/* The commands module the names resolve from: a record's command, a selection's, a form's and a public form's. */
const commands = catalogOf({
  assign: { target: 'lead' },
  bulk: { target: 'lead', targets: 'many' },
  createLead: {},
  apply: { public: true },
});
const parse = (raw: unknown) => withCommandCatalog(commands, () => parseAppApi(raw, ['reader', 'manager'], 'fixture.api'));

test('API parser is opt-in and App root still requires declared role authority', () => {
  assert.equal(parse(undefined), undefined);
  assert.throws(
    () => parseTestApp({ name: 'App', views: { leads: { kind: 'list', from: 'lead' } }, home: 'leads', api: base() }, 'fixture'),
    /api/,
  );
});
test('explicit projection and defaults normalize without mutating authored data', () => {
  const raw = base(),
    before = structuredClone(raw),
    result = parse(raw)!;
  assert.deepEqual(result, { ...raw, publicSpec: false, views: [], commands: [], events: [] });
  result.resources.lead.fields.push('other');
  result.roles.push('manager');
  assert.deepEqual(raw, before);
  assert.deepEqual(parse({ ...base(), publicSpec: false }), parse(base()));
  assert.equal(parse({ ...base(), publicSpec: true })!.publicSpec, true);
});
test('resource defaults expose no filter or sort implicitly', () => {
  assert.deepEqual(parse({ version: 1, roles: ['reader'], resources: { lead: { fields: ['id'] } } })!.resources.lead, {
    fields: ['id'],
    filters: [],
    sorts: [],
  });
});
test('roles and version belong to existing root authority', () => {
  assert.throws(() => parseTestApi(base(), []), /needs auth.roles/);
  for (const roles of [[], ['unknown'], ['reader', 'reader'], true, 'reader']) assert.throws(() => parse({ ...base(), roles }));
  for (const version of [undefined, 0, -1, 1.2, '1', true, Number.MAX_SAFE_INTEGER + 1, Infinity])
    assert.throws(() => parse({ ...base(), version }), /version/);
  for (const publicSpec of ['true', 1, null, {}]) assert.throws(() => parse({ ...base(), publicSpec }), /publicSpec/);
});
test('fields must be explicit, unique and bounded; filters and sorts cannot widen projection', () => {
  for (const fields of [
    undefined,
    true,
    [],
    ['id', 'id'],
    ['owner_id.constructor'],
    ['*'],
    ['id;drop'],
    Array.from({ length: 257 }, (_, i) => `f${i}`),
  ]) {
    assert.throws(() => parse({ ...base(), resources: { lead: { fields } } }));
  }
  for (const key of ['filters', 'sorts']) {
    assert.throws(() => parse({ ...base(), resources: { lead: { fields: ['id'], [key]: ['hidden'] } } }), /exposed fields only/);
    assert.throws(() => parse({ ...base(), resources: { lead: { fields: ['id'], [key]: ['id', 'id'] } } }), /duplicate/);
  }
});
test('a generic write is opted into with true alone, and fixed actions are refused even when false', () => {
  for (const key of ['create', 'update', 'delete']) {
    assert.equal(parse({ ...base(), resources: { lead: { fields: ['id'], [key]: true } } })!.resources.lead[key as 'create'], true);
    for (const value of [false, ['status']]) {
      assert.throws(() => parse({ ...base(), resources: { lead: { fields: ['id'], [key]: value } } }), /opted into with true/);
    }
  }
  for (const value of [false, true, ['status']]) {
    assert.throws(() => parse({ ...base(), resources: { lead: { fields: ['id'], actions: value } } }), /not supported.*command/);
  }
});
test('view references normalize keys and presentation without catalog guesses', () => {
  assert.deepEqual(parse({ ...base(), views: ['leads', { view: 'working', label: ' Working ', description: ' Current leads ' }] })!.views, [
    { view: 'leads' },
    { view: 'working', label: 'Working', description: 'Current leads' },
  ]);
  for (const views of [['leads', { view: 'leads' }], ['Bad key'], [true], [{ view: 'leads', grant: true }]])
    assert.throws(() => parse({ ...base(), views }));
  assert.equal(parse({ ...base(), views: ['a'.repeat(64)] })!.views[0].view.length, 64);
  assert.throws(() => parse({ ...base(), views: ['a'.repeat(65)] }), /view key/);
});
test('one, many and no-target commands are named, and resolve to their registrations', () => {
  const result = parse({ ...base(), commands: ['assign', { command: 'bulk', label: ' Assign ' }, 'createLead'] })!;
  assert.deepEqual(
    result.commands.map((entry) => entry.command.id),
    ['assign', 'bulk', 'createLead'],
  );
  assert.deepEqual(result.commands[0].command.input, []);
  assert.equal(result.commands[1].label, 'Assign');
  assert.equal('target' in result.commands[2].command, false);
  assert.throws(() => parse({ ...base(), commands: ['assign', { command: 'assign' }] }), /duplicate command/);
  for (const command of [
    'asign',
    { command: 'assign', execute: () => {} },
    { id: 'assign', version: 1, target: 'lead', input: {} },
    'apply',
    7,
  ]) {
    assert.throws(() => parse({ ...base(), commands: [command] }), JSON.stringify(command));
  }
});
test('objects and array entries never invoke getters', () => {
  let called = false;
  const accessor = {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  };
  const root = Object.defineProperty(base(), 'version', accessor);
  assert.throws(() => parse(root), /data properties/);
  const fields = ['id'];
  Object.defineProperty(fields, '0', accessor);
  assert.throws(() => parse({ ...base(), resources: { lead: { fields } } }), /data entries/);
  const entry = Object.defineProperty({ command: 'assign' }, 'label', accessor);
  assert.throws(() => parse({ ...base(), commands: [entry] }), /data properties/);
  assert.equal(called, false);
});
test('sparse arrays, symbol and hidden metadata, unsafe names and unknown keys are refused', () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  for (const raw of [
    null,
    [],
    true,
    Object.assign(base(), { extra: true }),
    Object.assign(base(), { [Symbol('hidden')]: true }),
    Object.defineProperty(base(), 'secret', { value: true }),
    { ...base(), views: sparse },
    { ...base(), resources: JSON.parse('{"__proto__":{"fields":["id"]}}') },
    { ...base(), resources: { 'bad-name': { fields: ['id'] } } },
  ])
    assert.throws(() => parse(raw));
});
