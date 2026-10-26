import { beforeEach, expect, test } from 'vitest';
import { layoutDraftRecovery } from './layoutDraftRecovery.js';
import type { Template } from './components/LayoutBuilder.js';

const layout = (): Template => ({ id: 'derived:customer', base: 'customer', name: 'Customer', sections: [] });
beforeEach(() => localStorage.clear());

test('record-layout recovery is scoped by connection and table, separate from saved state', () => {
  const original = layout();
  const owner = layoutDraftRecovery('a', original);
  const draft = { ...original, name: 'Draft' };
  expect(owner.write(draft)).toBe('stored');
  draft.name = 'Later mutation';
  expect(layoutDraftRecovery('a', original).recovered?.draft.name).toBe('Draft');
  expect(layoutDraftRecovery('b', original).recovered).toBeUndefined();
  expect(layoutDraftRecovery('a', { ...original, base: 'invoice' }).recovered).toBeUndefined();
  expect(layoutDraftRecovery('a', { ...original, name: 'Changed source' }).sourceChanged).toBe(true);
});

test('an older record editor cannot erase a newer recovery copy', () => {
  const first = layoutDraftRecovery('a', layout());
  first.write({ ...layout(), name: 'First' });
  const second = layoutDraftRecovery('a', layout());
  second.write({ ...layout(), name: 'Second' });
  expect(first.clear()).toBe('conflict');
  expect(first.write(layout())).toBe('conflict');
  expect(layoutDraftRecovery('a', layout()).recovered?.draft.name).toBe('Second');
});

test.each([
  null,
  { kind: 'fields', paths: [4] },
  { kind: 'list', via: 'fk', columns: null },
  { kind: 'list', via: 'fk', columns: [], limit: -1 },
  { kind: 'other' },
])('malformed sections are never restored: %j', (section) => {
  const owner = layoutDraftRecovery('a', layout());
  owner.write({ ...layout(), sections: [section] } as unknown as Template);
  expect(layoutDraftRecovery('a', layout()).recovered).toBeUndefined();
});
