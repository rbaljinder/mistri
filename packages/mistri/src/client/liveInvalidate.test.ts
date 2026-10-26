/** What a change asks the page to read again: the tables a read answered from, the rate, the held list. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query';
import { state } from '../../../kit/src/client/core.js';
import { fileQueryReads, fileReads } from '../../../kit/src/client/liveReads.js';
import { addChange, emptyBatch, forgetLive, invalidateLive } from './liveInvalidate.js';
import { liveKeyText, resetLiveState } from '../../../kit/src/client/liveState.js';
import { forgetOwnWrites, ownWriteSent } from '../../../kit/src/client/ownWrites.js';
import { liveMark, refreshRecordInPlace } from '../../../kit/src/client/recordWriteRefresh.js';

let client: QueryClient;
let unsubscribe: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  state.activeConnection = 'spoke';
  client = new QueryClient({ queryCache: new QueryCache({ onSuccess: fileQueryReads }) });
});
afterEach(() => {
  for (const stop of unsubscribe) stop();
  unsubscribe = [];
  forgetLive();
  forgetOwnWrites();
  resetLiveState();
  client.clear();
  vi.useRealTimers();
});

/** An on-screen read that counts how often it was asked, answered from `tables` (or from no header). */
async function watch(key: readonly unknown[], tables: string | null) {
  const asked = vi.fn();
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: () => {
      asked();
      const answer = { n: asked.mock.calls.length };
      fileReads(answer, tables);
      return answer;
    },
  });
  unsubscribe.push(observer.subscribe(() => {}));
  await vi.advanceTimersByTimeAsync(0);
  return asked;
}
const change = (tables: Record<string, { keys?: Array<Record<string, unknown>> | 'many'; kinds?: string[] }>, self = false) => {
  const batch = emptyBatch();
  addChange(batch, { tables, self });
  return batch;
};

test('a read filed with its tables is asked again for those and for no others', async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  const ledger = await watch(['count', 'spoke', 'ledger'], 'ledger');
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs).toHaveBeenCalledTimes(2);
  expect(ledger).toHaveBeenCalledTimes(1);
});

test('a read with no tables filed falls back to its family: asked again, never missed', async () => {
  const bare = await watch(['count', 'spoke', 'x'], null);
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(bare).toHaveBeenCalledTimes(2);
});

test('a read of another App is left alone by the fallback', async () => {
  const other = await watch(['count', 'elsewhere', 'x'], null);
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(other).toHaveBeenCalledTimes(1);
});

test('a read is asked at most once a second, and the change in the gap is not lost', async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  const touch = () => invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  touch();
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs).toHaveBeenCalledTimes(2);
  touch();
  touch();
  await vi.advanceTimersByTimeAsync(500);
  expect(jobs).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(600);
  expect(jobs).toHaveBeenCalledTimes(3);
});

test('changes faster than once a second for ten seconds slow a query to one in five seconds', async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  const touch = () => invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  for (let i = 0; i < 50; i++) {
    touch();
    await vi.advanceTimersByTimeAsync(300);
  }
  // Fifteen seconds more of it: three asks, not fifteen.
  const before = jobs.mock.calls.length;
  for (let i = 0; i < 50; i++) {
    touch();
    await vi.advanceTimersByTimeAsync(300);
  }
  expect(jobs.mock.calls.length - before).toBeLessThanOrEqual(3);
});

/* A field report measured 5.0 s from a colleague's change to the page at a person's pace: a minute's count of asks turned any
   page watched for a while hot, and every change after it waited out the five-second gap. */
test("changes at a person's pace are each asked at once, however long it goes on", async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  const touch = () => invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  for (let i = 0; i < 80; i++) {
    const before = jobs.mock.calls.length;
    touch();
    await vi.advanceTimersByTimeAsync(10);
    expect(jobs).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1_490);
  }
});

test('a query that was hot is asked at once again when the changes slow', async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  const touch = () => invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  for (let i = 0; i < 40; i++) {
    touch();
    await vi.advanceTimersByTimeAsync(300);
  }
  await vi.advanceTimersByTimeAsync(10_000);
  for (let i = 0; i < 8; i++) {
    const before = jobs.mock.calls.length;
    touch();
    await vi.advanceTimersByTimeAsync(10);
    expect(jobs).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1_490);
  }
});

test('a read nobody is looking at is marked stale, not asked', async () => {
  const asked = vi.fn(() => ({ n: 1 }));
  await client.fetchQuery({ queryKey: ['count', 'spoke', 'idle'], queryFn: asked, staleTime: Infinity });
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }), client);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(asked).toHaveBeenCalledTimes(1);
  expect(client.getQueryCache().getAll()[0].state.isInvalidated).toBe(true);
});

test('keys are one where they read the same as text, a past-2^53 id included', () => {
  expect(liveKeyText({ id: 5 })).toBe(liveKeyText({ id: '5' }));
  expect(liveKeyText({ id: '9007199254740993' })).not.toBe(liveKeyText({ id: '9007199254740992' }));
});

test("a batch merges its changes: many wins over named keys, and it is the reader's own only if each was", () => {
  const batch = emptyBatch();
  addChange(batch, { tables: { job: { keys: [{ id: 1 }], kinds: ['update'] } }, self: true });
  addChange(batch, { tables: { job: { keys: [{ id: 2 }], kinds: ['insert'] } }, self: true });
  expect(batch.self).toBe(true);
  expect([...(batch.tables.get('job')!.keys as Map<string, unknown>).keys()]).toHaveLength(2);
  addChange(batch, { tables: { job: { keys: 'many', kinds: ['update'] } } });
  expect(batch.tables.get('job')!.keys).toBe('many');
  expect(batch.self).toBe(false);
  expect(batch.events).toBe(3);
});

