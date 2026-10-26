/**
 * A field's `default`: what it starts as — a literal, `today`, `now`, `me` or
 * `{ record: column }`. What the declaration accepts, where a command may
 * start a field from the record or the reader, and what prepare serves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineSource, type CommandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { readPreparedRecord } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { preparesInitial } from '../packages/mistri/src/server/commands/commandPrepareNeeds.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandReferenceProblem } from '../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const today = { auto: 'today' } as const;
const now = { auto: 'now' } as const;
const me = { auto: 'me' } as const;

test('a default is a literal, or a word the field can hold, and the record and the reader fill the input itself', () => {
  const [channel, due, at, by, count] = parseCommandInput(
    {
      channel: field.choice(['phone', 'store'], { default: 'phone' }),
      due: field.date({ default: today }),
      at: field.datetime({ default: now }),
      by: field.email({ default: me }),
      count: field.number({ default: { record: 'on_hand' } }),
    },
    'input',
  );
  assert.deepEqual(
    [channel, due, at, by, count].map((f) => (f.type === 'group' ? undefined : f.default)),
    ['phone', today, now, me, { record: 'on_hand' }],
  );
  const refused = (input: Record<string, unknown>, options = {}) => assert.throws(() => parseCommandInput(input, 'input', options));
  refused({ due: { type: 'text', default: today } }, {});
  refused({ at: { type: 'date', default: now } });
  refused({ count: { type: 'number', default: me } });
  refused({ count: { type: 'number', default: { record: 'on_hand', extra: 1 } } });
  refused({ count: { type: 'number', default: [1] } });
  refused({ lines: { type: 'group', fields: { qty: { type: 'number' } }, default: 1 } });
  // The record and the reader are one record's; a group's rows and a public form have neither.
  refused({ lines: { type: 'group', fields: { qty: { type: 'number', default: { record: 'on_hand' } } } } });
  refused({ who: { type: 'text', default: me } }, { publicForm: true });
  assert.doesNotThrow(() => parseCommandInput({ lines: { type: 'group', fields: { qty: { type: 'number', default: 1 } } } }, 'input'));
});

const source = defineSource<{ level: { id: number; version: number; on_hand: string; note: string | null } }>('stock');
const base = { source, target: 'level' as const, output: bool(), handle: () => true };

test('defined, a literal must be an answer the field accepts, the record starts only a one-record command, the reader no selection', () => {
  assert.throws(
    () => defineCommand({ ...base, input: { qty: field.number({ min: 1, default: 0 }) } }),
    /starts as 0, which the field itself refuses/,
  );
  assert.throws(() => defineCommand({ ...base, input: { pick: field.choice(['a', 'b'], { default: 'c' }) } }), /field itself refuses/);
  assert.throws(
    () => defineCommand({ ...base, targets: 'none', input: { qty: field.number({ default: { record: 'on_hand' } }) } }),
    /starts from the record, which only a command that targets one record reads/,
  );
  assert.throws(() => defineCommand({ ...base, targets: 'many', input: { by: field.email({ default: me }) } }), /starts from the reader/);
  // A signed-in form prepares its reader.
  assert.ok(defineCommand({ ...base, targets: 'none', input: { by: field.email({ default: me }) } }));
  assert.ok(
    defineCommand({ ...base, targets: 'none', input: { qty: field.number({ min: 1, default: 1 }), on: field.date({ default: today }) } }),
  );
});

test('an App names a column the record has', () => {
  const schema = {
    label: 'Stock',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'level',
        name: 'level',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'on_hand', type: 'NUMERIC', nullable: false, primaryKey: false },
        ],
      },
    ],
  } as DatabaseSchema;
  const reference = (column: string) => ({
    id: 'adjust',
    version: 1,
    target: 'level',
    input: parseCommandInput({ qty: field.number({ default: { record: column } }) }, 'input'),
  });
  assert.equal(commandReferenceProblem(reference('on_hand'), 'level', schema), undefined);
  assert.match(commandReferenceProblem(reference('nope'), 'level', schema)!, /starts from record\.nope, which is not a column of level/);
});

const catalog: CommandCatalog = {
  level: {
    name: 'level',
    key: ['id'],
    kinds: { id: 'number', version: 'number', on_hand: 'number', note: 'text' },
    meta: {
      id: 'level',
      name: 'level',
      schema: '',
      isView: false,
      columns: ['id', 'version', 'on_hand', 'note'].map((name) => ({
        name,
        type: name === 'note' ? 'TEXT' : 'NUMERIC',
        nullable: true,
        primaryKey: name === 'id',
      })),
    },
  },
};

test('prepare starts each field from the record and the reader, under what initial() says', async () => {
  const reader = {
    // A NUMERIC column comes back as text from some drivers: a number field still starts as the number.
    query: async () => ({ rows: [{ id: 4, version: 2, on_hand: '17', note: null }] }),
    count: async () => 1,
  } as unknown as WriteTransaction;
  const prepare = (command: Parameters<typeof readPreparedRecord>[1]['command'], email?: string) =>
    readPreparedRecord(reader, {
      command,
      commandId: 'adjust',
      actor: { id: 'account', appId: 'stock', roles: ['staff'], ...(email ? { email } : {}) },
      key: { id: 4 },
      catalog,
    });
  const adjust = defineCommand({
    ...base,
    input: {
      qty: field.number({ integer: true, min: 0, default: { record: 'on_hand' } }),
      note: field.text({ optional: true, default: { record: 'note' } }),
      counted_by: field.email({ default: me }),
      reason: field.choice(['count', 'damage'], { default: 'count' }),
    },
  });
  assert.equal(preparesInitial(adjust), true);
  // The literal is the browser's to fill as the form opens; an empty column starts nothing.
  assert.deepEqual((await prepare(adjust, 'mara@example.test')).initial, { qty: 17, counted_by: 'mara@example.test' });
  assert.deepEqual((await prepare(adjust)).initial, { qty: 17 });
  const over = defineCommand({
    ...base,
    input: { qty: field.number({ default: { record: 'on_hand' } }), note: field.text({ optional: true }) },
    initial: () => ({ qty: 3, note: 'recount' }),
  });
  assert.deepEqual((await prepare(over)).initial, { qty: 3, note: 'recount' });
  // A start the field refuses (past its max) is left for the reader, and the form still opens.
  const capped = defineCommand({ ...base, input: { qty: field.number({ max: 10, default: { record: 'on_hand' } }) } });
  assert.equal((await prepare(capped)).initial, undefined);
});

test("a signed-in form's command prepares over no record: the reader's start and initial(), and refuses a key", async () => {
  const reads: unknown[] = [];
  const reader = {
    query: async (request: unknown) => {
      reads.push(request);
      return { rows: [{ id: 1, version: 0, on_hand: '5', note: 'evening' }] };
    },
    count: async () => 1,
  } as unknown as WriteTransaction;
  const prepare = (command: Parameters<typeof readPreparedRecord>[1]['command'], key = {}) =>
    readPreparedRecord(reader, {
      command,
      commandId: 'request',
      actor: { id: 'account', appId: 'stock', roles: ['staff'], email: 'mara@example.test' },
      key,
      catalog,
    });
  const plain = defineCommand({ ...base, targets: 'none', input: { qty: field.number({ default: 1 }) } });
  // A literal is the browser's: nothing to prepare, and no record read for a revision it does not have.
  assert.equal(preparesInitial(plain), false);
  assert.deepEqual(await prepare(plain), { expectedVersion: 0 });
  const request = defineCommand({
    ...base,
    targets: 'none',
    input: { by: field.email({ default: me }), window: field.text(), risk: field.choice(['low', 'moderate']) },
    initial: (context) => {
      assert.equal('record' in context, false);
      return { window: 'evening', risk: 'moderate' };
    },
  });
  assert.deepEqual(await prepare(request), {
    expectedVersion: 0,
    initial: { by: 'mara@example.test', window: 'evening', risk: 'moderate' },
  });
  assert.deepEqual(reads, []);
  await assert.rejects(prepare(request, { id: 1 }), { code: 'invalid_input' });
  // What initial() returns is served only as the input can hold it.
  const wrong = defineCommand({
    ...base,
    targets: 'none',
    input: { risk: field.choice(['low']) },
    initial: () => ({ risk: 'high' as never }),
  });
  await assert.rejects(prepare(wrong), { code: 'invalid_result' });
});
