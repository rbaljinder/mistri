/**
 * A board on a free-form page moves a card with what the page declared and nothing else: the resource's actions are
 * narrowed to the page's commands and fixed actions before the list's room is handed them.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const room = vi.hoisted(() => vi.fn());
vi.mock('@mistriwork/kit/client/components/TableRoom.js', () => ({
  TableRoom: (props: Record<string, unknown>) => {
    room(props);
    return <p>room</p>;
  },
}));
vi.mock('@mistriwork/kit/client/uiBridge.js', () => ({
  pageBridge: {
    activeApp: () => ({
      resources: {
        ticket: {
          actions: [
            { id: 'close', label: 'Close', set: { status: 'closed' } },
            { id: 'reopen', label: 'Reopen', set: { status: 'open' } },
            { id: 'advance', label: 'Advance', command: { id: 'advance' }, move: { column: 'status', edges: [] } },
            { id: 'escalate', label: 'Escalate', command: { id: 'escalate' }, move: { column: 'status', edges: [] } },
          ],
        },
      },
    }),
  },
}));

/* A pick list names its warehouse by key; the warehouse is named by its `name`. */
const col = (name: string, extra = {}) => ({ name, type: 'TEXT', nullable: true, primaryKey: false, ...extra });
const pick = {
  id: 'pick',
  name: 'pick',
  schema: '',
  isView: false,
  columns: [
    col('id', { type: 'INTEGER', primaryKey: true, nullable: false }),
    col('title'),
    col('status', { allowed: ['to_pick', 'picked'] }),
    col('warehouse_id', { type: 'INTEGER', references: { table: 'warehouse', column: 'id' } }),
  ],
};
const warehouse = {
  id: 'warehouse',
  name: 'warehouse',
  schema: '',
  isView: false,
  columns: [col('id', { type: 'INTEGER', primaryKey: true, nullable: false }), col('name')],
};
vi.mock('@mistriwork/kit/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  state: { activeConnection: 'demo', schema: { tables: [pick, warehouse], foreignKeys: [] } },
  findTable: (id: string) => [pick, warehouse].find((t) => t.id === id),
}));

const { PresentedList } = await import('./PresentedList.js');
const { listReferenceNames } = await import('@mistriwork/kit/client/components/appListModel.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const table = { id: 'ticket', name: 'ticket', schema: '', isView: false, columns: [] } as never;
const board = { kind: 'board', by: 'status', primary: 'title' } as const;
const lastRoom = () => room.mock.calls.at(-1)![0] as Record<string, any>;

test('a board is handed the actions the page declared, by the command or the id, and is interactive for them', () => {
  render(<PresentedList table={table} spec={board} query="priority = high" sort="title" label="Work" moves={['advance', 'close']} />);
  expect(screen.getByText('room')).toBeVisible();
  const props = lastRoom();
  expect(props.actions.map((action: { id: string }) => action.id)).toEqual(['close', 'advance']);
  expect(props.interactive).toBe(true);
  expect(props.entry).toEqual({ kind: 'table', table: 'ticket', query: 'ticket priority = high sort title' });
  expect(props.chrome).toBe(false);
  expect(props.embedded).toBe(true);
  expect(props.listLabel).toBe('Work');
});

test('a board the page declares no move for is read, not dragged', () => {
  render(<PresentedList table={table} spec={board} query="" label="Work" moves={[]} />);
  expect(lastRoom().actions).toEqual([]);
  expect(lastRoom().interactive).toBe(false);
});

test('a calendar and a gallery are read: no moves, and cards open their records', () => {
  render(
    <PresentedList table={table} spec={{ kind: 'calendar', date: 'due_on', primary: 'title' }} query="" label="Due" moves={['close']} />,
  );
  expect(lastRoom()).toMatchObject({ interactive: false, actions: undefined, recordNavigation: false });
  cleanup();
  render(
    <PresentedList table={table} spec={{ kind: 'cards', primary: 'title', image: 'photo' }} query="" label="Photos" moves={['close']} />,
  );
  expect(lastRoom()).toMatchObject({ interactive: false, recordNavigation: true });
});

test("a board's footer names a reference's record, as the list view's board does, never its key", () => {
  const spec = { kind: 'board', by: 'status', primary: 'title', footer: [{ column: 'warehouse_id', icon: 'warehouse' }] } as const;
  render(<PresentedList table={pick as never} spec={spec} query="" label="Picks" moves={[]} />);
  const props = lastRoom();
  // The names the board reads a card's facts by: the view's own, for the same presentation.
  expect(props.referenceLabels).toEqual({ warehouse_id: 'warehouse_id.name' });
  expect(props.referenceLabels).toEqual(listReferenceNames({ table: 'pick', presentation: spec }));
  // And the question fetches the name beside the key, so there is a name to read.
  expect(props.entry.query).toMatch(/^pick show .*\bwarehouse_id\.name\b/);
  expect(props.entry.query).toMatch(/\bwarehouse_id\b(?!\.)/);
});
