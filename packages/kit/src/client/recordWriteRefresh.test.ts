import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { askAgain, captureRecordWriteRefresh, liveMark, refreshAfterCommand, refreshRecordInPlace } from './recordWriteRefresh.js';
import { queryClient } from './components/mount.js';
import { state } from './core.js';
import { beginConnectionTransition } from './connectionTransition.js';
import { establishSessionIdentity } from './sessionIdentity.js';
import { composedReads } from './composedHook.js';
import './composedReads.js';

const key = { id: '9007199254740993' };
const original = ['record', 'task', key, ['name']];
const custom = ['page-fields', 'custom', 'task', key, ['name']];
const list = ['run', 'tick', 'task completed = false', 20, 0, false, 0];
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function cached(queryKey: QueryKey) {
  queryClient.setQueryData(queryKey, { rows: [{ name: 'Before' }] });
  return queryClient.getQueryCache().find({ queryKey, exact: true })!;
}
beforeEach(() => {
  queryClient.clear();
  state.activeConnection = 'tick';
  state.schema = { tables: [{ id: 'task', columns: [{ name: 'id', primaryKey: true }] }] };
  establishSessionIdentity({ signedIn: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

test('acknowledgement invalidates exact record/page keys and the current connection lists', async () => {
  const yes = [
    original,
    custom,
    list,
    ['run', 'task', 20],
    ['count', 'tick', 'task'],
    ['page-list', { base: 'task' }, 0],
    ['peekpanel', 'tick', 'task', [key.id]],
    ['peek', 'tick', 'task', 'id', key.id],
    ['picker-labels', 'tick', 'task', 'id', [key.id]],
  ];
  const no = [
    ['record', 'task', { id: '9007199254740992' }, ['name']],
    ['page-fields', 'custom', 'task', { id: 3 }, ['name']],
    ['record', 'issue', key, ['name']],
    ['run', 'thread', 'issue', 20, 0, false, 0],
    ['count', 'thread', 'issue'],
    ['page-list', { base: 'issue' }, 0],
    ['command-prepare', 'task'],
    ['peekpanel', 'tick', 'task', ['3']],
    ['peek', 'tick', 'task', 'id', '3'],
  ];
  const changed = yes.map(cached),
    untouched = no.map(cached);
  const acknowledge = captureRecordWriteRefresh('task', key);
  expect(changed.every((query) => !query.state.isInvalidated)).toBe(true);
  acknowledge();
  await settle();
  expect(changed.every((query) => query.state.isInvalidated)).toBe(true);
  expect(untouched.every((query) => !query.state.isInvalidated)).toBe(true);
});

test.each(['connection', 'schema', 'identity', 'leave-return'] as const)(
  '%s replacement refuses an old acknowledgement',
  async (reason) => {
    const query = cached(original);
    const acknowledge = captureRecordWriteRefresh('task', key);
    if (reason === 'connection') state.activeConnection = 'other';
    if (reason === 'schema') state.schema = {};
    if (reason === 'identity') establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'new' });
    if (reason === 'leave-return') beginConnectionTransition().finish();
    acknowledge();
    await settle();
    expect(query.state.isInvalidated).toBe(false);
  },
);

test('navigation alone still invalidates original cache and copied keys cannot be retargeted', async () => {
  const input = { ...key },
    query = cached(original);
  const acknowledge = captureRecordWriteRefresh('task', input);
  input.id = '3';
  state.stack = [{ kind: 'table', table: 'issue' }];
  acknowledge();
  await settle();
  expect(query.state.isInvalidated).toBe(true);
});

test('cache replacement during cancellation is not invalidated by an old completion', async () => {
  cached(original);
  let release!: () => void;
  vi.spyOn(queryClient, 'cancelQueries').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  captureRecordWriteRefresh('task', key)();
  queryClient.clear();
  const replacement = cached(original);
  release();
  await settle();
  expect(replacement.state.isInvalidated).toBe(false);
});

test('identity retirement during cancellation prevents follow-up reads', async () => {
  const query = cached(list);
  let release!: () => void;
  vi.spyOn(queryClient, 'cancelQueries').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const read = vi.spyOn(queryClient, 'refetchQueries');
  captureRecordWriteRefresh('task', key)();
  establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'new' });
  release();
  await settle();
  expect(query.state.isInvalidated).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

test('mounted lists refetch but mounted editors keep their confirmed source', async () => {
  const row = cached(original),
    source = row.state.data;
  cached(list);
  const readRow = vi.fn(async () => ({ rows: [{ name: 'Saved' }] }));
  const readList = vi.fn(async () => ({ rows: [{ name: 'Saved' }] }));
  const editor = new QueryObserver(queryClient, { queryKey: original, queryFn: readRow, staleTime: Infinity });
  const listing = new QueryObserver(queryClient, { queryKey: list, queryFn: readList, staleTime: Infinity });
  const closeEditor = editor.subscribe(() => {}),
    closeList = listing.subscribe(() => {});
  try {
    const acknowledge = captureRecordWriteRefresh('task', key);
    acknowledge();
    acknowledge();
    await settle();
    expect(readRow).not.toHaveBeenCalled();
    expect(row.state.data).toBe(source);
    expect(readList).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(list)).toEqual({ rows: [{ name: 'Saved' }] });
  } finally {
    closeEditor();
    closeList();
  }
});

test('a pre-acknowledgement read cannot overwrite the invalidated record later', async () => {
  const query = cached(original),
    source = query.state.data;
  let release!: (value: unknown) => void;
  const read = queryClient
    .fetchQuery({
      queryKey: original,
      queryFn: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      staleTime: 0,
    })
    .catch(() => undefined);
  captureRecordWriteRefresh('task', key)();
  await settle();
  release({ rows: [{ name: 'Stale response' }] });
  await read;
  expect(query.state.data).toBe(source);
  expect(query.state.isInvalidated).toBe(true);
});

test.each(['sync', 'async'] as const)('%s reconciliation faults never escape the acknowledgement hook', async (kind) => {
  cached(original);
  vi.spyOn(queryClient, 'cancelQueries').mockImplementation(() => {
    if (kind === 'sync') throw new Error('Disposed cache');
    return Promise.reject(new Error('Disposed cache'));
  });
  expect(() => captureRecordWriteRefresh('task', key)()).not.toThrow();
  await settle();
});

/** A query on screen, counting how often it is asked; `slow` holds each answer until released. */
function shown(queryKey: QueryKey, stops: Array<() => void>, slow = false) {
  const asked = { count: 0, release: [] as Array<() => void> };
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => {
      asked.count++;
      return slow ? new Promise((resolve) => asked.release.push(() => resolve(asked.count))) : Promise.resolve(asked.count);
    },
    staleTime: Infinity,
  });
  stops.push(observer.subscribe(() => {}));
  return asked;
}
const answered = async () => {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
};
const ticket = { connection: 'tick', table: 'task', key };

