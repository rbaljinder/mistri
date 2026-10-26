/**
 * A dashboard has no `refresh` to set: what depends on the time is read again each minute, the rest follows changes.
 * Where the page follows none (an App without `live: true`, or `--no-live`), every read ticks, or a dashboard left on a
 * wall would never move.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { minuteTick } from './Dashboard.js';
import { resetLiveState, setLiveActive, setLiveOff } from '@mistriwork/kit/client/liveState.js';

afterEach(() => vi.useRealTimers());

const following = () => true;
const still = () => false;

test('a read whose text names the time ticks to the next minute; one that does not never ticks while the page follows changes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:45Z'));
  const tick = minuteTick('invoice due before today', undefined, following);
  expect(typeof tick).toBe('function');
  expect((tick as () => number)()).toBe(15_000);
  expect((minuteTick('opened last 7 days', undefined, following) as () => number)()).toBe(15_000);
  expect((minuteTick('opened in the past week', undefined, following) as () => number)()).toBe(15_000);
  expect((minuteTick('status = open', undefined, following) as () => number | false)()).toBe(false);
  expect((minuteTick('amount > 500', undefined, following) as () => number | false)()).toBe(false);
  expect(minuteTick(undefined, undefined, following)).toBe(false);
});

test('without live sync every read ticks on the minute', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:45Z'));
  expect((minuteTick('status = open', undefined, still) as () => number)()).toBe(15_000);
  expect((minuteTick('amount > 500', undefined, still) as () => number)()).toBe(15_000);
  expect((minuteTick('opened last 7 days', undefined, still) as () => number)()).toBe(15_000);
  expect(minuteTick(undefined, undefined, still)).toBe(false);
});

test('an answer read moments before the minute is not read again at the minute, but at the one after', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:58Z'));
  const tick = minuteTick('status = open', undefined, still) as (query?: { state: { dataUpdatedAt: number } }) => number;
  /* Read just now: the tick at 10:01:00 would re-read a two-second-old answer, so it waits for 10:02:00. */
  expect(tick({ state: { dataUpdatedAt: Date.now() - 500 } })).toBe(62_000);
  /* Not yet read (the interval is asked before the first answer too): the next minute. */
  expect(tick({ state: { dataUpdatedAt: 0 } })).toBe(2_000);
  /* Read at the last minute's tick: a minute old by the next, which reads it. */
  vi.setSystemTime(new Date('2026-10-21T10:01:00.200Z'));
  expect(tick({ state: { dataUpdatedAt: Date.now() } })).toBe(59_800);
  /* A time-relative read is held to the same floor. */
  vi.setSystemTime(new Date('2026-10-21T10:00:50Z'));
  const timed = minuteTick('opened last 7 days', undefined, following) as (query?: { state: { dataUpdatedAt: number } }) => number;
  expect(timed({ state: { dataUpdatedAt: Date.now() } })).toBe(70_000);
});

test('on a live App, a tile over a table that keeps out of live sync (its own live: false) keeps the minute; the others do not', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:45Z'));
  const followed = (table?: string) => table !== 'audit_log';
  expect((minuteTick('status = open', 'audit_log', followed) as () => number)()).toBe(15_000);
  expect((minuteTick('status = open', 'ticket', followed) as () => number | false)()).toBe(false);
  expect((minuteTick('opened last 7 days', 'ticket', followed) as () => number)()).toBe(15_000);
});

test("the page's own reading: the tables live sync's hello names as kept out tick, the rest follow", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:45Z'));
  setLiveOff(['audit_log']);
  setLiveActive(true);
  try {
    expect((minuteTick('status = open', 'audit_log') as () => number)()).toBe(15_000);
    expect((minuteTick('status = open', 'ticket') as () => number | false)()).toBe(false);
    expect((minuteTick('status = open') as () => number | false)()).toBe(false);
  } finally {
    setLiveActive(false);
    resetLiveState();
  }
});
