import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/** Every App names its home; these tests are about something else, so their Apps get this one list, named as the home. */
const parse = (config: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Service Atlas',
      views: { incidents: { kind: 'list', from: 'incidents' } },
      home: 'incidents',
      ...config,
      resources: { incidents: {}, ...(config.resources as Record<string, unknown> | undefined) },
    },
    'app.ts',
  );

test('named sources retain independent resource mappings and normalize the default connection', () => {
  const config = {
    sources: {
      operations: { connection: ' atlas ' },
      inventory: { connection: 'Assets database', default: true },
    },
    resources: { 'operations.incidents': { physical: ' public.incident ' }, devices: { physical: 'inventory.device' } },
  };
  const before = structuredClone(config);
  const app = parse(config);
  assert.equal(app.connection, 'Assets database');
  assert.deepEqual(app.sources, {
    operations: { connection: 'atlas', default: false },
    inventory: { connection: 'Assets database', default: true },
  });
  assert.deepEqual(
    app.resources,
    {
      incidents: { source: 'inventory' },
      'operations.incidents': { source: 'operations', physical: 'public.incident' },
      devices: { source: 'inventory', physical: 'inventory.device' },
    },
    'Each resource keeps its authored key and names its source',
  );
  assert.deepEqual(config, before);
});

test('sole sources infer their default; a root connection is the one source, named for it', () => {
  const single = parse({ sources: { operations: { connection: 'atlas' } } });
  assert.equal(single.connection, 'atlas');
  assert.deepEqual(single.sources, { operations: { connection: 'atlas', default: true } });
  const bound = parse({ connection: 'atlas', resources: { incidents: { physical: 'public.incident' } } });
  assert.equal(bound.connection, 'atlas');
  assert.deepEqual(bound.sources, { atlas: { connection: 'atlas', default: true } });
  assert.deepEqual(bound.resources, { incidents: { source: 'atlas', physical: 'public.incident' } });
  // A connection named as no source can be keeps no source: its App names one in `sources` to run commands.
  const unnamed = parse({ connection: 'atlas-db', resources: { incidents: { physical: 'public.incident' } } });
  assert.equal(unnamed.sources, undefined);
  assert.deepEqual(unnamed.resources, { incidents: { physical: 'public.incident' } });
  assert.equal(parse({}).connection, undefined);
});

test('named source defaults are explicit for multiple sources: at most one says default: true, and none has to', () => {
  const sources = { operations: { connection: 'atlas' }, inventory: { connection: 'assets' } };
  // No default: every resource keeps its source's name, so none is renamed when a source goes.
  const qualified = (config: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Service Atlas',
        home: 'incidents',
        views: { incidents: { kind: 'list', from: 'operations.incidents' } },
        resources: { 'operations.incidents': {} },
        ...config,
      },
      'app.ts',
    );
  assert.deepEqual(qualified({ sources }).sources, {
    operations: { connection: 'atlas', default: false },
    inventory: { connection: 'assets', default: false },
  });
  assert.equal(qualified({ sources }).connection, 'atlas');
  assert.throws(() => parse({ sources }), /bare name, and no source says "default: true".*'operations\.incidents', 'inventory\.incidents'/);
  assert.throws(
    () => parse({ sources: { operations: { connection: 'atlas', default: true }, inventory: { connection: 'assets', default: true } } }),
    /operations and inventory both do\./,
  );
  for (const value of ['operations', 'true', 1, null, {}]) {
    assert.throws(
      () => parse({ sources: { ...sources, operations: { connection: 'atlas', default: value } } }),
      /source "operations" has a "default" that is not true or false/,
    );
  }
  // A source standing alone is the default unless it says otherwise, which keeps its qualified names.
  assert.equal(parse({ sources: { operations: { connection: 'atlas' } } }).sources!.operations.default, true);
  const alone = qualified({ sources: { operations: { connection: 'atlas', default: false } } });
  assert.equal(alone.sources!.operations.default, false);
  assert.equal(alone.connection, 'atlas');
  assert.deepEqual(parse({ sources: { ...sources, inventory: { connection: 'assets', default: true } } }).sources, {
    operations: { connection: 'atlas', default: false },
    inventory: { connection: 'assets', default: true },
  });
  // The default is the source's own fact; a root key naming it is unknown.
  assert.throws(() => parse({ sources, defaultSource: 'operations' }), /has no "defaultSource"\. It takes: /);
});

test('named source ownership cannot mix with a root connection', () => {
  const sources = { operations: { connection: 'atlas' } };
  for (const extra of [{ connection: 'atlas' }, { connection: '' }, { connection: 'atlas', resources: {} }]) {
    assert.throws(() => parse({ sources, ...extra }), /"sources" cannot be combined with root "connection"/);
  }
});

