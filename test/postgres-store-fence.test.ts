/**
 * The administration journal and the support audit, attested in full when an
 * adapter first uses them and not again (packages/mistri/src/server/tenant/postgresStoreFence.ts),
 * against a real server.
 *
 * One test per property: an adapter attests each store once, across its
 * transactions; a drift made after that is seen by the next adapter (a
 * restart), not by this one; a statement that fails the way a moved
 * catalog fails one forgets what the adapter attested; and adapters of one
 * database share an attestation only under the exact catalog version each
 * read, and each reads the store's meta row again, so any drift is refused by
 * the next of them.
 *
 * Live and opt-in like postgres-tenant-store.test.ts: `TABLEWALK_TEST_PG`
 * names a server this file creates and drops a database of this run's own
 * in, and a NOLOGIN role, so the role needs CREATEDB and CREATEROLE.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import {
  changesCatalog,
  readsCatalogVersion,
  suspectsStores,
  transactionHandle,
} from '../packages/engine/src/adapters/postgresTransactionHandle.js';
import { postgresCatalogDigestOf, postgresCatalogDigestStatement } from '../packages/engine/src/adapters/postgresCatalogDigest.js';
import { SYSTEM_SCHEMAS } from '../packages/engine/src/adapters/postgresCatalog.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  ADMINISTRATION_JOURNAL_PREFIX,
  ADMINISTRATION_JOURNAL_TABLES as admin,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournalContract.js';
import {
  assertPostgresTenantAdministrationJournal,
  createPostgresTenantAdministrationJournal,
  migratePostgresTenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TENANT_STORE_PREFIX } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { assertPostgresTenantStore, migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { runtimeName, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import {
  SUPPORT_AUDIT_PREFIX,
  SUPPORT_AUDIT_TABLES as support,
  supportAuditKey,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  assertPostgresSupportAudit,
  createPostgresSupportAuditOwner,
  migratePostgresSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const FIXTURE_ID = randomUUID().replaceAll('-', '');
const DATABASE = `tw_store_fence_${FIXTURE_ID}`;
const OTHER_ROLE = `tablewalk_store_fence_${FIXTURE_ID}`;
const ITEM = 'public.store_fence_item';
const REF = 'public.store_fence_ref';
let url: string;
const key = supportAuditKey('store-fence-test-secret-of-thirty-two-bytes-or-more');
const owner = (): TenantStoreBinding => ({ appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'store-1' });
const q = (name: string) => runtimeTable('postgres', name);
const pgName = (name: string) => runtimeName('postgres', name);

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(target = url): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: target, statement_timeout: 10_000 });
  await created.connect();
  return created;
}
const denied = (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  return true;
};

/* Each store: how a transaction attests it, a few fences' worth of its own
   work through the composition the runtime uses, and the tables and rows a
   drift is made on. */
const stores = [
  {
    label: 'the administration journal',
    prefix: ADMINISTRATION_JOURNAL_PREFIX,
    table: admin.receipt,
    meta: admin.meta,
    index: `${pgName(admin.receipt)}_pkey`,
    attest: (c: PgQuery) => assertPostgresTenantAdministrationJournal(c, owner()),
    work: async (c: PgQuery, operations: TransactionOperations) => {
      const journal = createPostgresTenantAdministrationJournal(c, operations, owner(), () => {});
      const scope = { actorId: 'operator', tenantId: 'north', operation: 'createTenant', operationVersion: 1, idempotencyKey: 'attempt-1' };
      assert.equal(await journal.read(scope), null);
      assert.equal(await journal.read({ ...scope, idempotencyKey: 'attempt-2' }), null);
    },
  },
  {
    label: 'the support audit',
    prefix: SUPPORT_AUDIT_PREFIX,
    table: support.session,
    meta: support.meta,
    index: `${pgName(support.session)}_pkey`,
    attest: (c: PgQuery) => assertPostgresSupportAudit(c, owner(), key),
    // The support owner's path checkpoints every statement through a view of the handle.
    work: async (c: PgQuery, operations: TransactionOperations) => {
      const audit = createPostgresSupportAuditOwner(c, operations, owner(), key, () => {});
      assert.equal(await audit.audit.verify('missing-1'), null);
      assert.equal(await audit.audit.verify('missing-2'), null);
    },
  },
] as const;

/* A statement that changes the catalog forgets the version the transaction read, so nothing it attests next is filed
   under it. A comment before the verb, as a migration file or a query tool writes one, hides nothing. */
