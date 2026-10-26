import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantRetirement } from '../packages/mistri/src/server/tenant/tenantRetirement.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('retirement synchronously stops every family and waits for the slowest publication before closing sources', async () => {
  const a = gate(),
    b = gate(),
    order: string[] = [];
  const retire = tenantRetirement(
    [
      () => {
        order.push('read stopped');
        return a.promise;
      },
      () => {
        order.push('history stopped');
        return b.promise;
      },
      async () => {
        order.push('requests stopped');
      },
    ],
    [
      async () => {
        order.push('reader closed');
      },
      async () => {
        order.push('writer closed');
      },
    ],
  );
  const pending = retire();
  assert.deepEqual(order, ['read stopped', 'history stopped', 'requests stopped']);
  a.release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(order.length, 3);
  b.release();
  await pending;
  assert.deepEqual(order.slice(3), ['reader closed', 'writer closed']);
});

for (const phase of ['synchronous drain', 'asynchronous drain', 'synchronous close', 'asynchronous close']) {
  test(`${phase} failure still drains every family and attempts both source closures without private diagnostics`, async () => {
    const order: string[] = [],
      wait = gate();
    const failure = () => {
      throw new Error('PRIVATE_SENTINEL');
    };
    const retire = tenantRetirement(
      [
        () => {
          order.push('first');
          if (phase === 'synchronous drain') return failure();
          return phase === 'asynchronous drain' ? Promise.reject(new Error('PRIVATE_SENTINEL')) : Promise.resolve();
        },
        () => {
          order.push('second');
          return wait.promise;
        },
      ],
      [
        () => {
          order.push('reader');
          if (phase === 'synchronous close') return failure();
          return phase === 'asynchronous close' ? Promise.reject(new Error('PRIVATE_SENTINEL')) : Promise.resolve();
        },
        async () => {
          order.push('writer');
        },
      ],
    );
    const result = retire();
    assert.deepEqual(order, ['first', 'second']);
    wait.release();
    await assert.rejects(result, (error) => {
      assert.ok(error instanceof TenantWriteFailure);
      assert.equal(error.outcome, 'unknown');
      assert.equal('cause' in error, false);
      assert.equal(String(error).includes('PRIVATE_SENTINEL'), false);
      return true;
    });
    assert.deepEqual(order, ['first', 'second', 'reader', 'writer']);
    assert.equal(retire(), result);
  });
}

test('reentrant and repeated retirement share one promise and wait for closure acknowledgment', async () => {
  const wait = gate();
  let nested: Promise<void> | undefined,
    stops = 0,
    closes = 0;
  const retire = tenantRetirement(
    [
      async () => {
        stops++;
        nested = retire();
      },
    ],
    [
      () => {
        closes++;
        return wait.promise;
      },
    ],
  );
  const first = retire();
  assert.equal(nested, first);
  assert.equal(retire(), first);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  wait.release();
  await first;
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.equal(retire(), first);
});

test('retirement captures internal callback lists instead of following later array mutation', async () => {
  const seen: string[] = [];
  const drains = [
      async () => {
        seen.push('drain');
      },
    ],
    closes = [
      async () => {
        seen.push('close');
      },
    ];
  const retire = tenantRetirement(drains, closes);
  drains[0] = async () => {
    throw new Error('replacement');
  };
  closes.length = 0;
  await retire();
  assert.deepEqual(seen, ['drain', 'close']);
});
