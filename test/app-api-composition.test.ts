import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiAuthorityKey, composeAppApi } from '../packages/mistri/src/shared/appApi.js';
import { sameData } from '../packages/mistri/src/shared/authoredData.js';
import { withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { catalogOf, namedCommands, parseTestApi } from './support/commandCatalog.js';

const roles = ['reader', 'manager'];
const root = () => ({ version: 1, roles: ['reader'], resources: { lead: { fields: ['id', 'status'], filters: ['status'] } } });
const command = () => ({ id: 'assign', version: 1, target: 'lead', input: { note: { type: 'text' } } });
/* Each fragment's inline contract becomes its name, resolved from one commands module, as loading the App resolves it. */
const compose = (value: unknown = root(), features: readonly { id: string; api?: unknown }[] = []) => {
  const { app, commands } = namedCommands({ value, features });
  // Nothing inline: composed as written, so its getters and hidden keys are the composer's to refuse.
  const authored = commands.size ? app : { value, features };
  if (!commands.has('assign')) commands.set('assign', catalogOf({ assign: command() }).get('assign')!);
  return withCommandCatalog(commands, () => composeAppApi(authored.value, authored.features, roles));
};

test('omitted root and absent fragments remain omitted; features cannot enable API authority', () => {
  assert.deepEqual(composeAppApi(undefined, [{ id: 'empty' }], roles), { authority: {} });
  assert.throws(() => composeAppApi(undefined, [{ id: 'enable', api: {} }], roles), /explicit root api/);
  assert.deepEqual(compose().api, parseTestApi(root(), roles));
});

test('version, roles, publicSpec and root description cannot be contributed even identically', () => {
  for (const [key, value] of [
    ['version', 1],
    ['roles', ['reader']],
    ['publicSpec', false],
    ['description', 'API'],
  ] as const) {
    assert.throws(() => compose(root(), [{ id: 'feature', api: { [key]: value } }]), /features "feature".*root App only/);
  }
});

test('field/filter/sort unions preserve contributor order and exact provenance', () => {
  const result = compose(root(), [
    { id: 'first', api: { resources: { lead: { fields: ['status', 'amount'], filters: ['amount'], sorts: ['amount'] } } } },
    { id: 'second', api: { resources: { lead: { fields: ['amount', 'owner_id.name'], filters: ['amount'] } } } },
  ]);
  assert.deepEqual(result.api!.resources.lead, {
    fields: ['id', 'status', 'amount', 'owner_id.name'],
    filters: ['status', 'amount'],
    sorts: ['amount'],
  });
  assert.deepEqual(result.authority[apiAuthorityKey('field', 'lead', 'status')], ['the App', 'features "first"']);
  assert.deepEqual(result.authority[apiAuthorityKey('filter', 'lead', 'amount')], ['features "first"', 'features "second"']);
  assert.deepEqual(result.authority[apiAuthorityKey('sort', 'lead', 'amount')], ['features "first"']);
  assert.deepEqual(result.authority[apiAuthorityKey('version')], ['the App']);
  assert.deepEqual(result.authority[apiAuthorityKey('publicSpec')], ['the App']);
  assert.deepEqual(result.authority[apiAuthorityKey('role', 'reader')], ['the App']);
});

test('qualified resource/path segments cannot collide in provenance keys', () => {
  assert.notEqual(apiAuthorityKey('field', 'foo.field', 'bar.x'), apiAuthorityKey('field', 'foo', 'field.bar.x'));
});

test('identical views and normalized commands merge once and credit every contributor', () => {
  const result = compose({ ...root(), views: ['leads'], commands: [command()] }, [
    { id: 'one', api: { views: [{ view: 'leads', label: 'Leads API' }], commands: [{ command: command(), label: 'Assign' }] } },
    {
      id: 'two',
      api: { views: ['leads', 'working'], commands: [{ input: { note: { type: 'text' } }, target: 'lead', version: 1, id: 'assign' }] },
    },
  ]);
  assert.deepEqual(result.api!.views, [{ view: 'leads', label: 'Leads API' }, { view: 'working' }]);
  assert.equal(result.api!.commands.length, 1);
  assert.equal(result.api!.commands[0].label, 'Assign');
  assert.deepEqual(result.authority[apiAuthorityKey('command', 'assign')], ['the App', 'features "one"', 'features "two"']);
  assert.deepEqual(result.authority[apiAuthorityKey('view', 'working')], ['features "two"']);
});

test("a command named by several contributors is one exposure: its contract is the module's, never theirs", () => {
  const result = compose({ ...root(), commands: ['assign'] }, [{ id: 'one', api: { commands: [{ command: 'assign', label: 'Assign' }] } }]);
  assert.equal(result.api!.commands.length, 1);
  assert.deepEqual(result.authority[apiAuthorityKey('command', 'assign')], ['the App', 'features "one"']);
});

test('presentation conflicts remain refusals naming the actual declaration owners', () => {
  for (const key of ['label', 'description']) {
    assert.throws(
      () =>
        compose({ ...root(), views: ['leads'] }, [
          { id: 'one', api: { views: [{ view: 'leads', [key]: 'First' }] } },
          { id: 'two', api: { views: [{ view: 'leads', [key]: 'Second' }] } },
        ]),
      /features "one".*features "two"/,
    );
    assert.throws(
      () =>
        compose({ ...root(), commands: [{ command: command(), [key]: 'First' }] }, [
          { id: 'two', api: { commands: [{ command: command(), [key]: 'Second' }] } },
        ]),
      /the App.*features "two"/,
    );
  }
  assert.throws(
    () =>
      compose({ ...root(), resources: { lead: { fields: ['id'], description: 'First' } } }, [
        { id: 'two', api: { resources: { lead: { fields: ['id'], description: 'Second' } } } },
      ]),
    /the App.*features "two"/,
  );
});

test('false and omitted publicSpec normalize identically and output does not alias authored objects', () => {
  const raw = root(),
    fragments = [{ id: 'one', api: { commands: [command()] } }],
    before = structuredClone({ raw, fragments });
  const result = compose(raw, fragments);
  assert.deepEqual(compose({ ...root(), publicSpec: false }, fragments), result);
  result.api!.roles.push('manager');
  result.api!.resources.lead.fields.push('other');
  result.api!.commands[0].command.input[0].label = 'Changed';
  assert.deepEqual({ raw, fragments }, before);
});

test('aggregate union limits cannot be bypassed with individually valid fragments', () => {
  const first = Array.from({ length: 256 }, (_, i) => `f${i}`);
  assert.throws(
    () =>
      compose({ ...root(), resources: { lead: { fields: first } } }, [{ id: 'more', api: { resources: { lead: { fields: ['extra'] } } } }]),
    /merged.*256/,
  );
  const resources = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`r${i}`, { fields: ['id'] }]));
  assert.throws(
    () => compose({ ...root(), resources }, [{ id: 'more', api: { resources: { extra: { fields: ['id'] } } } }]),
    /merged.*256/,
  );
  const views = Array.from({ length: 256 }, (_, i) => `v${i}`);
  assert.throws(() => compose({ ...root(), views }, [{ id: 'more', api: { views: ['extra'] } }]), /merged.*256/);
  const commands = Array.from({ length: 256 }, (_, i) => ({ id: `c${i}`, version: 1, input: {} }));
  assert.throws(
    () => compose({ ...root(), commands }, [{ id: 'more', api: { commands: [{ id: 'extra', version: 1, input: {} }] } }]),
    /merged.*256/,
  );
});

test('feature metadata stays bounded, data-only and refuses unsupported writes', () => {
  assert.throws(
    () =>
      compose(
        root(),
        Array.from({ length: 65 }, (_, i) => ({ id: `f${i}` })),
      ),
    /64/,
  );
  assert.throws(() => compose(root(), [{ id: 'same' }, { id: 'same' }]), /duplicate feature/);
  assert.throws(() => compose(root(), [{ id: 'bad id' }]), /feature id/);
  let calls = 0;
  const fragment = Object.defineProperty({ id: 'getter' }, 'api', {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => compose(root(), [fragment]), /data properties/);
  assert.equal(calls, 0);
  assert.throws(
    () => compose(root(), [{ id: 'bad', api: { resources: { lead: { fields: ['id'], delete: false } } } }]),
    /opted into with true/,
  );
  assert.throws(() => compose(root(), [{ id: 'bad', api: { grant: true } }]), /unknown property/);
});

test('the extracted comparator preserves object key independence and ordered array semantics', () => {
  assert.equal(sameData({ a: [1, 2], b: null }, { b: null, a: [1, 2] }), true);
  assert.equal(sameData({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(sameData({ a: 1 }, { a: '1' }), false);
});
