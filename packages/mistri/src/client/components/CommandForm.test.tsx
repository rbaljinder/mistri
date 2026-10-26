import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppAction, AppCommandAction, AppCommandField } from '../../shared/app.js';
import { establishSessionIdentity, lockSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { commandOperations, type CommandOwner } from '../commandState.js';

const { api, state, readable, visibility } = vi.hoisted(() => ({
  api: vi.fn(),
  state: { activeConnection: 'loans' },
  readable: new Set<string>(),
  visibility: { value: true, calls: 0 },
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: (path: string, body: { checks: Array<{ command: string; commandVersion: number; keys: unknown[] }> }) =>
    path === '/api/commands/availability'
      ? (visibility.calls++,
        Promise.resolve({
          checks: body.checks.map((check) => ({
            command: check.command,
            commandVersion: check.commandVersion,
            available: check.keys.map(() => visibility.value),
          })),
        }))
      : api(path, body),
  state,
  findTable: (id: string) => (readable.has(id) ? { id } : undefined),
  columnLabel: () => null,
  humanName: (name: string) => name,
  prefersPages: () => true,
  toast: vi.fn(),
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  // Read as live sync's modules load (liveInvalidate.ts, write.js).
  setRecordMutationPendingProbe: () => {},
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null }));

const { ActionBar } = await import('./Actions.js');
const { commandInput, blankCommandValues } = await import('./CommandFields.js');
const { commandChoices } = await import('./CommandReference.js');
const action: AppCommandAction = {
  id: 'assignReviewer',
  label: 'Assign reviewer',
  command: {
    id: 'assignReviewer',
    version: 1,
    target: 'loan_application',
    input: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, maxLength: 500, help: 'Explain the assignment.' }],
  },
};
const owner: CommandOwner = {
  connection: 'loans',
  target: 'loan_application',
  command: 'assignReviewer',
  commandVersion: 1,
  key: { id: 1 },
};
const success = {
  status: 'applied',
  command: 'assignReviewer',
  commandVersion: 1,
  resource: 'loan_application',
  key: { id: 1 },
  receiptId: 'receipt-1',
  replayed: false,
  result: { message: 'Assigned.' },
};
const clients: QueryClient[] = [];
function draw(props: Partial<Parameters<typeof ActionBar>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const done = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ActionBar
        tableId="loan_application"
        actions={[action]}
        recordKey={{ id: 1 }}
        label="Application 1"
        matches={async () => true}
        onDone={done}
        canUpdate={false}
        grantedCommands={['assignReviewer']}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, client, done };
}
beforeEach(() => {
  visibility.value = true;
  visibility.calls = 0;
  state.activeConnection = 'loans';
  readable.clear();
  readable.add('loan_application');
  readable.add('reviewer');
  establishSessionIdentity({ signedIn: true, accountId: 'manager', appId: 'loans' });
  api.mockReset();
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3 } : success));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

async function open() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Assign reviewer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign reviewer' });
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  return { user, dialog };
}
async function submit() {
  const opened = await open();
  await opened.user.type(within(opened.dialog).getByLabelText('Reason (required)'), 'North desk');
  await opened.user.click(within(opened.dialog).getByRole('button', { name: 'Assign reviewer' }));
  return opened;
}

test('a group envelope names every key in order, and settles only on a receipt naming all of them in that order', async () => {
  const group: CommandOwner = { ...owner, key: {}, keys: [{ id: '9007199254740993' }, { id: 2 }], labels: ['Loan 1', 'Loan 2'] };
  expect(() => commandOperations.start(group, 3, { reason: 'x' })).toThrow('Refresh these records');
  expect(() => commandOperations.start({ ...group, keys: [{ id: 2 }, { id: '2' }] }, [3, 4], { reason: 'x' })).toThrow(
    'Refresh these records',
  );
  const operation = commandOperations.start(group, [3, 4], { reason: 'Batch' });
  expect(operation.envelope).toMatchObject({ keys: group.keys, expectedVersions: [3, 4], input: { reason: 'Batch' } });
  expect(operation.envelope.key).toBeUndefined();
  expect(commandOperations.get(owner)).toBeUndefined();
  const named = { ...success, key: { id: '9007199254740993' } };
  await commandOperations.send(operation, 'execute', async () => ({ ...named, keys: [{ id: 2 }, { id: '9007199254740993' }] }), vi.fn());
  expect(operation.phase).toBe('unknown');
  const applied = vi.fn();
  await commandOperations.send(operation, 'status', async () => ({ ...named, keys: [{ id: '9007199254740993' }, { id: '2' }] }), applied);
  expect(operation.phase).toBe('success');
  expect(applied).toHaveBeenCalledOnce();
  commandOperations.forget(group);
});

