import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PageProps, PageViewHost } from '../../../../kit/src/client/components/Page.js';
import type { PendingBarProps } from '../../../../kit/src/client/components/Editable.js';
import type { ActionBarProps } from './Actions.js';
import type { DeleteButtonHost } from '../../../../kit/src/client/components/DeleteButton.js';

const mock = vi.hoisted(() => ({
  go: vi.fn(),
  pending: undefined as PendingBarProps | undefined,
  actions: undefined as ActionBarProps | undefined,
  deletion: undefined as DeleteButtonHost | undefined,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  go: mock.go,
  labelPath: () => undefined,
  state: { activeConnection: 'demo' },
  registerSurfaceMutationPendingProbe: () => () => {},
}));
vi.mock('../../../../kit/src/client/components/NewRecord.js', () => ({ NewRecordDialog: () => null }));
vi.mock('../appState.js', () => ({ inAppMode: () => true, activeApp: () => null }));
vi.mock('../../../../kit/src/client/write.js', () => ({
  canEditRow: () => true,
  // The head's draft subscription (PageHead.tsx): no draft here.
  pendingCount: () => 0,
  sameRow: () => false,
  stagedVersion: () => 0,
  subscribeStaged: () => () => {},
}));
vi.mock('../../../../kit/src/client/prefs.js', () => ({ relatedRows: () => 10 }));
vi.mock('../../../../kit/src/client/pagemarks.js', () => ({ isPinned: () => false, togglePinned: () => true }));
vi.mock('../../../../kit/src/client/insert.js', () => ({ canInsert: () => false }));
vi.mock('../../../../kit/src/client/components/walk.js', () => ({ useWalk: () => {} }));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null, RefJump: () => null }));
vi.mock('../../../../kit/src/client/components/Grid.js', () => ({ Grid: () => null }));
vi.mock('../../../../kit/src/client/components/Dropdown.js', () => ({ Dropdown: () => null }));
vi.mock('../../../../kit/src/client/components/WorkflowStatus.js', () => ({ WorkflowStatus: () => null }));
vi.mock('../../../../kit/src/client/components/Editable.js', () => ({
  Editable: () => null,
  PendingBar: (props: PendingBarProps) => {
    mock.pending = props;
    return null;
  },
}));
vi.mock('./Actions.js', () => ({
  ActionBar: (props: ActionBarProps) => {
    mock.actions = props;
    return (
      <>
        {props.actions.map((action) => (
          <button key={action.label}>{action.label}</button>
        ))}
      </>
    );
  },
  useReachable: () => new Set(),
}));
// The head asks useDelete for Delete (drawn last in More); the host it passes is what is checked.
vi.mock('../../../../kit/src/client/components/DeleteButton.js', () => ({
  useDelete: ({ host }: { host?: DeleteButtonHost }) => {
    mock.deletion = host;
    return { available: true, blocked: false, ask: () => {}, dialog: null };
  },
}));
const { PageView } = await import('../../../../kit/src/client/components/Page.js');

function props(): PageProps {
  return {
    entry: { kind: 'page', pageId: 'ticket', table: 'ticket', key: { id: 1 }, label: 'One' },
    page: { id: 'ticket', name: 'Ticket', base: 'ticket', source: 'config', sections: [] },
    base: { id: 'ticket', name: 'Ticket', schema: '', isView: false, columns: [] },
    plans: [],
    others: [],
    onLabel: vi.fn(),
    onTab: vi.fn(),
    onLayout: vi.fn(),
    actions: {
      list: [
        { id: 'close', label: 'Close', set: { status: 'closed' } },
        {
          id: 'assign',
          label: 'Assign',
          command: {
            id: 'assign',
            version: 1,
            target: 'ticket',
            input: [],
          },
        },
      ],
      matches: async () => true,
      queryScope: 42,
      canUpdate: true,
      grantedCommands: ['assign'],
    },
  };
}
function host(): PageViewHost {
  // The loader's branded factory has separate authority/schema/renewal tests.
  // Here the supplied lifetime predicate is controlled independently of URL.
  return {
    owner: { connection: 'demo', queryScope: 1, isCurrent: vi.fn(() => true) } as unknown as PageViewHost['owner'],
    pendingBar: 'inline',
    onRecordChange: vi.fn(),
    onActionDone: vi.fn(),
    onDeleted: vi.fn(),
    onDeleteStateChange: vi.fn(),
  };
}
function draw(initial: PageProps) {
  const client = new QueryClient();
  const tree = (value: PageProps) => (
    <QueryClientProvider client={client}>
      <PageView {...value} />
    </QueryClientProvider>
  );
  const view = render(tree(initial));
  return { ...view, client, replace: (value: PageProps) => view.rerender(tree(value)) };
}
beforeEach(bridgeShell);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('the route default refreshes the record in place, never by replacing the walk, and leaves body dock/deletion defaults alone', () => {
  /* Replacing the walk entry started the room over: the record page stood
     blank until every read had been asked again. */
  const initial = props();
  const { client } = draw(initial);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  expect(mock.pending?.placement).toBeUndefined();
  expect(mock.pending?.isCurrent).toBeUndefined();
  expect(mock.deletion).toBeUndefined();
  expect(mock.actions?.queryScope).toBe(42);
  act(() => mock.pending?.onDone?.({ inPlace: false }));
  act(() => mock.actions?.onDone());
  expect(mock.go).not.toHaveBeenCalled();
  const planned = invalidate.mock.calls
    .map(([filters]) => filters?.predicate)
    .filter((predicate): predicate is NonNullable<typeof predicate> => typeof predicate === 'function');
  const query = (queryKey: unknown[]) => ({ queryKey }) as unknown as Parameters<NonNullable<(typeof planned)[number]>>[0];
  // The record's fields on any page that shows them: a command's receipt does not know the page it ran from.
  expect(planned.some((predicate) => predicate(query(['page-fields', 'ticket', 'ticket', { id: 1 }])))).toBe(true);
  expect(planned.some((predicate) => predicate(query(['page-fields', 'ticket', 'ticket', { id: 2 }])))).toBe(false);
  expect(planned.some((predicate) => predicate(query(['page-plan', 'demo', 'ticket', '{"id":1}', '', 42])))).toBe(true);
  expect(planned.some((predicate) => predicate(query(['page-plan', 'demo', 'ticket', '{"id":1}', '', 7])))).toBe(false);
  expect(screen.getByText('Close')).toBeInTheDocument();
});

