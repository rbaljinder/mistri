/**
 * The record dialog: it titles itself by the record's kind, steps through
 * the list it was opened from with J/K and its buttons (never while a field
 * is typed in, never past an unsaved draft the reader keeps), leaves for the
 * full page only when leaving is allowed, and keeps a closed owner's late
 * page from landing.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  allow: true,
  page: 'ticket-page' as string | null,
  opened: [] as unknown[][],
  cancels: 0,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  allowMutationExit: () => mocks.allow,
  findTable: (id: string) => (id === 'ticket' ? { id: 'ticket', name: 'support_ticket' } : undefined),
  openRecord: (...args: unknown[]) => {
    mocks.opened.push(args);
  },
  pageFor: async () => mocks.page,
  // RecordTrailNav's own imports; a step past the page is not exercised here.
  api: async () => ({ rows: [] }),
  currentEntry: () => undefined,
  go: () => {},
  keyOf: (_t: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_t: unknown, row: Record<string, unknown>) => `#${row.id}`,
}));
vi.mock('../../../../kit/src/client/write.js', () => ({
  cancelRecordAutosave: () => {
    mocks.cancels++;
  },
}));
vi.mock('../../../../kit/src/client/components/recordSurface.js', () => ({
  captureRecordSurfaceOwner: (isCurrent: () => boolean) => ({ isCurrent }),
}));
vi.mock('./recordPicture.js', () => ({ takePicture: () => null, showPicture: () => {}, clearPicture: () => false, enterRecord: () => {} }));
/* The page body is its own suite's; here it only says which record it reads. */
vi.mock('./RecordPageBody.js', () => ({
  RecordPageBody: ({ recordKey, onName }: { recordKey: { id: number }; onName: (name: string) => void }) => (
    <div data-testid="body">
      <p>record {recordKey.id}</p>
      <input aria-label="Subject" />
      <button type="button" onClick={() => onName(`Ticket ${recordKey.id}`)}>
        name it
      </button>
    </div>
  ),
}));

const { RecordModal } = await import('./RecordModal.js');

const records = [
  { key: { id: 1 }, label: 'One' },
  { key: { id: 2 }, label: 'Two' },
  { key: { id: 3 }, label: 'Three' },
];
let current = true;
function draw(props: { recordKey?: Record<string, unknown>; records?: typeof records } = {}) {
  const onClose = vi.fn();
  const owner = { isCurrent: () => current } as never;
  render(
    <RecordModal
      tableId="ticket"
      recordKey={props.recordKey ?? { id: 2 }}
      label="Two"
      records={props.records ?? records}
      owner={owner}
      onClose={onClose}
      setPendingProbe={() => {}}
    />,
  );
  return onClose;
}
const at = () => document.querySelector('.record-trail-at');

beforeEach(() => {
  mocks.allow = true;
  mocks.page = 'ticket-page';
  mocks.opened = [];
  mocks.cancels = 0;
  current = true;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test('names the dialog by the record and heads it with the kind, then the page names it', async () => {
  draw();
  expect(screen.getByRole('dialog', { name: 'Two — details' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Support ticket');
  await screen.findByText('record 2');
  fireEvent.click(screen.getByRole('button', { name: 'name it' }));
  expect(screen.getByRole('dialog', { name: 'Ticket 2 — details' })).toBeInTheDocument();
});

test('J and K step through the list from inside the dialog, and stand aside for a field and a modifier', async () => {
  draw();
  await screen.findByText('record 2');
  expect(at()).toHaveTextContent('2 of 3');
  screen.getByRole('button', { name: 'Close' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'j' });
  await screen.findByText('record 3');
  expect(at()).toHaveTextContent('3 of 3');
  // The end of the list: nothing to step to, and the button says so.
  expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled();

  screen.getByRole('textbox', { name: 'Subject' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  expect(screen.getByText('record 3')).toBeInTheDocument();

  screen.getByRole('button', { name: 'Close' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'k', metaKey: true });
  expect(screen.getByText('record 3')).toBeInTheDocument();

  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  await screen.findByText('record 2');
  // Each step settles a pending autosave before it moves.
  expect(mocks.cancels).toBeGreaterThan(0);
});

test('a step the reader refuses to leave for stays on the record', async () => {
  draw();
  await screen.findByText('record 2');
  mocks.allow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Next record' }));
  expect(screen.getByText('record 2')).toBeInTheDocument();
  expect(at()).toHaveTextContent('2 of 3');
});

test('a record not among the list opens alone, with no steps', async () => {
  draw({ recordKey: { id: 9 } });
  await screen.findByText('record 9');
  expect(document.querySelector('.record-trail')).toBeNull();
});

test('Details closes the dialog and opens the full page, unless leaving is refused', async () => {
  const onClose = draw();
  await screen.findByText('record 2');
  mocks.allow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  expect(mocks.opened).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();

  mocks.allow = true;
  await userEvent.click(screen.getByRole('button', { name: 'Details →' }));
  expect(mocks.opened).toEqual([['ticket', { id: 2 }, 'Two', 'push', { direct: true }]]);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test('Close asks before it goes, and a refused close keeps the dialog', async () => {
  const onClose = draw();
  await screen.findByText('record 2');
  mocks.allow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  mocks.allow = true;
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test('a table with no page says so; a page that arrives for a retired owner lands nowhere', async () => {
  mocks.page = null;
  draw();
  expect(await screen.findByText(/layout is unavailable/)).toBeInTheDocument();
  cleanup();

  mocks.page = 'ticket-page';
  current = false;
  draw();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId('body')).toBeNull();
  expect(screen.getByText('Reading…')).toBeInTheDocument();
});