test('a granted command is available with generic writes disabled and never enters update or Undo', async () => {
  const done = draw().done;
  const { user, dialog } = await submit();
  // The command's own words for what it did (its output's `message`), never a generic "Completed.".
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Assigned.'));
  expect(within(dialog).getByRole('status')).not.toHaveTextContent('Completed.');
  expect(api.mock.calls.map((call) => call[0])).toEqual(['/api/commands/prepare', '/api/commands/execute']);
  expect(api.mock.calls[0][1]).toEqual({ conn: 'loans', command: 'assignReviewer', commandVersion: 1, key: { id: 1 } });
  expect(api.mock.calls[1][1]).toMatchObject({
    command: 'assignReviewer',
    commandVersion: 1,
    key: { id: 1 },
    expectedVersion: 3,
    input: { reason: 'North desk' },
  });
  expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  expect(done).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(done).toHaveBeenCalledOnce();
});

test('union visibility uses command grants and readable resources independently of fixed edits', () => {
  const actions: AppAction[] = [action, { id: 'fixedEdit', label: 'Fixed edit', set: { status: 'new' } }];
  draw({ actions, canUpdate: true, grantedCommands: [] });
  expect(screen.queryByRole('button', { name: 'Assign reviewer' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Fixed edit' })).toBeVisible();
  cleanup();
  readable.delete('reviewer');
  draw({
    actions: [
      {
        ...action,
        command: {
          ...action.command,
          input: [{ name: 'reviewer', label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' }],
        },
      },
    ],
  });
  expect(screen.queryByRole('button', { name: 'Assign reviewer' })).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('unknown locks edits and dismissal, and status misses and retries reuse the exact immutable envelope', async () => {
  let tries = 0;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/prepare')) return { expectedVersion: 3 };
    if (path.endsWith('/status')) return { status: 'not_found', outcome: 'unknown' };
    if (!tries++) throw new Error('Connection lost');
    return success;
  });
  draw();
  const { user, dialog } = await submit();
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('not yet confirmed'));
  const envelope = api.mock.calls[1][1];
  expect(within(dialog).getByLabelText('Reason (required)')).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Check result' }));
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('not yet confirmed'));
  expect(api.mock.calls[2][1]).toEqual(envelope);
  await user.click(within(dialog).getByRole('button', { name: 'Retry same submission' }));
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Assigned.'));
  expect(api.mock.calls[3][1]).toEqual(envelope);
  expect(api.mock.calls.filter((call) => call[0].endsWith('/prepare'))).toHaveLength(1);
});

test('an action that keeps no receipt says to check the record when its answer is lost, and lets go', async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/prepare')) return { expectedVersion: 3 };
    throw new Error('Connection lost');
  });
  draw({ actions: [{ ...action, untracked: true as const }] });
  const { user, dialog } = await submit();
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('keeps no receipt'));
  // Nothing to check a lost answer by: no status lookup, no resend of the same submission.
  expect(within(dialog).queryByRole('button', { name: 'Check result' })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Retry same submission' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await user.click(within(dialog).getByRole('button', { name: 'Refresh and review' }));
  expect(api.mock.calls.filter((call) => call[0].endsWith('/status'))).toHaveLength(0);
});

test('unavailable commands stay hidden and do not evaluate command conditions per row', async () => {
  visibility.value = false;
  const matches = vi.fn(async () => true);
  draw({ actions: [{ ...action, when: 'version > 0' }], matches });
  await act(async () => {
    await Promise.resolve();
  });
  expect(visibility.calls).toBe(1);
  expect(screen.queryByRole('button', { name: 'Assign reviewer' })).toBeNull();
  expect(matches).not.toHaveBeenCalled();
});

