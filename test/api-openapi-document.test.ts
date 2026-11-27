/** Pure composed API document: the read half stays exactly the read preview,
 * and narrowing/comparison treat each half with its own rules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareApiOpenApiDocuments,
  narrowApiOpenApi,
  renderApiOpenApi,
  splitApiOpenApi,
} from '../packages/mistri/src/server/api/apiOpenApiDocument.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi } from './support/commandCatalog.js';

const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'Logical',
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
        { name: 'revision', type: 'INTEGER', primaryKey: false, nullable: false },
      ],
    },
  ],
};
const evidence = { connectionFor: () => 'private', writableConnection: () => true, transactionalConnection: () => true };
function setup(options: { commands?: boolean; noteType?: 'text' | 'number'; many?: boolean } = {}) {
  const commands = options.commands ?? true;
  const input = { note: { type: options.noteType ?? 'text', optional: true } } as const;
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      sources: { business: { connection: 'private' } },
      resources: { item: { access: 'write' } },
      auth: { roles: { editor: { read: true, commands: ['edit'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'fixture',
  );
  app.api = parseTestApi(
    {
      version: 1,
      roles: ['editor'],
      resources: { item: { fields: ['id', 'revision'], sorts: [], filters: [] } },
      commands: commands ? [{ id: 'edit', version: 1, target: 'item', input, ...(options.many ? { targets: 'many' } : {}) }] : [],
    },
    ['editor'],
  )!;
  const registry = defineCommands({
    edit: defineCommand({
      source: 'business',
      target: 'item',
      input,
      ...(options.many ? { targets: 'many' as const } : {}),
      output: shape({ ok: bool() }),
      handle() {
        return { ok: true };
      },
    }),
  });
  return {
    app,
    registry,
    composed: () => renderApiOpenApi(app, schema, registry, evidence, { integers: 'decimal-string' }).document,
    // The read preview of the same App, commands projected out as the composer does.
    read: () => renderApiReadOpenApi({ ...app, api: { ...app.api!, commands: [] } }, schema, { integers: 'decimal-string' }).document,
  };
}

test('the composed document keeps the read preview intact and adds only command routes and components', () => {
  const f = setup(),
    doc = f.composed() as Record<string, any>;
  assert.equal(doc['x-mistri-document'], 'app-api');
  const split = splitApiOpenApi(doc);
  assert.deepEqual(JSON.parse(JSON.stringify(split.read)), JSON.parse(JSON.stringify(f.read())));
  assert.deepEqual(Object.keys(split.commands.paths).sort(), [
    '/commands/edit/v1/receipts/{idempotencyKey}',
    '/item/{id}/commands/edit/v1',
    '/item/{id}/commands/edit/v1/prepare',
  ]);
  assert.ok(Object.keys(split.commands.schemas).every((name) => name.startsWith('Command')));
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.paths));
  // A read-only preview is a document with no commands.
  assert.deepEqual(splitApiOpenApi(f.read()).commands, { paths: {}, schemas: {} });
  assert.throws(() => splitApiOpenApi({ ...doc, 'x-mistri-document': 'something-else' }));
  assert.throws(() => splitApiOpenApi({ ...f.read(), paths: { ...f.read().paths, ...split.commands.paths } }));
});

test('narrowing keeps each granted operation with only what it references, and refuses unknown scope', () => {
  const doc = setup().composed();
  const readOnly = narrowApiOpenApi(doc, ['list:item']);
  assert.deepEqual(Object.keys(readOnly.paths), ['/item']);
  assert.ok(Object.keys(readOnly.components.schemas).every((name: string) => !name.startsWith('Command')));
  const commandOnly = narrowApiOpenApi(doc, ['command:edit']);
  assert.deepEqual(Object.keys(commandOnly.paths).sort(), [
    '/commands/edit/v1/receipts/{idempotencyKey}',
    '/item/{id}/commands/edit/v1',
    '/item/{id}/commands/edit/v1/prepare',
  ]);
  assert.ok(Object.keys(commandOnly.components.schemas).every((name: string) => name.startsWith('Command')));
  assert.doesNotMatch(JSON.stringify(commandOnly), /x-mistri-eligible-roles/);
  const none = narrowApiOpenApi(doc, []);
  assert.deepEqual(none.paths, {});
  assert.deepEqual(none.components.schemas, {});
  for (const ids of [['command:missing'], ['item:missing'], ['other:x'], ['command:edit', 'command:edit']]) {
    assert.throws(() => narrowApiOpenApi(doc, ids), TypeError, ids.join(','));
  }
});

test('comparison: unchanged is clean, adding commands is additive, changing or removing one needs review', () => {
  const f = setup();
  const same = compareApiOpenApiDocuments(f.composed(), f.composed());
  assert.deepEqual(same.findings, []);
  assert.equal(same.versionRequirementMet, true);
  const added = compareApiOpenApiDocuments(setup({ commands: false }).read(), f.composed());
  assert.ok(added.findings.length && added.findings.every((finding) => finding.classification === 'additive'));
  assert.equal(added.requiresVersionBump, false);
  const changed = compareApiOpenApiDocuments(f.composed(), setup({ noteType: 'number' }).composed());
  assert.ok(changed.findings.some((finding) => finding.change === 'command-schema-changed'));
  assert.equal(changed.requiresVersionBump, true);
  assert.equal(changed.versionRequirementMet, false);
  const removed = compareApiOpenApiDocuments(f.composed(), setup({ commands: false }).composed());
  assert.ok(removed.findings.some((finding) => finding.change === 'operation-removed'));
  assert.equal(removed.requiresVersionBump, true);
});

test('a document that nests past the canonical depth names the limit, the path and what to change', () => {
  /* A many command's body reached 17 levels and the walk refused it as a command request is refused, "The command
     request is invalid.", which told the App's author nothing. */
  assert.throws(
    () => setup({ many: true }).composed(),
    (error: Error) => {
      assert.doesNotMatch(error.message, /command request is invalid/);
      assert.match(error.message, /deeper than the 16 levels/);
      assert.match(error.message, /at paths › \/item\/commands\/edit\/v1 › post › requestBody .* › targets › items/);
      assert.match(error.message, /\[api-document-depth\]/);
      assert.match(error.message, /Command "edit" takes many records.*take `targets: 'many'` off its entry in `api\.commands`/);
      return true;
    },
  );
});

