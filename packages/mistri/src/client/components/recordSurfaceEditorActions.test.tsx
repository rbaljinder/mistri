import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ActionBarProps } from './Actions.js';
import type { AppCommandAction } from '../../shared/app.js';
import { establishSessionIdentity, lockSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { commandOperations, type CommandOwner } from '../commandState.js';
import { updateAttempts } from '../../../../kit/src/client/updateAttempts.js';

const model = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  current: true,
  app: true,
  close: undefined as (() => void) | undefined,
  state: { activeConnection: 'demo' },
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: (path: string, body: { checks: Array<{ command: string; commandVersion: number; keys: unknown[] }> }) =>
    path === '/api/commands/availability'
      ? Promise.resolve({
          checks: body.checks.map((check) => ({
            command: check.command,
            commandVersion: check.commandVersion,
            available: check.keys.map(() => true),
          })),
        })
      : model.api(path, body),
  toast: model.toast,
  state: model.state,
  prefersPages: () => model.app,
  columnLabel: () => null,
  humanName: (s: string) => s,
  findTable: () => ({ id: 'ticket', columns: [] }),
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null }));
vi.mock('@mistriwork/ui/Typeahead.js', () => ({ Typeahead: () => null }));
vi.mock('@mistriwork/ui/Modal.js', () => ({
  Modal: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => {
    model.close = onClose;
    return <div role="dialog">{children}</div>;
  },
}));
const { ActionBar } = await import('./Actions.js');
// It confirms, so its form opens: a command that asks nothing and does not confirm runs on one click (Actions.command.test.tsx).
const command: AppCommandAction = {
  id: 'assign',
  label: 'Assign',
  confirm: true,
  command: {
    id: 'assign',
    version: 1,
    target: 'ticket',
    input: [],
  },
};
const owner: CommandOwner = { connection: 'demo', target: 'ticket', command: 'assign', commandVersion: 1, key: { id: 1 } };
const success = { status: 'applied', command: 'assign', commandVersion: 1, resource: 'ticket', key: { id: 1 }, receiptId: 'receipt-1' };
const current = () => model.current;
const clients: QueryClient[] = [];
function draw(overrides: Partial<ActionBarProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const done = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ActionBar
        tableId="ticket"
        recordKey={{ id: 1 }}
        label="One"
        actions={[{ id: 'close', label: 'Close', set: { status: 'closed' } }]}
        matches={async () => true}
        onDone={done}
        isCurrent={current}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { ...view, done, client };
}
beforeEach(() => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'demo' });
  model.current = true;
  model.app = true;
  model.state.activeConnection = 'demo';
  model.api.mockReset();
  model.toast.mockReset();
  model.api.mockImplementation(async (path, body) =>
    path.endsWith('/prepare') ? { expectedVersion: 3 } : path.endsWith('/update') ? { affected: 1, applied: body.values } : success,
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  lockSessionIdentity();
});

test('fixed action checks its host before click and again at deferred mutation dispatch', async () => {
  draw();
  const button = screen.getByRole('button', { name: 'Close' });
  model.current = false;
  fireEvent.click(button);
  expect(model.api).not.toHaveBeenCalled();
  model.current = true;
  act(() => {
    fireEvent.click(button);
    model.current = false;
  });
  await act(async () => {});
  expect(model.api).not.toHaveBeenCalled();
  expect(updateAttempts.get({ connection: 'demo', table: 'ticket', key: { id: 1 } })).toBeUndefined();
});

test('fixed action checks its host at the actual request even after an attempt starts', async () => {
  const run = updateAttempts.run.bind(updateAttempts);
  vi.spyOn(updateAttempts, 'run').mockImplementationOnce(async (owner, values, request) => {
    model.current = false;
    return run(owner, values, request);
  });
  draw();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
  expect(model.api).not.toHaveBeenCalled();
  expect(updateAttempts.get({ connection: 'demo', table: 'ticket', key: { id: 1 } })).toBeUndefined();
});

test('a fixed confirmation, in an App as in the Workbench, cannot dispatch from a retired host at the same URL', async () => {
  draw({ actions: [{ id: 'close', label: 'Close', set: { status: 'closed' }, confirm: true }] });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  model.current = false;
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
  expect(model.api).not.toHaveBeenCalled();
});

test.each(['host', 'native', 'unmount'])(
  'late fixed-action acknowledgement after %s retirement settles only the existing attempt',
  async (boundary) => {
    let resolve!: (value: unknown) => void;
    model.api.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = draw();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    if (boundary === 'host') model.current = false;
    if (boundary === 'native') act(() => lockSessionIdentity());
    if (boundary === 'unmount') view.unmount();
    await act(async () => resolve({ affected: 1, applied: { status: 'closed' } }));
    expect(view.done).not.toHaveBeenCalled();
    expect(model.toast).not.toHaveBeenCalled();
    expect(model.api).toHaveBeenCalledOnce();
    expect(updateAttempts.get({ connection: 'demo', table: 'ticket', key: { id: 1 } })).toBeUndefined();
  },
);

async function openCommand() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Assign' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign' })).toBeEnabled());
  return { user, dialog };
}

