/** Where an App's reader has been: rooms and records, newest first, in memory, and not where they are. */
import { afterEach, expect, test } from 'vitest';
import { forgetVisits, noteVisit, recentVisits } from './paletteRecents.js';

afterEach(forgetVisits);

test('rooms and records are visits, newest first, and the one the reader is on is not one of them', () => {
  noteVisit({ kind: 'table', view: 'leases' });
  noteVisit({ kind: 'page', pageId: 'dash-today' });
  noteVisit({ kind: 'row', table: 'lease', key: { id: 7 }, label: 'Alder Court #101' });
  expect(recentVisits().map((visit) => visit.id)).toEqual(['room:today', 'room:leases']);
  noteVisit({ kind: 'table', view: 'repairs' });
  expect(recentVisits().map((visit) => visit.id)).toEqual([expect.stringMatching(/^record:lease:/), 'room:today', 'room:leases']);
});

test('a form and the assistant are rooms; a page with nothing chosen, a drawer’s peek and a list with no view are not', () => {
  noteVisit({ kind: 'page', pageId: 'form-postRent' });
  noteVisit({ kind: 'page', pageId: 'app:assistant' });
  noteVisit({ kind: 'page', pageId: 'invoice-page' });
  noteVisit({ kind: 'table' });
  noteVisit(undefined);
  expect(recentVisits().map((visit) => visit.id)).toEqual(['room:assistant', 'room:postRent']);
});

test('a record is one visit however it was reached, and is noted once it has a name', () => {
  noteVisit({ kind: 'row', table: 'lease', key: { id: 7 } });
  expect(recentVisits()).toEqual([]);
  noteVisit({ kind: 'row', table: 'lease', key: { id: 7 }, label: 'Alder Court #101' });
  noteVisit({ kind: 'table', view: 'leases' });
  // The same record by a numeric key and by a string one is one entry, as pagemarks.js has it.
  noteVisit({ kind: 'page', pageId: 'lease-page', table: 'lease', key: { id: '7' }, label: 'Alder Court #101' });
  noteVisit({ kind: 'table', view: 'repairs' });
  expect(recentVisits().map((visit) => ('label' in visit ? visit.label : visit.room))).toEqual(['Alder Court #101', 'leases']);
});

test('the list is a shortlist and forgetting empties it', () => {
  for (let i = 0; i < 20; i += 1) noteVisit({ kind: 'table', view: `room${i}` });
  expect(recentVisits().length).toBeLessThanOrEqual(8);
  forgetVisits();
  expect(recentVisits()).toEqual([]);
});
