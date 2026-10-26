/**
 * Handing a walk to an agent.
 *
 * The document is the feature. Its failure mode is quiet omission — a
 * connection left out, a projection that silently widens back to the whole
 * table, values pasted into a chat window nobody meant to send — and none of
 * those look wrong at the call site. So the test reads the whole document.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { agentContext, positionOf } from '../packages/kit/src/client/handoff.js';

const meta = {
  id: 'app.invoice',
  name: 'invoice',
  columns: [
    { name: 'id', type: 'integer', primaryKey: true, nullable: false },
    { name: 'customer_id', type: 'integer', nullable: false, references: { table: 'app.customer', column: 'id' } },
    { name: 'total', type: 'numeric', nullable: true },
  ],
};

const state = {
  activeConnection: 'erp',
  schema: { label: 'erp', dialect: 'postgres', tables: [meta] },
  stack: [
    { kind: 'table', table: 'app.customer', query: 'customer' },
    { kind: 'row', table: 'app.customer', label: 'Harbour Freight' },
    { kind: 'table', table: 'app.invoice', query: "invoice where status = 'open'" },
  ],
};

describe('a position handed to an agent', () => {
  const entry = { kind: 'table', table: 'app.invoice', query: "invoice where status = 'open'" };
  const text = agentContext(
    positionOf(state, entry, {
      columns: ['id', 'total'],
      shown: 20,
      total: 1284,
    }),
  );

  test('names the connection, the dialect and the question', () => {
    assert.match(text, /Connection `erp` \(postgres\)/);
    assert.match(text, /invoice where status = 'open'/);
  });

  test('says how much of the result is on screen', () => {
    assert.match(text, /Showing 20 rows of 1,284 matching/);
  });

  test('carries the projection, not the whole table', () => {
    assert.match(text, /Columns on screen: id, total/);
  });

  test('carries the shape, keys and references included', () => {
    assert.match(text, /- id · integer · key/);
    assert.match(text, /- customer_id · integer · not null · → app\.customer\.id/);
  });

  test('retells the walk that arrived here', () => {
    assert.match(text, /## The walk\n\n- customer\n- Harbour Freight\n- invoice where status = 'open'/);
  });

  test('hands over a runnable MCP call', () => {
    const json = text.slice(text.indexOf('```json') + 7);
    const call = JSON.parse(json.slice(0, json.indexOf('```')));
    assert.equal(call.name, 'query');
    assert.deepEqual(call.arguments, { connection: 'erp', q: "invoice where status = 'open'", limit: 20 });
  });

  test('does not paste the rows anywhere', () => {
    /* Copying a position must not be a way to send data somewhere by
       accident: the document says how to fetch, and fetching stays a
       decision. */
    assert.match(text, /not included here/);
  });
});

describe('a record handed to an agent', () => {
  const entry = { kind: 'row', table: 'app.invoice', label: 'INV-2231', key: { id: 2231 } };
  const text = agentContext(
    positionOf(state, entry, {
      record: { key: entry.key, label: entry.label },
    }),
  );

  test('is about one row, named and keyed', () => {
    assert.match(text, /One row of `app\.invoice`: \*\*INV-2231\*\*/);
    assert.match(text, /\{"id":2231\}/);
  });

  test('offers `record`, which is the tool that answers it', () => {
    const json = text.slice(text.lastIndexOf('```json') + 7);
    const call = JSON.parse(json.slice(0, json.indexOf('```')));
    assert.equal(call.name, 'record');
    assert.deepEqual(call.arguments, { connection: 'erp', table: 'app.invoice', key: { id: 2231 } });
  });

  test('leaves out the row-count line a single row would make nonsense of', () => {
    assert.doesNotMatch(text, /Showing/);
  });
});
