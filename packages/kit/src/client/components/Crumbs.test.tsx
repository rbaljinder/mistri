/**
 * The trail, drawn from a walk and driven.
 */
import { afterEach, describe, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const walk = { stack: [] as unknown[] };
const listeners = new Set<() => void>();
let tick = 0;
const backTo = vi.fn();
let appMode = false;
let app: Record<string, unknown> | null = null;

vi.mock('../core.js', () => ({
  state: walk,
  subscribeWalk: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  walkVersion: () => tick,
  backTo,
  findTable: (id: string) => ({ id, name: id }),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => app, inAppMode: () => appMode }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('./appListModel.js', () => ({
  appCrumbLabel: (e: { query: string }) => `Leads · ${e.query}`,
  // The `inbox` view is a split; every other view is a plain list.
  appListFor: (table: string, _query?: string, view?: string) => ({
    table,
    label: view ?? table,
    presentation: view === 'inbox' ? { kind: 'split' } : undefined,
  }),
  splitOf: (spec?: { presentation?: { kind: string } }) => (spec?.presentation?.kind === 'split' ? spec.presentation : undefined),
}));

const { Crumbs } = await import('./Crumbs.js');

function tickWalk() {
  tick += 1;
  for (const fn of listeners) fn();
}

afterEach(() => {
  cleanup();
  walk.stack = [];
  appMode = false;
  app = null;
  backTo.mockReset();
});

test("a split's selected record is one crumb with its list, and Back goes past the list", () => {
  appMode = true;
  walk.stack = [
    { kind: 'page', pageId: 'workspace' },
    { kind: 'table', table: 'issue', query: 'issue show name', view: 'inbox' },
    { kind: 'row', table: 'issue', key: { id: 2 }, label: 'Repair keyboard focus', view: 'inbox' },
  ];
  render(<Crumbs onHome={() => {}} />);
  expect(screen.queryByText('Repair keyboard focus')).toBeNull();
  expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('title', 'Back to workspace');
});

test('a row read beside a plain list is still a crumb of its own', () => {
  appMode = true;
  walk.stack = [
    { kind: 'table', table: 'issue', query: 'issue show name', view: 'issues' },
    { kind: 'row', table: 'issue', key: { id: 2 }, label: 'Repair keyboard focus', view: 'issues' },
  ];
  render(<Crumbs onHome={() => {}} />);
  expect(screen.getByText('Repair keyboard focus')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('title', 'Back to Leads · issue show name');
});

test("a room's pushed place is one crumb, and Back returns to the place before it", async () => {
  appMode = true;
  app = { views: { 'pick-walk': { label: 'Pick walk', sections: [], room: { reads: [], params: ['list'] } } }, nav: [], resources: {} };
  walk.stack = [
    { kind: 'table', table: 'pick_list', query: 'pick_list' },
    { kind: 'page', pageId: 'dash-pick-walk' },
    { kind: 'page', pageId: 'dash-pick-walk', rootBody: 'list=12' },
  ];
  render(<Crumbs onHome={() => {}} />);
  expect(screen.getAllByText('Pick walk')).toHaveLength(1);
  expect(document.querySelectorAll('.crumbs .sep')).toHaveLength(2);
  expect(document.querySelector('.crumbs .current')).toHaveTextContent('Pick walk');
  const back = screen.getByRole('button', { name: /Back/ });
  expect(back).toHaveAttribute('title', 'Back to Pick walk');
  await userEvent.setup().click(back);
  expect(backTo).toHaveBeenLastCalledWith(1);
});

describe('the trail', () => {
  test('names an unmounted dashboard ancestor from its authored definition', async () => {
    appMode = true;
    app = {
      views: { 'service-catalog': { label: 'Service catalog', sections: [] } },
      nav: [{ view: 'service-catalog', label: 'Service catalog' }],
      resources: {},
    };
    walk.stack = [
      { kind: 'page', pageId: 'dash-service-catalog' },
      { kind: 'table', table: 'catalog_item', query: 'catalog_item active = true' },
    ];
    render(<Crumbs onHome={() => {}} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Service catalog' }));
    expect(backTo).toHaveBeenCalledWith(0);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('title', 'Back to Service catalog');
  });

  test('retains the fallback for an unknown page and the label of a record page', () => {
    walk.stack = [
      { kind: 'page', pageId: 'unknown-page' },
      { kind: 'page', pageId: 'config-catalog-item', table: 'catalog_item', label: 'Editor license' },
    ];
    render(<Crumbs onHome={() => {}} />);
    expect(screen.getByRole('button', { name: 'unknown-page' })).toBeInTheDocument();
    expect(document.querySelector('.crumbs .current')).toHaveTextContent('Editor license');
  });

  test('starts at the schema and names each step, the last as the current room', () => {
    walk.stack = [
      { kind: 'table', table: 'work_order', query: 'work_order status = open' },
      { kind: 'row', table: 'work_order', key: { id: 8 }, label: 'WO-100008' },
      { kind: 'row', table: 'customer', key: { id: 3 }, label: 'Southerly Surveying' },
    ];
    const onHome = vi.fn();
    render(<Crumbs onHome={onHome} />);
    expect(screen.getByRole('button', { name: 'Schema' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'work_order status = open' })).toBeInTheDocument();
    // A row names its table only when the walk changed table.
    expect(screen.getByRole('button', { name: 'WO-100008' })).toBeInTheDocument();
    const current = document.querySelector('.crumbs .current')!;
    expect(current).toHaveTextContent('customerSoutherly Surveying');
    expect(current.querySelector('.crumb-table')).toHaveAttribute('title', 'customer');
    expect(screen.getByRole('button', { name: /Back/ })).toHaveAttribute('title', 'Back to WO-100008');
  });

  test('a crumb goes back to its step, Back to the one before the current', async () => {
    const user = userEvent.setup();
    walk.stack = [
      { kind: 'table', table: 'invoice', query: 'invoice' },
      { kind: 'row', table: 'invoice', key: { id: 1 }, label: '1001' },
    ];
    render(<Crumbs onHome={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'invoice' }));
    expect(backTo).toHaveBeenCalledWith(0);
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(backTo).toHaveBeenLastCalledWith(0);
  });

  test("speaks the app's word for a list while the app curates", () => {
    appMode = true;
    walk.stack = [{ kind: 'table', table: 'lead', query: 'lead status = new' }];
    render(<Crumbs onHome={() => {}} />);
    expect(document.querySelector('.crumbs .current')).toHaveTextContent('Leads · lead status = new');
  });

  test('redraws when the walk ticks — a label arriving after the row', () => {
    const entry = { kind: 'row', table: 'customer', key: { id: 4 }, label: '4' };
    walk.stack = [entry];
    render(<Crumbs onHome={() => {}} />);
    expect(document.querySelector('.crumbs .current')).toHaveTextContent('4');
    entry.label = 'Acme';
    act(() => tickWalk());
    expect(document.querySelector('.crumbs .current')).toHaveTextContent('Acme');
  });
});

test('in an App the home crumb is the App\'s home, never "Schema"', () => {
  appMode = true;
  app = { name: 'Marketplace', views: {}, resources: {} };
  walk.stack = [{ kind: 'row', table: 'vehicle', key: { id: 3 }, label: '2024 Corolla' }];
  render(<Crumbs onHome={() => {}} />);
  expect(screen.getByRole('button', { name: 'Marketplace home' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Schema' })).toBeNull();
});

test('a row crumb in an App gives its table a step of its own, said in the resource label', () => {
  appMode = true;
  walk.stack = [{ kind: 'row', table: 'billing.order_line', key: { id: 7 }, label: 'Line 7' }];
  render(<Crumbs onHome={() => {}} />);
  expect(document.querySelector('.crumb-table-step')).toHaveTextContent('Leads');
  expect(document.querySelector('.crumb-table')).toBeNull();
});

test("a dashboard's trail is the home mark and its title, with no empty step for a table it does not have", () => {
  appMode = true;
  walk.stack = [{ kind: 'page', pageId: 'service-desk', label: 'Service desk' }];
  const { container } = render(<Crumbs onHome={() => {}} />);
  expect(container.querySelector('.crumb-table-step')).toBeNull();
  expect(container.querySelectorAll('.sep')).toHaveLength(1);
});
