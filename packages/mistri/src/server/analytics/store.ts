/**
 * The behavior-analytics store: explicit, append-only, dedicated.
 *
 * Provisioned by `mistri analytics provision` with the server stopped;
 * serving only opens it and attests the layout, the binding and that the
 * database holds nothing else (it must not be the business or the identity
 * database: the AN2 rule). Events are insert-only: a trigger refuses UPDATE
 * and refuses DELETE except inside `pruneAnalyticsEvents`, which is the one
 * door retention goes through. Times are milliseconds since the epoch on both
 * engines, so the funnel's window arithmetic is one integer expression.
 *
 * The store never holds an email, an IP address, a user agent, a referrer or
 * payload text; what may reach it is decided before it is called (ingest.ts).
 */
import { openMigrationDb, quoteIdent, dialectOf, type Dialect, type MigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import { layoutRefusal } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { ensurePostgresRuntimeSchema, postgresRuntimeSchemaProblems } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import { postgresAnalyticsDdl, postgresForeignRelations, postgresQueryOf, POSTGRES_ANALYTICS_PREFIX } from './storePostgres.js';
import { sqliteAnalyticsDdl, sqliteForeignRelations, SQLITE_ANALYTICS_PREFIX } from './storeSqlite.js';

const ANALYTICS_STORE_VERSION = 1;
/** Rows one append, one read or one batch carries at most. */
const ANALYTICS_STORE_LIMITS = Object.freeze({ batch: 1000, nameBytes: 128, fieldsBytes: 4096, readBatch: 5000 });
const ANALYTICS_EVENT_KINDS = ['view', 'action', 'form', 'event', 'business'] as const;
type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];
type AnalyticsUnitKind = 'subject' | 'visitor';

/** What identifies a store to one deployment of one App. */
export interface AnalyticsBinding {
  readonly appId: string;
  readonly deploymentId: string;
}

export interface AnalyticsEventInput {
  /** Milliseconds since the epoch, UTC. */
  readonly occurredAt: number;
  readonly environment: string;
  readonly tenantId?: string | null;
  readonly kind: AnalyticsEventKind;
  readonly name: string;
  /** A form's step id (or `submit`), or an action's outcome (`ran` or `refused`). */
  readonly step?: string | null;
  readonly unitKind?: AnalyticsUnitKind | null;
  /** Opaque: a suite subject id or an AN2 visitor id. Never an email. */
  readonly unitId?: string | null;
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
  /** A business event's source id: the same event delivered twice is stored once. */
  readonly sourceEventId?: string | null;
}
export interface AnalyticsEventRow extends Required<Omit<AnalyticsEventInput, 'fields'>> {
  readonly id: number;
  readonly receivedAt: number;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

/** The store cannot be opened as the one this deployment provisioned. Says nothing more: the reason is for the operator's log. */
export class AnalyticsStoreUnavailable extends Error {
  constructor(readonly reason = 'the analytics store is not available') {
    super('The analytics store is not available.');
    this.name = 'AnalyticsStoreUnavailable';
  }
}

export interface AnalyticsStore {
  readonly dialect: Dialect;
  readonly binding: AnalyticsBinding;
  /** The quoted name of a store table, for the funnel's statement. */
  table(name: 'events' | 'sink_cursors'): string;
  /** Append events; a repeated `sourceEventId` is stored once. Returns how many rows are new. */
  append(events: readonly AnalyticsEventInput[], receivedAt?: number): Promise<number>;
  /** Up to `limit` events with an id above `after`, in id order, received at or before `settledBefore` when given. */
  readAfter(after: number, limit: number, settledBefore?: number): Promise<AnalyticsEventRow[]>;
  /** A sink's position (0 before its first delivery); creates it. */
  ensureCursor(sinkId: string, now?: number): Promise<number>;
  /** Move a sink from `from` to `to` in one transaction; false when another process already moved it. */
  advanceCursor(sinkId: string, from: number, to: number, now?: number): Promise<boolean>;
  /** A read-only statement with `?` parameters. */
  rows<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Delete events that occurred before `before` (ms) that every sink has already been given. Returns the count. */
  prune(before: number): Promise<number>;
  close(): Promise<void>;
}

const quoted = (dialect: Dialect, name: 'meta' | 'events' | 'sink_cursors' | 'prune'): string =>
  dialect === 'postgres'
    ? `${quoteIdent('postgres', RUNTIME_SCHEMA)}.${quoteIdent('postgres', `${POSTGRES_ANALYTICS_PREFIX}${name}`)}`
    : quoteIdent('sqlite', `${SQLITE_ANALYTICS_PREFIX}${name}`);

function engineOf(url: string): 'sqlite' | 'postgres' {
  const dialect = dialectOf(url);
  if (dialect === 'mysql') throw new Error('The analytics store runs on SQLite or PostgreSQL.');
  return dialect;
}

const safe = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new AnalyticsStoreUnavailable('a stored number is out of range');
  return number;
};