test('source maps, aliases and binding shapes fail with contextual messages', () => {
  for (const sources of [null, [], {}, 'atlas', 2]) {
    assert.throws(() => parse({ sources }), /"sources" must be a non-empty map/);
  }
  for (const name of [
    '',
    'operations.live',
    '1operations',
    'ops/assets',
    'ops-assets',
    'constructor',
    '__proto__',
    'prototype',
    'toString',
    'hasOwnProperty',
  ]) {
    assert.throws(() => parse({ sources: Object.fromEntries([[name, { connection: 'atlas' }]]) }), /non-reserved identifier/);
  }
  for (const value of [null, [], 'atlas', 1]) {
    assert.throws(() => parse({ sources: { operations: value } }), /source "operations" must be a connection binding object/);
  }
  for (const connection of [undefined, null, '', ' ', 1]) {
    assert.throws(() => parse({ sources: { operations: { connection } } }), /non-empty "connection" reference/);
  }
  assert.throws(() => parse({ sources: { operations: { connection: 'atlas', password: 'secret' } } }), /"password"/);
  // A source no longer maps resources; the resource block binds its own physical table.
  assert.throws(
    () => parse({ sources: { operations: { connection: 'atlas', resources: { incident: 'public.incident' } } } }),
    /source "operations" has a "resources" that is neither 'all' nor a list of its tables' names/,
  );
  const one = { operations: { connection: 'atlas' } };
  assert.throws(
    () => parse({ sources: one, resources: { 'bad-name': { physical: 'public.incident' } } }),
    /resources "bad-name" needs a logical name/,
  );
  assert.throws(
    () => parse({ sources: one, resources: { 'bad.name': { physical: 'public.incident' } } }),
    /a dot in a resource name always qualifies it by source/,
  );
  assert.throws(
    () => parse({ sources: one, resources: { incident: { physical: '' } } }),
    /resources "incident" has a "physical" that is not a table id/,
  );
});

test('source bindings cannot carry connection URLs or repeat the same configured reference', () => {
  for (const connection of [
    'postgres://admin:secret@private-host/db',
    ' postgresql://admin:secret@private-host/db ',
    'sqlite:///private/secret.db',
  ]) {
    assert.throws(
      () => parse({ sources: { operations: { connection } } }),
      (error) => {
        assert.match((error as Error).message, /reference server configuration/);
        assert.doesNotMatch((error as Error).message, /admin|secret|private-host/);
        return true;
      },
    );
  }
  assert.throws(
    () =>
      parse({
        sources: {
          operations: { connection: 'atlas', default: true },
          inventory: { connection: ' atlas ' },
        },
      }),
    /repeats connection "atlas".*its own "schema"/,
  );
  assert.equal(Object.getPrototypeOf(parse({ sources: { operations: { connection: 'atlas' } } }).sources), Object.prototype);
  assert.equal(({} as Record<string, unknown>).operations, undefined);
});

test('JSON authoring schema expresses source defaults and reference-only bindings', () => {
  const schema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.sources.minProperties, 1);
  assert.equal(schema.properties.sources.additionalProperties.$ref, '#/$defs/source');
  // The default is a fact about one source; the root has no key for it.
  assert.equal(schema.properties.defaultSource, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.$defs.source.properties.default, {
    type: 'boolean',
    description: schema.$defs.source.properties.default.description,
  });
  assert.equal(schema.$defs.source.properties.schema.type, 'string');
  assert.deepEqual(schema.$defs.source.properties.resources.oneOf[0], { const: 'all' });
  assert.deepEqual(schema.$defs.source.required, ['connection']);
  assert.equal(schema.$defs.source.additionalProperties, false);
});

test('TS DSL accepts named source maps and rejects driver credential fields', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.app-sources-typecheck.ts');
  const source = [
    'import { listView, type AppConfig, type TypedAppConfig } from "@mistriwork/mistri/app";',
    'const app = { name: "Service Atlas", sources: { operations: { connection: "atlas", default: true }, inventory: { connection: "assets" } },',
    '  resources: { incidents: { physical: "public.incident" } }, views: { incidents: listView("incidents") }, home: "incidents" } satisfies AppConfig;',
    'const typed = { ...app, views: { incidents: listView("incidents") }, home: "incidents", nav: ["incidents"] } satisfies TypedAppConfig<{ incidents: "id" | "name" }>;',
    '// A source standing alone keeps its qualified names by saying it is not the default; a schema and its tables are its own.',
    'const qualified: AppConfig = { name: "Kept", views: { incidents: listView("operations.incidents") }, home: "incidents",',
    '  sources: { operations: { connection: "atlas", default: false, schema: "ops", resources: ["incidents"] } } };',
    '// @ts-expect-error A source brings in its tables as a list or all of them.',
    'const someTables: AppConfig = { name: "Bad", views: {}, home: "incidents", sources: { operations: { connection: "atlas", resources: "some" } } };',
    '// @ts-expect-error A source is a named binding, not an inline driver configuration.',
    'const credentials: AppConfig = { name: "Bad", views: { incidents: listView("incidents") }, home: "incidents", sources: { operations: { connection: "atlas", password: "secret" } } };',
    '// @ts-expect-error Connection bindings must be strings.',
    'const wrongConnection: AppConfig = { name: "Bad", views: { incidents: listView("incidents") }, home: "incidents", sources: { operations: { connection: 3 } } };',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