test.each(['an action', 'a Save that asks for a repaint'])(
  'after %s every section read the page holds for the record asks again, and another record keeps its reads',
  async (path) => {
    /* The remount used to re-read everything; refreshing in place re-read only the fields, so the
       history an action had just written stayed two entries long (record-history.spec). */
    const { client } = draw(props());
    const mine = { id: 1 },
      theirs = { id: 2 };
    const reads = {
      history: ['page-history', 'ticket', mine, 20],
      flows: ['page-flows', 'ticket', mine],
      custom: ['page-custom', 'record', 'ticket', 'ticket', mine, ['status']],
      customReads: ['page-custom', 'reads', { notes: 'q' }],
      links: ['page-link-fields', 3, 'ticket', 'ticket', mine, ['owner']],
      children: ['record-children', 'ticket', mine, ['fk']],
      related: ['page-list', { base: 'note', q: 'ticket_id = 1' }, 0],
      timeline: ['page-timeline', [{ from: 'note' }], 20, undefined, undefined],
      metric: ['page-metric', { base: 'note' }],
      breakdown: ['page-breakdown', { base: 'note' }],
      otherHistory: ['page-history', 'ticket', theirs, 20],
      otherFlows: ['page-flows', 'ticket', theirs],
      otherTable: ['page-history', 'customer', mine, 20],
    } as const;
    for (const key of Object.values(reads)) client.setQueryData([...key], { rows: [] });
    await act(async () => {
      if (path === 'an action') mock.actions?.onDone();
      else mock.pending?.onDone?.({ inPlace: false });
    });
    const stale = (key: readonly unknown[]) => client.getQueryState([...key])?.isInvalidated;
    const { otherHistory, otherFlows, otherTable, ...own } = reads;
    for (const [name, key] of Object.entries(own)) expect([name, stale(key)]).toEqual([name, true]);
    for (const key of [otherHistory, otherFlows, otherTable]) expect(stale(key)).toBe(false);
    expect(mock.go).not.toHaveBeenCalled();
  },
);

test('host gets staging versus confirmed refresh, authored actions, deletion, and explicit dock placement', () => {
  const initial = props(),
    owner = host();
  draw({ ...initial, host: owner });
  expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  // Delete is handed to the toolbar as the last item of its More menu.
  expect(mock.actions?.menuTail).toBeTruthy();
  expect(mock.actions?.actions).toBe(initial.actions?.list);
  expect(mock.actions?.queryScope).toBe(42);
  expect(mock.actions?.grantedCommands).toEqual(['assign']);
  expect(mock.pending?.placement).toBe('inline');
  act(() => {
    mock.pending?.onDone?.();
    mock.pending?.onDone?.({ inPlace: true });
    mock.pending?.onDone?.({ inPlace: false });
  });
  expect(owner.onRecordChange).toHaveBeenNthCalledWith(1, undefined);
  expect(owner.onRecordChange).toHaveBeenNthCalledWith(2, { inPlace: true });
  expect(owner.onRecordChange).toHaveBeenNthCalledWith(3, { inPlace: false });
  act(() => {
    mock.actions?.onDone();
    mock.deletion?.onStateChange('pending');
    mock.deletion?.onDeleted();
  });
  expect(owner.onActionDone).toHaveBeenCalledOnce();
  expect(owner.onDeleted).toHaveBeenCalledOnce();
  expect(owner.onDeleteStateChange).toHaveBeenCalledWith('pending');
  expect(mock.go).not.toHaveBeenCalled();
});

test.each(['predicate', 'record', 'owner', 'unmount'])('late completion is fenced after %s changes without a URL change', (boundary) => {
  const initial = props(),
    owner = host();
  const view = draw({ ...initial, host: owner });
  const pending = mock.pending!,
    actions = mock.actions!,
    deletion = mock.deletion!;
  if (boundary === 'predicate') vi.mocked(owner.owner.isCurrent).mockReturnValue(false);
  if (boundary === 'record') view.replace({ ...initial, entry: { ...initial.entry, key: { id: 2 } }, host: owner });
  if (boundary === 'owner') view.replace({ ...initial, host: host() });
  if (boundary === 'unmount') view.unmount();
  expect(deletion.isCurrent()).toBe(false);
  act(() => {
    pending.onDone?.({ inPlace: true });
    actions.onDone();
  });
  expect(owner.onRecordChange).not.toHaveBeenCalled();
  expect(owner.onActionDone).not.toHaveBeenCalled();
  expect(mock.go).not.toHaveBeenCalled();
});

test('same owner and key through refresh keep existing callbacks current', () => {
  const initial = props(),
    owner = host();
  const view = draw({ ...initial, host: owner });
  const pending = mock.pending!,
    deletion = mock.deletion!;
  view.replace({ ...initial, entry: { ...initial.entry, label: 'Updated label' }, host: { ...owner } });
  expect(deletion.isCurrent()).toBe(true);
  act(() => pending.onDone?.({ inPlace: true }));
  expect(owner.onRecordChange).toHaveBeenCalledWith({ inPlace: true });
});
