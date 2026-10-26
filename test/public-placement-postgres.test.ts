/** Disposable PostgreSQL fixture; scheduled separately by the release owner. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runtimeName, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import type {
  PublicPlacementAdmission,
  PublicPlacementAnchor,
  PublicPlacementOwner,
} from '../packages/mistri/src/adapters/commands/publicPlacementTypes.js';
import { provisionPostgresPublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import { PUBLIC_PLACEMENT_TABLES as tables } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import { describePostgresRelations } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { PUBLIC_PLACEMENT_PREFIX } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const LIVE = process.env.TABLEWALK_PUBLIC_PLACEMENT_TEST_PG ?? process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const owner: PublicPlacementOwner = {
  issuerId: 'issuer',
  sourceIdentity: 'original-source',
  appId: 'site',
  form: 'contact',
  tenant: 'north',
  commandId: 'contact',
  commandVersion: 1,
};
const admission: PublicPlacementAdmission = {
  ...owner,
  epoch: 'first',
  anchors: [
    { table: 'public.dealer', key: { id: 'north' }, expected: { active: true, version: 1 } },
    { table: 'public.storefront', key: { dealer: 'north', locale: 'en' }, expected: { published: true, version: 1 } },
  ],
};
const scope: RowScope = {
  'public.dealer': { groups: [[{ column: 'id', op: '=', value: 'north' }]] },
  'public.storefront': { groups: [[{ column: 'dealer', op: '=', value: 'north' }]] },
  'public.lead': { groups: [[{ column: 'dealer', op: '=', value: 'north' }]] },
};
const receipt: StoredCommandReceipt = {
  ...{ appId: owner.appId, actorId: `public:${owner.form}`, commandId: owner.commandId, commandVersion: owner.commandVersion },
  id: 'receipt',
  idempotencyKey: 'submission',
  fingerprint: 'canonical-input',
  resultJson: '{"reference":"lead"}',
  requestId: 'request',
  completedAt: '2026-09-30T12:00:00.000Z',
};
const audit = { target: 'lead', keyJson: '{}', changesJson: '[]' };
const lead = { table: 'public.lead', values: { id: 'lead', dealer: 'north' } };

test(
  'public placement PostgreSQL writer locks, atomic journal and original-owner recovery',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    // This lane must never touch the shared preview instance, even by opt-in.
    if (new URL(LIVE!).port === '57693') throw new Error('Use a disposable PostgreSQL control server, not preview port 57693.');
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const database = `tw_public_placement_${randomUUID().replaceAll('-', '')}`;
    let owned = false,
      db: Client | undefined,
      concurrent: Client | undefined,
      source: PostgresAdapter | undefined;
    try {
      await control.connect();
      await control.query(`CREATE DATABASE ${quote(database)}`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${database}`;
      db = new pg.default.Client({ connectionString: url.href, statement_timeout: 5000 });
      await db.connect();
      concurrent = new pg.default.Client({ connectionString: url.href, statement_timeout: 5000 });
      await concurrent.connect();
      const client = db,
        other = concurrent;
      assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
      await client.query(`CREATE TABLE dealer(id text PRIMARY KEY, active boolean NOT NULL, version integer NOT NULL);
        CREATE TABLE storefront(dealer text NOT NULL REFERENCES dealer(id), locale text NOT NULL, published boolean NOT NULL,
          version integer NOT NULL, PRIMARY KEY(dealer,locale));
        CREATE TABLE lead(id text PRIMARY KEY, dealer text NOT NULL REFERENCES dealer(id));
        CREATE TABLE foreign_table(id text PRIMARY KEY, active boolean NOT NULL);
        INSERT INTO dealer VALUES('north',true,1),('south',true,1);
        INSERT INTO storefront VALUES('north','en',true,1),('south','en',true,1);
        INSERT INTO foreign_table VALUES('north',true)`);
      source = new PostgresAdapter(url.href, 'Owned public placement fixture');
      const adapter = source;
      const empty = async () => {
        for (const table of ['lead', tables.receipt])
          assert.equal(
            Number(
              (await client.query(`SELECT count(*) AS n FROM ${table === 'lead' ? 'public.lead' : runtimeTable('postgres', table)}`))
                .rows[0].n,
            ),
            0,
          );
      };
      await t.test('serve does not provision; explicit v1 layout is idempotent', async () => {
        await assert.rejects(commandsOf(adapter).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('called')));
        await assert.rejects(commandsOf(adapter).publicPlacementReceipt(owner, receipt.idempotencyKey));
        assert.deepEqual(await provisionPostgresPublicPlacementJournal(url.href), { version: 1, provisioned: true });
        assert.deepEqual(await provisionPostgresPublicPlacementJournal(url.href), { version: 1, provisioned: false });
      });
      const dropJournal = async () => {
        for (const table of [tables.receipt, tables.meta]) await client.query(`DROP TABLE IF EXISTS ${runtimeTable('postgres', table)}`);
      };
      await t.test('unowned identical tables, foreign marker, version, fingerprint and partial layout are never adopted', async () => {
        for (const alteration of [
          `DROP TABLE ${runtimeTable('postgres', tables.meta)}`,
          `DELETE FROM ${runtimeTable('postgres', tables.meta)}`,
          `UPDATE ${runtimeTable('postgres', tables.meta)} SET format_owner='foreign-format'`,
          `UPDATE ${runtimeTable('postgres', tables.meta)} SET version=2`,
          `UPDATE ${runtimeTable('postgres', tables.meta)} SET schema_fingerprint='foreign-layout'`,
          `DROP TABLE ${runtimeTable('postgres', tables.receipt)}`,
        ]) {
          await dropJournal();
          await provisionPostgresPublicPlacementJournal(url.href);
          await client.query(alteration);
          const before = await describePostgresRelations(client, PUBLIC_PLACEMENT_PREFIX);
          const hasMeta = before.some((table) => table.name === runtimeName('postgres', tables.meta));
          const marker = hasMeta ? (await client.query(`SELECT * FROM ${runtimeTable('postgres', tables.meta)}`)).rows : undefined;
          await assert.rejects(
            commandsOf(adapter).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('unowned journal served')),
          );
          await assert.rejects(commandsOf(adapter).publicPlacementReceipt(owner, receipt.idempotencyKey));
          await assert.rejects(provisionPostgresPublicPlacementJournal(url.href));
          assert.deepEqual(await describePostgresRelations(client, PUBLIC_PLACEMENT_PREFIX), before);
          if (hasMeta) assert.deepEqual((await client.query(`SELECT * FROM ${runtimeTable('postgres', tables.meta)}`)).rows, marker);
        }
        await dropJournal();
        await provisionPostgresPublicPlacementJournal(url.href);
      });
      await t.test('late provisioning failure rolls back every newly created journal relation', async () => {
        await dropJournal();
        // Constraint names are per schema, so the clash has to sit in the runtime schema beside the journal.
        await client.query('CREATE SCHEMA IF NOT EXISTS mistri');
        await client.query('CREATE TABLE mistri.provision_conflict(id integer CONSTRAINT tw_pp_meta_pk PRIMARY KEY)');
        await assert.rejects(provisionPostgresPublicPlacementJournal(url.href));
        assert.deepEqual(await describePostgresRelations(client, PUBLIC_PLACEMENT_PREFIX), []);
        await client.query('DROP TABLE mistri.provision_conflict');
        await provisionPostgresPublicPlacementJournal(url.href);
      });
      await t.test('rollback includes business insert and both receipt tables', async () => {
        await assert.rejects(
          commandsOf(adapter).publicPlacementCommandTransaction(scope, admission, async (tx, journal) => {
            await tx.insert(lead);
            await journal.commit(receipt, audit);
            throw new Error('rollback');
          }),
        );
        await empty();
      });
      await t.test('complete PK and source catalog are required before handler admission', async () => {
        const invalid: PublicPlacementAnchor[] = [
          { table: 'public.storefront', key: { dealer: 'north' }, expected: { published: true } },
          { table: 'public.foreign_table', key: { id: 'north' }, expected: { active: true } },
        ];
        for (const anchor of invalid) {
          await assert.rejects(
            commandsOf(adapter).publicPlacementCommandTransaction(scope, { ...admission, anchors: [anchor] }, async () =>
              assert.fail('called'),
            ),
          );
        }
        await empty();
      });
      await t.test('eligibility UPDATE and DELETE conflict with locks held through receipt commit', async () => {
        await commandsOf(adapter).publicPlacementCommandTransaction(scope, admission, async (tx, journal) => {
          assert.equal('lockRecord' in tx, false);
          await other.query("SET lock_timeout = '100ms'");
          for (const sql of [
            "UPDATE dealer SET active=false WHERE id='north'",
            "DELETE FROM storefront WHERE dealer='north' AND locale='en'",
            `UPDATE ${runtimeTable('postgres', tables.meta)} SET format_owner='foreign-format'`,
            `DELETE FROM ${runtimeTable('postgres', tables.meta)}`,
          ]) {
            await assert.rejects(other.query(sql), (error: unknown) => (error as { code?: string }).code === '55P03');
          }
          await tx.insert(lead);
          await journal.commit(receipt, audit);
        });
        assert.deepEqual(await commandsOf(adapter).publicPlacementReceipt(owner, receipt.idempotencyKey), receipt);
      });
      await t.test('epoch replacement replays original namespace; stale eligibility never admits new writes', async () => {
        await commandsOf(adapter).publicPlacementCommandTransaction(scope, { ...admission, epoch: 'second' }, async (_tx, journal) => {
          assert.deepEqual(await journal.find(receipt), receipt);
        });
        await other.query("UPDATE dealer SET active=false,version=2 WHERE id='north'");
        await assert.rejects(
          commandsOf(adapter).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('stale admission')),
        );
        assert.deepEqual(await commandsOf(adapter).publicPlacementReceipt(owner, receipt.idempotencyKey), receipt);
        assert.equal(await commandsOf(adapter).publicPlacementReceipt({ ...owner, tenant: 'south' }, receipt.idempotencyKey), undefined);
        assert.equal(Number((await client.query('SELECT count(*) AS n FROM lead')).rows[0].n), 1);
      });
    } finally {
      await source?.close();
      await concurrent?.end().catch(() => {});
      await db?.end().catch(() => {});
      if (owned) await control.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
      await control.end().catch(() => {});
    }
  },
);
