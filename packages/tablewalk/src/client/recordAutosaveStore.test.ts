import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';
import type { TableMeta } from '../../../engine/src/shared/schema.js';
import type { RecordEditControlState } from '../../../kit/src/client/recordEditValidation.js';

const model = vi.hoisted(() => ({
  activeConnection: 'a',
  canWrite: true,
  app: true,
  allowed: true,
  nav: 0,
  schema: undefined as { tables: TableMeta[] } | undefined,
  connections: [
    { id: 'a', writable: true },
    { id: 'b', writable: true },
  ],
}));
const refresh = vi.hoisted(() => ({ capture: vi.fn(), acknowledged: vi.fn() }));
/* Registered when `write.js` is imported, which happens once, before any test
   runs. A mock's own call record cannot answer for it: Vitest clears mocks
   between tests by default, so by the time the assertion runs the call made at
   module load is gone. A plain array is not a mock and is not cleared. */
const probe = vi.hoisted(() => ({ registered: [] as unknown[] }));
vi.mock('../../../kit/src/client/recordWriteRefresh.js', () => ({ captureRecordWriteRefresh: refresh.capture }));
vi.mock('../../../kit/src/client/core.js', () => ({
  state: model,
  prefersPages: () => model.app,
  writeAllowed: () => model.allowed,
  captureNavigation: () => {
    const nav = model.nav;
    return () => nav === model.nav;
  },
  api: vi.fn(),
  currentEntry: () => ({}),
  loadJson: (_key: string, fallback: unknown) => fallback,
  setRecordMutationPendingProbe: vi.fn((probeFn: unknown) => {
    probe.registered.push(probeFn);
  }),
  saveJson: vi.fn(),
  render: vi.fn(),
  toast: vi.fn(),
  el: (tag: string, attrs: Record<string, unknown> = {}, children: Node | Node[] = []) => {
    const node = document.createElement(tag);
    if (attrs.text) node.textContent = String(attrs.text);
    if (typeof attrs.onclick === 'function') node.addEventListener('click', attrs.onclick as EventListener);
    node.append(...[children].flat());
    return node;
  },
}));
vi.mock('./undo.js', () => ({ refreshUndo: vi.fn(), undoLast: vi.fn() }));
vi.mock('../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
const write = await import('../../../kit/src/client/write.js');
const { api, toast } = await import('../../../kit/src/client/core.js');
const { establishSessionIdentity } = await import('../../../kit/src/client/sessionIdentity.js');
const { beginConnectionTransition } = await import('../../../kit/src/client/connectionTransition.js');
const { refreshUndo } = await import('./undo.js');
const table: TableMeta = {
  id: 'task',
  name: 'Task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['open', 'done'] },
    { name: 'due', type: 'DATE', nullable: true, primaryKey: false },
    { name: 'assignee', type: 'TEXT', nullable: true, primaryKey: false, references: { table: 'staff', column: 'id' } },
  ],
};
const key = { id: '90071992547409931234' };
let identityNumber = 0;
beforeEach(bridgeShell);