test('a command refreshes its record once: the Done that follows with no write between asks nothing again (G173)', async () => {
  const stops: Array<() => void> = [];
  try {
    const plan = shown(['page-plan', 'tick', 'task-page', JSON.stringify(key), '', 1], stops);
    const root = shown(['page-root', 'tick', 'task-page', JSON.stringify(key), 1], stops);
    const related = shown(['page-list', { base: 'note' }, 0], stops);
    const shell = shown(['inbox', 'tick'], stops);
    await answered();
    expect([plan.count, root.count, related.count, shell.count]).toEqual([1, 1, 1, 1]);

    // The receipt, then the form's Done or the one-click verb's end.
    refreshAfterCommand(queryClient, ticket);
    refreshRecordInPlace(queryClient, ticket, true);
    await answered();
    expect(plan.count, 'one compose').toBe(2);
    expect(root.count).toBe(2);
    expect(related.count).toBe(2);
    // The shell is no part of the record: it keeps its answer until it is next shown or asked.
    expect(shell.count).toBe(1);

    // A further write is news: the next refresh asks again.
    composedReads()!.forget();
    refreshRecordInPlace(queryClient, ticket, true);
    await answered();
    expect(plan.count).toBe(3);
  } finally {
    for (const stop of stops) stop();
  }
});

/* A field report: a save on a boot-drawn record page asked its compose, lists and counts twice at once — the receipt's
   refresh and the page's own, spelled with another scope, each asked it, the second cancelling the first mid-flight. */
test('a second refresh of the same record from another surface joins the first, never asking a read twice', async () => {
  const stops: Array<() => void> = [];
  try {
    const plan = shown(['page-plan', 'tick', 'task-page', JSON.stringify(key), '', 1], stops);
    const root = shown(['page-root', 'tick', 'task-page', JSON.stringify(key), 1], stops);
    const related = shown(['page-list', { base: 'note' }, 0], stops);
    await answered();
    // The write the refreshes follow.
    composedReads()!.forget();
    refreshAfterCommand(queryClient, ticket);
    refreshRecordInPlace(queryClient, { ...ticket, queryScope: 1 }, true);
    refreshRecordInPlace(queryClient, { ...ticket, connection: '' }, false);
    await answered();
    expect([plan.count, root.count, related.count], 'each asked once').toEqual([2, 2, 2]);
    // A further write is news to every surface.
    composedReads()!.forget();
    refreshRecordInPlace(queryClient, { ...ticket, queryScope: undefined }, true);
    await answered();
    expect(plan.count).toBe(3);
  } finally {
    for (const stop of stops) stop();
  }
});

