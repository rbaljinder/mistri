import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { storeStatuses } from '../packages/mistri/src/server/storeLayouts.js';
import {
  AnalyticsStoreUnavailable,
  openAnalyticsStore,
  provisionAnalyticsStore,
  pruneAnalyticsEvents,
  type AnalyticsEventInput,
} from '../packages/mistri/src/server/analytics/store.js';
import { ENGINES, LIVE, scratch, type Engine } from './support/storeLayouts.js';

const binding = { appId: 'shop', deploymentId: 'prod-1' };
const event = (over: Partial<AnalyticsEventInput> = {}): AnalyticsEventInput => ({
  occurredAt: 1_000,
  environment: 'prod',
  kind: 'view',
  name: 'items',
  unitKind: 'visitor',
  unitId: 'v-1',
  ...over,
});

for (const engine of ENGINES as readonly Engine[]) {
  const skip = engine === 'postgres' ? liveSkip('postgres', LIVE) : false;
  test(`${engine}: provision, attest, insert-only, dedupe, prune and cursors`, { skip }, async (t) => {
    const where = await scratch(engine, 'analytics-store');
    try {
      await provisionAnalyticsStore({ url: where.url, binding });
      await provisionAnalyticsStore({ url: where.url, binding });

      await t.test('opening attests the binding and the layout', async () => {
        await assert.rejects(
          openAnalyticsStore({ url: where.url, binding: { ...binding, deploymentId: 'other' } }),
          AnalyticsStoreUnavailable,
        );
        await assert.rejects(
          provisionAnalyticsStore({ url: where.url, binding: { ...binding, deploymentId: 'other' } }),
          AnalyticsStoreUnavailable,
        );
        const store = await openAnalyticsStore({ url: where.url, binding });
        assert.equal(store.dialect, engine);
        await store.close();
      });

      const store = await openAnalyticsStore({ url: where.url, binding });
      try {
        await t.test('events append, and a repeated source event id is stored once', async () => {
          assert.equal(
            await store.append(
              [
                event(),
                event({
                  occurredAt: 2_000,
                  kind: 'business',
                  name: 'application.submitted',
                  sourceEventId: 'src-1',
                  fields: { plan: 'pro' },
                }),
              ],
              5_000,
            ),
            2,
          );
          assert.equal(
            await store.append([event({ occurredAt: 2_500, kind: 'business', name: 'application.submitted', sourceEventId: 'src-1' })]),
            0,
          );
          assert.equal(await store.append([event({ unitKind: null, unitId: null })]), 1);
          const rows = await store.readAfter(0, 10);
          assert.equal(rows.length, 3);
          assert.deepEqual(rows[1].fields, { plan: 'pro' });
          assert.equal(rows[0].receivedAt, 5_000);
          assert.equal(rows[2].unitId, null);
          assert.deepEqual(
            (await store.readAfter(rows[0].id, 10)).map((row) => row.id),
            [rows[1].id, rows[2].id],
          );
          assert.equal((await store.readAfter(0, 10, 4_999)).length, 0);
        });

        await t.test('a row cannot be changed or deleted by SQL, and a unit is whole or absent', async () => {
          const db = await openMigrationDb(where.url, [], false);
          try {
            const events = store.table('events');
            await assert.rejects(db.run(`UPDATE ${events} SET name = 'x'`), /append-only/);
            await assert.rejects(db.run(`DELETE FROM ${events}`), /append-only/);
            if (engine === 'postgres') await assert.rejects(db.run(`TRUNCATE ${events}`), /append-only/);
            await assert.rejects(
              db.run(
                `INSERT INTO ${events} (occurred_at, received_at, environment, kind, name, fields, unit_kind) VALUES (1, 1, 'p', 'view', 'a', '{}', 'visitor')`,
              ),
            );
            await assert.rejects(
              db.run(
                `INSERT INTO ${events} (occurred_at, received_at, environment, kind, name, fields) VALUES (1, 1, 'p', 'click', 'a', '{}')`,
              ),
            );
            assert.equal((await db.all(`SELECT id FROM ${events}`)).length, 3);
          } finally {
            await db.close();
          }
        });

        await t.test('cursors move forward once, and prune keeps what a sink has not been given', async () => {
          assert.equal(await store.ensureCursor('warehouse', 1), 0);
          assert.equal(await store.prune(1_500), 0, 'a sink at 0 has been given nothing');
          const [first] = await store.readAfter(0, 1);
          assert.equal(await store.advanceCursor('warehouse', 0, first.id, 2), true);
          assert.equal(await store.advanceCursor('warehouse', 0, first.id, 3), false, 'a stale position does not move');
          assert.equal(await store.ensureCursor('warehouse'), first.id);
          assert.equal(await store.prune(1_500), 1);
          assert.equal((await store.readAfter(0, 10)).length, 2);
          await assert.rejects(store.advanceCursor('warehouse', first.id, 0));
        });
      } finally {
        await store.close();
      }

      await t.test('the exported prune opens the store, and refuses a bad time', async () => {
        const [last] = (
          await (async () => {
            const s = await openAnalyticsStore({ url: where.url, binding });
            try {
              return s.readAfter(0, 10);
            } finally {
              await s.close();
            }
          })()
        ).slice(-1);
        assert.ok(last);
        await assert.rejects(pruneAnalyticsEvents(where.url, { binding, before: -1 }));
        const s = await openAnalyticsStore({ url: where.url, binding });
        try {
          await s.advanceCursor('warehouse', await s.ensureCursor('warehouse'), last.id);
        } finally {
          await s.close();
        }
        assert.equal(await pruneAnalyticsEvents(where.url, { binding, before: new Date(10_000) }), 2);
      });

      await t.test('migrate stores status shows the store at version 1', async () => {
        const lines: string[] = [];
        assert.equal(
          await runMigrate(['stores', 'status', '--no-config', where.url], (line) => lines.push(line), undefined, MIGRATE_APPS),
          0,
        );
        assert.match(lines.join('\n'), /analytics\s+v1\s+current v1\s+up to date/);
        const db = await openMigrationDb(where.url, [], false);
        try {
          assert.equal((await storeStatuses(db)).find((status) => status.id === 'analytics')!.found, 1);
        } finally {
          await db.close();
        }
      });
    } finally {
      await where.drop();
    }
  });

  test(`${engine}: a database that holds anything else is not an analytics store`, { skip }, async () => {
    const where = await scratch(engine, 'analytics-foreign');
    try {
      const db = await openMigrationDb(where.url, [], false);
      try {
        await db.run('CREATE TABLE customer (id integer PRIMARY KEY)');
      } finally {
        await db.close();
      }
      await assert.rejects(provisionAnalyticsStore({ url: where.url, binding }), /database of its own/);
    } finally {
      await where.drop();
    }
    const clean = await scratch(engine, 'analytics-foreign2');
    try {
      await provisionAnalyticsStore({ url: clean.url, binding });
      const db = await openMigrationDb(clean.url, [], false);
      try {
        await db.run('CREATE TABLE customer (id integer PRIMARY KEY)');
      } finally {
        await db.close();
      }
      await assert.rejects(openAnalyticsStore({ url: clean.url, binding }), AnalyticsStoreUnavailable);
    } finally {
      await clean.drop();
    }
  });
}
