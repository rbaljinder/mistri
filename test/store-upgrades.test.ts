/**
 * The registry of mistri's own store layouts (packages/mistri/src/server/storeLayouts.ts),
 * held to the fixtures under test/fixtures/store-layouts:
 *
 *  1. what a fresh provisioning leaves is exactly the fixture of the version
 *     this build expects, and the registry reads it as that version;
 *  2. the upgrade framework runs a registered step once and in order, and refuses a version with no step
 *     or one newer than this build, unchanged (every store is at layout version 1, so a test's own
 *     registry stands for a later layout);
 *  3. `mistri migrate stores status | up` says and does the same.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the
 * role may create databases (each case makes its own).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { STORES, storeIsCurrent, storeStatuses, upgradeStores, type StoreDef } from '../packages/mistri/src/server/storeLayouts.js';
import { isRuntimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import {
  ENGINES,
  LIVE,
  PROVISION,
  applyFixture,
  describeUrl,
  fixtureFiles,
  scratch,
  withoutBeneath,
  type Engine,
} from './support/storeLayouts.js';
const skip = (engine: Engine) => (engine === 'postgres' ? liveSkip('postgres', LIVE) : false);
const open = (url: string) => openMigrationDb(url, [], false);
async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await open(url);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}
const statusOf = (db: MigrationDb, id: string) => storeStatuses(db).then((all) => all.find((status) => status.id === id)!);

test('the registry names every store once, and each dialect it says it holds has a way to provision and a fixture', () => {
  const ids = STORES.map((layout) => layout.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const layout of STORES) {
    for (const engine of ENGINES) {
      const current = layout.current[engine];
      assert.equal(
        Boolean(PROVISION[layout.id]?.[engine]),
        current !== undefined,
        `${layout.id} on ${engine}: provisioning iff the registry holds it`,
      );
      if (current === undefined) continue;
      assert.ok(
        fixtureFiles(layout.id, engine).some((file) => file.version === current),
        `${layout.id} on ${engine} has a fixture of version ${current}: node --import tsx scripts/store-layouts.mjs --write`,
      );
      // A step per version below the current one, or the store is refused from there ("reseed").
      for (const fixture of fixtureFiles(layout.id, engine)) {
        assert.ok(fixture.version <= current, `${layout.id}/${engine}/v${fixture.version} is newer than the registry's ${current}`);
        if (fixture.version < current)
          assert.ok(
            layout.upgrades[engine]?.[fixture.version],
            `${layout.id}/${engine}: an older fixture, v${fixture.version}, with no step from it`,
          );
      }
    }
    for (const [engine, steps] of Object.entries(layout.upgrades)) {
      for (const from of Object.keys(steps).map(Number)) {
        assert.ok(
          from < layout.current[engine as Engine]!,
          `${layout.id}/${engine}: a step from ${from}, which is not below the current version`,
        );
        assert.ok(
          fixtureFiles(layout.id, engine as Engine).some((file) => file.version === from),
          `${layout.id}/${engine}: the step from v${from} has an older fixture`,
        );
      }
    }
  }
});

test('a store the list names by prefix is one the engine hides, and provisionStores reaches only a layout the list holds', () => {
  for (const store of STORES) {
    // The engine reads no list (it runs without the App framework): its prefix rule is what hides these tables.
    if ('prefix' in store.tables)
      assert.ok(isRuntimeTable(`${store.tables.prefix}x`), `${store.id}: ${store.tables.prefix} is not reserved`);
    for (const engine of Object.keys(store.provision ?? {}) as Engine[])
      // The schema epoch is an event trigger and its log, which no release has had to move.
      assert.ok(
        store.id === 'schema-epoch' || store.current[engine] !== undefined,
        `${store.id}: provisioned on ${engine}, with no layout there`,
      );
  }
});

for (const engine of ENGINES) {
  for (const layout of STORES) {
    const current = layout.current[engine];
    if (current === undefined) continue;

    test(
      `${layout.id} on ${engine}: a fresh provisioning is the fixture of version ${current}, and the registry reads it so`,
      { skip: skip(engine) },
      async () => {
        const fresh = await scratch(engine, `fresh_${layout.id}`),
          fixture = await scratch(engine, `fix_${layout.id}`);
        try {
          await PROVISION[layout.id][engine]!(fresh.url);
          const file = fixtureFiles(layout.id, engine).find((each) => each.version === current)!;
          await applyFixture(engine, fixture.url, readFileSync(file.path, 'utf8'));
          assert.deepEqual(
            withoutBeneath(layout.id, engine, await describeUrl(fixture.url)),
            withoutBeneath(layout.id, engine, await describeUrl(fresh.url)),
          );
          for (const url of [fresh.url, fixture.url]) {
            await withDb(url, async (db) => {
              const status = await statusOf(db, layout.id);
              assert.equal(status.found, current, `${layout.id} reads as version ${current}`);
              assert.ok(storeIsCurrent(status));
            });
          }
        } finally {
          await fresh.drop();
          await fixture.drop();
        }
      },
    );
  }
}

test('the upgrade framework runs a step once, and refuses what it has no step for or what is newer', async () => {
  const where = await scratch('sqlite', 'steps');
  try {
    await withDb(where.url, async (db) => {
      await db.run('CREATE TABLE sample_meta (version INTEGER NOT NULL)');
      await db.run('INSERT INTO sample_meta (version) VALUES (1)');
      const layout = (current: number, steps: number[]): StoreDef => ({
        id: 'sample',
        title: 'a sample store',
        tables: { prefix: 'sample_' },
        current: { sqlite: current },
        async read(each) {
          const rows = await each.all<{ version: number }>('SELECT version FROM sample_meta');
          return rows.length ? Number(rows[0].version) : null;
        },
        upgrades: {
          sqlite: Object.fromEntries(
            steps.map((from) => [
              from,
              {
                says: `step ${from}`,
                async run({ db: inner }) {
                  await inner.run('UPDATE sample_meta SET version = ?', [from + 1]);
                },
              },
            ]),
          ),
        },
      });
      const status = (each: StoreDef) => storeStatuses(db, [each]).then((all) => all[0]);
      assert.deepEqual((await status(layout(3, [1, 2]))).pending, [1, 2]);
      assert.match((await status(layout(3, [1]))).refused!, /no upgrade from version 2/);
      const refused = await upgradeStores(db, where.url, [layout(3, [1])]);
      assert.deepEqual(refused.applied, []);
      assert.equal((await status(layout(3, [1]))).found, 1, 'refused, not altered');
      const done = await upgradeStores(db, where.url, [layout(3, [1, 2])]);
      assert.deepEqual(
        done.applied.map((each) => [each.from, each.to]),
        [
          [1, 2],
          [2, 3],
        ],
      );
      assert.ok(storeIsCurrent(await status(layout(3, [1, 2]))));
      assert.deepEqual((await upgradeStores(db, where.url, [layout(3, [1, 2])])).applied, [], 'a second run changes nothing');
      assert.match((await status(layout(2, [1]))).refused!, /newer than this mistri/);
    });
  } finally {
    await where.drop();
  }
});

for (const engine of ENGINES)
  test(
    `${engine}: a marker no registered step reaches, or newer than this build, is refused and left as it is`,
    { skip: skip(engine) },
    async () => {
      const where = await scratch(engine, 'refuse');
      try {
        await PROVISION['record-history'][engine]!(where.url);
        await withDb(where.url, async (db) => {
          const table = db.dialect === 'sqlite' ? '"__mistri_history_meta"' : 'mistri.history_meta';
          for (const [version, why] of [
            [0, /no upgrade from version 0/],
            [2, /newer than this mistri/],
          ] as const) {
            // The marker's own CHECK pins the version, so a forged marker is a table of the same name without it.
            await db.run(`DROP TABLE ${table}`);
            await db.run(`CREATE TABLE ${table} (singleton integer PRIMARY KEY, version integer NOT NULL)`);
            await db.run(`INSERT INTO ${table} (singleton, version) VALUES (1, ?)`, [version]);
            const status = await statusOf(db, 'record-history');
            assert.equal(status.found, version);
            assert.match(status.refused!, why);
            const result = await upgradeStores(db, where.url);
            assert.deepEqual(result.applied, []);
            assert.equal(result.refused.find((each) => each.id === 'record-history')!.message, status.refused);
            assert.equal((await db.all<{ version: number }>(`SELECT version FROM ${table}`))[0].version, version, 'untouched');
          }
        });
      } finally {
        await where.drop();
      }
    },
  );

test('migrate stores status and up, on a SQLite file', async (t) => {
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await runMigrate(argv, (line) => lines.push(line), undefined, MIGRATE_APPS);
    return { code, text: lines.join('\n') };
  };
  await t.test('sqlite: a file holding a store reads as up to date and nothing is pending', async () => {
    const where = await scratch('sqlite', 'cli');
    try {
      await PROVISION['record-history'].sqlite!(where.url);
      const status = await run('stores', 'status', '--no-config', where.url);
      assert.equal(status.code, 0);
      assert.match(status.text, /record-history\s+v1\s+current v1\s+up to date/);
      assert.match(status.text, /inbox\s+absent/);
      const up = await run('stores', 'up', '--no-config', where.url);
      assert.equal(up.code, 0);
      assert.match(up.text, /nothing to upgrade/);
    } finally {
      await where.drop();
    }
  });
  await t.test('it refuses what it cannot read as a stores command', async () => {
    assert.equal((await run('stores', 'nope', '--no-config', 'x.db')).code, 1);
    assert.equal((await run('stores')).code, 1);
  });
});
