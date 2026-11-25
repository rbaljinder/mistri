/**
 * An App API declaration's refusals, said together (api/apiRefusals.ts): each exposed command is judged on its own
 * and every refused one is said in one throw, a line each; a fault in mistri's own code is never collected as one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApiCommandCatalog } from '../packages/mistri/src/server/api/apiCommandCatalog.js';
import { ApiRefusals, apiJudgment, refusalsOf } from '../packages/mistri/src/server/api/apiRefusals.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

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

test('every exposed command no role holds is said in one refusal, a line each, beside the one that passes', () => {
  const app = parseTestApp(
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
  const exposed = ['edit', 'archive', 'restore'].map((id) => ({ id, version: 1, target: 'item', input: {} }));
  app.api = parseTestApi({ version: 1, roles: ['editor'], commands: exposed }, ['editor'])!;
  const command = () =>
    defineCommand({ source: 'business', target: 'item', input: {}, output: shape({ ok: bool() }), handle: () => ({ ok: true }) });
  const registry = defineCommands({ edit: command(), archive: command(), restore: command() });
  assert.throws(
    () => checkApiCommandCatalog(app.api!, app, schema, registry, evidence),
    (error: unknown) => {
      assert.ok(error instanceof ApiRefusals);
      assert.deepEqual(
        error.refusals.map((refusal) => refusal.replace(/: .*\[/, ' [')),
        ['api.commands.archive [api-command-unheld].', 'api.commands.restore [api-command-unheld].'],
      );
      assert.equal(error.message.split('\n').length, 2);
      return true;
    },
  );
});

test("a judgment keeps each exposure's refusal once, throws them together, and lets a fault through as it was", () => {
  const judged = apiJudgment();
  assert.equal(
    judged.run(() => 1),
    1,
  );
  judged.run(() => {
    throw new Error('api.resources.a: one.');
  });
  judged.run(() => {
    throw new Error('api.resources.a: one.');
  });
  judged.run(() => {
    throw new ApiRefusals(['api.views.b: two.', 'api.views.c: three.']);
  });
  assert.throws(
    () => judged.done(),
    (error: unknown) => {
      assert.deepEqual(refusalsOf(error), ['api.resources.a: one.', 'api.views.b: two.', 'api.views.c: three.']);
      return true;
    },
  );
  assert.throws(
    () =>
      apiJudgment().run(() => {
        throw new TypeError('a bug');
      }),
    TypeError,
  );
  apiJudgment().done();
});

test('renderAppApiOpenApi says a refused read, a refused generic write and a refused command together', async () => {
  const { renderAppApiOpenApi } = await import('../packages/mistri/src/server/api/apiPublicSpec.js');
  const app = parseTestApp(
    {
      id: 'app',
      name: 'App',
      sources: { business: { connection: 'private' } },
      resources: { item: { access: 'write' } },
      auth: { roles: { editor: { read: true, commands: [] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'fixture',
  );
  app.api = parseTestApi(
    {
      version: 1,
      roles: ['editor'],
      resources: { item: { fields: ['id', 'revision', 'created_at'], sorts: ['created_at'], delete: true } },
      commands: [{ id: 'archive', version: 1, target: 'item', input: {} }],
    },
    ['editor'],
  )!;
  const catalog: DatabaseSchema = {
    ...schema,
    tables: [
      {
        ...schema.tables[0],
        columns: [...schema.tables[0].columns, { name: 'created_at', type: 'TIMESTAMP', primaryKey: false, nullable: false }],
      },
    ],
  };
  const registry = defineCommands({
    archive: defineCommand({ source: 'business', target: 'item', input: {}, output: shape({ ok: bool() }), handle: () => ({ ok: true }) }),
  });
  assert.throws(
    () => renderAppApiOpenApi(app, catalog, { integers: 'decimal-string', commands: registry, evidence }),
    (error: unknown) => {
      const said = refusalsOf(error) ?? [];
      assert.ok(
        said.some((line) => line.includes('[api-write-unsupported]')),
        JSON.stringify(said),
      );
      assert.ok(
        said.some((line) => line.includes('[api-sort-type]')),
        JSON.stringify(said),
      );
      assert.ok(
        said.some((line) => line.includes('[api-command-unheld]')),
        JSON.stringify(said),
      );
      return true;
    },
  );
});
