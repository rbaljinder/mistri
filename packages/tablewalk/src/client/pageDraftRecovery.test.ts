import { beforeEach, expect, test } from 'vitest';
import { pageDraftRecovery } from './pageDraftRecovery.js';
import type { PageDraft } from './components/pageDraft.js';

const page = (): PageDraft => ({
  id: 'config:customer',
  base: 'customer',
  name: 'Customer',
  source: 'config',
  sections: [{ kind: 'fields' }],
});
const draft = (): PageDraft => ({ ...page(), id: 'saved:customer:123', source: 'saved', name: 'Working layout' });
beforeEach(() => localStorage.clear());

test('recovers copies under the original identity, scoped to the connection', () => {
  const session = pageDraftRecovery('a', page());
  expect(session.status).toBe('empty');
  expect(session.write(draft())).toBe('stored');
  expect(pageDraftRecovery('a', page()).recovered?.draft).toEqual(draft());
  expect(pageDraftRecovery('b', page()).recovered).toBeUndefined();
  expect(pageDraftRecovery('a', { ...page(), id: 'another' }).recovered).toBeUndefined();
  expect(session.clear()).toBe('empty');
  expect(pageDraftRecovery('a', page()).recovered).toBeUndefined();
});

test('snapshots drafts and notices source changes', () => {
  const changed = draft();
  pageDraftRecovery('a', page()).write(changed);
  changed.name = 'Later mutation';
  const loaded = pageDraftRecovery('a', { ...page(), name: 'New source' });
  expect(loaded.sourceChanged).toBe(true);
  expect(loaded.recovered?.draft.name).toBe('Working layout');
});

test('an old session cannot overwrite or delete another editor recovery', () => {
  const first = pageDraftRecovery('a', page());
  const second = pageDraftRecovery('a', page());
  first.write(draft());
  expect(second.write({ ...draft(), name: 'Other tab' })).toBe('conflict');
  expect(second.clear()).toBe('conflict');
  const newer = pageDraftRecovery('a', page());
  expect(newer.write({ ...draft(), name: 'Newer draft' })).toBe('stored');
  expect(first.clear()).toBe('conflict');
  expect(pageDraftRecovery('a', page()).recovered?.draft.name).toBe('Newer draft');
});

test('blocked storage is reported and can recover on a later attempt', () => {
  let blocked = true;
  const session = pageDraftRecovery('a', page(), () => {
    if (blocked) throw new Error('Denied');
    return localStorage;
  });
  expect(session.status).toBe('unavailable');
  expect(session.write(draft())).toBe('unavailable');
  blocked = false;
  expect(session.write(draft())).toBe('stored');
});

test('unfinished layouts remain recoverable but malformed storage is not rendered', () => {
  const session = pageDraftRecovery('a', page());
  session.write({ ...draft(), name: '', sections: [] });
  expect(pageDraftRecovery('a', page()).recovered?.draft).toMatchObject({ name: '', sections: [] });
  session.write({ ...draft(), sections: [{ kind: 'metric', from: 'invoice', path: 'customer_id', fn: 'sum' }] });
  expect(pageDraftRecovery('a', page()).recovered?.draft.sections).toHaveLength(1);
  const key = localStorage.key(0)!;
  localStorage.setItem(key, '{broken');
  expect(pageDraftRecovery('a', page()).recovered).toBeUndefined();
  localStorage.setItem(
    key,
    JSON.stringify({ version: 1, original: '{}', revision: 'x', updatedAt: 1, draft: { ...draft(), sections: [null] } }),
  );
  expect(pageDraftRecovery('a', page()).recovered).toBeUndefined();
});
