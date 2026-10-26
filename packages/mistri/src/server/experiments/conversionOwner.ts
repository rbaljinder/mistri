/** Native committed-source owner for AN2. Reads the existing command journal,
 * event batches and outbox: no second event counter or implicit provisioning.
 * Completeness leases hold source write fences until result-store completion.
 */
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { createHash } from 'node:crypto';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import { canonicalCommandJson, snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../../adapters/commands/commandJournal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { COMMAND_EVENT_TABLES as events } from '../../adapters/events/commandEventSchema.js';
import type { CommandEventEnvelope } from '../../adapters/events/commandEventTypes.js';
import {
  assertSqliteEventDeliveryStore,
  EVENT_DELIVERY_TABLES as delivery,
  openEventDeliveryFile,
} from '../../adapters/events/eventDeliverySchema.js';
import { readEventDeliveryReceipt } from '../../adapters/events/eventDeliverySource.js';
import {
  captureEventDeliveryPolicy,
  EVENT_DELIVERY_HISTORY_LIMIT,
  EVENT_DELIVERY_OPEN,
  type EventDeliveryPolicy,
} from '../../adapters/events/eventDeliveryTypes.js';
import { inspectDeliveryRow, verifyDeliveryHistory, type DeliveryRow } from '../../adapters/events/eventDeliveryRules.js';
import { assertPostgresEventDeliveryStore, readPostgresEventDeliveryReceipt } from '../../adapters/events/postgresEventDeliveryStore.js';
import {
  assertEventSourceEnvelope,
  captureEventSourceEnrollment,
  sameEventSource,
  type EventSourceEnrollment,
} from '../../adapters/events/eventSourceIdentity.js';
import { parseEventPayload } from '../commands/businessEvents.js';
import {
  addTime,
  ensure,
  identifyEpoch,
  integer,
  normalizeBinding,
  normalizeReference,
  opaqueIdentifier,
  record,
  time,
  type CommitGuard,
  type ExperimentBinding,
  type RegisteredEpoch,
} from './contracts.js';
import { registeredConversionEvent, validateExperimentDeliveryPolicy, type ExperimentConversionRegistry } from './conversionRegistry.js';
import type { ExperimentOutboxOwner } from './conversionTransport.js';

export interface NativeConversionAuthorityRequest {
  readonly operation: 'observe' | 'complete';
  readonly serviceId: string;
  readonly destinationId: string;
  readonly source: EventDeliveryPolicy['source'];
  readonly epoch: RegisteredEpoch;
}
interface ExperimentConversionOwnerOptions {
  readonly binding: ExperimentBinding;
  readonly epoch: RegisteredEpoch;
  readonly registry: ExperimentConversionRegistry;
  readonly enrollment: EventSourceEnrollment;
  readonly policy: EventDeliveryPolicy;
  /** Existing native deployment/service owner. Never supplied by an event/body.
   * The returned lease must reobserve current service authority, not the user's
   * historical membership (whose provenance comes from the committed audit). */
  readonly authorize: (request: NativeConversionAuthorityRequest) => Promise<CommitGuard>;
  readonly maxReceipts?: number;
  /** Reobservation lifetime. The transport releases in finally after durable
   * COMMIT/rollback; direct native callers must likewise release every lease. */
  readonly leaseMs?: number;
  /** Deployment's bound on event-emitter clock lag/lead against its source DB.
   * No implicit zero-skew claim. It is not a completeness callback. */
  readonly maxClockSkewMs: number;
}

interface SourceLease {
  readonly dialect: 'sqlite' | 'postgres';
  readonly nowMs: number;
  query(sql: string, values?: readonly (string | number | null)[]): Promise<Record<string, unknown>[]>;
  receipt(id: string): Promise<readonly CommandEventEnvelope[]>;
  attest(): Promise<void>;
  /** Transactions not yet holding the journal tables can still append late. */
  inflight(): Promise<string>;
  assertLive(): void;
  release(): Promise<void>;
}
interface Source {
  open(): Promise<SourceLease>;
}
interface NativeExperimentConversionOwner extends ExperimentOutboxOwner {
  close(): Promise<void>;
}
const tableNames = [...Object.values(journal), ...Object.values(events), ...Object.values(delivery)].sort();
const q = (lease: SourceLease, name: string) => runtimeTable(lease.dialect, name);
const canonical = (value: unknown) => canonicalCommandJson(value, 262_144);
function numeric(value: unknown): number {
  if (typeof value === 'string') {
    ensure(/^(0|[1-9][0-9]*)$/.test(value));
    return integer(Number(value));
  }
  return integer(value);
}
function deliveryRow(row: Record<string, unknown>): DeliveryRow {
  const numericFields = [
    'ordinal',
    'attempts',
    'redrives',
    'attempt_limit',
    'next_at',
    'lease_until',
    'attempt',
    'started_at',
    'deadline',
    'finished_at',
  ];
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value !== null && numericFields.includes(key) ? numeric(value) : value]),
  );
}
function settings(options: ExperimentConversionOwnerOptions) {
  const binding = normalizeBinding(options.binding),
    epoch = identifyEpoch(binding, options.epoch.declaration),
    reference = normalizeReference(options.epoch);
  ensure(reference.key === epoch.key && reference.fingerprint === epoch.fingerprint);
  const enrollment = captureEventSourceEnrollment(options.enrollment),
    policy = captureEventDeliveryPolicy(options.policy);
  ensure(sameEventSource(enrollment.source, policy.source) && policy.source.appId === epoch.declaration.scope.appId);
  validateExperimentDeliveryPolicy(options.registry, policy, epoch, epoch.declaration.scope.evaluationTenantId);
  ensure(typeof options.authorize === 'function');
  return {
    epoch,
    reference,
    policy,
    registry: options.registry,
    authorize: options.authorize,
    maxReceipts: integer(options.maxReceipts ?? 256, 1, 4096),
    leaseMs: integer(options.leaseMs ?? 15_000, 100, 30_000),
    skew: integer(options.maxClockSkewMs, 0, 120_000),
  };
}
type Settings = ReturnType<typeof settings>;
function relevantReceipts(lease: SourceLease, config: Settings) {
  const values: (string | number | null)[] = [config.policy.source.appId];
  const parameter = (value: string | number) => {
    values.push(value);
    return `$${values.length}`;
  };
  const routes = config.policy.routes.map((route) => {
    ensure(route.scope !== 'tenants', 'One conversion owner is pinned to one evaluation scope.');
    const scope =
      route.scope === 'app'
        ? "r.store_id='' AND r.source_id='' AND r.tenant_id=''"
        : `r.store_id=${parameter(config.policy.source.storeId)} AND r.source_id=${parameter(config.policy.source.sourceId)} AND r.tenant_id=${parameter(route.tenantId)}`;
    return `((${scope}) AND r.command_id=${parameter(route.commandId)} AND r.command_version=${parameter(route.commandVersion)})`;
  });
  const starts = parameter(new Date(config.epoch.declaration.startsAtMs).toISOString());
  const ends = parameter(new Date(addTime(config.epoch.declaration.endsAtMs, config.epoch.declaration.conversionWindowMs)).toISOString());
  return {
    from: `${q(lease, journal.receipt)} r`,
    where: `r.app_id=$1 AND r.realm='tenant' AND (${routes.join(' OR ')}) AND r.completed_at>=${starts} AND r.completed_at<${ends}`,
    values,
  };
}
function assertSubject(envelope: CommandEventEnvelope): void {
  opaqueIdentifier(envelope.actorId);
  ensure(!/^(public|service):/.test(envelope.actorId), 'Public/service journal actors are not experimental subjects.');
}
async function verifyEnvelope(lease: SourceLease, config: Settings, requested: CommandEventEnvelope): Promise<CommandEventEnvelope> {
  assertEventSourceEnvelope(requested, config.policy.source);
  const batch = await lease.receipt(requested.receiptId);
  const ordinal = integer(requested.ordinal, 0, 31),
    stored = batch[ordinal];
  ensure(stored && canonical(stored) === canonical(requested), 'Event differs from the committed receipt/audit association.');
  const declared = registeredConversionEvent(config.registry, stored.name, stored.version);
  parseEventPayload(declared, stored.payloadJson);
  return stored;
}