test('a catalog write is seen behind comments and after other statements, and a word inside a statement is not one', () => {
  for (const text of [
    'ALTER TABLE t ADD COLUMN c text',
    '/* add a column */ ALTER TABLE t ADD COLUMN c text',
    '-- add a column\nALTER TABLE t ADD COLUMN c text',
    '/* one */ /* two */\n  drop index i',
    'SELECT 1; GRANT SELECT ON t TO r',
    'DO $$ BEGIN END $$',
    'create unique index i on t (c)',
  ])
    assert.equal(changesCatalog(text), true, text);
  for (const text of [
    'SELECT created_at FROM t',
    "SELECT 'x' AS altered, dropped FROM t",
    'INSERT INTO t (c) VALUES (1) ON CONFLICT (c) DO UPDATE SET c = 2',
    'UPDATE t SET grant_id = 1',
  ])
    assert.equal(changesCatalog(text), false, text);
});

/* A broken reference forgets what one adapter attested; only a table, column or privilege that moved forgets what the
   process shares, so an App's ordinary foreign-key violation does not send every adapter back to a full attestation. */
test('a broken reference is suspect for one adapter, and a moved catalog for the process', () => {
  for (const code of ['42P01', '42703', '42501', '23503']) assert.equal(suspectsStores({ code }), true, code);
  for (const code of ['23505', '40001', undefined]) assert.equal(suspectsStores({ code }), false, String(code));
});

