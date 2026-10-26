import { setTimeout as delay } from 'node:timers/promises';

/** Fixed deadlines, no response-paced scheduling or catch-up bursts. Slots
 * missed by the generator or concurrency cap remain visible as dropped work. */
export async function runArrivals({
  rate,
  seconds,
  concurrency,
  signal,
  run,
  now = () => performance.now(),
  sleep = (ms) => delay(ms, undefined, { signal }),
}) {
  if (
    !Number.isInteger(rate) ||
    rate < 1 ||
    rate > 100 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 300 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  )
    throw new Error('Invalid arrival schedule');
  const started = now(),
    interval = 1000 / rate,
    scheduled = rate * seconds;
  const free = Array.from({ length: concurrency }, (_, index) => index),
    pending = new Set();
  const result = { rate, scheduled, admitted: 0, droppedBusy: 0, droppedLate: 0, cancelled: 0, peakInFlight: 0, maximumLagMs: 0 };
  let next = 0,
    failure;
  try {
    while (next < scheduled && !signal.aborted) {
      const deadline = started + next * interval;
      if (now() < deadline) {
        await sleep(deadline - now());
        continue;
      }
      const lag = Math.max(0, now() - deadline);
      result.maximumLagMs = Math.max(result.maximumLagMs, lag);
      // Skip expired slots, rather than queueing a burst after an event-loop stall.
      if (lag >= interval) {
        const missed = Math.min(scheduled - next, Math.floor(lag / interval));
        result.droppedLate += missed;
        next += missed;
        continue;
      }
      const iteration = next++,
        slot = free.shift();
      if (slot === undefined) {
        result.droppedBusy++;
        continue;
      }
      result.admitted++;
      const task = Promise.resolve()
        .then(() => run(slot, iteration))
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          pending.delete(task);
          free.push(slot);
        });
      pending.add(task);
      result.peakInFlight = Math.max(result.peakInFlight, pending.size);
    }
    // The last scheduled arrival is before the end of the offered-load window.
    if (!signal.aborted && now() < started + seconds * 1000) await sleep(started + seconds * 1000 - now());
  } catch (error) {
    if (!signal.aborted) failure ??= error;
  } finally {
    await Promise.allSettled([...pending]);
  }
  result.cancelled = scheduled - next;
  if (failure) throw failure;
  return result;
}
