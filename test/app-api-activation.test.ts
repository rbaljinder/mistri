import { withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeFeatures } from '../packages/mistri/src/shared/appFeatures.js';
import { apiAuthorityKey } from '../packages/mistri/src/shared/appApi.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { namedCommands, parseTestApp } from './support/commandCatalog.js';

const base = () => ({
  name: 'API app',
  resources: { lead: {} },
  auth: { roles: { reader: { read: true } } },
  views: { leads: { kind: 'list', from: 'lead' } },
  home: 'leads',
});
const exposure = () => ({ version: 1, roles: ['reader'], resources: { lead: { fields: ['id'] } } });

test('API absent normalization remains unchanged and present exposure is explicit', () => {
  const raw = base(),
    app = parseTestApp(raw, 'fixture');
  assert.equal(Object.hasOwn(app, 'api'), false);
  assert.deepEqual(parseTestApp({ ...raw, features: [] }, 'fixture'), app);
  for (const id of ['constructor', 'prototype']) {
    assert.deepEqual(parseTestApp({ ...raw, features: [{ id, resources: {} }] }, 'fixture'), app);
  }
  const parsed = parseTestApp({ ...raw, api: exposure() }, 'fixture');
  const { api, ...rest } = parsed;
  assert.deepEqual(rest, app);
  assert.deepEqual(api, {
    ...exposure(),
    publicSpec: false,
    resources: { lead: { fields: ['id'], filters: [], sorts: [] } },
    views: [],
    commands: [],
    events: [],
  });
});

test('API-only list is retained without creating navigation', () => {
  const app = parseTestApp(
    {
      ...base(),
      views: { ...base().views, exportable: { kind: 'list', from: 'lead', query: 'id > 1' } },
      api: { ...exposure(), views: ['exportable'] },
    },
    'fixture',
  );
  assert.ok('exportable' in app.views);
  assert.deepEqual(app.nav, []);
  assert.equal(app.home.length, 1);
  assert.equal(app.home[0].view, 'leads');
  const schema: DatabaseSchema = {
    label: 'logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'lead',
        name: 'lead',
        schema: '',
        isView: false,
        columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
      },
    ],
  };
  const payload = servedApp(app, schema);
  assert.equal(Object.hasOwn(payload, 'api'), false);
  assert.equal(Object.hasOwn(payload.views, 'exportable'), false);
  assert.ok(Object.hasOwn(payload.views, 'leads'));
  assert.equal(JSON.stringify(payload).includes('id > 1'), false);
  app.nav = [{ view: 'exportable' }];
  assert.ok(Object.hasOwn(servedApp(app, schema).views, 'exportable'));
});

test('feature exposure merges and view definition remains owned by its declaring feature', () => {
  const raw = {
    ...base(),
    api: exposure(),
    features: [
      { id: 'definitions', views: { exportable: { kind: 'list', from: 'lead' } } },
      { id: 'exposure', api: { resources: { lead: { fields: ['status'], filters: ['status'] } }, views: ['exportable'] } },
    ],
  };
  const { origins } = composeFeatures(raw, 'fixture'),
    parsed = parseTestApp(raw, 'fixture');
  assert.deepEqual(parsed.api!.resources.lead.fields, ['id', 'status']);
  assert.deepEqual(origins.authority[apiAuthorityKey('view', 'exportable')], ['features "exposure"']);
  assert.deepEqual(origins.authority[apiAuthorityKey('viewDefinition', 'exportable')], ['features "definitions"']);
  assert.deepEqual(parsed.nav, []);
});

test('feature cannot invent root API identity or authority', () => {
  assert.throws(() => parseTestApp({ ...base(), features: [{ id: 'exposure', api: { resources: {} } }] }, 'fixture'), /explicit root api/);
  assert.throws(
    () => parseTestApp({ ...base(), api: exposure(), features: [{ id: 'exposure', api: { roles: ['reader'] } }] }, 'fixture'),
    /root App only/,
  );
});

/* Composition parses the api block; the parse front must not parse it again.
   A command reference does not survive a second parse — its `input` normalises
   from an object of fields keyed by name into a list, which the second parse
   rightly refuses — so an App with both `features` and `api.commands` was
   refused outright. The deep-equal against the featureless parse is the guard
   for the next field that normalises: it fails for any part of the block a
   second parse would change, not only for `input`. */