/** The event reader already verified the immutable batch/receipt/audit
 * association. Read that same first audit, never an event payload unit field. */
async function committedUnit(lease: SourceLease, config: Settings, event: CommandEventEnvelope): Promise<string | null> {
  if (config.epoch.declaration.unit === 'subject') {
    assertSubject(event);
    return event.actorId;
  }
  ensure(event.actorId.startsWith('public:'), 'Visitor conversions require a public intake actor.');
  // The receipt row keeps each target's changes in request order; an event's are its first target's.
  const rows = await lease.query(`SELECT changes_json FROM ${q(lease, journal.receipt)} WHERE id=$1`, [event.receiptId]);
  ensure(rows.length === 1 && typeof rows[0].changes_json === 'string');
  const first: unknown = (JSON.parse(rows[0].changes_json) as unknown[])[0];
  ensure(typeof first === 'string' && Buffer.byteLength(first) <= 65_536);
  const parsed = JSON.parse(first as string);
  if (!parsed || typeof parsed !== 'object' || parsed.format !== 'mistri.visitor-audit.v1') return null;
  const audit = record(parsed, ['format', 'changes', 'visitor']),
    visitor = record(audit.visitor, ['kind', 'id']);
  ensure(visitor.kind === 'visitor');
  return opaqueIdentifier(visitor.id);
}

