/**
 * A store at a layout version 2, for the rehearsal in test/store-upgrade-rehearsal.test.ts.
 *
 * Every store mistri ships is at layout version 1, so no real v1 -> v2 upgrade exists to run. This is the next best
 * thing: the record-history store, whose v1 is the committed fixture, given a v2 whose step does what a real
 * layout change does to one — a column added and backfilled in the data table, and the marker's own CHECK (which
 * pins the version) replaced — and handed to the real `upgradeStores`. The test's child process runs it
 * (test/support/storeUpgradeChild.ts) so the test can kill the process inside the step.
 */
import { STORES, type StoreDef } from '../../packages/mistri/src/server/storeLayouts.js';

const base = STORES.find((layout) => layout.id === 'record-history')!;

/** The v2 layout. `pause` runs inside the step after the data is changed and before the marker moves. */
export function historyV2(pause: () => Promise<void> = async () => {}): StoreDef {
  return {
    ...base,
    current: { sqlite: 2, postgres: 2 },
    upgrades: {
      sqlite: {
        1: {
          says: 'add source to every change, from its via',
          async run({ db }) {
            await db.run('ALTER TABLE "__mistri_history_change" ADD COLUMN source TEXT');
            await db.run('UPDATE "__mistri_history_change" SET source = via');
            await pause();
            // The marker's CHECK pins its version, and SQLite cannot alter a CHECK: the table is made again.
            await db.run('DROP TABLE "__mistri_history_meta"');
            await db.run(
              'CREATE TABLE "__mistri_history_meta" (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version = 2))',
            );
            await db.run('INSERT INTO "__mistri_history_meta" (singleton, version) VALUES (1, 2)');
          },
        },
      },
      postgres: {
        1: {
          says: 'add source to every change, from its via',
          async run({ db }) {
            await db.run('ALTER TABLE mistri.history_change ADD COLUMN source text');
            await db.run('UPDATE mistri.history_change SET source = via');
            await pause();
            await db.run('ALTER TABLE mistri.history_meta DROP CONSTRAINT history_meta_version_check');
            await db.run('UPDATE mistri.history_meta SET version = 2');
            await db.run('ALTER TABLE mistri.history_meta ADD CONSTRAINT history_meta_version_check CHECK (version = 2)');
          },
        },
      },
    },
  };
}