/* G211: a commit took tens of seconds to paint under load. A record's fields are asked by two paths at once — the
   query's own slot and the record's in-place refresh — and each cancelled the other's read in flight, so while
   changes kept coming faster than a read took, no read ever landed. */
async function slowRecord(fetchMs: number) {
  const landed: Array<{ start: number; at: number }> = [];
  const cancelled = { n: 0 };
  const observer = new QueryObserver(client, {
    queryKey: ['page-fields', 'ticket-page', 'ticket', { id: 1 }],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      new Promise<{ start: number }>((resolve, reject) => {
        const start = Date.now();
        const timer = setTimeout(() => {
          landed.push({ start, at: Date.now() });
          resolve({ start });
        }, fetchMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          cancelled.n++;
          reject(new Error('cancelled'));
        });
      }),
  });
  unsubscribe.push(observer.subscribe(() => {}));
  await vi.advanceTimersByTimeAsync(fetchMs + 10);
  landed.length = 0;
  return { landed, cancelled };
}
/** From each change to the first read that began after it and landed: what the reader waits to see it. */
const commitToPaint = (changes: number[], landed: Array<{ start: number; at: number }>) =>
  changes.map((at) => (landed.find((read) => read.start >= at)?.at ?? Number.POSITIVE_INFINITY) - at);

/* Before the fix, with a change every 500 ms for 40 s: reads of 1.2 s painted within 6.2 s, cancelling 16 reads; reads
   of 6 s (a loaded server) landed twice in 46 s, and a change waited out the whole stream. After: 6.0 s and 11.5 s,
   none cancelled — the read already out, the hot gap of five seconds, and one read. */
test.each([1_200, 6_000])(
  'under a steady stream of changes to a read of %i ms, every change is painted within a bound and no read is cancelled',
  async (FETCH) => {
    const EVERY = 500,
      STREAM = 40_000;
    const { landed, cancelled } = await slowRecord(FETCH);
    const changes: number[] = [];
    for (let at = 0; at < STREAM; at += EVERY) {
      changes.push(Date.now());
      invalidateLive(change({ ticket: { keys: [{ id: 1 }], kinds: ['update'] } }), client);
      await vi.advanceTimersByTimeAsync(EVERY);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    const waits = commitToPaint(changes, landed);
    const worst = Math.max(...waits);
    expect(cancelled.n).toBe(0);
    // A change waits at most for the read already out, the hot gap and its own read.
    expect(worst).toBeLessThanOrEqual(FETCH + 5_000 + FETCH);
    // And reads keep landing while the changes come, rather than once they stop.
    expect(landed.filter((read) => read.at < changes.at(-1)!).length).toBeGreaterThanOrEqual(3);
  },
);

test('a change that arrives while a slow read is out waits for that read, then exactly one more', async () => {
  const FETCH = 3_000;
  const { landed, cancelled } = await slowRecord(FETCH);
  const touch = () => invalidateLive(change({ ticket: { keys: [{ id: 1 }], kinds: ['update'] } }), client);
  touch();
  await vi.advanceTimersByTimeAsync(100);
  const during = Date.now();
  touch();
  await vi.advanceTimersByTimeAsync(400);
  touch();
  await vi.advanceTimersByTimeAsync(3 * FETCH);
  expect(cancelled.n).toBe(0);
  // The first read, and one trailing read that began after the last change; never one per change.
  expect(landed).toHaveLength(2);
  expect(landed[1].start).toBeGreaterThanOrEqual(during + 400);
  expect(landed[1].start).toBeGreaterThanOrEqual(landed[0].at);
});

/* The page's own write comes back on the stream marked `self`, a moment after its answer, while the write's own
   refresh is out or has landed. Measured from its arrival it asked all of those again (a field report: a record page composed
   twice, and its sections asked one by one, after every write). */
test("the echo of the page's own write asks nothing its refresh has already asked", async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  liveMark(client);
  ownWriteSent()();
  // The write's own refresh, begun once it was answered.
  await client.refetchQueries({ queryKey: ['count', 'spoke', 'jobs'] });
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }, true), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs).toHaveBeenCalledTimes(2);
});

test("the echo still asks a read its write's refresh did not reach, once", async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  liveMark(client);
  ownWriteSent()();
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }, true), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs).toHaveBeenCalledTimes(2);
});

test("a change of the same account long after any write of this page is asked as anyone else's", async () => {
  const jobs = await watch(['count', 'spoke', 'jobs'], 'job');
  liveMark(client);
  ownWriteSent()();
  await client.refetchQueries({ queryKey: ['count', 'spoke', 'jobs'] });
  await vi.advanceTimersByTimeAsync(5_000);
  invalidateLive(change({ job: { keys: 'many', kinds: ['update'] } }, true), client);
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs).toHaveBeenCalledTimes(3);
});

/* A pushed change to the record on screen asks its page again, and asked every list and count on the connection
   with it, cancelling the ones live sync had just begun by their tables. */
test('a change pushed to the record on screen leaves the lists of other tables alone', async () => {
  const ledger = await watch(['run', 'spoke', 'ledger', 20, 0, false, 0], 'ledger');
  await refreshRecordInPlace(client, { connection: 'spoke', table: 'job', key: { id: 1 } }, true, true, liveMark(client));
  await vi.advanceTimersByTimeAsync(10);
  expect(ledger).toHaveBeenCalledTimes(1);
});
