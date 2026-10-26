/**
 * A board's money: each lane's head adds up what its cards are worth beside its count, a card and a head say money
 * short with the whole figure in the title, an amount the adapters sent as text keeps every digit, and a closed
 * stage folds to a strip a reader opens, which their browser remembers.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppBoardList } from '../../../../engine/src/shared/listPresentations.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false },
  state: { activeConnection: 'crm', connections: [{ id: 'crm', writable: false }] },
  /* The amount's rule: in one currency, or (`currency: { column }`) in each card's own. */
  amountRule: { format: 'money', currency: 'USD' } as Record<string, unknown>,
}));
const table: TableMeta = {
  id: 'deal',
  name: 'deal',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'stage', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['discover', 'propose', 'won', 'lost'] },
    { name: 'amount', type: 'NUMERIC', nullable: true, primaryKey: false },
    { name: 'seats', type: 'INTEGER', nullable: true, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: vi.fn(),
  state: mocks.state,
  toast: vi.fn(),
  writeAllowed: () => false,
  findTable: (id: string) => (id === 'deal' ? table : undefined),
  primaryKey,
  columnLabel: () => null,
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  quote: (value: unknown) => String(value),
  columnDisplay: (_table: string, column: string) => (column === 'amount' ? mocks.amountRule : null),
  refsFrom: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../appState.js', () => ({ activeApp: () => ({ id: 'crm' }), inAppMode: () => true }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
vi.mock('../../../../kit/src/client/insert.js', () => ({ openNewRecord: () => undefined }));
const { BoardList } = await import('./BoardList.js');

/* Each lane's cards and their amounts, as the database would send them: a numeric column's values as decimal text. */
const lanes: Record<string, Array<{ name: string; amount: string | number | null }>> = {
  discover: [
    { name: 'Hearing program', amount: '9800.00' },
    { name: 'Nurse on site', amount: '65000.00' },
    { name: 'Physicals', amount: '18000.00' },
  ],
  propose: [{ name: 'Wellness program', amount: 1250000 }],
  won: [{ name: 'Renewal', amount: '240000.00' }],
  lost: [{ name: 'Far too big', amount: '12345678901234567890.12' }],
};
const sum = (stage: string) => {
  const cards = lanes[stage];
  if (stage === 'lost') return '12345678901234567890.12';
  return cards.reduce((n, card) => n + Number(card.amount ?? 0), 0).toFixed(2);
};

function serve() {
  mocks.api.mockImplementation(async (path: string, body: { q?: string; text?: string; limit?: number }) => {
    if (path === '/api/breakdown') {
      const summed = /sum amount as lane_amount/.test(body.text ?? '');
      return {
        columns: summed ? ['stage', 'lane_cards', 'lane_amount'] : ['stage', 'count'],
        rows: Object.keys(lanes).map((stage) =>
          summed ? { stage, lane_cards: lanes[stage].length, lane_amount: sum(stage) } : { stage, count: lanes[stage].length },
        ),
      };
    }
    if (path === '/api/run') {
      const stage = /stage = (\w+)/.exec(body.q ?? '')?.[1] ?? '';
      return { rows: (lanes[stage] ?? []).map((card, i) => ({ id: `${stage}-${i}`, stage, ...card })) };
    }
    return {};
  });
}

const base: AppBoardList = { kind: 'board', by: 'stage', primary: 'name', lines: ['amount'] };
function draw(spec: AppBoardList = base) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BoardList table={table} rows={[]} spec={spec} label="Pipeline" query="deal show id, name, stage, amount" />
    </QueryClientProvider>,
  );
}
const lane = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  serve();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

test("a lane's head says its count and the money its cards are worth, short, the whole figure in its title", async () => {
  draw();
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/breakdown',
      expect.objectContaining({ text: 'deal count as lane_cards, sum amount as lane_amount by stage' }),
    ),
  );
  const discovery = await waitFor(() => lane('Discover'));
  await waitFor(() => expect(discovery.querySelector('.triage-lane-sum')).toHaveTextContent('$92.8K'));
  expect(discovery.querySelector('.triage-lane-sum')).toHaveAttribute('title', '$92,800.00');
  expect(within(discovery).getByLabelText('3 items')).toBeInTheDocument();
  expect(lane('Propose').querySelector('.triage-lane-sum')).toHaveTextContent('$1.25M');
  // A number the database sent as a number is money all the same: its whole figure is to the cent.
  const card = await screen.findByRole('button', { name: /Wellness program/ });
  expect(within(card).getByText('$1.25M')).toHaveAttribute('title', '$1,250,000.00');
});

test('a card says its money short with the whole amount in its title, and reads it out whole', async () => {
  draw();
  const card = await screen.findByRole('button', { name: /Nurse on site/ });
  const short = within(card).getByText('$65K');
  expect(short).toHaveAttribute('title', '$65,000.00');
  expect(card.getAttribute('aria-label')).toContain('$65,000.00');
  // Under a thousand is already short: said whole.
  lanes.discover[0].amount = '950.50';
  cleanup();
  draw();
  expect(within(await screen.findByRole('button', { name: /Hearing program/ })).getByText('$950.50')).toBeInTheDocument();
  lanes.discover[0].amount = '9800.00';
});

test('an amount sent as text past 2^53 keeps every digit in its title', async () => {
  draw({ ...base, folded: undefined });
  const lost = await waitFor(() => lane('Lost'));
  await waitFor(() => expect(lost.querySelector('.triage-lane-sum')).toHaveTextContent('$12,300,000T'));
  expect(lost.querySelector('.triage-lane-sum')).toHaveAttribute('title', '$12,345,678,901,234,567,890.12');
  const card = await screen.findByRole('button', { name: /Far too big/ });
  expect(within(card).getByText('$12,300,000T')).toHaveAttribute('title', '$12,345,678,901,234,567,890.12');
});

