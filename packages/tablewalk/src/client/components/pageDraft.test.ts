import { expect, test } from 'vitest';
import { checkedDraft, type PageDraft } from './pageDraft.js';

const draft = (): PageDraft => ({
  id: 'saved:customer:1',
  name: 'Customer',
  base: 'customer',
  source: 'saved',
  connection: 'crm',
  listTabs: false,
  sections: [{ kind: 'fields', paths: ['name'], width: 'full' }],
});

test('validation preserves saved identity, explicit defaults, and an independent snapshot', () => {
  const original = draft();
  const checked = checkedDraft(original);
  expect(checked).toEqual(original);
  expect(checked).not.toBe(original);
  expect(checked.sections[0]).not.toBe(original.sections[0]);
});

test('incomplete and invalid edits are rejected by the same DSL parser', () => {
  expect(() => checkedDraft({ ...draft(), name: '   ' })).toThrow('Invalid caption at Page editor: page 1.label');
  expect(() => checkedDraft({ ...draft(), sections: [] })).toThrow('at least one section');
  expect(() => checkedDraft({ ...draft(), sections: [{ kind: 'metric', fn: 'sum', from: 'invoice', path: 'customer_id' }] })).toThrow(
    'no column to sum',
  );
  expect(() => checkedDraft({ ...draft(), sections: [{ kind: 'list', from: 'invoice', path: 'customer_id', limit: -1 }] })).toThrow(
    'positive whole number',
  );
  expect(() => checkedDraft({ ...draft(), sections: [{ kind: 'timeline', streams: [] }] })).toThrow('needs "streams"');
});