describe('an adapter attests the journal and the support audit once, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const extra: Control[] = [];
  const connection = async () => {
    const created = await client();
    extra.push(created);
    return created;
  };
  /** An adapter of this database as PostgresAdapter is one: it reads the catalog digest when it has a store to attest. */
  const adapterOf = () => {
    const adapter = {};
    readsCatalogVersion(
      adapter,
      url,
      async (c) => `digest:${postgresCatalogDigestOf(await c.query(postgresCatalogDigestStatement(SYSTEM_SCHEMAS)))}`,
    );
    return adapter;
  };
  /** A transaction on its own handle, as `adapter`'s writer makes one, rolled back at the end. */
  const within = async (
    adapter: object,
    work: (handle: PgQuery) => Promise<void>,
    sent?: (text: string, values: unknown) => void | Promise<void>,
    begin = 'BEGIN',
  ) => {
    const c = await connection();
    const handle = transactionHandle(
      {
        query: (async (...args: unknown[]) => {
          const request = args[0] as string | { text: string };
          await sent?.(typeof request === 'string' ? request : request.text, args[1]);
          return (c.query as (...values: unknown[]) => unknown)(...args);
        }) as PgQuery['query'],
      },
      adapter,
    );
    await handle.query(begin);
    try {
      await work(handle);
    } finally {
      await handle.query('ROLLBACK');
    }
  };

  before(async () => {
    const server = await client(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${DATABASE}"`);
      await server.query(`CREATE ROLE "${OTHER_ROLE}" NOLOGIN`);
    } finally {
      await server.end();
    }
    const target = new URL(LIVE!);
    target.pathname = `/${DATABASE}`;
    url = target.href;
    control = await client();
  });
  after(async () => {
    await control.end();
    const server = await client(LIVE!);
    try {
      await server.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      await server.query(`DROP ROLE IF EXISTS "${OTHER_ROLE}"`);
    } finally {
      await server.end();
    }
  });
  beforeEach(async () => {
    await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
    await control.query(`DROP TABLE IF EXISTS ${REF}, ${ITEM}`);
    await control.query('DROP FUNCTION IF EXISTS public.store_fence_noop()');
    await control.query(`CREATE TABLE ${ITEM} (id text PRIMARY KEY, receipt text)`);
    await control.query(`CREATE TABLE ${REF} (item text REFERENCES ${ITEM})`);
    await control.query(`CREATE FUNCTION public.store_fence_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`);
    await migratePostgresTenantStore(url, owner());
    await migratePostgresTenantAdministrationJournal(url, owner());
    await migratePostgresSupportAudit(url, owner(), key);
  });
  afterEach(async () => {
    while (extra.length)
      await extra
        .pop()!
        .end()
        .catch(() => {});
  });

  for (const store of stores) {
    test(`${store.label}: an adapter attests it in full once, across its transactions`, async () => {
      const described = new Map<string, number>();
      const adapter = {};
      for (let transaction = 0; transaction < 2; transaction++)
        await within(
          adapter,
          async (handle) => {
            const operations = new TransactionOperations();
            await store.work(handle, operations);
            await operations.finish();
          },
          (text, values) => {
            // describePostgresRelations is the full attestation's first read.
            const prefix = Array.isArray(values) ? values[0] : undefined;
            if (/pg_attrdef/.test(text) && typeof prefix === 'string') described.set(prefix, (described.get(prefix) ?? 0) + 1);
          },
        );
      // Two transactions of two operations each: one full attestation of this store, and one of the tenant store beneath it.
      assert.deepEqual(Object.fromEntries(described), { [pgName(store.prefix)]: 1, [pgName(TENANT_STORE_PREFIX)]: 1 });
    });

    /* Each made from another connection once an adapter has attested the
         store. Nothing waits on a pin any more; the adapter that attested goes
         on, and the next one to start refuses. */
    const drifts: [string, (c: Control) => Promise<unknown>][] = [
      ['a grant on a table', (c) => c.query(`GRANT SELECT ON ${q(store.table)} TO "${OTHER_ROLE}"`)],
      ['a grant on a column', (c) => c.query(`GRANT SELECT (id) ON ${q(store.table)} TO "${OTHER_ROLE}"`)],
      ['a renamed index', (c) => c.query(`ALTER INDEX mistri."${store.index}" RENAME TO "${store.index}_renamed"`)],
      ['a new reserved table', (c) => c.query(`CREATE TABLE ${q(`${store.prefix}extra`)} (id integer)`)],
      ['a rebound meta row', (c) => c.query(`UPDATE ${q(store.meta)} SET store_id = 'other-store'`)],
      [
        'a trigger',
        (c) =>
          c.query(
            `CREATE TRIGGER store_fence_noop BEFORE UPDATE ON ${q(store.table)} FOR EACH ROW EXECUTE FUNCTION public.store_fence_noop()`,
          ),
      ],
      ['an index', (c) => c.query(`CREATE INDEX store_fence_extra ON ${q(store.table)} (id)`)],
      ['a column', (c) => c.query(`ALTER TABLE ${q(store.table)} ADD COLUMN note text`)],
    ];
    test(`${store.label}: a drift after it was attested is refused by the next adapter to start`, async () => {
      for (const [label, drift] of drifts) {
        const running = {};
        await within(running, (handle) => store.attest(handle));
        await drift(await connection());
        await within(running, (handle) => store.attest(handle));
        await assert.rejects(
          within({}, (handle) => store.attest(handle)),
          denied,
          label,
        );
        await undo(label);
      }
    });

    test(`${store.label}: adapters of one database share it under the catalog version they read, and a drift moves it`, async () => {
      const reads: string[] = [];
      const sent = (text: string, values: unknown) => {
        const prefix = Array.isArray(values) ? values[0] : undefined;
        if (/pg_attrdef/.test(text) && typeof prefix === 'string') reads.push(prefix);
      };
      await within(adapterOf(), (handle) => store.attest(handle), sent);
      assert.deepEqual(reads.sort(), [pgName(store.prefix), pgName(TENANT_STORE_PREFIX)].sort(), 'the first adapter attests in full');
      reads.length = 0;
      await within(adapterOf(), (handle) => store.attest(handle), sent);
      assert.deepEqual(reads, [], 'the next adapter reads the same version and finds both stores attested');
      /* Each catalog drift moves the version, and the next adapter attests in full. A rebound meta row moves nothing:
         it is data, and the next adapter reads it again however it finds the catalog. */
      const everyDrift: [string, (c: Control) => Promise<unknown>][] = [
        ...drifts,
        [
          'a text search configuration beside the store',
          (c) => c.query('CREATE TEXT SEARCH CONFIGURATION mistri.store_fence_ts (COPY = pg_catalog.simple)'),
        ],
        ['the schema granted to another role', (c) => c.query(`GRANT USAGE ON SCHEMA mistri TO "${OTHER_ROLE}"`)],
      ];
      for (const [label, drift] of everyDrift) {
        await within(adapterOf(), (handle) => store.attest(handle));
        await drift(await connection());
        await assert.rejects(
          within(adapterOf(), (handle) => store.attest(handle)),
          denied,
          label,
        );
        await undo(label);
      }
    });

    /* A writer reads committed state statement by statement: it reads the version, and DDL that commits before its
       attestation's next read is what it attests. That attestation is not filed under the version read before it,
       where a snapshot that still sees the older catalog would find it. */
    test(`${store.label}: an attestation that saw DDL committed after its version was read is not filed under it`, async () => {
      const extra = q(`${store.prefix}extra`);
      await control.query(`CREATE TABLE ${extra} (id integer)`);
      let snapshotBegun!: () => void;
      const begun = new Promise<void>((resolve) => (snapshotBegun = resolve));
      let writerDone!: () => void;
      const done = new Promise<void>((resolve) => (writerDone = resolve));
      // A snapshot taken while the extra table stands, and asked to attest only once the writer has.
      const snapshot = within(
        adapterOf(),
        async (handle) => {
          await handle.query('SELECT 1');
          snapshotBegun();
          await done;
          await store.attest(handle);
        },
        undefined,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      void snapshot.catch(() => {});
      await begun;
      let dropped = false;
      try {
        await within(
          adapterOf(),
          (handle) => store.attest(handle),
          async (text, values) => {
            /* describePostgresRelations, the full attestation's first read, asks for its prefix; the digest read before
               it reads pg_attrdef too, and asks for nothing. */
            if (!dropped && /pg_attrdef/.test(text) && Array.isArray(values) && typeof values[0] === 'string') {
              dropped = true;
              await control.query(`DROP TABLE ${extra}`);
            }
          },
        );
      } finally {
        writerDone();
      }
      assert.ok(dropped, 'the table was dropped between the version read and the attestation');
      await assert.rejects(snapshot, denied, 'the snapshot attests the catalog it sees, extra table and all');
      await undo('an extra table');
    });

    test(`${store.label}: an App's broken reference leaves what adapters share attested`, async () => {
      await within(adapterOf(), (handle) => store.attest(handle));
      await within(adapterOf(), async (handle) => {
        await store.attest(handle);
        await handle.query('SAVEPOINT reference');
        await assert.rejects(handle.query(`INSERT INTO ${REF} VALUES ('missing')`), (error: { code?: string }) => error.code === '23503');
        await handle.query('ROLLBACK TO SAVEPOINT reference');
      });
      const reads: unknown[] = [];
      await within(
        adapterOf(),
        (handle) => store.attest(handle),
        (text, values) => {
          if (/pg_attrdef/.test(text) && Array.isArray(values)) reads.push(values[0]);
        },
      );
      assert.deepEqual(reads, [], 'the next adapter finds both stores attested');
    });

    test(`${store.label}: a statement that fails on a table that moved forgets the attestation`, async () => {
      const running = {};
      await within(running, (handle) => store.attest(handle));
      await control.query(`ALTER TABLE ${q(store.table)} RENAME TO "${pgName(store.table)}_moved"`);
      await within(running, async (handle) => {
        await handle.query('SAVEPOINT moved');
        await assert.rejects(handle.query(`SELECT 1 FROM ${q(store.table)}`), (error: { code?: string }) => error.code === '42P01');
        await handle.query('ROLLBACK TO SAVEPOINT moved');
        await assert.rejects(store.attest(handle), denied);
      });
      await undo('a moved table');
    });
  }

  /* A reporting role is commonly granted every table in `public`. The runtime tables used to sit
     there, so the grant reached them and every store refused to start; in their own schema it
     reaches only the business tables, and the stores attest as before. */
  test('a reporting role granted public and all of its tables leaves every store attesting', async () => {
    await control.query(`GRANT USAGE ON SCHEMA public TO "${OTHER_ROLE}"`);
    await control.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${OTHER_ROLE}"`);
    try {
      await within({}, (handle) => assertPostgresTenantStore(handle, owner()));
      for (const store of stores) await within({}, (handle) => store.attest(handle));
      // The same grants on the runtime schema are still refused: the store is solely this role's.
      await control.query(`GRANT USAGE ON SCHEMA mistri TO "${OTHER_ROLE}"`);
      await assert.rejects(
        within({}, (handle) => assertPostgresTenantStore(handle, owner())),
        denied,
      );
    } finally {
      await control.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${OTHER_ROLE}"`);
      await control.query(`REVOKE ALL ON SCHEMA public FROM "${OTHER_ROLE}"`);
      await control.query(`REVOKE ALL ON SCHEMA mistri FROM "${OTHER_ROLE}"`);
    }
  });

  /** Put the stores back as the migrations made them, after a drift. */
  async function undo(label: string) {
    void label;
    await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
    await control.query(`ALTER TABLE ${ITEM} DROP CONSTRAINT IF EXISTS store_fence_extra`);
    await migratePostgresTenantStore(url, owner());
    await migratePostgresTenantAdministrationJournal(url, owner());
    await migratePostgresSupportAudit(url, owner(), key);
  }
});