function normalizeBinding(input: AnalyticsBinding): AnalyticsBinding {
  for (const value of [input?.appId, input?.deploymentId]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
      throw new Error('An analytics binding needs an appId and a deploymentId of letters, digits and ._:-.');
  }
  return Object.freeze({ appId: input.appId, deploymentId: input.deploymentId });
}

async function inTransaction<T>(db: MigrationDb, work: () => Promise<T>): Promise<T> {
  await db.run(db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await work();
    await db.run('COMMIT');
    return result;
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {
      /* keep the failure */
    });
    throw error;
  }
}

/** Provision on a database that holds nothing of ours yet, and attest. Safe to repeat for the same binding. */
export async function provisionAnalyticsStore(options: { url: string; binding: AnalyticsBinding }): Promise<void> {
  const binding = normalizeBinding(options.binding);
  const dialect = engineOf(options.url);
  const db = await openMigrationDb(options.url, [], dialect === 'sqlite');
  try {
    const held = await db.all(
      dialect === 'postgres'
        ? `SELECT 1 AS found FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ? AND c.relname = ?`
        : `SELECT 1 AS found FROM sqlite_schema WHERE name = ?`,
      dialect === 'postgres' ? [RUNTIME_SCHEMA, `${POSTGRES_ANALYTICS_PREFIX}meta`] : [`${SQLITE_ANALYTICS_PREFIX}meta`],
    );
    if (!held.length) {
      const foreign = await foreignRelations(db);
      if (foreign.length)
        throw new Error(
          `The analytics store needs a database of its own; this one holds ${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', ...' : ''}.`,
        );
      await inTransaction(db, async () => {
        if (dialect === 'postgres') await ensurePostgresRuntimeSchema(postgresQueryOf(db));
        await db.script(dialect === 'postgres' ? postgresAnalyticsDdl() : sqliteAnalyticsDdl());
        await db.run(`INSERT INTO ${quoted(dialect, 'meta')} (singleton, version, app_id, deployment_id) VALUES (1, ?, ?, ?)`, [
          ANALYTICS_STORE_VERSION,
          binding.appId,
          binding.deploymentId,
        ]);
      });
    }
    await attest(db, binding);
  } finally {
    await db.close();
  }
}

const foreignRelations = (db: MigrationDb): Promise<string[]> =>
  db.dialect === 'postgres' ? postgresForeignRelations(db) : sqliteForeignRelations(db);

const COLUMNS = [
  'id',
  'occurred_at',
  'received_at',
  'environment',
  'tenant_id',
  'kind',
  'name',
  'step',
  'unit_kind',
  'unit_id',
  'fields',
  'source_event_id',
];