test("a record's sections ask again only once its compose is back, which answers them (G173)", async () => {
  const stops: Array<() => void> = [];
  try {
    const plan = shown(['page-plan', 'tick', 'task-page', JSON.stringify(key), '', 1], stops, true);
    const related = shown(['page-list', { base: 'note' }, 0], stops);
    await answered();
    plan.release.shift()!();
    await answered();
    expect([plan.count, related.count]).toEqual([1, 1]);

    composedReads()!.forget();
    refreshRecordInPlace(queryClient, ticket, true);
    await answered();
    expect(plan.count).toBe(2);
    expect(related.count, 'waits for the compose').toBe(1);
    expect(queryClient.getQueryState(['page-list', { base: 'note' }, 0])?.isInvalidated).toBe(true);
    plan.release.shift()!();
    await answered();
    expect(related.count).toBe(2);
  } finally {
    for (const stop of stops) stop();
  }
});

test("a custom section's own reads (useRecord, useRows, useBreakdown) ask again after a command on its page (G183)", async () => {
  const stops: Array<() => void> = [];
  try {
    const plan = shown(['page-plan', 'tick', 'task-page', JSON.stringify(key), '', 1], stops, true);
    const record = shown(['mistri-ui', 'record', 'reader', 'task', { id: 4 }, ['status'], undefined], stops);
    const rows = shown(['mistri-ui', 'rows', 'reader', 'quote_line', { query: 'quote = 4' }], stops);
    const breakdown = shown(['mistri-ui', 'breakdown', 'reader', 'task', { by: 'status', measure: 'count' }], stops);
    await answered();
    plan.release.shift()!();
    await answered();
    expect([record.count, rows.count, breakdown.count]).toEqual([1, 1, 1]);

    composedReads()!.forget();
    refreshAfterCommand(queryClient, ticket);
    await answered();
    // Marked at once, asked with the rest of the page's sections once its compose is back.
    expect(queryClient.getQueryState(['mistri-ui', 'record', 'reader', 'task', { id: 4 }, ['status'], undefined])?.isInvalidated).toBe(
      true,
    );
    plan.release.shift()!();
    await answered();
    expect([record.count, rows.count, breakdown.count]).toEqual([2, 2, 2]);
  } finally {
    for (const stop of stops) stop();
  }
});

/* G211: a read that began after a pushed change counts as showing it only if it landed. */
test.each(['failed', 'cancelled'] as const)('a read begun after a change that then %s is still asked again for it', async (outcome) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const since = liveMark(client);
  let calls = 0;
  let release: (() => void) | undefined;
  const queryFn = ({ signal }: { signal: AbortSignal }) => {
    calls += 1;
    if (calls > 1) return Promise.resolve({ rows: ['after'] });
    if (outcome === 'failed') return Promise.reject(new Error('dropped'));
    return new Promise<{ rows: string[] }>((resolve, reject) => {
      release = () => resolve({ rows: ['late'] });
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  };
  const observer = new QueryObserver(client, { queryKey: ['run', 'tick', 'task', 20], queryFn });
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(calls).toBe(1));
    if (outcome === 'cancelled') await client.cancelQueries({ queryKey: ['run'] });
    await vi.waitFor(() => expect(client.getQueryCache().find({ queryKey: ['run', 'tick', 'task', 20] })!.state.fetchStatus).toBe('idle'));
    await askAgain(client, (query) => query.queryKey[0] === 'run', since);
    expect(calls).toBe(2);
    expect(client.getQueryData(['run', 'tick', 'task', 20])).toEqual({ rows: ['after'] });
  } finally {
    release?.();
    stop();
    client.clear();
  }
});

test('a read begun after a change that landed is not asked again for it', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const since = liveMark(client);
  let calls = 0;
  const observer = new QueryObserver(client, { queryKey: ['run', 'tick', 'task', 20], queryFn: async () => ({ rows: [++calls] }) });
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(client.getQueryData(['run', 'tick', 'task', 20])).toEqual({ rows: [1] }));
    await askAgain(client, (query) => query.queryKey[0] === 'run', since);
    expect(calls).toBe(1);
  } finally {
    stop();
    client.clear();
  }
});