test('a document past the 10,000-node ceiling names the limit, its node count, and its largest entries (#581)', () => {
  const tableCount = 35;
  const colCount = 35;
  const tables = Array.from({ length: tableCount }, (_, t) => ({
    id: `tbl_${t}`,
    name: `tbl_${t}`,
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
      ...Array.from({ length: colCount }, (_, c) => ({ name: `col_${c}`, type: 'TEXT', primaryKey: false, nullable: true })),
    ],
  }));
  const largeSchema: DatabaseSchema = { dialect: 'sqlite', label: 'Logical', readAt: '', foreignKeys: [], tables };
  const resources = Object.fromEntries(tables.map((t) => [t.id, { access: 'write' as const }]));
  const apiResources = Object.fromEntries(
    tables.map((t) => [t.id, { fields: t.columns.map((c) => c.name), sorts: [] as string[], filters: [] as string[] }]),
  );
  const app = parseAppConfig(
    {
      id: 'big',
      name: 'Big',
      sources: { business: { connection: 'private' } },
      resources,
      auth: { roles: { editor: { read: true, commands: ['edit'] } } },
      views: { items: { kind: 'list', from: 'tbl_0' } },
      home: 'items',
    },
    'fixture',
  );
  const input = { note: { type: 'text' as const, optional: true } };
  app.api = parseTestApi(
    {
      version: 1,
      roles: ['editor'],
      resources: apiResources,
      commands: [{ id: 'edit', version: 1, target: 'tbl_0', input }],
    },
    ['editor'],
  )!;
  const registry = defineCommands({
    edit: defineCommand({
      source: 'business',
      target: 'tbl_0',
      input,
      read: ['tbl_0'],
      write: ['tbl_0'],
      output: shape({ ok: bool() }),
      async handle() {
        return { ok: true };
      },
    }),
  });
  assert.throws(
    () => renderApiOpenApi(app, largeSchema, registry, evidence, { integers: 'number' }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /command request is invalid/);
      assert.match(error.message, /past the 10,000-node limit/);
      assert.match(error.message, /\[api-document-size\]/);
      assert.match(error.message, /Largest entries:/);
      return true;
    },
  );
});
