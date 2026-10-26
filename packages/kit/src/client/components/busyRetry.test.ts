import { expect, test } from 'vitest';
import { BUSY_RETRIES, busyDelay, queryClient, retryWhenBusy } from './mount.js';

const busy = { status: 503, code: 'server_busy', retryAfter: 1000 };

test('a read is asked again, a few times, only when the server said it was busy', () => {
  expect(retryWhenBusy(0, busy)).toBe(true);
  expect(retryWhenBusy(BUSY_RETRIES - 1, busy)).toBe(true);
  expect(retryWhenBusy(BUSY_RETRIES, busy)).toBe(false);
  // Any other refusal is a full sentence, and a retry does not change it.
  expect(retryWhenBusy(0, { status: 503, code: 'row_locked' })).toBe(false);
  expect(retryWhenBusy(0, { status: 500 })).toBe(false);
  expect(retryWhenBusy(0, new Error('The server is not answering.'))).toBe(false);
  expect(retryWhenBusy(0, null)).toBe(false);
});

test('the wait honors Retry-After, grows with each failure, and is jittered and capped', () => {
  for (const failures of [0, 1, 2]) {
    const wait = busyDelay(failures, busy);
    const base = 1000 * 2 ** failures;
    expect(wait).toBeGreaterThanOrEqual(base * 0.5);
    expect(wait).toBeLessThan(base * 1.5);
  }
  expect(busyDelay(10, busy)).toBeLessThan(8_000 * 1.5);
  // Without a header, a second.
  expect(busyDelay(0, { status: 503, code: 'server_busy' })).toBeLessThan(1_500);
});

test('only reads retry: the client keeps the busy rule for queries and none for writes', () => {
  expect(queryClient.getDefaultOptions().queries?.retry).toBe(retryWhenBusy);
  expect(queryClient.getDefaultOptions().mutations?.retry).toBeUndefined();
});