test('an App with features parses its api.commands once, exactly as one without features', () => {
  const targeted = { id: 'change', version: 1, target: 'lead', input: { note: { type: 'text' } } };
  const api = { ...exposure(), commands: [targeted] };
  const alone = parseTestApp({ ...base(), api }, 'fixture');
  const composed = parseTestApp(
    { ...base(), api, features: [{ id: 'exposure', api: { resources: { lead: { fields: ['id'] } } } }] },
    'fixture',
  );
  assert.deepEqual(composed.api, alone.api);
  // The normalised reference is the parsed one, not the authored object.
  assert.deepEqual(alone.api!.commands[0].command.input, [{ name: 'note', label: 'Note', required: true, type: 'text' }]);

  // A feature contributes a command of its own, and both are served.
  const contributed = parseTestApp(
    { ...base(), api, features: [{ id: 'closing', api: { commands: [{ command: { ...targeted, id: 'close' }, label: 'Close' }] } }] },
    'fixture',
  );
  assert.deepEqual(
    contributed.api!.commands.map((entry) => entry.command.id),
    ['change', 'close'],
  );
  assert.equal(contributed.api!.commands[1].label, 'Close');
  assert.deepEqual(contributed.api!.commands[1].command.input, alone.api!.commands[0].command.input);

  // Crediting is unchanged in content: the App's command and the feature's.
  const authored = namedCommands({
    ...base(),
    api,
    features: [{ id: 'closing', api: { commands: [{ command: { ...targeted, id: 'close' }, label: 'Close' }] } }],
  });
  const { origins } = withCommandCatalog(authored.commands, () => composeFeatures(authored.app, 'fixture'));
  assert.deepEqual(origins.authority[apiAuthorityKey('command', 'change')], ['the App']);
  assert.deepEqual(origins.authority[apiAuthorityKey('command', 'close')], ['features "closing"']);

  // Every refusal the block already made still holds with features present.
  assert.throws(
    () =>
      parseTestApp(
        {
          ...base(),
          api,
          features: [
            { id: 'a', api: { commands: [targeted] } },
            { id: 'a', api: { views: [] } },
          ],
        },
        'fixture',
      ),
    /both have the id "a"/,
  );
  assert.throws(
    () =>
      parseTestApp(
        {
          ...base(),
          api: { ...api, commands: [{ command: targeted, label: 'Change' }] },
          features: [{ id: 'clash', api: { commands: [{ command: targeted, label: 'Different label' }] } }],
        },
        'fixture',
      ),
    /commands "change".*label/,
  );
  assert.throws(
    () => parseTestApp({ ...base(), api, features: [{ id: 'unknown', api: { commands: [targeted], surprise: true } }] }, 'fixture'),
    /unknown property "surprise"/,
  );
});

test('non-list and missing API views are refused', () => {
  assert.throws(() => parseTestApp({ ...base(), api: { ...exposure(), views: ['missing'] } }, 'fixture'), /existing list view/);
  assert.throws(
    () =>
      parseTestApp(
        {
          ...base(),
          views: { ...base().views, board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'view', view: 'leads' }] } },
          api: { ...exposure(), views: ['board'] },
        },
        'fixture',
      ),
    /existing list view/,
  );
});

test("command exposure is accepted, a form's command too; unsupported multi-source authority is refused", () => {
  const targeted = { id: 'change', version: 1, target: 'lead', input: {} };
  const app = parseTestApp(
    { ...base(), api: { ...exposure(), commands: [targeted, { command: { ...targeted, id: 'close' }, label: 'Close' }] } },
    'fixture',
  );
  assert.deepEqual(
    app.api!.commands.map((exposure) => exposure.command.id),
    ['change', 'close'],
  );
  // A form's command has no record to address: it is served on its resource
  // (`…/lead/commands/change/v1`); the checked catalog asks for its signed-in form.
  assert.deepEqual(
    parseTestApp({ ...base(), api: { ...exposure(), commands: [{ id: 'change', version: 1, input: {} }] } }, 'fixture').api!.commands.map(
      ({ command }) => 'target' in command,
    ),
    [false],
  );
  // Several sources may be exposed; a path that would read a second connection in one request may not.
  const several = (fields: string[]) => ({
    ...base(),
    sources: { first: { connection: 'a', default: true }, second: { connection: 'b' } },
    resources: { lead: { references: { owner_id: { to: 'second.owner' } } }, 'second.owner': {} },
    api: { ...exposure(), resources: { lead: { fields }, 'second.owner': { fields: ['id', 'name'] } } },
  });
  assert.ok(parseTestApp(several(['id', 'owner_id']), 'fixture').api);
  assert.throws(
    () => parseTestApp(several(['id', 'owner_id.name']), 'fixture'),
    /"owner_id\.name" reaches "second\.owner", on another connection.*\[api-multi-source\]/,
  );
  // A row-policy App's API reads through its policy, each token as its own
  // account; a tenant App's acts through one tenant membership per token. Both may declare exposure.
  assert.ok(
    parseTestApp(
      { ...base(), sources: { first: { connection: 'a' } }, auth: { ...base().auth, rows: 'policy' }, api: exposure() },
      'fixture',
    ).api,
  );
  const tenant = parseTestApp(
    {
      ...base(),
      sources: { first: { connection: 'a' } },
      resources: { lead: { owner: 'tenant' } },
      auth: { ...base().auth, rows: 'tenant' },
      api: exposure(),
    },
    'fixture',
  );
  assert.equal(tenant.api!.roles[0], 'reader');
});