/** Every counted receipt is verified against the deployment's command version
 * and complete manifest, not the batch's self-description. Unexamined receipts,
 * missing/pruned delivery evidence and in-flight writers are coverage gaps.
 */
async function ledger(lease: SourceLease, config: Settings) {
  const selected = relevantReceipts(lease, config);
  const total = numeric(
    (await lease.query(`SELECT count(*) AS count FROM ${selected.from} WHERE ${selected.where}`, selected.values))[0].count,
  );
  const ids = await lease.query(
    `SELECT r.id FROM ${selected.from} WHERE ${selected.where} ORDER BY r.id LIMIT ${config.maxReceipts}`,
    selected.values,
  );
  const hash = createHash('sha256');
  hash.update(canonical({ total, reference: config.reference, policy: config.policy }));
  // Use the existing source batch position; PostgreSQL sequence allocation is
  // not commit order. The table fence plus the in-flight check below are both
  // required: MAX alone would miss an earlier transaction that commits late.
  const position = lease.dialect === 'postgres' ? 'xact_id::text' : 'rowid';
  const order = lease.dialect === 'postgres' ? 'xact_id' : 'rowid';
  // A batch is a receipt row that carries one.
  hash.update(
    canonical(
      await lease.query(
        `SELECT ${position} AS position,id AS receipt_id FROM ${q(lease, journal.receipt)} WHERE manifest_json IS NOT NULL
        ORDER BY ${order} DESC,id DESC LIMIT 1`,
      ),
    ),
  );
  // Exposure obligations and missing instrumentation are merged by the
  // results store under its epoch lock; this owner proves conversion delivery.
  let pending = 0,
    failed = 0,
    incomplete = total - ids.length;
  const metadata = await lease.query(
    `SELECT scanned_count${lease.dialect === 'postgres' ? ',cursor_xact::text AS cursor_xact' : ''}
    FROM ${q(lease, delivery.destination)} WHERE id=$1`,
    [config.policy.destinationId],
  );
  hash.update(canonical(metadata));
  for (const row of ids) {
    lease.assertLive();
    const receiptId = String(row.id),
      batch = await lease.receipt(receiptId);
    ensure(batch.length > 0);
    const marker = await lease.query(
      `SELECT event_count,pruned_at FROM ${q(lease, delivery.receipt)} WHERE destination_id=$1 AND receipt_id=$2`,
      [config.policy.destinationId, receiptId],
    );
    const rows = await lease.query(
      `SELECT * FROM ${q(lease, delivery.delivery)} WHERE destination_id=$1 AND receipt_id=$2 ORDER BY ordinal LIMIT 33`,
      [config.policy.destinationId, receiptId],
    );
    hash.update(canonical({ receiptId, batch, marker, rows }));
    if (!marker.length) {
      ensure(rows.length === 0, 'Delivery rows without discovery coverage.');
      pending += batch.length;
    } else {
      ensure(marker.length === 1 && numeric(marker[0].event_count) === batch.length, 'Incomplete destination manifest coverage.');
      // Retention intentionally removes per-event ACK/history. Its marker is
      // not enough to re-prove acceptance into this experiment database.
      if (marker[0].pruned_at !== null) {
        ensure(rows.length === 0);
        incomplete += batch.length;
      } else {
        ensure(rows.length === batch.length, 'Missing destination delivery row.');
        for (const [ordinal, saved] of rows.entries()) {
          const row = deliveryRow(saved),
            event = batch[ordinal];
          ensure(row.event_id === event.eventId && row.ordinal === ordinal && row.receipt_id === receiptId);
          inspectDeliveryRow(row);
          const history = (
            await lease.query(
              `SELECT * FROM ${q(lease, delivery.attempt)} WHERE destination_id=$1 AND event_id=$2 ORDER BY attempt LIMIT ${EVENT_DELIVERY_HISTORY_LIMIT + 1}`,
              [config.policy.destinationId, event.eventId],
            )
          ).map(deliveryRow);
          verifyDeliveryHistory(config.policy, row, history);
          hash.update(canonical(history));
          if (EVENT_DELIVERY_OPEN.includes(row.state as (typeof EVENT_DELIVERY_OPEN)[number])) pending++;
          else if (row.state === 'failed') failed++;
          else ensure(row.state === 'delivered');
        }
      }
    }
    for (const event of batch) {
      hash.update(
        canonical({
          eventId: event.eventId,
          unit: await committedUnit(lease, config, event),
        }),
      );
      parseEventPayload(registeredConversionEvent(config.registry, event.name, event.version), event.payloadJson);
      ensure(time(Date.parse(event.occurredAt)) <= lease.nowMs + config.skew, 'Source event clock exceeds deployment bound.');
    }
  }
  const inflight = await lease.inflight();
  hash.update(inflight);
  if (inflight !== '[]') incomplete++;
  return Object.freeze({
    token: hash.digest('hex'),
    delivery: Object.freeze({
      throughMs: time(lease.nowMs - config.skew),
      pending: integer(pending),
      failed: integer(failed),
      incomplete: integer(incomplete),
    }),
  });
}

