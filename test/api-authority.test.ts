import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeAppApi } from '../packages/mistri/src/shared/appApi.js';
import { apiAuthorityFacts } from '../packages/mistri/src/shared/apiAuthority.js';
import { authorityDiff, authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { composeFeatures } from '../packages/mistri/src/shared/appFeatures.js';
import { authorityChange, authorityLockProblem } from '../packages/mistri/src/server/app/authorityLock.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

const declaration = () => ({
  version: 1,
  roles: ['reader'],
  resources: {
    item: { fields: ['id', 'status'], filters: ['status'], sorts: ['id'] },
  },
  views: ['items'],
  commands: [],
});
const views = (): AppDef['views'] => ({
  items: { table: 'item', query: 'status = open', tabs: [{ label: 'Open', query: 'status = open' }], sort: 'id' },
});
const facts = (raw: unknown, list = views()) => apiAuthorityFacts(parseTestApi(raw, ['reader', 'manager']), list);
const text = (raw: unknown, list = views()) =>
  facts(raw, list)
    .map(({ fact }) => `${fact} — the App`)
    .join('\n');

test('absent API adds no facts and emitted facts never claim catalog-derived callable roles', () => {
  assert.deepEqual(apiAuthorityFacts(undefined, {}), []);
  const result = facts(declaration());
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every(Object.isFrozen));
  assert.ok(result.some((item) => item.fact === 'api public-spec false'));
  assert.ok(result.every((item) => !item.fact.startsWith('api call ')));
});

test('API widening and view query changes move authority facts', () => {
  const before = declaration();
  for (const after of [
    { ...before, version: 2 },
    { ...before, roles: ['reader', 'manager'] },
    { ...before, publicSpec: true },
    { ...before, resources: { item: { ...before.resources.item, fields: ['id', 'status', 'name'] } } },
    { ...before, resources: { item: { ...before.resources.item, filters: ['status', 'id'] } } },
    { ...before, resources: { item: { ...before.resources.item, sorts: ['id', 'status'] } } },
  ])
    assert.notDeepEqual(authorityDiff(text(before), text(after)), []);
  const all = views();
  if ('table' in all.items) all.items.query = '';
  assert.notDeepEqual(authorityDiff(text(before), text(before, all)), []);
});

test('presentation changes and exposure set ordering preserve authored authority', () => {
  const before = declaration();
  const presentation = views();
  if ('table' in presentation.items) Object.assign(presentation.items, { label: 'Renamed', icon: 'file', show: ['status'] });
  const after = {
    ...before,
    description: 'Documentation',
    publicSpec: false,
    resources: { item: { ...before.resources.item, fields: ['status', 'id'], description: 'Public fields' } },
    views: [{ view: 'items', label: 'Integration list', description: 'Documentation' }],
  };
  assert.deepEqual(facts(before), facts(after, presentation));
});

test('API command target contracts move facts without exposing field labels as authority', () => {
  const before = { ...declaration(), commands: [{ id: 'revise', version: 1, target: 'item', input: {} }] };
  // Its target is authority; its version is the lock's contract line (commandContracts.ts), which a bump moves, not a fact.
  const moved = { ...before, commands: [{ ...before.commands[0], targets: 'many' }] };
  assert.notDeepEqual(authorityDiff(text(before), text(moved)), []);
  const after = { ...before, commands: [{ ...before.commands[0], version: 2 }] };
  assert.deepEqual(authorityDiff(text(before), text(after)), []);
  assert.ok(facts(before).some((item) => item.fact.includes('"targets":"one"')));
  assert.throws(() => facts(declaration(), {}), /resolved list view/);
});

test('feature widening names its contributor through the shared provenance keys', () => {
  const { api, authority } = composeAppApi(
    declaration(),
    [
      {
        id: 'extra',
        api: {
          resources: { item: { fields: ['id', 'name'], filters: ['name'] } },
        },
      },
    ],
    ['reader'],
  );
  const result = apiAuthorityFacts(api, views());
  const name = result.find((item) => item.fact === 'api resource item field name')!;
  const id = result.find((item) => item.fact === 'api resource item field id')!;
  assert.deepEqual(authority[name.path], ['features "extra"']);
  assert.deepEqual(authority[id.path], ['the App', 'features "extra"']);
  assert.notEqual(
    result.find((item) => item.fact === 'api view items')!.path,
    result.find((item) => item.fact.startsWith('api view items definition '))!.path,
  );
});

const authored = () => ({
  name: 'API authority',
  resources: { item: {} },
  auth: { roles: { reader: { read: ['item'] }, manager: { read: ['item'] } } },
  views: { items: { kind: 'list', from: 'item', query: 'status = open', sort: 'id' } },
  home: 'items',
});
function reported(raw: unknown) {
  // parseAppConfig composes for itself; the manifest, not the composed root,
  // is what it takes. A composed root is raw everywhere still to be parsed and
  // carries no api block — composition parses that one itself, exactly once.
  const composed = composeFeatures(raw, 'API authority fixture');
  const app = parseTestApp(raw, 'API authority fixture');
  return { app, report: authorityReport(app, composed.origins) };
}

test('normal authority report preserves absent API and gates active read exposure mutations', () => {
  const base = authored(),
    absent = reported(base);
  assert.equal(absent.report, authorityReport(parseTestApp(base, 'API authority fixture')));
  assert.doesNotMatch(absent.report, /^api /m);
  const before = { ...base, api: declaration() },
    original = reported(before);
  assert.match(original.report, /^api version 1 — the App$/m);
  for (const raw of [
    { ...before, api: { ...declaration(), version: 2 } },
    { ...before, api: { ...declaration(), roles: ['reader', 'manager'] } },
    { ...before, api: { ...declaration(), publicSpec: true } },
    { ...before, api: { ...declaration(), resources: { item: { fields: ['id', 'status', 'name'] } } } },
    { ...before, views: { items: { ...base.views.items, query: 'status != closed' } } },
    { ...before, views: { items: { ...base.views.items, sort: 'id desc' } } },
  ]) {
    const next = reported(raw);
    assert.match(
      authorityLockProblem({ lock: original.report, report: next.report, lockPath: 'authority.lock' })!,
      /effective authority differs/,
    );
    assert.match(authorityChange(original, next)!, /authority changed/);
  }
  const presentation = reported({
    ...before,
    name: 'Renamed',
    api: { ...declaration(), description: 'Docs' },
    views: { items: { ...base.views.items, label: 'Items renamed', icon: 'file', show: ['status'] } },
  });
  assert.equal(original.report, presentation.report);
});

test('normal authority report credits view semantics to its author, exposure to its contributor', () => {
  const base = authored();
  const root = {
    ...base,
    views: {},
    api: { ...declaration(), views: [] },
    features: [
      { id: 'lists', views: base.views },
      { id: 'integration', api: { views: ['items'], resources: { item: { fields: ['name'] } } } },
    ],
  };
  const { report } = reported(root);
  assert.match(report, /^api view items — features "integration"$/m);
  assert.match(report, /^api view items definition .* — features "lists"$/m);
  assert.match(report, /^api resource item field name — features "integration"$/m);
  const moved = reported({ ...root, views: base.views, features: [{ id: 'integration', api: root.features[1].api }] });
  assert.match(moved.report, /^api view items definition .* — the App$/m);
  assert.deepEqual(authorityDiff(report, moved.report, 'facts'), []);
  assert.notDeepEqual(authorityDiff(report, moved.report, 'lines'), []);
});
