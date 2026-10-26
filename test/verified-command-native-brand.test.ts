/** Fake receivers cannot turn a native journal into a supplied runner. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { nativeVerifiedCommandRunner } from '../packages/mistri/src/server/commands/verifiedCommandRunner.js';
import { storeHostOf } from '../packages/engine/src/adapters/storeHost.js';
import { nativeCommandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

test('native verified command runners refuse forged, copied and proxy receivers before getters or I/O', async () => {
  for (const prototype of [SqliteAdapter.prototype, PostgresAdapter.prototype]) {
    let reads = 0;
    // The journal is lent through the constructed adapter's store host, never a method a receiver could carry.
    assert.equal('verifiedCommandTransaction' in prototype, false);
    const forged = Object.create(prototype);
    for (const name of ['closed', 'connections', 'journalTransaction', 'transact']) {
      Object.defineProperty(forged, name, {
        get() {
          reads++;
          throw new Error('must not run');
        },
      });
    }
    for (const receiver of [
      forged,
      { ...forged },
      new Proxy(forged, {
        get() {
          reads++;
          throw new Error('must not run');
        },
      }),
    ]) {
      assert.equal(storeHostOf(receiver), undefined);
      assert.equal(nativeCommandsOf(receiver), undefined);
      assert.equal(nativeVerifiedCommandRunner(receiver), undefined);
    }
    const trappedPrototype = new Proxy(prototype, {
      getPrototypeOf() {
        reads++;
        throw new Error('must not run');
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error('must not run');
      },
    });
    assert.equal(nativeVerifiedCommandRunner(Object.create(trappedPrototype)), undefined);
    assert.equal(reads, 0);
  }
});