async function nativeOwner(config: Settings, source: Source): Promise<NativeExperimentConversionOwner> {
  let closed = false;
  const leases = new Set<SourceLease>();
  const acquire = async () => {
    ensure(!closed && leases.size < 4, 'Conversion source owner unavailable or busy.');
    const lease = await source.open();
    if (closed || leases.size >= 4) {
      await lease.release();
      throw new Error('Conversion source owner retired.');
    }
    leases.add(lease);
    return lease;
  };
  const release = async (lease: SourceLease) => {
    try {
      await lease.release();
    } finally {
      leases.delete(lease);
    }
  };
  const authority = async (operation: NativeConversionAuthorityRequest['operation']) => {
    ensure(!closed);
    const guard = await config.authorize(
      Object.freeze({
        operation,
        serviceId: config.policy.serviceId,
        destinationId: config.policy.destinationId,
        source: config.policy.source,
        epoch: config.epoch,
      }),
    );
    ensure(typeof guard === 'function');
    await guard();
    return guard;
  };
  const initial = await acquire();
  try {
    await initial.attest();
  } finally {
    await release(initial);
  }
  return Object.freeze({
    async observeCommittedActor(input: CommandEventEnvelope) {
      const envelope = snapshot(input, 131_072).value as unknown as CommandEventEnvelope;
      const guard = await authority('observe');
      let unit: string | null | undefined;
      const verify = async () => {
        ensure(!closed);
        await guard();
        const lease = await acquire();
        try {
          await verifyEnvelope(lease, config, envelope);
          const observed = await committedUnit(lease, config, envelope);
          ensure(unit === undefined || unit === observed, 'Committed visitor provenance changed.');
          unit = observed;
          await guard();
          lease.assertLive();
        } finally {
          await release(lease);
        }
      };
      await verify();
      return Object.freeze({
        eventId: envelope.eventId,
        receiptId: envelope.receiptId,
        appId: config.epoch.declaration.scope.appId,
        environment: config.epoch.declaration.scope.environment,
        evaluationTenantId: config.epoch.declaration.scope.evaluationTenantId,
        realm: envelope.scope === 'tenant' ? ('tenant' as const) : ('app' as const),
        ...(config.epoch.declaration.unit === 'subject' ? { subjectId: unit! } : { visitorId: unit ?? null }),
        reobserve: verify,
      });
    },
    async captureCompleteness(request: Parameters<ExperimentOutboxOwner['captureCompleteness']>[0]) {
      const reference = normalizeReference(request.epoch);
      ensure(canonical(reference) === canonical(config.reference) && canonical(request.policy) === canonical(config.policy));
      const dataRevision = integer(request.dataRevision),
        guard = await authority('complete'),
        lease = await acquire();
      try {
        const captured = await ledger(lease, config);
        await guard();
        lease.assertLive();
        return Object.freeze({
          epoch: config.reference,
          destinationId: config.policy.destinationId,
          dataRevision,
          delivery: captured.delivery,
          async reobserve() {
            ensure(!closed);
            lease.assertLive();
            await guard();
            await lease.attest();
            ensure((await ledger(lease, config)).token === captured.token, 'Source watermark or destination coverage changed.');
            await guard();
            lease.assertLive();
          },
          release: () => release(lease),
        });
      } catch (error) {
        await release(lease);
        throw error;
      }
    },
    async close() {
      closed = true;
      await Promise.all([...leases].map(release));
    },
  });
}

