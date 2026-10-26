/**
 * A decision's suggestion at a field: what it says, what a reader may press, what is told the server when a press
 * landed, and "Why this?" — the question, the inputs (a hidden one is not shown), who answered and how sure.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FieldSuggestion } from '../../shared/decisionSuggestions.js';

const { api, toast, handle } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  handle: {
    granted: true,
    run: vi.fn(),
    open: vi.fn(),
  },
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  toast,
  findTable: () => undefined,
  state: {},
  emptyWord: () => '—',
  columnLabel: () => null,
  columnDisplay: () => null,
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span data-testid="input-value">{String(value)}</span>,
}));
vi.mock('./sdk/commands.js', () => ({
  commandHandle: () => ({ label: 'Assign', available: async () => handle.granted, ...handle }),
}));

const { default: DecisionChip } = await import('./DecisionChip.js');

const suggestion: FieldSuggestion = {
  id: 'dec-1',
  decision: 'route',
  field: 'assignee_id',
  command: 'assign',
  answer: 7,
  label: 'Ada Nguyen',
  probability: 0.9,
  filled: false,
  at: '2026-10-20T10:00:00.000Z',
};
const why = {
  decision: 'route',
  question: 'Who should take this ticket?',
  inputs: [
    { name: 'title', label: 'Title', value: 'Printer jam', readable: true },
    { name: 'notes', label: 'Private notes', readable: false },
  ],
  provider: 'jev',
  model: 'router',
  modelVersion: '2026-10',
  probability: 0.9,
  outcome: 'pending',
  at: '2026-10-20T10:00:00.000Z',
};

const settled = vi.fn();
function draw(over: Partial<FieldSuggestion> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DecisionChip suggestion={{ ...suggestion, ...over }} table="ticket" recordKey={{ id: 3 }} onSettled={settled} />
    </QueryClientProvider>,
  );
}
const menu = async () => userEvent.click(screen.getByRole('button', { name: 'More about the suggestion Ada Nguyen' }));
const settleCalls = () => api.mock.calls.filter(([path]) => path === '/api/record-decisions/settle');

beforeEach(() => {
  bridgeShell();
  handle.granted = true;
  handle.run.mockReset().mockResolvedValue({ status: 'applied' });
  handle.open.mockReset().mockResolvedValue({ status: 'applied' });
  api.mockReset().mockImplementation(async (path: string) => (path === '/api/record-decisions/why' ? why : {}));
  toast.mockReset();
  settled.mockReset();
});
afterEach(cleanup);

describe('the chip', () => {
  test('says the answer and how sure it was in a word, and is named so for assistive technology', () => {
    draw();
    expect(screen.getByLabelText('Suggested: Ada Nguyen, very likely')).toBeInTheDocument();
    expect(document.querySelector('.decision-chip-value')).toHaveTextContent('Ada Nguyenvery likely');
    expect(document.querySelector('.decision-chip-trailing')).toBeNull();
  });

  test('the confidence word follows the probability bands', () => {
    for (const [probability, word] of [
      [0.97, 'almost certain'],
      [0.75, 'likely'],
      [0.4, 'possible'],
    ] as const) {
      const view = draw({ probability });
      expect(screen.getByLabelText(`Suggested: Ada Nguyen, ${word}`)).toBeInTheDocument();
      view.unmount();
    }
  });

  test('a suggestion trailing a value is marked so', () => {
    draw({ filled: true });
    expect(document.querySelector('.decision-chip')).toHaveClass('decision-chip-trailing');
  });
});

describe('granted', () => {
  test('Accept runs the command with the answer, tells the server it is done, and the record is asked again', async () => {
    draw();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(handle.run).toHaveBeenCalledWith({ id: 3 }, { assignee_id: 7 });
    expect(settleCalls()).toEqual([['/api/record-decisions/settle', { id: 'dec-1', action: 'done' }]]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('a command that closed without applying tells the server nothing', async () => {
    handle.run.mockResolvedValue({ status: 'closed' });
    draw();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(handle.run).toHaveBeenCalledTimes(1);
    expect(settleCalls()).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
  });

  test('Change… opens the command with the answer filled, and settles when it applied', async () => {
    draw();
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Change…' }));
    expect(handle.open).toHaveBeenCalledWith({ id: 3 }, { assignee_id: 7 });
    expect(handle.run).not.toHaveBeenCalled();
    expect(settleCalls()).toEqual([['/api/record-decisions/settle', { id: 'dec-1', action: 'done' }]]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('Dismiss tells the server so and the record is asked again', async () => {
    draw();
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));
    expect(settleCalls()).toEqual([['/api/record-decisions/settle', { id: 'dec-1', action: 'dismiss' }]]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(handle.run).not.toHaveBeenCalled();
  });

  test('a settle that fails says so and still asks again', async () => {
    api.mockRejectedValue(new Error('down'));
    draw();
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));
    expect(toast).toHaveBeenCalledWith('The suggestion could not be updated. Try again.', 'error');
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('Why this? lists the question, the inputs, who answered and how sure', async () => {
    draw();
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Why this?' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why Ada Nguyen?' });
    expect(await within(dialog).findByText('Who should take this ticket?')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/api/record-decisions/why', { id: 'dec-1' });
    // A readable input by its value; a hidden one says it is not shown, and shows nothing of its value.
    expect(within(dialog).getByText('Title')).toBeInTheDocument();
    expect(within(dialog).getByTestId('input-value')).toHaveTextContent('Printer jam');
    expect(within(dialog).getByText('Private notes').closest('div')).toHaveTextContent('not shown to you');
    expect(within(dialog).getByText('jev · router · 2026-10')).toBeInTheDocument();
    expect(within(dialog).getByText('90% · very likely')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('not granted', () => {
  beforeEach(() => {
    handle.granted = false;
  });

  test('there is no Accept, and the menu holds only Why this?', async () => {
    draw();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    await menu();
    expect(await screen.findByRole('menuitem', { name: 'Why this?' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByLabelText('Suggested: Ada Nguyen, very likely')).toBeInTheDocument();
  });
});
