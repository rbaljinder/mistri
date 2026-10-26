import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { Adapter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { CommandJournal, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import type { PublicPlacementAdmission, PublicPlacementOwner } from '../packages/mistri/src/adapters/commands/publicPlacementTypes.js';
import { provisionSqlitePublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import { PUBLIC_PLACEMENT_TABLES } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import { createAppResources, createAppResourcesOver } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { mapOpenedAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResourceMapping.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const owner: PublicPlacementOwner = {
  issuerId: 'issuer',
  sourceIdentity: 'retained-source-owner',
  appId: 'placement-map',
  form: 'contact',
  tenant: 'north',
  commandId: 'contact',
  commandVersion: 1,
};
const admission: PublicPlacementAdmission = {
  ...owner,
  epoch: 'original-epoch',
  anchors: [{ table: 'dealer', key: { tenant: 'north', locale: 'en' }, expected: { published: 1, revision: 1, label: 'archive.dealer' } }],
};
const scope: RowScope = {
  dealer: { groups: [[{ column: 'tenant', op: '=', value: 'north' }]] },
  lead: { groups: [[{ column: 'dealer_id', op: '=', value: 'north' }]] },
};
const receipt: StoredCommandReceipt = {
  id: 'receipt',
  appId: owner.appId,
  actorId: 'public:contact',
  commandId: owner.commandId,
  commandVersion: 1,
  idempotencyKey: 'submission',
  fingerprint: 'validated-input',
  resultJson: '{"reference":"lead"}',
  requestId: 'request',
  completedAt: '2026-09-30T12:00:00.000Z',
};
const audit = { target: 'lead', keyJson: '{}', changesJson: '[]' };
const insert = { table: 'lead', values: { id: 'lead', dealer_id: 'north', locale: 'en', answer: 'archive.dealer' } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-placement-mapping-'));
  const sources: Record<string, AppAdapterSource> = {},
    databases = new Map<string, DatabaseSync>();
  const adapters: SqliteAdapter[] = [];
  t.after(async () => {
    for (const adapter of adapters) await adapter.close();
    for (const db of databases.values()) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ['operations', 'archive']) {
    const path = join(directory, `${name}.db`),
      db = new DatabaseSync(path);
    databases.set(name, db);
    db.exec(`CREATE TABLE physical_dealer(tenant TEXT NOT NULL, locale TEXT NOT NULL, published INTEGER NOT NULL,
      revision INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY(tenant,locale));
      CREATE TABLE physical_lead(id TEXT PRIMARY KEY NOT NULL, dealer_id TEXT NOT NULL, locale TEXT NOT NULL, answer TEXT NOT NULL,
        FOREIGN KEY(dealer_id,locale) REFERENCES physical_dealer(tenant,locale));
      INSERT INTO physical_dealer VALUES('north','en',1,1,'archive.dealer'),('south','en',1,1,'south');`);
    provisionSqlitePublicPlacementJournal(path);
    const adapter = new SqliteAdapter(path);
    adapters.push(adapter);
    sources[name] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      group: `${name}-connection`,
      resources: { dealer: 'physical_dealer', lead: 'physical_lead' },
    };
  }
  const app = parseAppConfig(
    {
      id: owner.appId,
      name: 'Placement mapping',
      sources: {
        operations: { connection: 'operations-connection', default: true },
        archive: { connection: 'archive-connection' },
      },
      resources: {
        dealer: { physical: 'physical_dealer' },
        lead: { physical: 'physical_lead', access: 'write' },
        'archive.dealer': { physical: 'physical_dealer' },
        'archive.lead': { physical: 'physical_lead', access: 'write' },
      },
      views: { dealers: { kind: 'list', from: 'dealer' } },
      home: 'dealers',
    },
    'placement mapping fixture',
  );
  const resources = mapOpenedAppRuntimeResources(
    app,
    'operations-connection',
    new Map(Object.entries(sources)),
    new Map([
      ['operations', 'operations-connection'],
      ['archive', 'archive-connection'],
    ]),
  );
  return { sources, databases, resources };
}
const count = (db: DatabaseSync, table: string) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n;

test('RuntimeResources exposes one-source placement with mapped records, catalog and original-owner receipt recovery', async (t) => {
  const { resources, databases } = await fixture(t);
  assert.equal(commandsOf(resources.adapter).publicPlacementCommandTransaction, undefined);
  assert.equal(commandsOf(resources.adapter).publicPlacementReceipt, undefined);
  const source = resources.forConnection(resources.connectionFor('dealer'));
  let records: WriteTransaction | undefined;
  await commandsOf(source).publicPlacementCommandTransaction!(scope, admission, async (tx, journal, evidence) => {
    records = tx;
    assert.equal('lockRecord' in tx, false);
    assert.equal('publicPlacementCommandTransaction' in tx, false);
    assert.deepEqual(evidence.tables.map((table) => table.id).sort(), ['dealer', 'lead']);
    assert.equal(evidence.foreignKeys[0].from.table, 'lead');
    assert.equal(evidence.foreignKeys[0].to.table, 'dealer');
    assert.deepEqual(
      (await tx.query({ table: 'dealer', offset: 0, limit: 10 })).rows.map((row) => row.tenant),
      ['north'],
    );
    await tx.insert(insert);
    await journal.commit(receipt, audit);
  });
  assert.equal(count(databases.get('operations')!, 'physical_lead'), 1);
  assert.equal(databases.get('operations')!.prepare('SELECT answer FROM physical_lead').get()?.answer, 'archive.dealer');
  assert.equal(count(databases.get('archive')!, 'physical_lead'), 0);
  await assert.rejects(records!.insert({ ...insert, values: { ...insert.values, id: 'escaped' } }));
  databases.get('operations')!.exec('UPDATE physical_dealer SET published=0,revision=2');
  assert.deepEqual(await commandsOf(source).publicPlacementReceipt!(owner, receipt.idempotencyKey), receipt);
  assert.equal(
    await commandsOf(source).publicPlacementReceipt!({ ...owner, sourceIdentity: 'new-source-owner' }, receipt.idempotencyKey),
    undefined,
  );
  assert.equal(
    await commandsOf(resources.forConnection('archive-connection')).publicPlacementReceipt!(owner, receipt.idempotencyKey),
    undefined,
  );
});

test('secondary source qualification maps anchors and full key/expected dictionaries without relabeling scalar values', async (t) => {
  const { resources, databases } = await fixture(t);
  const secondaryScope = { 'archive.dealer': scope.dealer, 'archive.lead': scope.lead };
  await commandsOf(resources.forConnection('archive-connection')).publicPlacementCommandTransaction!(
    secondaryScope,
    { ...admission, anchors: admission.anchors.map((anchor) => ({ ...anchor, table: 'archive.dealer' })) },
    async (tx, journal, evidence) => {
      assert.deepEqual(evidence.tables.map((table) => table.id).sort(), ['archive.dealer', 'archive.lead']);
      await tx.insert({ ...insert, table: 'archive.lead' });
      await journal.commit(receipt, audit);
    },
  );
  assert.equal(count(databases.get('operations')!, 'physical_lead'), 0);
  assert.equal(count(databases.get('archive')!, 'physical_lead'), 1);
});

test('foreign anchors, malformed keys and caught foreign writes refuse or roll back the complete mapped transaction', async (t) => {
  const { resources, databases } = await fixture(t);
  const source = resources.forConnection('operations-connection');
  for (const anchors of [
    [{ ...admission.anchors[0], table: 'archive.dealer' }],
    [admission.anchors[0], { ...admission.anchors[0], table: 'archive.dealer' }],
    [{ ...admission.anchors[0], table: 'physical_dealer' }],
    [{ ...admission.anchors[0], key: { tenant: 'north' } }],
    [{ ...admission.anchors[0], expected: { missing: 1 } }],
  ])
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction!(scope, { ...admission, anchors }, async () => assert.fail('foreign admission')),
    );
  for (const table of ['archive.lead', 'physical_lead', 'missing']) {
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction!(scope, admission, async (tx, journal) => {
        await tx.insert(insert);
        await journal.commit(receipt, audit);
        await tx.insert({ ...insert, table }).catch(() => {});
      }),
    );
  }
  for (const db of databases.values())
    for (const table of ['physical_lead', PUBLIC_PLACEMENT_TABLES.receipt]) assert.equal(count(db, table), 0);
});

test('placement methods and identity mappings are captured; mutation cannot rebind a retained owner', async (t) => {
  const { sources, databases } = await fixture(t);
  const physical = sources.operations.adapter;
  const logical = createAppResources(physical, sources.operations.schema, sources.operations.resources);
  const mutable = new Map([
    ['dealer', 'physical_dealer'],
    ['lead', 'physical_lead'],
  ]);
  const mapped = createAppResourcesOver(physical, {
    schema: logical.schema,
    toPhysical: (name) => mutable.get(name)!,
    toLogical: (name) => [...mutable].find(([, value]) => value === name)![0],
  });
  let replacements = 0;
  physical.publicPlacementCommandTransaction = async () => {
    replacements++;
    throw new Error('rebound writer');
  };
  physical.publicPlacementReceipt = async () => {
    replacements++;
    throw new Error('rebound recovery');
  };
  mutable.set('lead', 'physical_dealer');
  mapped.schema.tables.find((table) => table.id === 'dealer')!.columns.length = 0;
  await commandsOf(mapped.adapter).publicPlacementCommandTransaction!(scope, admission, async (tx, journal) => {
    await tx.insert(insert);
    await journal.commit(receipt, audit);
  });
  assert.deepEqual(await commandsOf(mapped.adapter).publicPlacementReceipt!(owner, receipt.idempotencyKey), receipt);
  assert.equal(replacements, 0);
  assert.equal(count(databases.get('operations')!, 'physical_lead'), 1);
});

test('unknown out-of-source constraints are not removed by catalog bounds before admission evidence is checked', async (t) => {
  const { sources, databases } = await fixture(t);
  const source = sources.operations;
  const logical = createAppResources(source.adapter, source.schema, source.resources);
  const bounded = createAppResourcesOver(source.adapter, { ...logical, bounds: { full: source.schema, within: source.schema } });
  databases.get('operations')!.exec('CREATE TABLE hidden_dependent(id INTEGER PRIMARY KEY, lead_id TEXT REFERENCES physical_lead(id));');
  await assert.rejects(
    commandsOf(bounded.adapter).publicPlacementCommandTransaction!(scope, admission, async () =>
      assert.fail('hidden constraint disappeared'),
    ),
  );
  assert.equal(count(databases.get('operations')!, 'physical_lead'), 0);
});

test('read-only source keeps recovery but no placement writer; unsupported and composite capabilities stay absent', async (t) => {
  const { sources } = await fixture(t);
  sources.operations.writable = false;
  const runtime = createAppSourceAdapter(sources, 'operations');
  assert.equal(commandsOf(runtime.forSource('operations')).publicPlacementCommandTransaction, undefined);
  assert.equal(typeof commandsOf(runtime.forSource('operations')).publicPlacementReceipt, 'function');
  assert.equal(await commandsOf(runtime.forSource('operations')).publicPlacementReceipt!(owner, 'absent'), undefined);
  const absent: Adapter = {
    dialect: 'sqlite',
    introspect: async () => sources.operations.schema,
    query: async () => {
      throw new Error('not used');
    },
    count: async () => 0,
    close: async () => {},
  };
  const simple = createAppResources(absent, sources.operations.schema);
  assert.equal(commandsOf(simple.adapter).publicPlacementCommandTransaction, undefined);
  assert.equal(commandsOf(simple.adapter).publicPlacementReceipt, undefined);
});

test('sharing a physical group never permits mixed-source placement or another source through a source-bound facade', async () => {
  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'mapping only',
    readAt: '',
    foreignKeys: [],
    tables: ['sales', 'archive'].map((name) => ({
      id: `${name}.dealer`,
      name: 'dealer',
      schema: name,
      isView: false,
      columns: [
        { name: 'id', type: 'text', primaryKey: true, nullable: false },
        { name: 'active', type: 'boolean', primaryKey: false, nullable: false },
      ],
    })),
  };
  let transactions = 0;
  const noRecord = async (): Promise<never> => {
    throw new Error('not needed');
  };
  const tx: WriteTransaction = { query: noRecord, count: noRecord, insert: noRecord, update: noRecord, remove: noRecord };
  const journal: CommandJournal = { find: async () => undefined, commit: async () => {} };
  const physical: Adapter = {
    dialect: 'postgres',
    introspect: async () => schema,
    query: noRecord,
    count: noRecord,
    close: async () => {},
    publicPlacementCommandTransaction: async (_scope, _admission, run) => {
      transactions++;
      return run(tx, journal, schema);
    },
  };
  const sources = {
    sales: { adapter: physical, schema, group: 'one-db', scope: 'sales', writable: true },
    archive: { adapter: physical, schema, group: 'one-db', scope: 'archive', writable: true },
  };
  const runtime = createAppSourceAdapter(sources, 'sales');
  const salesAdmission = { ...admission, anchors: [{ table: 'dealer', key: { id: 'north' }, expected: { active: true } }] };
  const archiveAdmission = { ...admission, anchors: [{ table: 'archive.dealer', key: { id: 'north' }, expected: { active: true } }] };
  await assert.rejects(
    commandsOf(runtime.forGroup('one-db')).publicPlacementCommandTransaction!(
      { dealer: true, 'archive.dealer': true },
      salesAdmission,
      noRecord,
    ),
  );
  await assert.rejects(
    commandsOf(runtime.forGroup('one-db')).publicPlacementCommandTransaction!(
      { dealer: true },
      { ...salesAdmission, anchors: [...salesAdmission.anchors, ...archiveAdmission.anchors] },
      noRecord,
    ),
  );
  await assert.rejects(
    commandsOf(runtime.forSource('sales')).publicPlacementCommandTransaction!({ 'archive.dealer': true }, archiveAdmission, noRecord),
  );
  assert.equal(transactions, 0);
  await commandsOf(runtime.forGroup('one-db')).publicPlacementCommandTransaction!({ dealer: true }, salesAdmission, async () => {});
  assert.equal(transactions, 1);
  await assert.rejects(
    commandsOf(runtime.forGroup('one-db')).publicPlacementCommandTransaction!({ dealer: true }, salesAdmission, async (records) => {
      await records.insert({ table: 'archive.dealer', values: { id: 'wrong-source', active: true } }).catch(() => {});
    }),
  );
});