test('pending blocks duplicate submits and survives reopening even when no longer available', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation(async (path: string) =>
    path.endsWith('/prepare')
      ? { expectedVersion: 3 }
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  draw();
  const { user, dialog } = await submit();
  expect(within(dialog).getByRole('status')).toHaveTextContent('Submitting');
  expect(within(dialog).getByRole('button', { name: 'Submitting…' })).toBeDisabled();
  fireEvent.submit(dialog.querySelector('form')!);
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(2);
  cleanup();
  visibility.value = false;
  draw({ recordKey: { id: '1' } });
  expect(screen.getByRole('dialog')).toHaveTextContent('Submitting');
  expect(screen.getByLabelText('Reason (required)')).toHaveValue('North desk');
  await act(async () => finish(success));
  expect(screen.getByRole('status')).toHaveTextContent('Assigned.');
  expect(api).toHaveBeenCalledTimes(2);
});

test('account transitions clear operations and reject a late success', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation(async (path: string) =>
    path.endsWith('/prepare')
      ? { expectedVersion: 3 }
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const { done, client } = draw();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await submit();
  act(() => {
    lockSessionIdentity();
    establishSessionIdentity({ signedIn: true, accountId: 'different-manager', appId: 'loans' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(commandOperations.get(owner)).toBeUndefined();
  await act(async () => finish(success));
  expect(done).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(screen.queryByText('Completed.')).toBeNull();
});

test('reopening after a command metadata upgrade resumes the original fields and version-bound envelope', async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/prepare')) return { expectedVersion: 3 };
    throw new Error('Connection lost');
  });
  draw();
  await submit();
  await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('not yet confirmed'));
  const first = api.mock.calls[1][1];
  cleanup();
  draw({
    actions: [
      {
        ...action,
        command: { ...action.command, version: 2, input: [{ name: 'newReason', label: 'New reason', type: 'text', required: true }] },
      },
    ],
  });
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Reason (required)')).toHaveValue('North desk');
  expect(within(dialog).queryByLabelText('New reason (required)')).toBeNull();
  await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Retry same submission' }));
  expect(api.mock.calls.at(-1)![1]).toEqual(first);
  expect(api.mock.calls.filter((call) => call[0].endsWith('/prepare'))).toHaveLength(1);
});

test('required input validation keeps the form and sends no command', async () => {
  draw();
  const { user, dialog } = await open();
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  expect(within(dialog).getByRole('status')).toHaveTextContent('Reason is required.');
  expect(api).toHaveBeenCalledTimes(1);
});

test('a confirmed rejection has refresh and review, fetching a fresh version before a new submission', async () => {
  let prepares = 0;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/prepare')) return { expectedVersion: ++prepares };
    throw Object.assign(new Error('The record changed.'), { code: 'stale_record', outcome: 'not_applied' });
  });
  draw();
  const { user, dialog } = await submit();
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('The record changed.'));
  const first = api.mock.calls[1][1];
  await user.click(within(dialog).getByRole('button', { name: 'Refresh and review' }));
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  const second = api.mock.calls.at(-1)![1];
  expect(second.expectedVersion).toBeGreaterThan(first.expectedVersion);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

test('a refusal that names an input is said beside it, and the form stays open to change the answer and send again', async () => {
  let executes = 0;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/prepare')) return { expectedVersion: 3 };
    if (++executes === 1)
      throw Object.assign(new Error('North desk is closed today.'), { code: 'invalid_input', outcome: 'not_applied', field: 'reason' });
    return success;
  });
  draw();
  const { user, dialog } = await submit();
  const reason = within(dialog).getByLabelText('Reason (required)');
  await vi.waitFor(() => expect(reason).toHaveAccessibleDescription(expect.stringContaining('North desk is closed today.')));
  expect(reason).toHaveAttribute('aria-invalid', 'true');
  expect(reason).toBeEnabled();
  // Changing the answer clears its problem; a second submission is a new attempt.
  await user.clear(reason);
  await user.type(reason, 'South desk');
  expect(reason).not.toHaveAttribute('aria-invalid', 'true');
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Assigned.'));
  const [first, second] = api.mock.calls.filter(([path]) => path === '/api/commands/execute').map(([, body]) => body);
  expect(second.input).toEqual({ reason: 'South desk' });
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

