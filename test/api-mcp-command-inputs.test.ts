/** Every declared input kind reaches the App MCP's tools/list and the API document: a text length,
 * a reference, a group and a `when` are described, never a reason to refuse the session. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { projectApiMcpCommandTools } from '../packages/mistri/src/server/api/apiMcpCommandTools.js';
import { renderApiCommandOpenApi } from '../packages/mistri/src/server/api/apiCommandOpenApi.js';
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
      id: 'flow',
      name: 'flow',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'version', type: 'INTEGER', primaryKey: false, nullable: false },
        { name: 'status', type: 'TEXT', primaryKey: false, nullable: false },
      ],
    },
    {
      id: 'person',
      name: 'person',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
      ],
    },
  ],
};
// As a service-desk App's flow editor asks it: nearly every text has a length.
const input = {
  name: { type: 'text' as const, max: 80 },
  code: { type: 'text' as const, min: 2, max: 12, case: 'upper' as const, pattern: '^[A-Z]+$' },
  owner: { type: 'reference' as const, from: 'person', by: 'id', labelColumn: 'name' },
  reason: { type: 'textarea' as const, max: 500, when: "record.status = 'live'" },
  starts: { type: 'date' as const, optional: true, min: '2026-01-01' },
  steps: { type: 'group' as const, repeat: { min: 1, max: 5 }, fields: { title: { type: 'text' as const, max: 40 } } },
};

function fixture() {
  const app = parseTestApp(
    {
      id: 'flows',
      name: 'Flows',
      sources: { business: { connection: 'private' } },
      resources: { flow: { access: 'write' }, person: {} },
      auth: { roles: { admin: { read: true, commands: ['createFlow'] } } },
      views: { flows: { kind: 'list', from: 'flow' } },
      home: 'flows',
    },
    'fixture',
  );
  app.api = parseTestApi({ version: 1, roles: ['admin'], commands: [{ id: 'createFlow', version: 1, target: 'flow', input }] }, ['admin'])!;
  const registry = defineCommands({
    createFlow: defineCommand({
      source: 'business',
      target: 'flow',
      read: ['flow', 'person'],
      input,
      output: shape({ ok: bool() }),
      handle() {
        return { ok: true };
      },
    }),
  });
  const evidence = { connectionFor: () => 'private', writableConnection: () => true, transactionalConnection: () => true };
  return { app, registry, evidence };
}

test('a command whose inputs carry lengths, a reference, a group and a when is listed, each input described', () => {
  const { app, registry, evidence } = fixture();
  const listed = projectApiMcpCommandTools(
    app,
    schema,
    registry,
    evidence,
    { integers: 'number' },
    { operations: ['command:createFlow'], roles: ['admin'] },
  );
  const run = listed.tools.find((tool) => String(tool.name).startsWith('run_createFlow_'));
  assert.ok(run, 'the run tool is listed');
  const described = (run!.inputSchema as any).properties.input;
  new Ajv2020({ strict: true }).compile(described);
  const props = described.properties;
  assert.equal(props.name.maxLength, 80);
  assert.equal(props.code.minLength, 2);
  assert.equal(props.code.maxLength, 12);
  assert.match(props.code.description, /\^\[A-Z\]\+\$/);
  assert.match(props.code.description, /upper case/);
  assert.match(props.owner.description, /"id" of a "person" row/);
  assert.match(props.reason.description, /status = 'live'/);
  assert.equal(props.steps.type, 'array');
  assert.equal(props.steps.minItems, 1);
  assert.equal(props.steps.items.properties.title.maxLength, 40);
  assert.match(props.starts.description, /On or after 2026-01-01/);
  // Asked only where the record says so: no fixed schema may require it.
  assert.deepEqual([...described.required].sort(), ['code', 'name', 'owner', 'steps']);

  const validate = new Ajv2020({ strict: true }).compile(described);
  assert.equal(validate({ name: 'Onboarding', code: 'ONB', owner: 7, steps: [{ title: 'Laptop' }] }), true);
  assert.equal(validate({ name: 'x'.repeat(81), code: 'ONB', owner: 7, steps: [{ title: 'Laptop' }] }), false);
  assert.equal(validate({ name: 'Onboarding', code: 'ONB', owner: 7, steps: [] }), false);
});

test('the API document describes the same command rather than refusing it', () => {
  const { app, registry, evidence } = fixture();
  const doc = renderApiCommandOpenApi(app, schema, registry, evidence, { integers: 'number' });
  const component = Object.entries(doc.schemas).find(([name]) => name.startsWith('CommandInput_'))![1] as any;
  assert.equal(component.properties.name.maxLength, 80);
  assert.equal(component.properties.steps.items.type, 'object');
});