test('without money on its card, a lane says its count alone; `sum` names a number to add up', async () => {
  draw({ ...base, lines: undefined });
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/breakdown', expect.objectContaining({ text: 'deal count by stage' })));
  expect(await within(await waitFor(() => lane('Discover'))).findByLabelText('3 items')).toBeInTheDocument();
  expect(document.querySelector('.triage-lane-sum')).toBeNull();
  cleanup();
  draw({ ...base, lines: undefined, sum: 'seats' });
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/breakdown',
      expect.objectContaining({ text: 'deal count as lane_cards, sum seats as lane_amount by stage' }),
    ),
  );
});

test('a folded stage is a strip with its name, count and sum; a click opens it, and the browser remembers', async () => {
  draw({ ...base, folded: ['won', 'lost'] });
  const strip = await screen.findByRole('button', { name: /^Won/ });
  expect(strip).toHaveAttribute('aria-expanded', 'false');
  expect(strip.closest('section')).toHaveClass('is-folded');
  expect(await within(strip).findByText('$240K')).toHaveAttribute('title', '$240,000.00');
  expect(within(strip).getByLabelText('1 item')).toBeInTheDocument();
  // Its cards are neither drawn nor read while it is folded.
  expect(screen.queryByRole('button', { name: /Renewal/ })).toBeNull();
  expect(mocks.api).not.toHaveBeenCalledWith('/api/run', expect.objectContaining({ q: expect.stringContaining('stage = won') }));
  // A phone's lane picker steps through the open lanes; a strip is in view beside the last of them.
  expect(document.querySelector('.triage-lane-picker-of')).toHaveTextContent('1 of 2');

  await userEvent.click(strip);
  expect(await screen.findByRole('button', { name: /Renewal/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fold Won' })).toHaveAttribute('aria-expanded', 'true');
  expect(document.querySelector('.triage-lane-picker-of')).toHaveTextContent('1 of 3');
  // Lost is still folded; an open lane that is not declared foldable has no fold control.
  expect(screen.getByRole('button', { name: /^Lost/ })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Fold Discover' })).toBeNull();

  // Drawn again, the board remembers Won open.
  cleanup();
  draw({ ...base, folded: ['won', 'lost'] });
  expect(await screen.findByRole('button', { name: /Renewal/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Fold Won' }));
  expect(await screen.findByRole('button', { name: /^Won/ })).toHaveAttribute('aria-expanded', 'false');
});

test('a storage that throws leaves the declared lanes folded and the board working', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    draw({ ...base, folded: ['won'] });
    const strip = await screen.findByRole('button', { name: /^Won/ });
    await userEvent.click(strip);
    expect(await screen.findByRole('button', { name: /Renewal/ })).toBeInTheDocument();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

test('where each card says its own currency, a card says its amount in it and a lane sums each currency apart', async () => {
  mocks.amountRule = { format: 'money', currency: 'USD', currencyColumn: 'currency' };
  mocks.api.mockImplementation(async (path: string, body: { q?: string; text?: string }) => {
    if (path === '/api/breakdown')
      return {
        columns: ['stage', 'lane_currency', 'lane_cards', 'lane_amount'],
        rows: [
          { stage: 'discover', lane_currency: 'USD', lane_cards: 1, lane_amount: '9800.00' },
          { stage: 'discover', lane_currency: 'JPY', lane_cards: 1, lane_amount: '150000' },
        ],
      };
    if (path === '/api/run') {
      const stage = /stage = (\w+)/.exec(body.q ?? '')?.[1] ?? '';
      return {
        rows:
          stage === 'discover'
            ? [
                { id: 'd-0', stage, name: 'Hearing program', amount: '9800.00', currency: 'USD' },
                { id: 'd-1', stage, name: 'Tokyo clinic', amount: '150000', currency: 'JPY' },
              ]
            : [],
      };
    }
    return {};
  });
  try {
    draw();
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        '/api/breakdown',
        expect.objectContaining({ text: 'deal count as lane_cards, sum amount as lane_amount by stage, currency as lane_currency' }),
      ),
    );
    const discovery = await waitFor(() => lane('Discover'));
    await waitFor(() => expect(discovery.querySelector('.triage-lane-sum')).toHaveTextContent('$9.8K · ¥150K'));
    expect(within(discovery).getByLabelText('2 items')).toBeInTheDocument();
    const card = await screen.findByRole('button', { name: /Tokyo clinic/ });
    expect(within(card).getByText('¥150K')).toHaveAttribute('title', '¥150,000');
  } finally {
    mocks.amountRule = { format: 'money', currency: 'USD' };
  }
});

test('an empty final lane folds from the first paint on the next visit, never when the counts land', async () => {
  const stage = table.columns[2] as unknown as { states?: { final?: string[] } };
  const cards = lanes.lost;
  stage.states = { final: ['won', 'lost'] };
  lanes.lost = [];
  try {
    draw();
    // The first visit draws Lost open, and keeps it open once its count of nothing has landed: folding then moved the board.
    await waitFor(() => expect(within(lane('Lost')).getByLabelText('0 items')).toBeInTheDocument());
    expect(lane('Lost').closest('section')).not.toHaveClass('is-folded');
    await waitFor(() => expect(window.localStorage.getItem('mistri.board-folds:crm:deal:stage:Pipeline:empty')).toBe('["lost"]'));
    cleanup();
    // The next visit folds it before anything is read; Won, which has a card, stays open.
    mocks.api.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(screen.getByRole('button', { name: /Lost/ }).closest('section')).toHaveClass('is-folded');
    expect(lane('Won').closest('section')).not.toHaveClass('is-folded');
  } finally {
    delete stage.states;
    lanes.lost = cards;
  }
});
