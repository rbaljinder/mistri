import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';
import type { PendingBarPlacement } from '../../../../kit/src/client/components/Editable.js';
import {
  acceptTenantRenewal,
  captureTenantLease,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
  suspendTenantLease,
} from '../../../../kit/src/client/sessionIdentity.js';

const model = vi.hoisted(() => ({
  mode: 'explicit' as 'explicit' | 'blur',
  current: true,
  api: vi.fn(),
  state: {
    activeConnection: 'demo',
    canWrite: true,
    connections: [{ id: 'demo', writable: true }],
    schema: undefined as { tables: TableMeta[]; foreignKeys: [] } | undefined,
  },
}));
vi.mock('../appState.js', () => ({ appSaveMode: () => model.mode }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  columnDisplay: () => null,
  $: () => ({ addEventListener() {}, setAttribute() {}, textContent: '', title: '' }),
  state: model.state,
  api: model.api,
  el: (tag: string) => document.createElement(tag),
  loadJson: () => ({}),
  saveJson: () => {},
  prefersPages: () => true,
  captureNavigation: () => () => true,
  setRecordMutationPendingProbe: () => {},
  render: () => {},
  toast: () => {},
  writeAllowed: () => true,
  columnKind,
  columnLabel: () => null,
  refsFrom: () => [],
  findTable: () => model.state.schema?.tables[0],
  viewportBox: (node: Element) => node.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({
  refreshUndo: () => {},
  undoLast: async () => {},
  undoEntry: async () => undefined,
}));
vi.mock('../../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
vi.mock('../../../../kit/src/client/recordWriteRefresh.js', () => ({ captureRecordWriteRefresh: () => () => {} }));
vi.mock('../../../../kit/src/client/components/RecordPicker.js', () => ({ RecordPicker: () => null }));
const { Editable, PendingBar } = await import('../../../../kit/src/client/components/Editable.js');
const { activateDraft, discardStaged, stagedValue, stagedAttempt } = await import('../../../../kit/src/client/write.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');
const table: TableMeta = {
  id: 'ticket',
  name: 'Ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
    { name: 'notes', type: 'TEXT', primaryKey: false, nullable: true },
  ],
};
const key = { id: 4 },
  row = { ...key, name: 'One', notes: 'Memo' };
const current = () => model.current;
const done = vi.fn();
function tree(placement?: PendingBarPlacement) {
  return (
    <div role="dialog" aria-label="Record">
      <PendingBar table={table} recordKey={key} placement={placement} isCurrent={current} onDone={done} />
      <Editable app table={table} recordKey={key} row={row} column={table.columns[1]} isCurrent={current} onSaved={done} />
      <Editable app table={table} recordKey={key} row={row} column={table.columns[2]} isCurrent={current} onSaved={done} />
    </div>
  );
}
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
beforeEach(bridgeShell);

beforeEach(() => {
  model.mode = 'explicit';
  model.current = true;
  model.state.activeConnection = 'demo';
  model.state.schema = { tables: [table], foreignKeys: [] };
  establishSessionIdentity({ signedIn: false });
  act(() => {
    updateAttempts.reset();
    activateDraft(table, key);
    discardStaged();
  });
  done.mockReset();
  model.api.mockReset();
  model.api.mockImplementation(async (_path, body) => ({ affected: 1, applied: body.values, undoId: 1 }));
});
afterEach(() => {
  cleanup();
  lockSessionIdentity();
});

test.each(['inline', 'container', 'mounting'] as const)(
  'explicit %s placement keeps actual draft/save/feedback inside the focus boundary',
  async (placement) => {
    const view = render(tree('inline'));
    const dialog = screen.getByRole('dialog');
    const target = document.createElement('div');
    dialog.append(target);
    const chosen = placement === 'inline' ? 'inline' : { container: placement === 'container' ? target : null };
    view.rerender(tree(chosen));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name'), ' changed');
    const input = screen.getByLabelText('Name'),
      draft = activateDraft(table, key);
    expect(within(dialog).getByRole('region', { name: 'Unsaved changes' })).not.toHaveClass('pending-dock');
    if (placement === 'container') expect(target).toContainElement(screen.getByRole('button', { name: 'Save changes' }));
    view.rerender(tree(chosen));
    expect(activateDraft(table, key)).toBe(draft);
    expect(screen.getByLabelText('Name')).toBe(input);
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(model.api).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(within(dialog).getByText('Changes saved')).toBeVisible());
    expect(model.api).toHaveBeenCalledExactlyOnceWith('/api/update', {
      conn: 'demo',
      table: 'ticket',
      key,
      values: { name: 'One changed' },
      expected: { name: 'One' },
    });
    expect(done).toHaveBeenLastCalledWith({ inPlace: true });
    expect(screen.getByLabelText('Name')).toBe(input);
    expect(input).toHaveValue('One changed');
    expect(within(dialog).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeVisible();
  },
);

test('omitted placement retains the routed App body dock', async () => {
  render(tree());
  await userEvent.setup().type(screen.getByLabelText('Name'), ' changed');
  const bar = screen.getByRole('region', { name: 'Unsaved changes' });
  expect(bar.parentElement).toBe(document.body);
  expect(bar).toHaveClass('pending-dock');
});

test('blur uses the existing one-attempt autosave and confirms the same mounted field', async () => {
  model.mode = 'blur';
  render(tree('inline'));
  const user = userEvent.setup();
  const input = screen.getByLabelText('Name');
  await user.type(input, ' changed');
  await user.click(screen.getByLabelText('Notes'));
  await waitFor(() => expect(model.api).toHaveBeenCalledOnce());
  await flush();
  expect(model.api).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Name')).toBe(input);
  expect(done).toHaveBeenLastCalledWith({ inPlace: true });
});

test('a retired surface cannot dispatch scheduled blur or explicit Save', async () => {
  model.mode = 'blur';
  render(tree('inline'));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), ' changed');
  const save = screen.getByRole('button', { name: 'Save changes' });
  model.current = false;
  await user.click(screen.getByLabelText('Notes'));
  await flush();
  fireEvent.click(save);
  expect(model.api).not.toHaveBeenCalled();
  expect(stagedValue('name')).toBe('One changed');
});

