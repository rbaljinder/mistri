import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { createSqliteCommandJournal, migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { StoredCommandReceipt } from '../../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import { COMMAND_EVENT_TABLES, provisionSqliteCommandEventStore } from '../../packages/mistri/src/adapters/events/commandEventSchema.js';
import { provisionSqliteEventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import type { EventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import { openSqliteEventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliveryStore.js';
import type { EventDeliveryPolicy, EventDeliveryRoute } from '../../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import type { CommandEventEnvelope } from '../../packages/mistri/src/adapters/events/commandEventTypes.js';

export function eventDeliveryPolicy(eventCount = 1, scope: 'app' | 'tenant' = 'tenant'): EventDeliveryPolicy {
  const manifest = Array.from({ length: eventCount }, (_, i) => ({ name: `assignment.fact-${i}`, version: 1 }));
  return {
    source: { appId: 'publication-proof', storeId: 'publication-store', sourceId: 'business' },
    serviceId: 'disposable-publisher',
    destinationId: 'assignment-facts-v1',
    routes: [
      scope === 'tenant'
        ? { scope, tenantId: 'north', commandId: 'assign', commandVersion: 2, manifest }
        : { scope, commandId: 'assign', commandVersion: 2, manifest },
    ],
    limits: { maxAttempts: 3, leaseMs: 100, timeoutMs: 20, backoffMs: 10, maxBackoffMs: 20, maxRetained: 64, scanBatch: 8 },
  };
}

/** Storage-state proof uses the real command journal transaction: a tenant
 * route's receipts come from a tenant-bound journal, an App-scope route's
 * from one bound to the App's own event source. The separate native fixture
 * proves producer authority through native login/enrollment. */
export function eventDeliveryFixture(t: TestContext, policy = eventDeliveryPolicy(), provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-event-delivery-')),
    path = join(directory, 'source.db');
  let db = new DatabaseSync(path);
  db.exec('CREATE TABLE effects (id INTEGER PRIMARY KEY, executions INTEGER NOT NULL); INSERT INTO effects VALUES (1,0)');
  db.close();
  migrateSqliteCommandJournal(path);
  provisionSqliteCommandEventStore(path, policy.source);
  if (provision) provisionSqliteEventDeliveryStore(path, policy, { stopped: true });
  db = new DatabaseSync(path);
  const stores: EventDeliveryStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = () => {
    const store = openSqliteEventDeliveryStore(path, policy);
    stores.push(store);
    return store;
  };
  const seed = async (
    id = 'receipt-001',
    route: EventDeliveryRoute = policy.routes[0],
    provenance?: { actorId: string; changesJson: string },
  ) => {
    const actorId = provenance?.actorId ?? 'native-account-proof';
    const owner =
      route.scope === 'tenant'
        ? {
            ...policy.source,
            tenantId: route.tenantId,
            actorId,
            membershipId: 'historical-grant',
            membershipVersion: '1',
            tenantVersion: '1',
            roles: ['manager'],
            deployment: 'historical-generation',
          }
        : { scope: 'app' as const, ...policy.source };
    const receipt: StoredCommandReceipt = {
      id,
      appId: policy.source.appId,
      actorId,
      commandId: route.commandId,
      commandVersion: route.commandVersion,
      idempotencyKey: `attempt-${id}`,
      fingerprint: `fingerprint-${id}`,
      resultJson: '{"assigned":true}',
      requestId: `request-${id}`,
      completedAt: '2026-09-08T12:00:00.000Z',
    };
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('UPDATE effects SET executions=executions+1 WHERE id=1');
      await createSqliteCommandJournal(db, operations, owner).commit(
        receipt,
        { target: 'effects', keyJson: '{"id":1}', changesJson: provenance?.changesJson ?? '[{"operation":"update","resource":"effects"}]' },
        route.manifest.map((event) => ({ ...event, payloadJson: '{"assigned":true}' })),
      );
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return db
      .prepare(`SELECT envelope_json FROM "${COMMAND_EVENT_TABLES.event}" WHERE receipt_id=? ORDER BY ordinal`)
      .all(id)
      .map((row) => JSON.parse(row.envelope_json as string) as CommandEventEnvelope);
  };
  return {
    directory,
    path,
    db,
    policy,
    seed,
    open,
    executions: () => db.prepare('SELECT executions FROM effects WHERE id=1').get()!.executions,
  };
}