test('reference search uses authored columns, bounded authorized queries, and preserves large string and numeric IDs', async () => {
  api.mockResolvedValue({
    rows: [
      { code: '9007199254740993', display: 'Huge' },
      { code: 7, display: 'Seven' },
    ],
  });
  const field = {
    name: 'reviewer',
    label: 'Reviewer',
    type: 'reference' as const,
    from: 'staff.reviewer',
    by: 'code',
    labelColumn: 'display',
    query: 'active = true',
  };
  expect(await commandChoices(field, 'North', 'loans')).toEqual([
    { value: '9007199254740993', label: 'Huge' },
    { value: 7, label: 'Seven' },
  ]);
  expect(api).toHaveBeenCalledWith('/api/run', {
    conn: 'loans',
    q: 'staff.reviewer active = true and display contains "North" show code, display sort display',
    limit: 20,
    offset: 0,
    count: 'none',
  });
  await commandChoices({ ...field, query: 'active = true show display sort code limit 2000' }, '', 'loans');
  expect(api).toHaveBeenLastCalledWith('/api/run', {
    conn: 'loans',
    q: 'staff.reviewer active = true show code, display sort display',
    limit: 20,
    offset: 0,
    count: 'none',
  });
});

test('reference picker selection submits the adapter value, not a numeric conversion', async () => {
  const reference: AppCommandField = {
    name: 'reviewer',
    label: 'Reviewer',
    type: 'reference',
    from: 'reviewer',
    by: 'id',
    labelColumn: 'name',
    required: true,
  };
  api.mockImplementation(async (path: string) =>
    path.endsWith('/prepare')
      ? { expectedVersion: 3 }
      : path === '/api/run'
        ? { rows: [{ id: '9007199254740993', name: 'North reviewer' }] }
        : success,
  );
  draw({ actions: [{ ...action, command: { ...action.command, input: [reference] } }] });
  const { user, dialog } = await open();
  await user.click(await within(dialog).findByRole('combobox', { name: 'Reviewer (required)' }));
  await user.click(await screen.findByRole('option', { name: 'North reviewer' }));
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() =>
    expect(api.mock.calls.find((call) => call[0].endsWith('/execute'))?.[1].input).toEqual({ reviewer: '9007199254740993' }),
  );
});

test('a picker narrowed by the record searches the query prepare bound to it, and offers nothing where that is empty', async () => {
  const reference: AppCommandField = {
    name: 'reviewer',
    label: 'Reviewer',
    type: 'reference',
    from: 'reviewer',
    by: 'id',
    labelColumn: 'name',
    required: true,
    query: 'team_id = record.team_id',
  };
  let bound: string | null = 'team_id = 4';
  api.mockImplementation(async (path: string) =>
    path.endsWith('/prepare')
      ? { expectedVersion: 3, choices: { reviewer: bound } }
      : path === '/api/run'
        ? { rows: [{ id: 'A-1', name: 'Ari Patel' }] }
        : success,
  );
  const drawn = draw({ actions: [{ ...action, command: { ...action.command, input: [reference] } }] });
  const { user, dialog } = await open();
  await user.click(await within(dialog).findByRole('combobox', { name: 'Reviewer (required)' }));
  await screen.findByRole('option', { name: 'Ari Patel' });
  const asked = api.mock.calls.find((call) => call[0] === '/api/run')?.[1].q as string;
  expect(asked).toContain('team_id = 4');
  expect(asked).not.toContain('record.');
  drawn.unmount();

  // The record has no team (or the reader cannot see it): the picker stays shut rather than offer every reviewer.
  bound = null;
  api.mockClear();
  draw({ actions: [{ ...action, command: { ...action.command, input: [reference] } }] });
  const second = await open();
  expect(within(second.dialog).getByRole('combobox', { name: 'Reviewer (required)' })).toBeDisabled();
  expect(api.mock.calls.some((call) => call[0] === '/api/run')).toBe(false);
});

