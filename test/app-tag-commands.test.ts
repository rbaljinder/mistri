/**
 * A tag picker that runs the App's own commands (`tags: { add, remove }`) is
 * served those commands as an action is, with no action of their own: granted both, the reader's App lists them; granted neither, the
 * picker is the link table's, judged by its own writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleBusinessCommandActions } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { servedCommandIds } from '../packages/mistri/src/shared/appCommandIds.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';

const tagInput = { tag: { label: 'Tag', type: 'number' } } as const;
const app = parseTestApp(
  {
    id: 'desk',
    name: 'Desk',
    sources: { desk: { connection: 'desk-db' } },
    resources: {
      ticket: {
        access: 'write',
        tags: {
          through: 'ticket_label',
          to: 'label',
          add: 'label',
          remove: 'unlabel',
        },
      },
      ticket_label: {},
      label: {},
    },
    auth: { roles: { agent: { read: true, commands: ['label', 'unlabel'] }, viewer: { read: true } } },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
  },
  'tag commands fixture',
  { label: { target: 'ticket', input: tagInput }, unlabel: { target: 'ticket', input: tagInput } },
);
const run = defineCommand({ source: 'desk', target: 'ticket', input: { tag: field.number() }, handle: async () => undefined });
const commands = defineCommands({ label: run, unlabel: run });
const table = (id: string, columns: string[]) => ({
  id,
  name: id,
  schema: 'main',
  isView: false,
  columns: columns.map((name, i) => ({ name, type: 'INTEGER', primaryKey: i === 0, nullable: i !== 0 })),
});
const schema: DatabaseSchema = {
  label: 'desk',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [table('ticket', ['id', 'version']), table('ticket_label', ['id', 'ticket_id', 'label_id']), table('label', ['id', 'name'])],
};

test("a tag picker's commands are served to a reader who runs them, and the picker is the link table's otherwise", () => {
  const agent = visibleBusinessCommandActions(app, commands, schema, ['agent']);
  assert.deepEqual(servedCommandIds(agent), ['label', 'unlabel']);
  assert.equal(agent.resources!.ticket.tags!.add!.id, 'label');
  const viewer = visibleBusinessCommandActions(app, commands, schema, ['viewer']);
  assert.deepEqual(servedCommandIds(viewer), []);
  assert.deepEqual(viewer.resources!.ticket.tags, { through: 'ticket_label', to: 'label' });
});