/** File-backed native owner. BEGIN IMMEDIATE excludes every business writer,
 * including transactions that have not appended their event batch yet. */
export async function openSqliteExperimentConversionOwner(
  options: ExperimentConversionOwnerOptions & { readonly path: string },
): Promise<NativeExperimentConversionOwner> {
  const config = settings(options),
    path = options.path;
  const pinned = openEventDeliveryFile(path);
  pinned.db.close();
  return nativeOwner(config, {
    async open() {
      pinned.verifyFile();
      const file = openEventDeliveryFile(path),
        db = file.db;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try {
          if (db.isTransaction) db.exec('ROLLBACK');
        } finally {
          db.close();
        }
      };
      const deadline = performance.now() + config.leaseMs;
      const assertLive = () => {
        ensure(!released && performance.now() < deadline);
        pinned.verifyFile();
        file.verifyFile();
      };
      try {
        assertLive();
        db.exec('BEGIN IMMEDIATE');
        assertSqliteEventDeliveryStore(db, config.policy);
        const nowMs = time(Math.floor(Number(db.prepare("SELECT unixepoch('subsec')*1000 AS now").get()!.now)));
        const lease: SourceLease = {
          dialect: 'sqlite',
          nowMs,
          assertLive,
          release,
          async query(sql, values = []) {
            assertLive();
            const parameters: (string | number | null)[] = [];
            const text = sql.replace(/\$(\d+)/g, (_match, index) => {
              parameters.push(values[Number(index) - 1]);
              return '?';
            });
            return db.prepare(text).all(...parameters) as Record<string, unknown>[];
          },
          async receipt(id) {
            assertLive();
            return readEventDeliveryReceipt(db, config.policy, id);
          },
          async attest() {
            assertLive();
            assertSqliteEventDeliveryStore(db, config.policy);
          },
          async inflight() {
            assertLive();
            return '[]';
          },
        };
        // Expiry refuses reobservation; it must not asynchronously drop a source
        // fence between the final guard and the result database's COMMIT.
        return lease;
      } catch (error) {
        await release();
        throw error;
      }
    },
  });
}

