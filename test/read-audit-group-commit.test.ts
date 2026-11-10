/**
 * The read audit's group commit (adapters/readAudit/groupCommit.ts), alone:
 * which appends share a flush, how many flushes run at once, the cap, and that a
 * failed flush refuses exactly the appends it carried.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupCommit } from '../packages/mistri/src/adapters/readAudit/groupCommit.js';

/** A flush that records each batch and finishes when told to. */
function recorder() {
  const batches: number[][] = [];
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const flush = (items: readonly number[]) => {
    batches.push([...items]);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    return new Promise<void>((resolve, reject) => {
      pending.push({
        resolve: () => {
          inFlight -= 1;
          resolve();
        },
        reject: (error) => {
          inFlight -= 1;
          reject(error);
        },
      });
    });
  };
  return { batches, pending, flush, mostInFlight: () => mostInFlight };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('appends made in one turn leave in one flush, and each resolves when it commits', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush);
  let settled = 0;
  const appends = [1, 2, 3, 4, 5].map((n) => append(n).then(() => (settled += 1)));
  await turn();
  assert.deepEqual(flusher.batches, [[1, 2, 3, 4, 5]]);
  assert.equal(settled, 0, 'no append resolves before its flush commits');
  flusher.pending[0].resolve();
  await Promise.all(appends);
  assert.equal(settled, 5);
});

test('a second flush starts at once; past two in flight, appends gather behind them', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush);
  const first = append(1);
  await turn();
  const second = append(2);
  await turn();
  const behind = [append(3), append(4)];
  await turn();
  const later = append(5);
  await turn();
  assert.deepEqual(flusher.batches, [[1], [2]], 'the third batch waits for a place');
  flusher.pending[0].resolve();
  await first;
  await turn();
  assert.deepEqual(flusher.batches, [[1], [2], [3, 4, 5]]);
  flusher.pending[1].resolve();
  flusher.pending[2].resolve();
  await Promise.all([second, ...behind, later]);
  assert.equal(flusher.mostInFlight(), 2);
});

test('one flush at a time when asked: every row gathers behind it', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush, undefined, 256, 1);
  const first = append(1);
  await turn();
  const behind = [append(2), append(3)];
  await turn();
  assert.deepEqual(flusher.batches, [[1]]);
  flusher.pending[0].resolve();
  await first;
  await turn();
  assert.deepEqual(flusher.batches, [[1], [2, 3]]);
  flusher.pending[1].resolve();
  await Promise.all(behind);
  assert.equal(flusher.mostInFlight(), 1);
});

test('a batch carries at most its cap; the rest wait for the next', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush, undefined, 3);
  const all = [1, 2, 3, 4, 5, 6, 7].map((n) => append(n));
  await turn();
  assert.deepEqual(flusher.batches, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
  flusher.pending[0].resolve();
  flusher.pending[1].resolve();
  await turn();
  await turn();
  flusher.pending[2].resolve();
  await Promise.all(all);
  assert.deepEqual(flusher.batches, [[1, 2, 3], [4, 5, 6], [7]]);
});

test('a failed flush refuses every append it carried and no other; the next batch is still written', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush);
  const failing = [append(1), append(2), append(3)];
  await turn();
  const after = append(4);
  await turn();
  flusher.pending[0].reject(new Error('disk full'));
  const answers = await Promise.allSettled(failing);
  assert.ok(answers.every((answer) => answer.status === 'rejected' && /disk full/.test(String(answer.reason))));
  assert.deepEqual(flusher.batches, [[1, 2, 3], [4]]);
  flusher.pending[1].resolve();
  await after;
});

test('a flush that throws before it returns a promise refuses its batch the same way', async () => {
  const append = groupCommit<number>(() => {
    throw new Error('no writer');
  });
  const answers = await Promise.allSettled([append(1), append(2)]);
  assert.ok(answers.every((answer) => answer.status === 'rejected' && /no writer/.test(String(answer.reason))));
});

test('an append its admit refuses is refused alone, without joining a batch', async () => {
  const flusher = recorder();
  const append = groupCommit(flusher.flush, (n: number) => {
    if (n === 2) throw new Error('malformed');
  });
  const one = append(1);
  await assert.rejects(append(2), /malformed/);
  const three = append(3);
  await turn();
  assert.deepEqual(flusher.batches, [[1, 3]]);
  flusher.pending[0].resolve();
  await Promise.all([one, three]);
});