test('a field opens at its default, and what prepare starts it from stands over that', async () => {
  const input: AppCommandField[] = [
    { name: 'reason', label: 'Reason', type: 'textarea', required: true, default: 'Recount' },
    { name: 'count', label: 'Count', type: 'number', required: true, default: { record: 'on_hand' } },
    { name: 'counted_on', label: 'Counted on', type: 'date', required: true, default: { auto: 'today' } },
  ];
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3, initial: { count: 17 } } : success));
  draw({ actions: [{ ...action, command: { ...action.command, input } }] });
  const { dialog } = await open();
  expect(within(dialog).getByLabelText('Reason (required)')).toHaveValue('Recount');
  await vi.waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: /Count/ })).toHaveValue(17));
  const day = new Intl.DateTimeFormat('en-CA').format(new Date());
  expect(commandInput(input, { ...blankCommandValues(input), count: 1 })).toMatchObject({ reason: 'Recount', counted_on: day });
});

test('metadata validation bounds text and numbers without coercing reference IDs or false booleans', () => {
  const fields: AppCommandField[] = [
    { name: 'count', label: 'Count', type: 'number', required: true, integer: true, min: 1, max: 5 },
    { name: 'note', label: 'Note', type: 'text', maxLength: 4 },
    { name: 'flag', label: 'Flag', type: 'boolean', required: true },
    { name: 'ref', label: 'Reference', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' },
  ];
  expect(commandInput(fields, { count: '3', flag: false, ref: '9007199254740993' })).toEqual({
    count: 3,
    flag: false,
    ref: '9007199254740993',
  });
  for (const count of ['0', '6', '1.5', 'NaN', '9007199254740993']) expect(() => commandInput(fields, { count, flag: false })).toThrow();
  expect(() => commandInput(fields, { count: 2, flag: false, note: 'longer' })).toThrow('4 characters');
});

const reviewers = [
  { id: 'A-1', name: 'Ari Patel' },
  { id: 'M-2', name: 'Maya Chen' },
  { id: 'R-3', name: 'Robin Bell' },
];
/** A Reviewer field whose empty search answers at once and whose typed searches wait to be released. */
function drawReference() {
  const held = new Map<string, (value: unknown) => void>();
  api.mockImplementation(async (path: string, body: { q?: string }) => {
    if (path.endsWith('/prepare')) return { expectedVersion: 3 };
    if (path !== '/api/run') return success;
    const asked = /contains "([^"]*)"/.exec(body.q ?? '')?.[1];
    return asked === undefined
      ? { rows: reviewers }
      : new Promise((resolve) => {
          held.set(asked, resolve);
        });
  });
  const reference: AppCommandField = {
    name: 'reviewer',
    label: 'Reviewer',
    type: 'reference',
    from: 'reviewer',
    by: 'id',
    labelColumn: 'name',
    required: true,
  };
  draw({ actions: [{ ...action, command: { ...action.command, input: [reference] } }] });
  return held;
}

test('before the typed search is asked, the reference list offers only the rows the box names', async () => {
  /* The search waits for a pause in typing; until then the list answers the
     empty search with its first row lit, and Enter put Ari Patel into a
     command whose box said "rob". */
  drawReference();
  const { user, dialog } = await open();
  const box = within(dialog).getByRole('combobox', { name: 'Reviewer (required)' });
  await user.click(box);
  expect(await screen.findAllByRole('option')).toHaveLength(3);
  /* Typed (an `inputType`, so not autofill) and entered with only microtasks
     between (Base UI lights the first row in one), so the 150 ms pause
     cannot end before Enter. */
  fireEvent.input(box, { target: { value: 'rob' }, inputType: 'insertText' });
  await act(async () => {});
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Robin Bell']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box).toHaveValue('Robin Bell');
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() => expect(api.mock.calls.find((call) => call[0].endsWith('/execute'))?.[1].input).toEqual({ reviewer: 'R-3' }));
});

