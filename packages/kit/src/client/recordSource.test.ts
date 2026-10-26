import { expect, test } from 'vitest';
import { advanceRecordSource, readRecordSource, shareRecordSource } from './recordSource.js';

const answer = () => ({ rows: [{ id: 1, name: 'Original' }] });

test('equal results in the same epoch preserve the cached row identity', async () => {
  const old = await readRecordSource(async () => answer());
  const next = await readRecordSource(async () => answer());
  expect(next.rows[0]).not.toBe(old.rows[0]);
  const shared = shareRecordSource(old, next) as typeof old;
  expect(shared).toBe(old);
  expect(shared.rows[0]).toBe(old.rows[0]);
});

test('advancing the epoch retains fresh rows even when their values equal the cache', async () => {
  const old = await readRecordSource(async () => answer());
  advanceRecordSource();
  const next = await readRecordSource(async () => answer());
  expect(next.recordSourceEpoch).toBe(old.recordSourceEpoch + 1);
  const shared = shareRecordSource(old, next) as typeof next;
  expect(shared).toBe(next);
  expect(shared.rows[0]).not.toBe(old.rows[0]);
  expect(shared.rows[0]).toEqual(old.rows[0]);
});

test('a pending read retains its starting epoch and shares an equal pre-reconciliation cache', async () => {
  const old = await readRecordSource(async () => answer());
  let finish!: (value: ReturnType<typeof answer>) => void;
  const pending = readRecordSource(
    () =>
      new Promise<ReturnType<typeof answer>>((resolve) => {
        finish = resolve;
      }),
  );
  advanceRecordSource();
  const current = await readRecordSource(async () => answer());
  finish(answer());
  const late = await pending;
  expect(late.recordSourceEpoch).toBe(old.recordSourceEpoch);
  expect(current.recordSourceEpoch).toBe(old.recordSourceEpoch + 1);
  expect(shareRecordSource(old, late)).toBe(old);
});

test('same-epoch changes retain ordinary deep sharing for unchanged rows', async () => {
  const old = await readRecordSource(async () => ({
    rows: [
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ],
  }));
  const next = await readRecordSource(async () => ({
    rows: [
      { id: 1, name: 'Changed' },
      { id: 2, name: 'Two' },
    ],
  }));
  const shared = shareRecordSource(old, next) as typeof next;
  expect(shared.rows[0]).toEqual(next.rows[0]);
  expect(shared.rows[0]).not.toBe(old.rows[0]);
  expect(shared.rows[1]).toBe(old.rows[1]);
});

test('the local epoch overrides response metadata without mutating the response', async () => {
  const source = { ...answer(), recordSourceEpoch: -1 };
  const read = await readRecordSource(async () => source);
  expect(read.recordSourceEpoch).toBeGreaterThanOrEqual(0);
  expect(source.recordSourceEpoch).toBe(-1);
  expect(read).not.toBe(source);
  expect(shareRecordSource(undefined, read)).toBe(read);
});