interface OwnedPgClient extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}
/** Dedicated connections, never a caller's transaction. SHARE table locks span
 * results COMMIT. READ COMMITTED after lock acquisition sees writers that just
 * finished; other in-flight source transactions suppress completeness. */
export async function openPostgresExperimentConversionOwner(
  options: ExperimentConversionOwnerOptions & { readonly url: string },
): Promise<NativeExperimentConversionOwner> {
  const config = settings(options),
    url = options.url;
  ensure(typeof url === 'string' && /^postgres(ql)?:\/\//.test(url));
  return nativeOwner(config, {
    async open() {
      const module = 'pg';
      const pg = (await import(module)) as {
        Client: new (options: unknown) => OwnedPgClient;
      };
      const client = new pg.Client({
        ...pgConnectionOptions(url),
        connectionTimeoutMillis: 5000,
        query_timeout: 10_000,
        application_name: 'mistri-experiment-conversion-owner',
      });
      let released = false,
        inTransaction = false,
        failed = false;
      // A connection can fail while the results database is being contacted.
      // Retire its proof instead of letting an idle Client error escape globally.
      client.on('error', () => {
        failed = true;
      });
      const deadline = performance.now() + config.leaseMs;
      const assertLive = () =>
        ensure(!released && !failed && performance.now() < deadline, 'Source completeness lease expired or unavailable.');
      const release = async () => {
        if (released) return;
        released = true;
        try {
          if (inTransaction && !failed) await client.query('ROLLBACK');
        } finally {
          await client.end();
        }
      };
      try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        inTransaction = true;
        await client.query(
          "SET LOCAL search_path=pg_catalog,public; SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout=0",
        );
        await client.query(`LOCK TABLE ${tableNames.map((name) => runtimeTable('postgres', name)).join(', ')} IN SHARE MODE`);
        await assertPostgresEventDeliveryStore(client, config.policy);
        const nowMs = time(
          numeric((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now),
        );
        const lease: SourceLease = {
          dialect: 'postgres',
          nowMs,
          assertLive,
          release,
          async query(sql, values = []) {
            assertLive();
            return (await client.query(sql, [...values])).rows;
          },
          async receipt(id) {
            assertLive();
            return readPostgresEventDeliveryReceipt(client, config.policy, id);
          },
          async attest() {
            assertLive();
            await assertPostgresEventDeliveryStore(client, config.policy);
          },
          async inflight() {
            assertLive();
            // pg_stat_activity is cached for this transaction unless explicitly
            // refreshed; READ COMMITTED alone does not refresh statistics views.
            await client.query('SELECT pg_stat_clear_snapshot()');
            // Invisible activity from another DB role is uncertainty, not idle.
            const rows = (
              await client.query(`SELECT pid,COALESCE(xact_start::text,'unknown') AS started FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'
              AND (xact_start IS NOT NULL OR state IS NULL) ORDER BY pid`)
            ).rows;
            return canonical(rows);
          },
        };
        return lease;
      } catch (error) {
        await release();
        throw error;
      }
    },
  });
}