test('authored command receives the host fence: stale submit cannot start an operation', async () => {
  draw({ actions: [command], canUpdate: false, grantedCommands: ['assign'] });
  const { user, dialog } = await openCommand();
  model.current = false;
  await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
  expect(commandOperations.get(owner)).toBeUndefined();
  expect(model.api).toHaveBeenCalledOnce();
});

test('command dispatch rechecks host after operation creation, without a network write', async () => {
  const start = commandOperations.start.bind(commandOperations);
  vi.spyOn(commandOperations, 'start').mockImplementationOnce((...args) => {
    const operation = start(...args);
    model.current = false;
    return operation;
  });
  draw({ actions: [command], grantedCommands: ['assign'] });
  const { user, dialog } = await openCommand();
  await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
  expect(model.api).toHaveBeenCalledOnce();
  expect(commandOperations.get(owner)?.phase).toBe('error'); // definite local not-applied, not a lost response
});

test.each(['applied', 'unknown'])(
  'command %s survives form unmount; a stale close cannot forget pending or complete another host',
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    model.api.mockImplementation(async (path) =>
      path.endsWith('/prepare')
        ? { expectedVersion: 3 }
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const view = draw({ actions: [command], grantedCommands: ['assign'] });
    const { user, dialog } = await openCommand();
    const staleClose = model.close!;
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    const operation = commandOperations.get(owner)!;
    act(() => staleClose());
    expect(commandOperations.get(owner)).toBe(operation);
    expect(operation.phase).toBe('pending');
    view.unmount();
    await act(async () => resolve(outcome === 'applied' ? success : { outcome: 'unknown' }));
    expect(commandOperations.get(owner)).toBe(operation);
    expect(operation.phase).toBe(outcome === 'applied' ? 'success' : 'unknown');
    expect(view.done).not.toHaveBeenCalled();
    expect(model.api).toHaveBeenCalledTimes(2);
  },
);

test('unknown command retains the same envelope and blocks stale host status/retry/close callbacks', async () => {
  model.api.mockImplementation(async (path) => (path.endsWith('/prepare') ? { expectedVersion: 3 } : { outcome: 'unknown' }));
  draw({ actions: [command], grantedCommands: ['assign'] });
  const { user, dialog } = await openCommand();
  await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
  await waitFor(() => expect(commandOperations.get(owner)?.phase).toBe('unknown'));
  const operation = commandOperations.get(owner),
    envelope = operation?.envelope;
  const retry = screen.getByRole('button', { name: 'Retry same submission' });
  const status = screen.getByRole('button', { name: 'Check result' });
  model.current = false;
  fireEvent.click(retry);
  fireEvent.click(status);
  act(() => model.close?.());
  expect(commandOperations.get(owner)).toBe(operation);
  expect(operation?.envelope).toBe(envelope);
  expect(operation?.phase).toBe('unknown');
  expect(model.api).toHaveBeenCalledTimes(2);
});

test.each(['before', 'after'])(
  'Complete → route replacement shows Reopen when retired visibility settles %s replacement',
  async (timing) => {
    // Match the application's fresh-cache window: a fresh false from the old
    // owner must not suppress the new owner's read or join its in-flight query.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 }, mutations: { retry: false } } });
    clients.push(client);
    let completed = false,
      retired = false;
    const held: Array<() => void> = [];
    const matches = vi.fn(async (when: string) => (when === 'completed = 1' ? completed : !completed));
    const oldMatches = vi.fn(async (when: string) => {
      if (!completed) return when === 'completed = 0';
      // Invalidation begins before go(replace); the old surface then retires
      // while its reads are still waiting and correctly reports false.
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
      return !retired && (await matches(when));
    });
    model.api.mockImplementationOnce(async (_path, body) => {
      completed = true;
      return { affected: 1, applied: body.values };
    });
    const tree = (scope: number) => (
      <QueryClientProvider client={client}>
        <ActionBar
          tableId="ticket"
          recordKey={{ id: 1 }}
          label="One"
          queryScope={scope}
          actions={[
            { id: 'complete', label: 'Complete', set: { completed: 1 }, when: 'completed = 0' },
            { id: 'reopen', label: 'Reopen', set: { completed: 0 }, when: 'completed = 1' },
          ]}
          matches={scope === 1 ? oldMatches : matches}
          onDone={() => {
            retired = true;
          }}
        />
      </QueryClientProvider>
    );
    const view = render(tree(1));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(retired).toBe(true);
    expect(completed).toBe(true);
    if (timing === 'before')
      await act(async () => {
        held.forEach((resolve) => resolve());
      });
    view.rerender(tree(2));
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeVisible();
    if (timing === 'after')
      await act(async () => {
        held.forEach((resolve) => resolve());
      });
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    const queries = client.getQueryCache().findAll({ queryKey: ['when', 'ticket'] });
    expect(queries).toHaveLength(4);
    expect(queries.filter((query) => query.queryKey.at(-1) === 1).map((query) => query.state.data)).toEqual([false, false]);
    expect(matches).toHaveBeenCalledTimes(2);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['when', 'ticket'] });
    });
    expect(matches).toHaveBeenCalledTimes(4); // prefix invalidation still reaches the new scope
    expect(model.api).toHaveBeenCalledOnce();
  },
);
