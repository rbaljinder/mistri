/**
 * A card over a link (join) table opens the far side: the author's `opens`, else the one reference of a table that
 * is two references and nothing else of note which `whose` does not name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkTarget, type TableMeta } from '../packages/engine/src/shared/schema.js';

const column = (name: string, over: object = {}) => ({ name, type: 'integer', nullable: false, primaryKey: false, ...over });
const table = (columns: TableMeta['columns']): TableMeta => ({ id: 'link', name: 'link', schema: '', isView: false, columns });
const ref = (name: string, to: string) => column(name, { references: { table: to, column: 'id' } });

test('a table of two references, a key and dates opens the one whose does not name', () => {
  const link = table([
    column('id', { primaryKey: true }),
    ref('ticket_id', 'ticket'),
    ref('conversation_id', 'conversation'),
    column('linked_at', { type: 'timestamp' }),
  ]);
  assert.equal(linkTarget(link, 'ticket_id'), 'conversation_id');
  assert.equal(linkTarget(link, 'conversation_id'), 'ticket_id');
});

test('a table with anything else of note opens its own row, unless the author names the target', () => {
  const rich = table([
    column('id', { primaryKey: true }),
    ref('ticket_id', 'ticket'),
    ref('conversation_id', 'conversation'),
    column('note', { type: 'text' }),
  ]);
  assert.equal(linkTarget(rich, 'ticket_id'), undefined);
  assert.equal(linkTarget(rich, 'ticket_id', 'conversation_id'), 'conversation_id');
  assert.equal(linkTarget(table([column('id', { primaryKey: true }), ref('ticket_id', 'ticket')]), 'ticket_id'), undefined);
  assert.equal(linkTarget(table([ref('a_id', 'a'), ref('b_id', 'b')]), 'a.b_id'), undefined, 'a path back is not read');
});
