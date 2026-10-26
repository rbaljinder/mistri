/**
 * The activity feed, drawn against a server that answers as
 * `/api/record-activity` does: what each change says, the period asked for,
 * the search narrowing what the period read, and the record a change opens.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const calls: Array<Record<string, unknown>> = [];
const opened = vi.fn();
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const tables: Record<string, TableMeta> = {
  pick_list: {
    id: 'pick_list',
    name: 'pick_list',
    schema: '',
    isView: false,
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('status', 'TEXT'),
      col('carrier', 'TEXT'),
      col('warehouse_id', 'INTEGER', { references: { table: 'warehouse', column: 'id' } }),
    ] as TableMeta['columns'],
  },
  thread: {
    id: 'thread',
    name: 'thread',
    schema: '',
    isView: false,
    columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('title', 'TEXT')] as TableMeta['columns'],
  },
};
const entries = [
  {
    at: '2026-09-23T17:20:00.000Z',
    kind: 'update',
    via: 'app',
    action: 'Ship',
    by: 'Ada Nguyen',
    table: 'pick_list',
    key: { id: 7 },
    label: 'SO-7',
    fields: [
      { column: 'status', before: 'packed', after: 'shipped' },
      { column: 'carrier', before: null, after: 'UPS' },
    ],
  },
  {
    at: '2026-09-23T16:00:00.000Z',
    kind: 'insert',
    via: 'app',
    action: 'Start a thread',
    by: 'Quinn Hart',
    table: 'thread',
    key: { id: 3 },
    label: 'Headphone hinge',
    fields: [{ column: 'title', after: 'Headphone hinge' }],
  },
  {
    at: '2026-09-23T15:00:00.000Z',
    kind: 'update',
    via: 'app',
    by: 'luis@example.test',
    table: 'pick_list',
    key: { id: 8 },
    label: 'SO-8',
    fields: [
      { column: 'warehouse_id', before: 1, after: 2 },
      { column: 'secret', hidden: true, label: 'Secret' },
    ],
  },
];

vi.mock('../../../../kit/src/client/core.js', () => ({
  api: async (_path: string, body: Record<string, unknown>) => {
    calls.push(body);
    return { entries: body.period === 'today' ? entries : [] };
  },
  columnLabel: (_t: string, column: string) => (({ status: 'Status', carrier: 'Carrier' }) as Record<string, string>)[column] ?? null,
  findTable: (id: string) => tables[id],
  openRecord: opened,
  columnDisplay: () => null,
  emptyWord: () => '—',
  refsFrom: () => [],
  state: {},
}));
vi.mock('../appState.js', () => ({
  activeApp: () => ({
    resources: { pick_list: { noun: { one: 'pick list', many: 'pick lists' } }, thread: { noun: { one: 'thread', many: 'threads' } } },
  }),
  inAppMode: () => true,
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/components/appRooms.js', () => ({
  resourceOf: (app: { resources: Record<string, unknown> }, table: string) => app.resources[table],
}));

const { ActivityFeed } = await import('./DashboardActivity.js');
const section = { kind: 'activity', title: 'Latest', limit: 2, resources: { pick_list: { icon: 'truck' as const }, thread: {} } };
const draw = () =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      <ActivityFeed section={section} dashboard="ops" at={4} />,
    ),
  );

beforeEach(() => {
  calls.length = 0;
  opened.mockReset();
});
afterEach(() => cleanup());

describe('the activity feed', () => {
  test('asks for its section and period, and says each change: what, which record, its first field, who', async () => {
    draw();
    await screen.findByText('Ship');
    expect(calls[0]).toEqual({ view: 'ops', section: 4, period: 'today' });
    expect(screen.getByText('3', { selector: 'strong' }).parentElement?.textContent).toBe('3 changes today');
    const ship = screen.getByText('Ship').closest('li')!;
    expect(ship.textContent).toContain('Pick list');
    expect(ship.textContent).toContain('Status');
    expect(ship.textContent).toContain('Ada Nguyen');
    // A title that already names the kind of record does not say it twice.
    expect(screen.getByText('Start a thread').closest('li')!.querySelector('.activity-noun')).toBeNull();
    // Two drawn, the third behind "Show 1 more".
    expect(screen.queryByText('SO-8')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    // A reference field and a hidden one are not said by value: the change says how many fields moved.
    expect(screen.getByText('SO-8').closest('li')!.textContent).toContain('2 fields changed');
    // A writer named by an address is said as someone: the feed never draws an email.
    expect(screen.getByText('SO-8').closest('li')!.textContent).toContain('Someone');
    expect(document.body.textContent).not.toMatch(/@/);
  });

  test('the search narrows what the period read, a period asks again, and a record opens', async () => {
    draw();
    await screen.findByText('Ship');
    await userEvent.type(screen.getByRole('searchbox'), 'hinge');
    await waitFor(() => expect(screen.queryByText('Ship')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Headphone hinge' }));
    expect(opened).toHaveBeenCalledWith('thread', { id: 3 }, 'Headphone hinge', 'push');
    await userEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await waitFor(() => expect(calls.some((call) => call.period === 'yesterday')).toBe(true));
    expect(screen.getByRole('button', { name: 'Yesterday' }).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText(/No changes yesterday/)).toBeTruthy();
  });
});
