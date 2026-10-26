/**
 * The app's verbs on a record, drawn and driven.
 *
 * Against an API that answers like the server would, and a `matches`
 * that answers for the server about a record's `when`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { AppAction } from '../../shared/app.js';
import { humanName } from '../../../../engine/src/shared/model.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';

const calls: Array<{ path: string; body: unknown }> = [];
const toasts: Array<[string, string]> = [];
let answer: unknown = {};
let appMode = false;

vi.mock('../../../../kit/src/client/core.js', () => ({
  state: { activeConnection: 'demo' },
  prefersPages: () => appMode,
  humanName,
  columnKind,
  columnLabel: (_table: string, column: string) => (column === 'owner_id' ? 'Assigned to' : null),
  columnDisplay: (_table: string, column: string) => (column === 'amount' ? { format: 'money' } : null),
  findTable: () => undefined,
  emptyWord: () => 'Empty',
  // The phone menu is anchored on the zoom-aware ruler.
  viewportSize: () => ({ width: 390, height: 844 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  api: async (path: string, body: unknown) => {
    calls.push({ path, body });
    if (answer instanceof Error) throw answer;
    return answer ?? { affected: 1, applied: (body as { values: unknown }).values };
  },
  toast: (message: string, tone: string) => toasts.push([message, tone]),
}));

const { ActionBar } = await import('./Actions.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');

const actions: AppAction[] = [
  { id: 'startWorking', label: 'Start working', set: { status: 'working' }, when: 'status = new' },
  { id: 'markLost', label: 'Mark lost', set: { status: 'lost', owner_id: null }, confirm: true },
];

function draw(props: Partial<Parameters<typeof ActionBar>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onDone = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      <ActionBar
        tableId="lead"
        actions={actions}
        recordKey={{ id: 127 }}
        label="Margot Fontaine"
        matches={async (when) => when === 'status = new'}
        onDone={onDone}
        {...props}
      />,
    ),
  );
  return { onDone };
}

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  answer = null;
  appMode = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the action bar on a phone', () => {
  test('the first shown verb stays a button, and the rest fold into More', async () => {
    const user = userEvent.setup();
    draw({ compact: true });
    const more = await screen.findByRole('button', { name: 'More actions' });
    expect(screen.getByRole('button', { name: 'Start working' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark lost' })).toBeNull();
    await user.click(more);
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Mark lost']);
  });

  test('one shown verb stays a button, with no menu to open', async () => {
    draw({ compact: true, matches: async () => false });
    expect(await screen.findByRole('button', { name: 'Mark lost' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});

describe('asking which actions are shown', () => {
  test('each distinct condition is asked once, and an action without one asks nothing', async () => {
    const warn = vi.spyOn(console, 'warn');
    const matches = vi.fn(async (when: string) => when === 'status = new');
    draw({
      matches,
      actions: [
        ...actions,
        { id: 'archive', label: 'Archive', set: { status: 'archived' } },
        { id: 'startAgain', label: 'Start again', set: { status: 'working' }, when: 'status = new' },
      ],
    });
    expect(await screen.findByRole('button', { name: 'Start working' })).toBeVisible();
    expect(matches).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter((call) => /Duplicate Queries/.test(String(call[0])))).toEqual([]);
  });

  test('an action kept out of the header is neither drawn nor asked about', async () => {
    const matches = vi.fn(async () => true);
    draw({
      matches,
      actions: [...actions, { id: 'reopen', label: 'Reopen', set: { status: 'new' }, when: 'status = lost', header: false }],
    });
    expect(await screen.findByRole('button', { name: 'Start working' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(matches.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['status = new']);
  });
});

describe('the toolbar on a wide screen', () => {
  const four: AppAction[] = [
    { id: 'qualify', label: 'Qualify', set: { status: 'qualified' } },
    { id: 'nurture', label: 'Nurture', set: { status: 'nurture' } },
    { id: 'reassign', label: 'Reassign', set: { owner_id: null } },
    { id: 'archive', label: 'Archive', set: { status: 'archived' } },
  ];

  test('the first shown verb is filled, the next two are quiet, and the rest fold into More', async () => {
    const user = userEvent.setup();
    draw({ actions: four });
    const lead = await screen.findByRole('button', { name: 'Qualify' });
    expect(lead.className).toContain('primary');
    for (const name of ['Nurture', 'Reassign']) expect(screen.getByRole('button', { name }).className).toContain('ghost');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Archive']);
  });

  test('under a record header a destructive verb goes last and quiet, and the forward one is filled', async () => {
    const lostFirst: AppAction[] = [
      { id: 'markLost', label: 'Mark lost', set: { status: 'lost' }, confirm: true },
      { id: 'qualify', label: 'Qualify', set: { status: 'qualified' } },
      { id: 'nurture', label: 'Nurture', set: { status: 'nurture' } },
    ];
    draw({ actions: lostFirst, destructive: (action) => action.label === 'Mark lost' });
    const lead = await screen.findByRole('button', { name: 'Qualify' });
    expect(lead.className).toContain('primary');
    const lost = screen.getByRole('button', { name: 'Mark lost' });
    expect(lost.className).toContain('btn-quiet');
    expect(lost.className).not.toContain('primary');
    const order = screen.getAllByRole('button').map((button) => button.textContent);
    expect(order.indexOf('Mark lost')).toBeGreaterThan(order.indexOf('Nurture'));
  });

  test('a verb whose condition fails is not the one filled', async () => {
    draw();
    const shown = await screen.findByRole('button', { name: 'Mark lost' });
    await screen.findByRole('button', { name: 'Start working' });
    expect(screen.getByRole('button', { name: 'Start working' }).className).toContain('primary');
    expect(shown.className).toContain('ghost');
  });

  test("a header's actions are the buttons, in its order, and every other verb is in More", async () => {
    const user = userEvent.setup();
    draw({ actions: four, only: ['nurture', 'qualify'], primary: 'Qualify' });
    await screen.findByRole('button', { name: 'Qualify' });
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent)
        .slice(0, 3),
    ).toEqual(['Qualify', 'Nurture', 'More']);
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Reassign', 'Archive']);
  });

  test("a split view's keys are shown beside their verbs and run them, except while a field has focus", async () => {
    const user = userEvent.setup();
    const { RecordKeys } = await import('../../../../kit/src/client/components/recordKeys.js');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          RecordKeys.Provider,
          { value: { q: 'qualify' } },
          <>
            <input aria-label="Notes" />
            <ActionBar tableId="lead" actions={four} recordKey={{ id: 127 }} label="Margot" matches={async () => true} onDone={() => {}} />
          </>,
        ),
      ),
    );
    const qualify = await screen.findByRole('button', { name: /Qualify/ });
    expect(qualify.textContent).toBe('QualifyQ');
    expect(qualify.getAttribute('aria-keyshortcuts')).toBe('Q');
    await user.click(screen.getByLabelText('Notes'));
    await user.keyboard('q');
    expect(calls).toEqual([]);
    await user.click(document.body);
    await user.keyboard('q');
    await vi.waitFor(() => expect(calls.map((call) => call.path)).toEqual(['/api/update']));
  });

  test('Delete alone gives the bar a More menu, and is its last item', async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    const { DropItem } = await import('@mistriwork/ui/DropMenu.js');
    draw({
      actions: four.slice(0, 1),
      menuTail: (
        <DropItem className="page-actions-item is-danger" onClick={remove}>
          Delete…
        </DropItem>
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Delete…']);
    await user.click(items[0]);
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe('the action bar', () => {
  test.each([
    { name: 'empty', key: {} },
    { name: 'missing value', key: { id: undefined } },
    { name: 'null value', key: { id: null } },
    { name: 'object value', key: { id: {} } },
    { name: 'nonfinite value', key: { id: Infinity } },
  ])('an invalid $name key refuses before sending or registering an update attempt', async ({ key }) => {
    const run = vi.spyOn(updateAttempts, 'run');
    const version = updateAttempts.version();
    const user = userEvent.setup();
    const { onDone } = draw({ recordKey: key, actions: [{ id: 'apply', label: 'Apply', set: { status: 'working' } }] });
    const button = screen.getByRole('button', { name: 'Apply' });
    await user.click(button);
    await vi.waitFor(() => expect(toasts).toEqual([['This record has no usable key.', 'error']]));
    expect(button).toBeEnabled();
    // A deliberate second click remains a local refusal, not an uncertain-write gate.
    await user.click(button);
    await vi.waitFor(() => expect(toasts).toHaveLength(2));
    expect(calls).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(updateAttempts.version()).toBe(version);
    expect(updateAttempts.get({ connection: 'demo', table: 'lead', key })).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });

  test('an App asks a confirmed verb first too: it has no Undo, so one click writes nothing', async () => {
    appMode = true;
    const user = userEvent.setup();
    const { onDone } = draw();
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveAccessibleName('Mark lost?');
    expect(calls).toEqual([]);
    await user.click(dialog.querySelector('.primary')!);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(calls).toHaveLength(1);
  });
  test('a verb with a when is shown once the record satisfies it', async () => {
    draw();
    expect(screen.getByRole('button', { name: 'Mark lost' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Start working' })).toBeVisible();
  });

  test('and stays hidden when it does not', async () => {
    draw({ matches: async () => false });
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Start working' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Mark lost' })).toBeVisible();
  });

  test('a plain verb writes its set through /api/update and repaints', async () => {
    const user = userEvent.setup();
    const { onDone } = draw();
    await user.click(await screen.findByRole('button', { name: 'Start working' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([
      { path: '/api/update', body: { conn: 'demo', table: 'lead', key: { id: 127 }, values: { status: 'working' } } },
    ]);
    expect(toasts).toEqual([['Start working — done', 'ok']]);
  });

  test("a verb that confirms asks first, in the record's name, and Cancel writes nothing", async () => {
    const user = userEvent.setup();
    const { onDone } = draw();
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveTextContent('Mark lost?');
    expect(dialog).toHaveAccessibleName('Mark lost?');
    expect(dialog).toHaveTextContent('Margot Fontaine');
    expect(dialog).toHaveTextContent('Assigned to');
    expect(dialog).toHaveTextContent('Empty');
    expect(dialog).not.toHaveTextContent('owner_id');
    await user.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));
    expect(calls).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  test('and writes on yes', async () => {
    const user = userEvent.setup();
    const { onDone } = draw();
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(dialog.querySelector('.primary')!);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect((calls[0].body as { values: unknown }).values).toEqual({ status: 'lost', owner_id: null });
  });

  test('confirmation values use authored formatting without changing the write payload', async () => {
    const user = userEvent.setup();
    const action = { id: 'setAmount', label: 'Set amount', set: { amount: 1250 }, confirm: true };
    draw({ actions: [action] });
    await user.click(screen.getByRole('button', { name: 'Set amount' }));
    const dialog = screen.getByRole('dialog', { name: 'Set amount?' });
    expect(dialog).toHaveTextContent('$1,250');
    await user.click(dialog.querySelector('.primary')!);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0].body as { values: unknown }).values).toEqual({ amount: 1250 });
  });

  test('inside a conversation, what a verb came to is told to it: applied, then refused', async () => {
    const told: unknown[] = [];
    const { ActionOutcomes } = await import('./Actions.js');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ActionOutcomes.Provider,
          { value: (report: unknown) => told.push(report) },
          <ActionBar
            tableId="lead"
            actions={actions}
            recordKey={{ id: 127 }}
            label="Margot Fontaine"
            matches={async (when) => when === 'status = new'}
            onDone={() => {}}
          />,
        ),
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Start working' }));
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toEqual({
      tableId: 'lead',
      key: { id: 127 },
      label: 'Margot Fontaine',
      action: expect.objectContaining({ id: 'startWorking' }),
      outcome: { status: 'done' },
    });
    answer = { errors: [{ message: 'CHECK constraint failed: status' }], outcome: 'rejected' };
    await user.click(screen.getByRole('button', { name: 'Start working' }));
    await vi.waitFor(() => expect(told).toHaveLength(2));
    expect(told[1]).toMatchObject({
      action: { id: 'startWorking' },
      outcome: { status: 'failed', detail: 'CHECK constraint failed: status' },
    });
  });

  test("a refusal is said in the database's words and the record is left alone", async () => {
    answer = { errors: [{ message: 'CHECK constraint failed: status' }], outcome: 'rejected' };
    const user = userEvent.setup();
    const { onDone } = draw();
    await user.click(await screen.findByRole('button', { name: 'Start working' }));
    await vi.waitFor(() => expect(toasts).toEqual([['CHECK constraint failed: status', 'error']]));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start working' })).toBeEnabled();
  });

  test('an unconfirmed action stays locked after the component is reopened', async () => {
    answer = new Error('Connection lost');
    const user = userEvent.setup();
    const { onDone } = draw({ recordKey: { id: 999 } });
    await user.click(await screen.findByRole('button', { name: 'Start working' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Start working' })).toBeDisabled());
    cleanup();
    draw({ recordKey: { id: '999' } });
    await user.click(await screen.findByRole('button', { name: 'Start working' }));
    expect(screen.getByRole('button', { name: 'Mark lost' })).toBeDisabled();
    expect(calls).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('an action that asks a reason', () => {
  const cancel: AppAction = { id: 'cancelIssue', label: 'Cancel issue', set: { status: 'canceled' }, reason: 'cancel_note' };
  test('asks a reason before writing, in App mode too, and writes it with the change', async () => {
    appMode = true;
    const user = userEvent.setup();
    draw({ actions: [cancel], label: 'Keep drafts' });
    await user.click(await screen.findByRole('button', { name: 'Cancel issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel issue: reason' });
    const submit = dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).toBeDisabled();
    expect(calls).toEqual([]);
    await user.type(screen.getByLabelText('Reason'), 'Duplicate of #4');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(calls.at(-1)).toMatchObject({ path: '/api/update', body: { values: { status: 'canceled', cancel_note: 'Duplicate of #4' } } });
  });

  test('its own Cancel writes nothing', async () => {
    const user = userEvent.setup();
    draw({ actions: [cancel] });
    await user.click(await screen.findByRole('button', { name: 'Cancel issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel issue: reason' });
    await user.click(dialog.querySelector('button.ghost') as HTMLButtonElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('a fixed action granted without write', () => {
  test('a reader who writes nothing sees only the actions granted to a role of theirs, and runs them', async () => {
    draw({ canUpdate: false, grantedActions: ['startWorking'] });
    const start = await screen.findByRole('button', { name: 'Start working' });
    expect(screen.queryByRole('button', { name: 'Mark lost' })).toBeNull();
    await userEvent.click(start);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The action's own set and nothing else: the server admits exactly that.
    expect(calls[0]).toMatchObject({ path: '/api/update', body: { table: 'lead', key: { id: 127 }, values: { status: 'working' } } });
  });

  test('without the grant, none of its fixed actions is offered', async () => {
    draw({ canUpdate: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Start working' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark lost' })).toBeNull();
  });
});
