/*
 * A `when` that names a computed column or a rollup, judged where it runs. A
 * fixed action's is judged inside its write against the stored row, where
 * neither is there: it held for nothing, so load and check now refuse it and
 * name the fix. A form's field `when` is worked out from the draft in the
 * browser, so check accepts what the form evaluates.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveResources, withRollups } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema: DatabaseSchema = {
  label: 'desk',
  readAt: '2026-10-11T00:00:00Z',
  dialect: 'sqlite',
  foreignKeys: [{ name: 'line_fk', from: { table: 'line', columns: ['ticket_id'] }, to: { table: 'ticket', columns: ['id'] } }],
  tables: [
    {
      id: 'ticket',
      name: 'ticket',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }),
        column('qty', 'INTEGER'),
        column('price', 'REAL'),
        column('po_number', 'TEXT'),
        column('status', 'TEXT'),
      ],
    },
    {
      id: 'line',
      name: 'line',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }),
        column('ticket_id', 'INTEGER', { references: { table: 'ticket', column: 'id' } }),
      ],
    },
  ],
};

const problems = (ticket: object) => {
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      resources: {
        ticket: {
          access: 'write',
          computed: { total: { value: 'qty * price', type: 'number' } },
          rollups: { lines: { fn: 'count', from: 'line' } },
          ...ticket,
        },
        line: {},
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'derived-when fixture',
  );
  return resolveResources(app, withRollups(app, schema)).problems;
};

test("a fixed action's when over a computed column or a rollup is refused, naming the fix", () => {
  const computed = problems({ actions: { close: { label: 'Close', set: { status: 'closed' }, when: 'total > 10' } } });
  assert.equal(computed.length, 1);
  assert.match(computed[0], /action "close", when: "total" is computed[^]*run the action as a command, whose when reads it/);
  const rolled = problems({ actions: { close: { label: 'Close', set: { status: 'closed' }, when: 'status = open and lines > 0' } } });
  assert.match(rolled[0], /action "close", when: "lines" is a rollup/);
  // Stored columns are what the write reads: no problem.
  assert.deepEqual(problems({ actions: { close: { label: 'Close', set: { status: 'closed' }, when: 'qty > 1' } } }), []);
});

test("a form field's when over a computed column is accepted, as the form works it out from the draft", () => {
  assert.deepEqual(problems({ form: { show: ['qty', 'price', 'po_number'], when: { po_number: 'total > 1000' } } }), []);
  // A name that is nothing at all is still refused.
  assert.equal(problems({ form: { show: ['qty', 'price', 'po_number'], when: { po_number: 'nothing > 1000' } } }).length, 1);
});
