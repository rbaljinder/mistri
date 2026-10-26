/**
 * A picker narrowed by the record (`field.reference('order_line', { query:
 * 'sales_order_id = record.id' })`): what the catalog accepts, how prepare
 * binds the record's values into the query it serves.
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
import {
  boundRecordQuery,
  commandInputProblem,
  commandReferenceProblem,
  recordColumnsIn,
  type AppCommandField,
  type AppCommandReference,
} from '../packages/mistri/src/shared/command.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type = 'INTEGER', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const schema = {
  label: 'Shop',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'sales_order',
      name: 'sales_order',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('region', 'TEXT')],
    },
    {
      id: 'order_line',
      name: 'order_line',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('sales_order_id'), column('region', 'TEXT'), column('description', 'TEXT')],
    },
  ],
  foreignKeys: [
    { name: 'line_order', from: { table: 'order_line', columns: ['sales_order_id'] }, to: { table: 'sales_order', columns: ['id'] } },
  ],
} as DatabaseSchema;

const picker = (query: string): AppCommandField =>
  ({
    name: 'line',
    label: 'Item',
    type: 'reference',
    from: 'order_line',
    by: 'id',
    labelColumn: 'description',
    required: true,
    query,
  }) as AppCommandField;
const command = (query: string, extra: Partial<AppCommandReference> = {}): AppCommandReference => ({
  id: 'requestReturn',
  version: 1,
  target: 'sales_order',
  input: [{ name: 'lines', label: 'Lines', type: 'group', fields: [picker(query)] }],
  ...extra,
});

test('a picker query may name the record’s own columns, and only where there is one record', () => {
  assert.deepEqual(recordColumnsIn('sales_order_id = record.id and region = record.region'), ['id', 'region']);
  // A quoted word is a value, and a path that merely ends in "record" is not the word.
  assert.deepEqual(recordColumnsIn('description = "record.id" and sales_order_id.record.id = 1'), []);

  assert.equal(commandReferenceProblem(command('sales_order_id = record.id'), 'sales_order', schema), undefined);
  assert.equal(commandReferenceProblem(command('region = record.region sort description'), 'sales_order', schema), undefined);
  assert.match(
    commandReferenceProblem(command('sales_order_id = record.nope'), 'sales_order', schema)!,
    /names record\.nope, which is not a column of sales_order/,
  );
  assert.match(
    commandReferenceProblem(command('sales_order_id = record.id', { targets: 'many' }), 'sales_order', schema)!,
    /acts on many records \(targets: 'many'\) has no one record/,
  );
  // Bound, the query is still judged: a column the picked rows lack is wrong whatever the record says.
  assert.match(commandReferenceProblem(command('nope = record.id'), 'sales_order', schema)!, /query: /);
  // A form's command creates its record, so it has none to narrow by.
  assert.match(commandInputProblem([picker('sales_order_id = record.id')], schema)!, /a form's command has no one record/);
});

test('bound, each word is the record’s value, quoted as the query language quotes it; an empty one offers nothing', () => {
  assert.equal(boundRecordQuery('sales_order_id = record.id', { id: 7 }), 'sales_order_id = 7');
  assert.equal(
    boundRecordQuery('region = record.region and id != record.id', { id: 7, region: 'West Coast' }),
    'region = "West Coast" and id != 7',
  );
  assert.equal(boundRecordQuery('region = record.region', { region: 'a"b' }), 'region = "a\\"b"');
  assert.equal(boundRecordQuery('region = record.region', { region: null }), null);
  assert.equal(boundRecordQuery('region = record.region', {}), null);
});

const source = defineSource<{ sales_order: { id: number; version: number; region: string } }>('shop');
const catalog: CommandCatalog = {
  sales_order: {
    name: 'sales_order',
    key: ['id'],
    kinds: { id: 'number', version: 'number', region: 'text' },
    meta: {
      id: 'sales_order',
      name: 'sales_order',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('version'), column('region', 'TEXT')],
    },
  },
};

test('prepare serves each narrowed picker its query bound to the record, by the path the form draws it at', async () => {
  const requestReturn = defineCommand({
    source,
    target: 'sales_order',
    input: {
      lines: field.group(
        { line: field.reference('order_line', { by: 'id', labelColumn: 'description', query: 'sales_order_id = record.id' }) },
        { repeat: { min: 1, max: 5 } },
      ),
      nearby: field.reference('order_line', { by: 'id', labelColumn: 'description', query: 'region = record.region', optional: true }),
      any: field.reference('order_line', { by: 'id', labelColumn: 'description', optional: true }),
    },
    output: bool(),
    handle() {
      throw new Error('Prepare never runs the handler.');
    },
  });
  // No `initial` and no availability: the narrowed picker alone is what makes prepare read the record.
  assert.equal(preparesInitial(requestReturn), true);
  const reader = {
    query: async () => ({ rows: [{ id: 12, version: 3, region: 'North East' }] }),
    count: async () => 1,
  } as unknown as WriteTransaction;
  const prepared = await readPreparedRecord(reader, {
    command: requestReturn,
    commandId: 'requestReturn',
    actor: { id: 'account', appId: 'shop', roles: ['staff'] },
    key: { id: 12 },
    catalog,
  });
  assert.ok(Number.isSafeInteger(prepared.expectedVersion));
  assert.equal(prepared.initial, undefined);
  assert.deepEqual(prepared.choices, { 'lines.line': 'sales_order_id = 12', nearby: 'region = "North East"' });
});