beforeEach(() => {
  establishSessionIdentity({ signedIn: true, appId: 'store-test', accountId: `owner-${++identityNumber}` });
  Object.assign(model, { activeConnection: 'a', canWrite: true, app: true, allowed: true, schema: undefined });
  model.nav++;
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockClear();
  refresh.acknowledged.mockReset();
  refresh.capture.mockReset().mockReturnValue(refresh.acknowledged);
  vi.mocked(refreshUndo).mockClear();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
function stage(name = 'name', value: string | null = 'Changed', original: string | null = 'Original') {
  write.stage(
    table,
    key,
    table.columns.find((column) => column.name === name)!,
    value,
    original,
  );
}
function control(name: string, readState?: () => RecordEditControlState) {
  const input = document.createElement('input');
  document.body.append(input);
  const committed = vi.fn();
  const unregister = write.registerInput(table, key, name, input, committed, readState);
  return { input, committed, unregister };
}
function blur(guard = write.captureRecordAutosaveGuard(table, key, () => true)) {
  return write.applyStaged(table, key, undefined, { trigger: 'blur', guard });
}
function held() {
  let resolve!: (result: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (result: unknown) => resolve(result);
}
const applied = (values: Record<string, string | null> = { name: 'Changed' }) => ({ affected: 1, applied: values });

test('the core exit probe is registered once with the live exported function', () => {
  expect(probe.registered).toEqual([write.recordAutosavePending]);
});

test('blur dispatches one complete atomic payload with exact expected originals and confirms in place', async () => {
  const name = control('name'),
    status = control('status');
  stage();
  stage('name', 'Final', 'Replacement read');
  stage('status', 'done', 'open');
  vi.mocked(api).mockResolvedValueOnce(applied({ name: 'Final', status: 'done' }));
  await blur();
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/update', {
    conn: 'a',
    table: 'task',
    key,
    values: { name: 'Final', status: 'done' },
    expected: { name: 'Original', status: 'open' },
  });
  expect(name.committed).toHaveBeenCalledWith('Final');
  expect(status.committed).toHaveBeenCalledWith('done');
  expect(write.pendingCount()).toBe(0);
  expect(write.stagedEditErrors(table.id, key)).toEqual({});
  expect(write.stagedFeedback(table.id, key)?.phase).toBe('saved');
  expect(toast).not.toHaveBeenCalled();
  expect(refresh.capture).toHaveBeenCalledExactlyOnceWith(table.id, key);
  expect(refresh.acknowledged).toHaveBeenCalledTimes(1);
});

test.each(['explicit', 'blur'] as const)('%s refuses the entire invalid snapshot with no partial network write', async (trigger) => {
  control('name');
  control('status');
  stage();
  stage('status', 'other', 'open');
  await write.applyStaged(table, key, undefined, { trigger, guard: () => true });
  expect(api).not.toHaveBeenCalled();
  expect(write.retainedValues()).toEqual({ name: 'Changed', status: 'other' });
  expect(refresh.capture).not.toHaveBeenCalled();
  expect(refresh.acknowledged).not.toHaveBeenCalled();
  expect(write.stagedEditErrors(table.id, key)).toEqual({ status: 'Choose one of the available values.' });
  expect(write.stagedFeedback(table.id, key)).toBeUndefined();
  expect(toast).not.toHaveBeenCalled();
});

test('refresh is initially quiet and unchanged validation cannot make subscription effects loop', async () => {
  const read = vi.fn(() => ({ invalidInput: true }));
  control('due', read);
  stage();
  const before = write.stagedVersion();
  write.refreshEditValidation(table, key);
  expect(write.stagedVersion()).toBe(before);
  expect(read).not.toHaveBeenCalled();
  await blur();
  const errors = write.stagedEditErrors(table.id, key);
  const listener = vi.fn(() => write.refreshEditValidation(table, key));
  const stop = write.subscribeStaged(listener);
  write.refreshEditValidation(table, key);
  expect(listener).not.toHaveBeenCalled();
  expect(write.stagedEditErrors(table.id, key)).toBe(errors);
  read.mockReturnValue({ invalidInput: false });
  write.refreshEditValidation(table, key);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(write.stagedEditErrors(table.id, key)).toEqual({});
  stop();
  expect(api).not.toHaveBeenCalled();
});

test('an unresolved unstaged reference blocks the draft; resolution permits a fresh blur without staging search text', async () => {
  let unresolvedReference = true;
  control('assignee', () => ({ unresolvedReference }));
  stage();
  await blur();
  expect(api).not.toHaveBeenCalled();
  expect(write.stagedEditErrors(table.id, key)).toEqual({ assignee: 'Choose a record or clear the field.' });
  unresolvedReference = false;
  write.refreshEditValidation(table, key);
  vi.mocked(api).mockResolvedValueOnce(applied());
  await blur();
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/update', expect.objectContaining({ values: { name: 'Changed' } }));
});

test.each([
  () => {
    throw new Error('SECRET callback detail');
  },
  () => ({
    get invalidInput(): boolean {
      throw new Error('SECRET getter detail');
    },
  }),
  () => ({ invalidInput: 'false' }),
  () => Promise.resolve({}),
] as Array<() => unknown>)('faulty or asynchronous control readers fail closed with sanitized field errors', async (read) => {
  control('due', read as () => RecordEditControlState);
  stage();
  await blur();
  expect(api).not.toHaveBeenCalled();
  expect(write.stagedEditErrors(table.id, key)).toEqual({ due: 'Enter a valid value.' });
  expect(write.stagedFeedback(table.id, key)).toBeUndefined();
  expect(toast).not.toHaveBeenCalled();
});

test('unregister matches the original registration and detached controls do not supply transient errors', async () => {
  const old = control('due', () => ({ invalidInput: true }));
  const fresh = control('due', () => ({ invalidInput: true }));
  old.unregister();
  stage();
  await blur();
  expect(api).not.toHaveBeenCalled();
  fresh.input.remove();
  write.refreshEditValidation(table, key);
  expect(write.stagedEditErrors(table.id, key)).toEqual({});
  const newest = control('due', () => ({}));
  fresh.unregister();
  vi.mocked(api).mockResolvedValueOnce(applied());
  await blur();
  expect(api).toHaveBeenCalledTimes(1);
  expect(newest.input.isConnected).toBe(true);
});

test('explicit validation focuses the first invalid catalog field; passive validation leaves focus alone', async () => {
  const name = control('name');
  const status = control('status');
  const elsewhere = control('due');
  stage('status', 'other', 'open');
  stage('name', '', 'Original');
  elsewhere.input.focus();
  await blur();
  expect(document.activeElement).toBe(elsewhere.input);
  await write.applyStaged(table, key);
  expect(document.activeElement).toBe(name.input);
  stage('name', 'Corrected');
  await write.applyStaged(table, key);
  expect(document.activeElement).toBe(status.input);
  expect(api).not.toHaveBeenCalled();
});

test('feedback includes only inaccessible errors and disappears when they become inline-accessible', async () => {
  control('name');
  stage('name', '');
  stage('status', 'other', 'open');
  await blur();
  expect(write.stagedFeedback(table.id, key)?.message).toBe('status: Choose one of the available values.');
  control('status');
  write.refreshEditValidation(table, key);
  expect(write.stagedFeedback(table.id, key)).toBeUndefined();
  expect(Object.keys(write.stagedEditErrors(table.id, key))).toEqual(['name', 'status']);
});

test.each(['blur-first', 'explicit-first'] as const)(
  '%s suppresses duplicate blur/Enter during and after acknowledgement',
  async (order) => {
    stage();
    const guard = write.captureRecordAutosaveGuard(table, key, () => true);
    const resolve = held();
    const saving = order === 'blur-first' ? blur(guard) : write.applyStaged(table, key);
    await write.applyStaged(table, key);
    await blur(guard);
    expect(api).toHaveBeenCalledTimes(1);
    stage('name', 'Queued edit');
    expect(write.retainedValues()).toEqual({ name: 'Changed' });
    resolve(applied());
    await saving;
    await blur(guard);
    expect(api).toHaveBeenCalledTimes(1);
  },
);

test.each(['missing', 'false', 'truthy', 'throwing'] as const)('blur requires a supplied strictly true guard: %s', async (kind) => {
  stage();
  const guard =
    kind === 'missing'
      ? undefined
      : kind === 'false'
        ? () => false
        : kind === 'truthy'
          ? ((() => 1) as unknown as () => boolean)
          : () => {
              throw new Error('guard');
            };
  await write.applyStaged(table, key, undefined, { trigger: 'blur', guard });
  expect(api).not.toHaveBeenCalled();
  expect(write.recordAutosavePending()).toBe(false);
});

test.each(['mode', 'writer', 'resource', 'schema', 'connection', 'identity', 'navigation', 'cancellation'] as const)(
  '%s changed after capture prevents dispatch',
  async (change) => {
    stage();
    const guard = write.captureRecordAutosaveGuard(table, key, () => true);
    if (change === 'mode') model.app = false;
    if (change === 'writer') model.canWrite = false;
    if (change === 'resource') model.allowed = false;
    if (change === 'schema') model.schema = { tables: [table] };
    if (change === 'connection') model.activeConnection = 'b';
    if (change === 'identity') establishSessionIdentity({ signedIn: true, appId: 'x', accountId: 'replacement' });
    if (change === 'navigation') model.nav++;
    if (change === 'cancellation') write.cancelRecordAutosave();
    await blur(guard);
    expect(api).not.toHaveBeenCalled();
  },
);

test('control callbacks that cancel or replace the current draft cannot dispatch a previously valid snapshot', async () => {
  control('due', () => {
    write.cancelRecordAutosave();
    return {};
  });
  stage();
  await blur();
  expect(api).not.toHaveBeenCalled();
  expect(write.retainedValues()).toEqual({ name: 'Changed' });
});

test('rejection stays manual through correction, remount and Resume; only explicit save submits again', async () => {
  stage();
  vi.mocked(api).mockResolvedValueOnce({ outcome: 'rejected', errors: [{ message: 'Conflict' }] });
  await blur();
  expect(write.stagedFeedback(table.id, key)?.message).toBe('Conflict');
  expect(refresh.acknowledged).not.toHaveBeenCalled();
  stage('name', 'Corrected');
  await blur(() => true);
  const draft = write.activateDraft(table, key);
  write.suspendDraft(draft);
  write.activateDraft(table, key);
  write.resumeDraft(table, key);
  await blur(() => true);
  expect(api).toHaveBeenCalledTimes(1);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
  vi.mocked(api).mockResolvedValueOnce(applied({ name: 'Corrected' }));
  await write.applyStaged(table, key);
  expect(api).toHaveBeenCalledTimes(2);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
});

test.each(['Save', 'Discard'] as const)(
  'returning a rejected draft to its original cannot bypass the latch before explicit %s',
  async (intent) => {
    stage();
    vi.mocked(api).mockResolvedValueOnce({ outcome: 'rejected', errors: [{ message: 'Conflict' }] });
    await blur();
    stage('name', 'Original');
    expect(write.pendingCount()).toBe(0);
    const draft = write.activateDraft(table, key);
    write.suspendDraft(draft);
    write.activateDraft(table, key);
    expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
    stage();
    await blur(() => true);
    expect(api).toHaveBeenCalledTimes(1);
    if (intent === 'Save') {
      vi.mocked(api).mockResolvedValueOnce(applied());
      await write.applyStaged(table, key);
    } else write.discardStaged();
    expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
    stage('name', 'Fresh', 'Changed');
    vi.mocked(api).mockResolvedValueOnce(applied({ name: 'Fresh' }));
    await blur();
    expect(write.pendingCount()).toBe(0);
  },
);

test('uncertain acknowledgement locks all further saves without queue or retry', async () => {
  stage();
  vi.mocked(api).mockResolvedValueOnce({ affected: 1, applied: {} });
  await blur();
  expect(write.recordAutosavePending()).toBe(false);
  expect(write.stagedAttempt(table.id, key)?.phase).toBe('uncertain');
  stage('name', 'Retry');
  await blur(() => true);
  await write.applyStaged(table, key);
  expect(api).toHaveBeenCalledTimes(1);
  expect(write.retainedValues()).toEqual({ name: 'Changed' });
  expect(refresh.acknowledged).not.toHaveBeenCalled();
});

test('pending is set before transport, only for the original blur and current identity, and clears in finally', async () => {
  stage();
  const resolve = held();
  const saving = blur();
  expect(write.recordAutosavePending()).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
  write.cancelRecordAutosave();
  expect(write.recordAutosavePending()).toBe(true);
  model.activeConnection = 'b';
  expect(write.recordAutosavePending()).toBe(true);
  establishSessionIdentity({ signedIn: true, appId: 'x', accountId: 'replacement' });
  expect(write.recordAutosavePending()).toBe(false);
  resolve(applied());
  await saving;
  expect(write.recordAutosavePending()).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

test('explicit requests never set the autosave exit guard', async () => {
  stage();
  const resolve = held();
  const saving = write.applyStaged(table, key);
  expect(write.recordAutosavePending()).toBe(false);
  resolve(applied());
  await saving;
});

test('late original success after timeout settles its retained draft without touching the replacement editor', async () => {
  vi.useFakeTimers();
  stage();
  const original = write.activateDraft(table, key);
  const resolve = held();
  const saving = blur();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(refresh.capture).toHaveBeenCalledExactlyOnceWith(table.id, key);
  expect(refresh.acknowledged).not.toHaveBeenCalled();
  expect(write.stagedAttempt(table.id, key)?.phase).toBe('uncertain');
  expect(write.recordAutosavePending()).toBe(false);
  write.suspendDraft(original);
  const otherKey = { id: 'other' };
  write.stage(table, otherKey, table.columns[1], 'Other draft', 'Other original');
  resolve(applied());
  await saving;
  expect(refresh.acknowledged).toHaveBeenCalledTimes(1);
  expect(refreshUndo).toHaveBeenCalledTimes(1);
  expect(write.retainedValues()).toEqual({ name: 'Other draft' });
  expect(write.recordAutosavePending()).toBe(false);
  write.activateDraft(table, key);
  expect(write.pendingCount()).toBe(0);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
  expect(write.stagedAttempt(table.id, key)).toBeUndefined();
});

test('cancel and Discard invalidate deferred captures while cancel retains the draft', async () => {
  stage();
  const guard = write.captureRecordAutosaveGuard(table, key, () => true);
  write.cancelRecordAutosave();
  expect(write.retainedValues()).toEqual({ name: 'Changed' });
  await blur(guard);
  const another = write.captureRecordAutosaveGuard(table, key, () => true);
  write.discardStaged();
  stage();
  await blur(another);
  expect(api).not.toHaveBeenCalled();
});

test('Workbench retains explicit review/apply and does not use App control preflight', async () => {
  model.app = false;
  control('due', () => ({ invalidInput: true }));
  stage('name', '');
  await blur(() => true);
  expect(api).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValueOnce(applied({ name: '' }));
  const saving = write.applyStaged(table, key);
  const dialog = document.querySelector('dialog')!;
  expect(dialog).not.toBeNull();
  [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Apply')!.click();
  await saving;
  expect(api).toHaveBeenCalledTimes(1);
  expect(write.stagedEditErrors(table.id, key)).toEqual({});
  expect(refresh.capture).not.toHaveBeenCalled();
  expect(refresh.acknowledged).not.toHaveBeenCalled();
});

test('a throwing presentation callback after confirmed success cannot retain or resend applied edits', async () => {
  stage();
  vi.mocked(api).mockResolvedValueOnce(applied());
  await write.applyStaged(
    table,
    key,
    () => {
      throw new Error('presentation failed');
    },
    { trigger: 'blur', guard: () => true },
  );
  expect(write.pendingCount()).toBe(0);
  expect(write.recordAutosavePending()).toBe(false);
  expect(refresh.acknowledged).toHaveBeenCalledTimes(1);
  await blur(() => true);
  expect(api).toHaveBeenCalledTimes(1);
});

test('pending is already visible inside transport and finally clears after a lost response', async () => {
  stage();
  vi.mocked(api).mockImplementationOnce(async () => {
    expect(write.recordAutosavePending()).toBe(true);
    expect(refresh.capture).toHaveBeenCalledTimes(1);
    throw new Error('lost response');
  });
  await blur();
  expect(write.recordAutosavePending()).toBe(false);
  expect(write.stagedAttempt(table.id, key)?.phase).toBe('uncertain');
  expect(refresh.acknowledged).not.toHaveBeenCalled();
});

test.each(['navigation', 'cancel', 'identity', 'mode'] as const)(
  'a synchronous pending subscriber can retire %s before transport',
  async (reason) => {
    stage();
    const stop = write.subscribeStaged(() => {
      if (!write.recordAutosavePending()) return;
      if (reason === 'navigation') model.nav++;
      if (reason === 'cancel') write.cancelRecordAutosave();
      if (reason === 'identity') establishSessionIdentity({ signedIn: true, appId: 'x', accountId: 'new' });
      if (reason === 'mode') model.app = false;
    });
    await blur();
    stop();
    expect(api).not.toHaveBeenCalled();
    expect(write.recordAutosavePending()).toBe(false);
  },
);

test('the record is frozen before pending subscribers run, with no queued payload extension', async () => {
  stage();
  const resolve = held();
  const stop = write.subscribeStaged(() => {
    if (write.recordAutosavePending()) stage('status', 'done', 'open');
  });
  const saving = blur();
  stop();
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/update', expect.objectContaining({ values: { name: 'Changed' } }));
  expect(write.retainedValues()).toEqual({ name: 'Changed' });
  resolve(applied());
  await saving;
  expect(write.pendingCount()).toBe(0);
});

test.each(['identity', 'connection', 'schema', 'connection-generation'] as const)(
  'late acknowledged writes do not refresh replacement history after %s changes',
  async (change) => {
    stage();
    const resolve = held();
    const saving = blur();
    if (change === 'identity') establishSessionIdentity({ signedIn: true, appId: 'x', accountId: 'new' });
    if (change === 'connection') model.activeConnection = 'b';
    if (change === 'schema') model.schema = { tables: [table] };
    if (change === 'connection-generation') beginConnectionTransition().finish();
    resolve(applied());
    await saving;
    expect(refreshUndo).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(1);
  },
);
