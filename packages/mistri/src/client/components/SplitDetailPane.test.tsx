/**
 * An App split's detail pane: it reads the record through the App's page,
 * names the walk's entry once the page does (only while that entry is on
 * top), and its head steps through the list with J/K, replacing the row in
 * the walk with the split's view kept; Details leaves for the page only when
 * leaving is allowed.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { RecordTrail } from '../../../../kit/src/client/recordTrail.js';

const mocks = vi.hoisted(() => ({
  here: undefined as unknown,
  allow: true,
  page: 'ticket-page' as string | null,
  went: [] as Array<[Record<string, unknown>, string]>,
  opened: [] as unknown[][],
  crumbs: 0,
  generation: 0,
  failure: false,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  allowMutationExit: () => mocks.allow,
  currentEntry: () => mocks.here,
  captureNavigation: () => {
    const generation = mocks.generation;
    return () => generation === mocks.generation;
  },
  go: (entry: Record<string, unknown>, how: string) => {
    mocks.went.push([entry, how]);
  },
  openRecord: (...args: unknown[]) => {
    mocks.opened.push(args);
  },
  pageFor: async () => {
    if (mocks.failure) throw new Error('Offline');
    return mocks.page;
  },
  pageView: (pageId: string, table: string, key: unknown, label: unknown) => ({ kind: 'page', pageId, table, key, label }),
  renderCrumbs: () => {
    mocks.crumbs++;
  },
  api: async () => ({ rows: [] }),
  findTable: (id: string) => ({ id, name: id }),
  keyOf: (_t: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_t: unknown, row: Record<string, unknown>) => `#${row.id}`,
}));
vi.mock('../../../../kit/src/client/write.js', () => ({ cancelRecordAutosave: () => {} }));
vi.mock('../../../../kit/src/client/components/recordSurface.js', () => ({
  captureRecordSurfaceOwner: (isCurrent: () => boolean) => ({ isCurrent }),
}));
vi.mock('./recordPicture.js', () => ({
  takeStill: () => null,
  keepStill: () => {},
  showPicture: () => {},
  clearPicture: () => false,
  enterRecord: () => {},
}));
vi.mock('./RecordPageBody.js', () => ({
  RecordPageBody: ({ recordKey, sections, onName }: { recordKey: { id: number }; sections?: unknown; onName: (name: string) => void }) => (
    <div data-testid="body" data-sections={JSON.stringify(sections ?? null)}>
      <p>record {recordKey.id}</p>
      <button type="button" onClick={() => onName(`Ticket ${recordKey.id}`)}>
        name it
      </button>
    </div>
  ),
}));

const { SplitDetailPane, SplitDetailActions } = await import('./SplitDetailPane.js');

const trail = (index: number): RecordTrail => ({
  table: 'ticket',
  index,
  records: [
    { key: { id: 1 }, label: 'One' },
    { key: { id: 2 }, label: 'Two' },
    { key: { id: 3 }, label: 'Three' },
  ],
});
type Split = Parameters<typeof SplitDetailPane>[0]['entry'] & { label: string };
function entry(index = 1): Split {
  const made = {
    kind: 'row',
    table: 'ticket',
    view: 'inbox',
    key: { id: index + 1 },
    label: 'here',
    trail: trail(index),
  } as unknown as Split;
  mocks.here = made;
  return made;
}

beforeEach(() => {
  mocks.allow = true;
  mocks.page = 'ticket-page';
  mocks.went = [];
  mocks.opened = [];
  mocks.crumbs = 0;
  mocks.generation = 0;
  mocks.failure = false;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  mocks.here = undefined;
});

test('reads the record through the App page, with the split’s authored fields', async () => {
  render(<SplitDetailPane entry={entry()} show={['subject', 'status']} onClose={() => {}} />);
  expect(screen.getByText('Reading…')).toBeInTheDocument();
  await screen.findByText('record 2');
  expect(JSON.parse(screen.getByTestId('body').dataset.sections!)).toEqual([{ kind: 'fields', paths: ['subject', 'status'] }]);
});

test.each(['missing', 'failed'] as const)('a %s page says so, and a page for an entry already left lands nowhere', async (outcome) => {
  mocks.page = null;
  mocks.failure = outcome === 'failed';
  render(<SplitDetailPane entry={entry()} onClose={() => {}} />);
  expect(await screen.findByText('This record has no page to show here.')).toBeInTheDocument();
  cleanup();

  mocks.failure = false;
  mocks.page = 'ticket-page';
  const left = entry();
  mocks.here = { other: true };
  render(<SplitDetailPane entry={left} onClose={() => {}} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId('body')).toBeNull();
});

test('Details handles a current lookup failure through the routed App and ignores a superseded intent', async () => {
  mocks.failure = true;
  render(<SplitDetailActions entry={entry()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  await waitFor(() => expect(mocks.opened).toHaveLength(1));
  expect(mocks.went).toEqual([]);
  mocks.opened = [];
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Details →' }));
    mocks.generation++;
  });
  expect(mocks.opened).toEqual([]);
  expect(mocks.went).toEqual([]);
});

test('the page names the entry and the crumbs, only while the entry is on top', async () => {
  const mine = entry();
  render(<SplitDetailPane entry={mine} onClose={() => {}} />);
  await screen.findByText('record 2');
  fireEvent.click(screen.getByRole('button', { name: 'name it' }));
  expect(mine.label).toBe('Ticket 2');
  expect(mocks.crumbs).toBe(1);

  mocks.here = { other: true };
  mine.label = 'kept';
  fireEvent.click(screen.getByRole('button', { name: 'name it' }));
  expect(mine.label).toBe('kept');
  expect(mocks.crumbs).toBe(1);
});

test('J and K step the split, replacing the row and keeping its view', async () => {
  render(<SplitDetailActions entry={entry(1)} />);
  expect(document.querySelector('.record-trail-at')).toHaveTextContent('2 of 3');
  fireEvent.keyDown(document.body, { key: 'j' });
  await waitFor(() => expect(mocks.went).toHaveLength(1));
  expect(mocks.went[0][1]).toBe('replace');
  expect(mocks.went[0][0]).toMatchObject({
    kind: 'row',
    table: 'ticket',
    view: 'inbox',
    key: { id: 3 },
    label: 'Three',
    trail: { index: 2 },
  });
  fireEvent.keyDown(document.body, { key: 'k' });
  await waitFor(() => expect(mocks.went).toHaveLength(2));
  expect(mocks.went[1][0]).toMatchObject({ key: { id: 1 }, trail: { index: 0 } });
});

test('Details opens the App page, stays put when leaving is refused, and opens the record where there is no page', async () => {
  const mine = entry();
  render(<SplitDetailActions entry={mine} />);
  mocks.allow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  expect(mocks.went).toEqual([]);

  mocks.allow = true;
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  await waitFor(() => expect(mocks.went).toHaveLength(1));
  expect(mocks.went[0]).toEqual([{ kind: 'page', pageId: 'ticket-page', table: 'ticket', key: { id: 2 }, label: 'here' }, 'push']);

  mocks.page = null;
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  await waitFor(() => expect(mocks.opened).toHaveLength(1));
  expect(mocks.opened[0]).toEqual(['ticket', { id: 2 }, 'here', 'push', { direct: true }]);
});