test('a reference list says nothing matches only once the typed search has answered', async () => {
  const held = drawReference();
  const { user, dialog } = await open();
  const box = within(dialog).getByRole('combobox', { name: 'Reviewer (required)' });
  await user.click(box);
  expect(await screen.findAllByRole('option')).toHaveLength(3);
  fireEvent.input(box, { target: { value: 'zed' }, inputType: 'insertText' });
  await act(async () => {});
  expect(screen.queryAllByRole('option')).toEqual([]);
  expect(screen.getByText('Loading choices…')).toBeInTheDocument();
  await vi.waitFor(() => expect(held.has('zed')).toBe(true));
  expect(screen.queryByText('No matching choices.')).toBeNull();
  await act(async () => {
    held.get('zed')!({ rows: [] });
  });
  expect(await screen.findByText('No matching choices.')).toBeInTheDocument();
});

test('an output without a message says Completed.', async () => {
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3 } : { ...success, result: { id: 7 } }));
  draw();
  const { dialog } = await submit();
  await vi.waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Completed.'));
});

/* The command's starting values arrive with the revision: until they are in
   the fields, submitting would send the blank form ("Reason is required"),
   so the button waits for them — never enabled over empty fields. */
test("submit is enabled only once the command's starting values are in the form", async () => {
  let answer!: () => void;
  api.mockImplementation((path: string) =>
    path.endsWith('/prepare')
      ? new Promise((resolve) => {
          answer = () => resolve({ expectedVersion: 3, initial: { reason: 'Prefilled reason' } });
        })
      : Promise.resolve(success),
  );
  draw();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Assign reviewer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign reviewer' });
  const button = within(dialog).getByRole('button', { name: 'Assign reviewer' }) as HTMLButtonElement;
  const field = within(dialog).getByLabelText('Reason (required)') as HTMLTextAreaElement;
  expect(button).toBeDisabled();
  // Every moment the button is live, what the form holds.
  const seen: string[] = [];
  const watch = new MutationObserver(() => {
    if (!button.disabled) seen.push(field.value);
  });
  watch.observe(button, { attributes: true, attributeFilter: ['disabled'] });
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
  answer();
  await vi.waitFor(() => expect(button).toBeEnabled());
  watch.disconnect();
  expect(field.value).toBe('Prefilled reason');
  expect(seen.length).toBeGreaterThan(0);
  expect(
    seen.every((value) => value === 'Prefilled reason'),
    JSON.stringify(seen),
  ).toBe(true);
});

test('a box that starts checked and is cleared sends false', async () => {
  /* A notice rule could not be turned off: its `active` started true from the
     command's `initial`, and clearing the box still sent true. */
  const toggle: AppCommandAction = {
    ...action,
    command: { ...action.command, input: [{ name: 'active', label: 'Send this notice', type: 'boolean' }] },
  };
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3, initial: { active: true } } : success));
  draw({ actions: [toggle] });
  const { user, dialog } = await open();
  const box = within(dialog).getByRole('checkbox', { name: 'Send this notice' });
  await vi.waitFor(() => expect(box).toBeChecked());
  await user.click(box);
  expect(box).not.toBeChecked();
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/commands/execute', expect.anything()));
  const sent = api.mock.calls.find(([path]) => path === '/api/commands/execute')![1] as { input: Record<string, unknown> };
  expect(sent.input).toEqual({ active: false });
});

