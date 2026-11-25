/**
 * After a command the page asks again only the reads that could show what it wrote. A read is left alone only where
 * the run said its tables and the read is filed with its own; anything not known is asked again, as it always was.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { state } from '@mistriwork/kit/client/core.js';
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import { fileReads } from '@mistriwork/kit/client/liveReads.js';
import { refreshAfterWrites } from './commandRefresh.js';

const before = state.schema;
/* A board: a list of visits (which shows its patient), a list of rooms, the page's loader over visits, a read that
   says no tables, and two reads that are never filed by table. */
const KEYS = {
  visits: ['mistri-ui', 'rows', 'clinic', 1, 'visit', {}],
  rooms: ['mistri-ui', 'rows', 'clinic', 1, 'room', {}],
  loader: ['mistri-page', 'load', 'clinic', 1, 'today', 'board', {}],
  unfiled: ['mistri-ui', 'breakdown', 'clinic', 1, 'visit', {}],
  availability: ['command-availability', 'x'],
  history: ['page-history', 'visit', { id: 1 }],
} as const;
const answering = (reads: string | null) => () => {
  const answer = { rows: [] };
  fileReads(answer, reads);
  return answer;
};

beforeEach(async () => {
  state.schema = { tables: [{ id: 'visit' }, { id: 'patient' }, { id: 'room' }, { id: 'note' }] } as never;
  await queryClient.fetchQuery({ queryKey: KEYS.visits, queryFn: answering('patient,visit') });
  await queryClient.fetchQuery({ queryKey: KEYS.rooms, queryFn: answering('room') });
  await queryClient.fetchQuery({ queryKey: KEYS.loader, queryFn: answering('patient,visit') });
  await queryClient.fetchQuery({ queryKey: KEYS.unfiled, queryFn: answering(null) });
  await queryClient.fetchQuery({ queryKey: KEYS.availability, queryFn: () => true });
  await queryClient.fetchQuery({ queryKey: KEYS.history, queryFn: () => [] });
});
afterEach(() => {
  queryClient.clear();
  state.schema = before;
});

const stale = () =>
  Object.entries(KEYS)
    .filter(([, queryKey]) => queryClient.getQueryState(queryKey)?.isInvalidated)
    .map(([name]) => name)
    .sort();
/* What is never filed by table is asked after every command. */
const ALWAYS = ['availability', 'history', 'unfiled'];

test('a command that wrote a table a read shows asks that read again, and leaves a read over another table', async () => {
  await refreshAfterWrites(queryClient, ['visit']);
  expect(stale()).toEqual([...ALWAYS, 'loader', 'visits'].sort());
});

test('a table a read reaches without being its own (a reference it shows) asks it again too', async () => {
  await refreshAfterWrites(queryClient, ['patient']);
  expect(stale()).toEqual([...ALWAYS, 'loader', 'visits'].sort());
});

test('a command that wrote nothing asks no filed read again: no list, and not the loader', async () => {
  await refreshAfterWrites(queryClient, []);
  expect(stale()).toEqual(ALWAYS);
});

test('a command that wrote a table no read on the page shows asks none of them', async () => {
  await refreshAfterWrites(queryClient, ['note']);
  expect(stale()).toEqual(ALWAYS);
});

test("where the run's tables are not known, or name one this catalog does not hold, every read is asked again", async () => {
  await refreshAfterWrites(queryClient, undefined);
  expect(stale()).toEqual(Object.keys(KEYS).sort());
  queryClient.clear();
  await queryClient.fetchQuery({ queryKey: KEYS.rooms, queryFn: answering('room') });
  await refreshAfterWrites(queryClient, ['visit', 'ledger']);
  expect(stale()).toEqual(['rooms']);
});