async function attest(db: MigrationDb, binding: AnalyticsBinding): Promise<void> {
  const dialect = db.dialect;
  let meta: Array<{ version: unknown; app_id: string; deployment_id: string }>;
  try {
    meta = await db.all(`SELECT version, app_id, deployment_id FROM ${quoted(dialect, 'meta')}`);
  } catch {
    throw new AnalyticsStoreUnavailable('no analytics store marker');
  }
  if (meta.length !== 1 || Number(meta[0].version) !== ANALYTICS_STORE_VERSION)
    throw new AnalyticsStoreUnavailable(
      layoutRefusal('The analytics store', meta.length === 1 ? meta[0].version : undefined, ANALYTICS_STORE_VERSION) ??
        'the store is not version 1',
    );
  if (meta[0].app_id !== binding.appId || meta[0].deployment_id !== binding.deploymentId)
    throw new AnalyticsStoreUnavailable('the store is bound to another deployment');
  const columns =
    dialect === 'postgres'
      ? (
          await db.all<{ name: string }>(
            `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            [RUNTIME_SCHEMA, `${POSTGRES_ANALYTICS_PREFIX}events`],
          )
        ).map((row) => row.name)
      : (await db.all<{ name: string }>(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [`${SQLITE_ANALYTICS_PREFIX}events`])).map(
          (row) => row.name,
        );
  if (columns.join() !== COLUMNS.join()) throw new AnalyticsStoreUnavailable('the events table is not the one this build provisions');
  const triggers =
    dialect === 'postgres'
      ? await db.all(
          `SELECT 1 AS found FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ? AND c.relname = ? AND NOT t.tgisinternal AND t.tgenabled = 'O'`,
          [RUNTIME_SCHEMA, `${POSTGRES_ANALYTICS_PREFIX}events`],
        )
      : await db.all(`SELECT 1 AS found FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?`, [`${SQLITE_ANALYTICS_PREFIX}events`]);
  if (triggers.length < (dialect === 'postgres' ? 1 : 2)) throw new AnalyticsStoreUnavailable('the events table is not insert-only');
  const foreign = await foreignRelations(db);
  if (foreign.length) throw new AnalyticsStoreUnavailable(`the database also holds ${foreign[0]}: the store must be dedicated`);
  if (dialect === 'postgres') {
    const problems = await postgresRuntimeSchemaProblems(postgresQueryOf(db), POSTGRES_ANALYTICS_PREFIX);
    if (problems.length) throw new AnalyticsStoreUnavailable(`the analytics store is not solely this role's: ${problems.join('; ')}`);
  }
}

/** Open a provisioned store. Attests; never changes a layout. */
export async function openAnalyticsStore(options: { url: string; binding: AnalyticsBinding }): Promise<AnalyticsStore> {
  const binding = normalizeBinding(options.binding);
  const dialect = engineOf(options.url);
  const db = await openMigrationDb(options.url, [], false).catch(() => {
    throw new AnalyticsStoreUnavailable('the database could not be opened');
  });
  try {
    await attest(db, binding);
  } catch (error) {
    await db.close();
    throw error;
  }
  /* One connection, one statement at a time. */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
  const events = quoted(dialect, 'events'),
    cursors = quoted(dialect, 'sink_cursors');
  const json = dialect === 'postgres' ? '?::jsonb' : '?';
  const store: AnalyticsStore = {
    dialect,
    binding,
    table: (name) => quoted(dialect, name),
    append: (batch, receivedAt = Date.now()) =>
      serial(async () => {
        if (batch.length > ANALYTICS_STORE_LIMITS.batch) throw new Error('Too many analytics events in one append.');
        let inserted = 0;
        await inTransaction(db, async () => {
          for (const event of batch) {
            const fields = JSON.stringify(event.fields ?? {});
            if (Buffer.byteLength(fields) > ANALYTICS_STORE_LIMITS.fieldsBytes) throw new Error('An analytics event carries too much.');
            const rows = await db.all(
              `INSERT INTO ${events} (occurred_at, received_at, environment, tenant_id, kind, name, step, unit_kind, unit_id, fields, source_event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${json}, ?) ON CONFLICT DO NOTHING RETURNING id`,
              [
                event.occurredAt,
                receivedAt,
                event.environment,
                event.tenantId ?? null,
                event.kind,
                event.name,
                event.step ?? null,
                event.unitKind ?? null,
                event.unitId ?? null,
                fields,
                event.sourceEventId ?? null,
              ],
            );
            inserted += rows.length;
          }
        });
        return inserted;
      }),
    readAfter: (after, limit, settledBefore) =>
      serial(async () => {
        const rows = await db.all<Record<string, unknown>>(
          `SELECT id, occurred_at, received_at, environment, tenant_id, kind, name, step, unit_kind, unit_id, fields, source_event_id
        FROM ${events} WHERE id > ?${settledBefore === undefined ? '' : ' AND received_at <= ?'} ORDER BY id LIMIT ?`,
          settledBefore === undefined
            ? [after, Math.min(limit, ANALYTICS_STORE_LIMITS.readBatch)]
            : [after, settledBefore, Math.min(limit, ANALYTICS_STORE_LIMITS.readBatch)],
        );
        return rows.map((row) =>
          Object.freeze({
            id: safe(row.id),
            occurredAt: safe(row.occurred_at),
            receivedAt: safe(row.received_at),
            environment: String(row.environment),
            tenantId: (row.tenant_id as string | null) ?? null,
            kind: row.kind as AnalyticsEventKind,
            name: String(row.name),
            step: (row.step as string | null) ?? null,
            unitKind: (row.unit_kind as AnalyticsUnitKind | null) ?? null,
            unitId: (row.unit_id as string | null) ?? null,
            fields: Object.freeze(
              typeof row.fields === 'string' ? JSON.parse(row.fields) : (row.fields as Record<string, string | number | boolean>),
            ),
            sourceEventId: (row.source_event_id as string | null) ?? null,
          }),
        );
      }),
    ensureCursor: (sinkId, now = Date.now()) =>
      serial(async () => {
        await db.run(`INSERT INTO ${cursors} (sink_id, after_id, updated_at) VALUES (?, 0, ?) ON CONFLICT DO NOTHING`, [sinkId, now]);
        return safe((await db.all<{ after_id: unknown }>(`SELECT after_id FROM ${cursors} WHERE sink_id = ?`, [sinkId]))[0].after_id);
      }),
    advanceCursor: (sinkId, from, to, now = Date.now()) =>
      serial(() =>
        inTransaction(db, async () => {
          if (to < from) throw new Error('A sink position only moves forward.');
          const moved = await db.all(
            `UPDATE ${cursors} SET after_id = ?, updated_at = ? WHERE sink_id = ? AND after_id = ? RETURNING sink_id`,
            [to, now, sinkId, from],
          );
          return moved.length === 1;
        }),
      ),
    rows: (sql, params = []) => serial(() => db.all(sql, [...params]) as Promise<never>),
    prune: (before) =>
      serial(() =>
        inTransaction(db, async () => {
          const [floor] = await db.all<{ floor: unknown }>(`SELECT MIN(after_id) AS floor FROM ${cursors}`);
          const limit = floor?.floor === null || floor?.floor === undefined ? null : safe(floor.floor);
          if (dialect === 'postgres') await db.run(`SELECT set_config('mistri.analytics_prune', 'on', true)`);
          else await db.run(`INSERT INTO ${quoted(dialect, 'prune')} (singleton) VALUES (1)`);
          const where = `occurred_at < ?${limit === null ? '' : ' AND id <= ?'}`,
            params = limit === null ? [before] : [before, limit];
          let gone: number;
          if (dialect === 'postgres')
            gone = safe(
              (
                await db.all<{ n: unknown }>(
                  `WITH gone AS (DELETE FROM ${events} WHERE ${where} RETURNING 1) SELECT count(*) AS n FROM gone`,
                  params,
                )
              )[0].n,
            );
          else {
            await db.run(`DELETE FROM ${events} WHERE ${where}`, params);
            gone = safe((await db.all<{ n: unknown }>('SELECT changes() AS n'))[0].n);
            await db.run(`DELETE FROM ${quoted(dialect, 'prune')}`);
          }
          return gone;
        }),
      ),
    close: () => serial(() => db.close()),
  };
  return store;
}

/** Retention: delete events that occurred before `before`, except those a configured sink has not yet been given. */
export async function pruneAnalyticsEvents(url: string, options: { binding: AnalyticsBinding; before: number | Date }): Promise<number> {
  const before = options.before instanceof Date ? options.before.getTime() : options.before;
  if (!Number.isSafeInteger(before) || before < 0) throw new Error('prune needs a time before which events are deleted.');
  const store = await openAnalyticsStore({ url, binding: options.binding });
  try {
    return await store.prune(before);
  } finally {
    await store.close();
  }
}