test('unknown Save stays inside the host with proposed changes and no retry/discard controls', async () => {
  model.api.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  render(tree('inline'));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), ' changed');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(stagedAttempt(table.id, key)?.phase).toBe('uncertain'));
  expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  expect(model.api).toHaveBeenCalledOnce();
});

test('late confirmed Save settles its real draft but does not call a retired surface', async () => {
  let resolve!: (reply: unknown) => void;
  model.api.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(tree('inline'));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), ' changed');
  done.mockClear();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  model.current = false;
  await act(async () => resolve({ affected: 1, applied: { name: 'One changed' } }));
  expect(done).not.toHaveBeenCalled();
  expect(stagedValue('name')).toBeUndefined();
  expect(model.api).toHaveBeenCalledOnce();
});

test('tenant renewal preserves identity, draft and mounted input; native retirement erases draft', async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'demo' });
  requireTenantSelection();
  establishTenantSelection({
    appId: 'demo',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'one',
    context: 'north-one',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
  const identity = sessionIdentity();
  const view = render(tree('inline'));
  const user = userEvent.setup();
  const input = screen.getByLabelText('Name');
  await user.type(input, ' changed');
  const draft = activateDraft(table, key),
    lease = captureTenantLease(identity)!;
  act(() => {
    suspendTenantLease(identity);
    acceptTenantRenewal(identity, lease.revision, { ...lease, revision: 2, expiresAt: Date.now() + 120_000 });
  });
  view.rerender(tree('inline'));
  expect(sessionIdentity()).toBe(identity);
  expect(activateDraft(table, key)).toBe(draft);
  expect(screen.getByLabelText('Name')).toBe(input);
  expect(input).toHaveValue('One changed');
  expect(screen.queryByRole('region', { name: 'Retained draft' })).toBeNull();
  expect(model.api).not.toHaveBeenCalled();
  act(() => lockSessionIdentity());
  expect(sessionIdentity()).not.toBe(identity);
  expect(stagedValue('name')).toBeUndefined();
});
