/**
 * A row's own menu: a quiet ⋯ in each row's trailing cell that asks nothing
 * until pressed, then offers that record's actions as its page does.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../../../mistri/src/shared/app.js';

const mocks = vi.hoisted(() => ({ matches: vi.fn(), open: vi.fn() }));
const table: TableMeta = {
  id: 'lead',
  name: 'lead',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
vi.mock('../core.js', () => ({
  state: { activeConnection: 'crm' },
  api: vi.fn(),
  toast: vi.fn(),
  prefersPages: () => false,
  writeAllowed: () => true,
  findTable: () => table,
  humanName: (s: string) => s,
  columnLabel: () => null,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  quote: (v: unknown) => String(v),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => row.name,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
vi.mock('./pageModel.js', () => ({ rootMatches: mocks.matches }));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ grantedCommands: [] }) }));
const identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
vi.mock('../sessionIdentity.js', () => ({
  sessionIdentity: () => identity,
  captureSessionIdentity: () => identity,
  tenantLeaseActive: () => false,
  captureTenantLease: () => undefined,
  subscribeTenantLease: () => () => {},
  subscribeSessionIdentity: () => () => {},
}));
const { RowActions } = await import('./RowActions.js');
const { RowTrailHosts, useRowTrailScope } = await import('./RowHost.js');
const { bulkKey } = await import('../bulkActions.js');

const rows = [
  { id: 1, name: 'Margot Fontaine', status: 'new' },
  { id: 2, name: 'Wei Iyer', status: 'working' },
];
const actions: AppAction[] = [
  { id: 'startWorking', label: 'Start working', set: { status: 'working' }, when: 'status = new' },
  { id: 'markLost', label: 'Mark lost', set: { status: 'lost' }, confirm: true },
];

function StandInGrid() {
  const store = useRowTrailScope()!;
  return (
    <table>
      <tbody>
        {rows.map((row) => {
          const id = bulkKey(table, { id: row.id });
          return (
            <tr key={id} onClick={() => mocks.open(row.id)}>
              <td>{row.name}</td>
              <td className="row-trail" ref={store.ref(id)} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RowTrailHosts>
        <RowActions table={table} rows={rows} actions={actions} onDone={() => {}} />
        <StandInGrid />
      </RowTrailHosts>
    </QueryClientProvider>,
  );
}

beforeEach(bridgeShell);

beforeEach(() => {
  mocks.matches.mockReset();
  mocks.open.mockReset();
  mocks.matches.mockResolvedValue(true);
});
afterEach(cleanup);

test('each row has a quiet ⋯ at its end, and nothing is asked until one is pressed', async () => {
  draw();
  const trigger = await screen.findByRole('button', { name: 'Actions for Wei Iyer' });
  expect(trigger.closest('td')).toHaveClass('row-trail');
  expect(screen.getAllByRole('button', { name: /^Actions for / })).toHaveLength(2);
  expect(mocks.matches).not.toHaveBeenCalled();
});

test("pressing ⋯ opens that record's actions, asks only its conditions, and never opens the row", async () => {
  const user = userEvent.setup();
  draw();
  await user.click(await screen.findByRole('button', { name: 'Actions for Margot Fontaine' }));
  await waitFor(() => expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Start working', 'Mark lost']));
  expect(mocks.matches).toHaveBeenCalledTimes(1);
  expect(mocks.matches.mock.calls[0].slice(1, 3)).toEqual([{ id: 1 }, 'status = new']);
  expect(mocks.open).not.toHaveBeenCalled();
});

test('a record none of whose conditions hold says so instead of an empty menu', async () => {
  const user = userEvent.setup();
  mocks.matches.mockResolvedValue(false);
  draw();
  await user.click(await screen.findByRole('button', { name: 'Actions for Wei Iyer' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toContain('Mark lost');
  expect(screen.queryByRole('menuitem', { name: 'Start working' })).toBeNull();
});
