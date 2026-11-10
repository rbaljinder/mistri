/**
 * The read audit on PostgreSQL, where its cost is a writer's: a burst of
 * audited reads — a page's boot sends up to eight — shares a few writer
 * checkouts and inserts (adapters/readAudit/groupCommit.ts) instead of taking
 * one each in line with the saves, and a batch that cannot be written refuses
 * every read in it. On a database of its own.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { setDbLatency } from '../packages/engine/src/adapters/dbLatency.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/appAccess.js';
import { authorizeResources } from '../packages/mistri/src/server/app/appAccess.js';
import { appEntrypoint } from '../packages/mistri/src/server/app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { forgetReadAuditCoalescing, ReadAuditFailed, withReadRoute } from '../packages/mistri/src/server/readAudit.js';
import { withReadAuditSink } from '../packages/mistri/src/server/readAuditStore.js';
import { statementsOf } from './support/statements.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';
import { liveSkip } from './live.js';

const skip = liveSkip('postgres', process.env.TABLEWALK_TEST_PG);
const connection = 'audited-database';
const appId = 'audited-desk';
const manifest = parseAppConfig(
  {
    id: appId,
    name: 'Audited desk',
    connection,
    resources: { incident: { audit: { reads: true } } },
    auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: ['incident'] } } },
    views: { incidents: { kind: 'list', from: 'incident', label: 'Incidents' } },
    home: 'incidents',
    nav: ['incidents'],
  },
  'read audit postgres fixture',
);

async function fixture(
  run: (context: { control: Control; adapter: PostgresAdapter; read: (offset: number) => Promise<unknown> }) => Promise<void>,
) {
  const database = await uuidPostgresDatabase('read_audit_batch');
  const directory = mkdtempSync(join(tmpdir(), 'mistri-read-audit-pg-'));
  const control = await pgClient(database.url);
  const registry = new Registry();
  const releases: Array<() => void> = [];
  forgetReadAuditCoalescing();
  try {
    await control.query('CREATE TABLE incident (id integer PRIMARY KEY, name text NOT NULL)');
    await control.query(`INSERT INTO incident SELECT g, 'Incident ' || g FROM generate_series(1, 40) g`);
    await provisionStores({ postgres: database.url }, { only: ['read-audit'] });
    registry.add({ id: connection, name: 'Audited database', url: database.url, source: 'config' });
    const host = {
      app: { path: join(directory, 'app.ts'), app: manifest, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: manifest.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async () => null,
      },
    } as unknown as AppHost;
    const resources = await loadAppRuntimeResources(registry, manifest, appEntrypoint(host, registry)!, (owner) =>
      releases.push(registry.lease(owner)),
    );
    const { adapter } = await registry.open(connection);
    const access = withReadAuditSink(
      resolveAppAccess(manifest, resources.schema, ['viewer']),
      { app: appId, tenant: '', actor: 'account-viewer' },
      adapter,
      connection,
    );
    const facade = authorizeResources(resources, access);
    await run({
      control,
      adapter: adapter as PostgresAdapter,
      read: (offset) => withReadRoute('page', () => facade.adapter.query({ table: 'incident', limit: 5, offset } as never)),
    });
  } finally {
    for (const release of releases.reverse()) release();
    await registry.closeAll();
    await control.end();
    forgetReadAuditCoalescing();
    rmSync(directory, { recursive: true, force: true });
    await database.drop();
  }
}

const writerCheckouts = (adapter: PostgresAdapter) => adapter.poolStats().find((stats) => stats.role === 'write')?.checkouts ?? 0;
const auditRows = async (control: Control) =>
  Number((await control.query('SELECT count(*)::int AS n FROM mistri.read_audit_row')).rows[0].n);

test('a burst of eight audited reads takes at most four writer checkouts and inserts, not eight', { skip }, async () => {
  await fixture(async ({ control, adapter, read }) => {
    /* Warm: the first append attests the store; from then on a flush is its one INSERT. */
    await read(0);
    const before = writerCheckouts(adapter);
    /* A remote database's round trip: on a local one each insert is done before the next read is, so there is no
       line of rows to gather, and no cost to save either. */
    setDbLatency(20);
    const burst = await statementsOf(() => Promise.all(Array.from({ length: 8 }, (_, i) => read(i + 1)))).finally(() => setDbLatency(0));
    const checkouts = writerCheckouts(adapter) - before;
    const inserts = burst.statements.filter((sql) => /INSERT INTO "?mistri"?\."?read_audit_row/.test(sql)).length;
    assert.equal(await auditRows(control), 9, 'every read keeps its own row');
    /* Four readers let the eight reads through in two waves, and each wave's rows take at most the two flushes that
       may be on their way at once (READ_AUDIT_FLUSHES): four at most, and half the reads' worth. One each, eight,
       before the group commit. */
    assert.ok(checkouts <= 4, `eight audited reads took ${checkouts} writer checkouts`);
    assert.ok(inserts >= 1 && inserts <= 4, `eight audited reads sent ${inserts} inserts:\n${burst.statements.join('\n')}`);
  });
});

test('a batch that cannot be written refuses every read in it, and the next batch is written', { skip }, async () => {
  await fixture(async ({ control, read }) => {
    await read(0);
    /* A row the table refuses fails its statement, the whole batch with it: a trigger, so the store keeps its layout. */
    await control.query(`
      CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$;
      CREATE TRIGGER refuse_audit BEFORE INSERT ON mistri.read_audit_row FOR EACH ROW EXECUTE FUNCTION refuse_audit();
    `);
    const answers = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => read(i + 1)));
    for (const answer of answers) {
      assert.equal(answer.status, 'rejected');
      assert.ok((answer as PromiseRejectedResult).reason instanceof ReadAuditFailed, String((answer as PromiseRejectedResult).reason));
    }
    assert.equal(await auditRows(control), 1, 'no row of the refused batch was kept');
    await control.query('DROP TRIGGER refuse_audit ON mistri.read_audit_row');
    await read(20);
    assert.equal(await auditRows(control), 2);
  });
});