test('starting values that arrive after the person has typed fill every field they have not touched', async () => {
  /* Resolve opens with "Also resolve its open child tickets" checked, from
     `initial`; an agent who typed the note before `prepare` answered got the
     box unchecked, and the children were left open. */
  const resolve: AppCommandAction = {
    ...action,
    command: {
      ...action.command,
      input: [
        { name: 'note', label: 'Note', type: 'textarea' },
        { name: 'children', label: 'Also resolve its open child tickets', type: 'boolean' },
      ],
    },
  };
  let answer!: () => void;
  api.mockImplementation((path: string) =>
    path.endsWith('/prepare')
      ? new Promise((done) => {
          answer = () => done({ expectedVersion: 3, initial: { note: 'Server note', children: true } });
        })
      : Promise.resolve(success),
  );
  draw({ actions: [resolve] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Assign reviewer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign reviewer' });
  const note = within(dialog).getByLabelText('Note') as HTMLTextAreaElement;
  await user.type(note, 'Typed first');
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
  answer();
  const box = within(dialog).getByRole('checkbox', { name: 'Also resolve its open child tickets' });
  await vi.waitFor(() => expect(box).toBeChecked());
  expect(note.value).toBe('Typed first');
});

test('another command applied to the record re-prepares an open form and holds its submit until the new revision is in', async () => {
  draw();
  const { user, dialog } = await open();
  await user.type(within(dialog).getByLabelText('Reason (required)'), 'North desk');
  let answer!: (value: { expectedVersion: number }) => void;
  api.mockImplementation((path: string) =>
    path.endsWith('/prepare')
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : Promise.resolve(success),
  );
  // Approve applies to the same record elsewhere on the page; nothing refreshes the page's queries.
  const other: CommandOwner = { ...owner, command: 'approve' };
  const approve = commandOperations.start(other, 3, {});
  await act(() =>
    commandOperations.send(
      approve,
      'execute',
      async () => ({ ...success, command: 'approve', receiptId: 'receipt-approve' }),
      () => {},
    ),
  );
  const button = within(dialog).getByRole('button', { name: 'Assign reviewer' });
  await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/commands/prepare', expect.objectContaining({ key: { id: 1 } })));
  expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(api.mock.calls.some(([path]) => path === '/api/commands/execute')).toBe(false);
  await act(async () => answer({ expectedVersion: 4 }));
  await vi.waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await vi.waitFor(() =>
    expect(api).toHaveBeenCalledWith('/api/commands/execute', expect.objectContaining({ command: 'assignReviewer', expectedVersion: 4 })),
  );
  commandOperations.forget(other);
});

test("a form a component's open holds is not drawn again by the record's action bar while it is in flight", async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation(async (path: string) =>
    path.endsWith('/prepare')
      ? { expectedVersion: 3 }
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const { CommandForm } = await import('./CommandForm.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CommandForm action={action} owner={owner} label="" headless onClose={vi.fn()} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const dialog = await screen.findByRole('dialog', { name: 'Assign reviewer' });
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  await user.type(within(dialog).getByLabelText('Reason (required)'), 'North desk');
  await user.click(within(dialog).getByRole('button', { name: 'Assign reviewer' }));
  expect(commandOperations.get(owner)?.headless).toBe(true);
  draw();
  await screen.findByRole('button', { name: 'Assign reviewer' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await act(async () => finish(success));
  expect(within(dialog).getByRole('status')).toHaveTextContent('Assigned.');
});

test('a field asked when the record says so is drawn only once prepare says the record asks it, and then required', async () => {
  const asking: AppCommandAction = {
    ...action,
    command: {
      ...action.command,
      input: [
        ...action.command.input,
        { name: 'waiver', label: 'Waiver', type: 'text', required: true, maxLength: 200, when: 'record.balance > 0' } as AppCommandField,
      ],
    },
  };
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3, withheld: ['waiver'] } : success));
  draw({ actions: [asking] });
  const first = await open();
  expect(within(first.dialog).queryByLabelText(/Waiver/)).toBeNull();
  cleanup();
  api.mockImplementation(async (path: string) => (path.endsWith('/prepare') ? { expectedVersion: 3 } : success));
  draw({ actions: [asking] });
  const second = await open();
  expect(within(second.dialog).getByLabelText('Waiver (required)')).toBeInTheDocument();
});

test("a component's form opened again after a refusal prepares afresh, not from the closed form's read", async () => {
  let executes = 0;
  let prepares = 0;
  let late!: () => void;
  api.mockImplementation(async (path: string) => {
    /* The second prepare is slow: whatever asks it then is still waiting when the form is opened again. */
    if (path.endsWith('/prepare'))
      return ++prepares === 2 ? new Promise((resolve) => (late = () => resolve({ expectedVersion: 3 }))) : { expectedVersion: 3 };
    if (++executes === 1)
      throw Object.assign(new Error('A champion against the deal is no champion.'), { code: 'refused', outcome: 'not_applied' });
    return success;
  });
  const { CommandForm } = await import('./CommandForm.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const user = userEvent.setup();
  /* As useCommand's open holds it (sdk/commands.tsx): one shared client, the form taken down a microtask after it
     closes (mount.tsx's unmount), so it draws once more with its operation forgotten. */
  const openForm = async () => {
    const view = render(
      <QueryClientProvider client={client}>
        <CommandForm
          action={action}
          owner={owner}
          label=""
          headless
          onClose={() => queueMicrotask(() => view.unmount())}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );
    return screen.findByRole('dialog', { name: 'Assign reviewer' });
  };
  const first = await openForm();
  await vi.waitFor(() => expect(within(first).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  await user.type(within(first).getByLabelText('Reason (required)'), 'North desk');
  await user.click(within(first).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() => expect(within(first).getByRole('status')).toHaveTextContent('A champion against the deal'));
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const second = await openForm();
  await act(async () => late?.());
  await vi.waitFor(() => expect(within(second).getByRole('button', { name: 'Assign reviewer' })).toBeEnabled());
  expect(within(second).getByRole('status')).not.toHaveTextContent('could not be prepared');
  // A closing form reads nothing more: the second form's own prepare is the only one after the refusal.
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/commands/prepare', '/api/commands/execute', '/api/commands/prepare']);
  await user.type(within(second).getByLabelText('Reason (required)'), 'South desk');
  await user.click(within(second).getByRole('button', { name: 'Assign reviewer' }));
  await vi.waitFor(() => expect(within(second).getByRole('status')).toHaveTextContent('Assigned.'));
});

test("a public form's picker reads its choices as the App's signed-out visitor, never through a session's connection", async () => {
  const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ rows: [{ id: 3, title: 'Garden flat' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    const field = { name: 'unit', label: 'Home', type: 'reference' as const, from: 'unit', by: 'id', labelColumn: 'title' };
    expect(await commandChoices(field, 'Gar', { visitor: { app: 'lintel', via: 'north' } })).toEqual([{ value: 3, label: 'Garden flat' }]);
    const [url, init] = fetched.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/run\?app=lintel&via=north$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      q: 'unit title contains "Gar" show id, title sort title',
      limit: 20,
      offset: 0,
      count: 'none',
    });
    // A refused read (a column the public may not read) is the picker's error, not an empty list.
    fetched.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(commandChoices(field, '', { visitor: { app: 'lintel' } })).rejects.toThrow();
  } finally {
    fetched.mockRestore();
  }
});

test('an open form with typed input is held: a change to its record is said in its status line, and nothing it holds is read over', async () => {
  const { editingRecords, resetLiveState } = await import('../../../../kit/src/client/liveState.js');
  const { invalidateLive, emptyBatch, addChange } = await import('../liveInvalidate.js');
  const { client } = draw();
  const { user, dialog } = await open();
  /* Untouched, the form still follows the record. */
  expect(editingRecords()).toEqual([]);
  const reason = within(dialog).getByLabelText('Reason (required)');
  await user.type(reason, 'North desk');
  expect(editingRecords()).toEqual([{ table: 'loan_application', key: { id: 1 } }]);
  const prepares = () => api.mock.calls.filter(([path]) => path === '/api/commands/prepare').length;
  const before = prepares();
  const change = emptyBatch();
  addChange(change, { tables: { loan_application: { keys: [{ id: '1' }], kinds: ['update'] } } });
  act(() => invalidateLive(change, client));
  const status = within(dialog).getByRole('status');
  await vi.waitFor(() => expect(status).toHaveTextContent(/changed this/));
  /* Even a reset, which asks every read again, does not prepare a typed form again and refill it. */
  act(() => invalidateLive({ ...emptyBatch(), reset: true }, client));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(prepares()).toBe(before);
  expect(reason).toHaveValue('North desk');
  await user.click(within(status).getByRole('button', { name: 'Keep editing' }));
  expect(status).not.toHaveTextContent(/changed this/);
  expect(reason).toHaveValue('North desk');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(editingRecords()).toEqual([]);
  resetLiveState();
});
