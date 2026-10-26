import test from 'node:test';
import assert from 'node:assert/strict';
import { runArrivals } from './arrivals.mjs';

function clock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    sleep: async (ms) => {
      time += ms;
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}
test('fixed arrivals follow declared deadlines independently of completions', async () => {
  const time = clock(),
    starts = [];
  const result = await runArrivals({
    rate: 4,
    seconds: 1,
    concurrency: 2,
    signal: new AbortController().signal,
    ...time,
    run: (slot, iteration) => {
      starts.push([slot, iteration, time.now()]);
    },
  });
  assert.deepEqual(
    starts.map((row) => row[1]),
    [0, 1, 2, 3],
  );
  assert.equal(result.scheduled, 4);
  assert.equal(result.admitted, 4);
  assert.equal(result.droppedBusy + result.droppedLate + result.cancelled, 0);
  assert.equal(time.now(), 1000);
});
test('saturated concurrency drops offered work without queueing it', async () => {
  const time = clock();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const result = await runArrivals({
    rate: 4,
    seconds: 1,
    concurrency: 1,
    signal: new AbortController().signal,
    now: time.now,
    sleep: async (ms) => {
      await time.sleep(ms);
      if (time.now() >= 1000) release();
    },
    run: () => held,
  });
  assert.equal(result.admitted, 1);
  assert.equal(result.droppedBusy, 3);
  assert.equal(result.peakInFlight, 1);
});
test('generator stalls count late slots and never send catch-up bursts', async () => {
  const time = clock(),
    starts = [];
  let stalled = false;
  const result = await runArrivals({
    rate: 10,
    seconds: 1,
    concurrency: 2,
    signal: new AbortController().signal,
    now: time.now,
    sleep: async (ms) => {
      if (!stalled) {
        time.advance(400);
        stalled = true;
      }
      await time.sleep(ms);
    },
    run: (_slot, iteration) => {
      starts.push(iteration);
    },
  });
  assert.equal(result.droppedLate, 4);
  assert.deepEqual(starts, [0, 5, 6, 7, 8, 9]);
  assert.equal(result.scheduled, result.admitted + result.droppedLate);
});
test('abort stops admission but waits for the admitted work to drain', async () => {
  const time = clock(),
    controller = new AbortController();
  let drained = false;
  const result = await runArrivals({
    rate: 4,
    seconds: 1,
    concurrency: 1,
    signal: controller.signal,
    now: time.now,
    sleep: async (ms) => {
      controller.abort();
      await time.sleep(ms);
    },
    run: async () => {
      await Promise.resolve();
      drained = true;
    },
  });
  assert.equal(drained, true);
  assert.equal(result.admitted, 1);
  assert.equal(result.cancelled, 3);
});
test('unexpected worker failure is surfaced after all admitted work drains', async () => {
  const time = clock();
  await assert.rejects(
    runArrivals({
      rate: 1,
      seconds: 1,
      concurrency: 1,
      signal: new AbortController().signal,
      ...time,
      run: () => {
        throw new Error('fixture failure');
      },
    }),
    /fixture failure/,
  );
});
