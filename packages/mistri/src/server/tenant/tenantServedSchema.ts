/**
 * The catalog a tenant context is served over HTTP (tenantHttp.ts): the
 * context's own captured catalog, rebuilt as plain display evidence — the
 * scope catalog stays the authority the reads are checked against — with
 * what an App's catalog carries on the ordinary host as well.
 */
import { appCatalog, servedSegments, withLabelTemplates, type AppDef } from '../../shared/app.js';
import { computedConstants } from '../../shared/appComputed.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { foldConstants, readStatementInstantFrom, type ComputedNode } from '@mistriwork/engine/shared/computed.js';
import { readsOf } from '@mistriwork/engine/shared/query.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantCapabilities } from './tenantCapabilities.js';

/** What serving reads of a context: a tenant's, the platform realm's or a support session's. */
interface ServedContext {
  readonly schema: DatabaseSchema;
  readonly capabilities?: TenantCapabilities;
  /** The reader's zone, a computed column's `today` (readerZone.ts). */
  readonly zone?: string;
}

/** The catalog a context is served: its own tables and references, each
 * record's name as this reader's catalog can say it and the rollups whose
 * child rows it reads, as the ordinary host serves them (http/source.ts). Both
 * are computed from the context's pruned catalog, so a template or a rollup
 * naming a column this reader cannot see is not served, and both compile
 * through the context's scoped relations, so they read this tenant's rows.
 * `me` is the reader a computed column's `me` means: the session's email.
 * `now` is the request's instant, not a zoned clock: the catalog zones it once
 * for a date phrase, and a computed `today` zoned twice was the wrong day. */
export function tenantServedSchema(context: ServedContext, app: AppDef, now: Date, me: string | null = null): DatabaseSchema {
  now = new Date(servedInstant(now));
  const held = heldFor(context, app);
  /* A catalog whose building reads the instant (a rollup's `now`) is never kept: it is built for its request with
     the constants folded as it goes, as it always was, rather than kept-shaped and then copied. */
  if (held.reads?.clock === 2) {
    servedBuilt++;
    return servedAfresh(context, app, now, me, false).value;
  }
  return bound(servedBase(held, context, app, now, me), app, now, me, context.zone);
}

/** The catalog kept for this context, with computed columns' constants as written (bound folds them). */
function servedBase(held: Held, context: ServedContext, app: AppDef, now: Date, me: string | null): DatabaseSchema {
  const key = (clock: 0 | 1 | 2, reader: boolean) =>
    `${clock === 1 ? computedConstants(app, now, null, context.zone).today : ''}\0${reader ? (me ?? '\u0001') : ''}`;
  if (held.reads && held.reads.clock !== 2) {
    const found = held.served.get(key(held.reads.clock, held.reads.reader));
    if (found) {
      /* Most recently used last, so the bound drops the coldest. */
      held.served.delete(key(held.reads.clock, held.reads.reader));
      held.served.set(key(held.reads.clock, held.reads.reader), found);
      return found;
    }
  }
  const built = servedAfresh(context, app, now, me, true);
  servedBuilt++;
  held.reads = { clock: built.clock, reader: built.reader };
  if (built.clock !== 2) {
    held.served.set(key(built.clock, built.reader), built.value);
    while (held.served.size > SERVED_HELD) held.served.delete(held.served.keys().next().value!);
  }
  return built.value;
}

/* A computed column's `today`, `now` and `me` are this request's (computed.ts). The kept catalog leaves them as
   written, and each request is served a copy with the day and the reader folded in the tables that say one —
   sharing every other table, column and segment with the kept one, so the copy costs a table's worth, not a
   catalog's — kept by those two, as the catalog is. A copy that reads neither is the kept catalog itself. The
   instant is never folded: it changes on every request, so a catalog it was folded into was a new object every
   time, and every cache keyed by the catalog — a list's parse, a path, the projections — missed on every request
   (a field report: a large tenant App whose deadlines say `now` copied and captured its catalog for each one). A
   statement writes it as its request's instant instead (servedInstant, below). What the copy is of is remembered
   (servedBaseOf), so what is the same for every day and reader — the metadata projection (tenantMetadata.ts) — is
   found by the kept catalog. */
interface Constants {
  /** The tables whose computed columns say the day or the reader. */
  readonly tables: ReadonlySet<string>;
  readonly day: boolean;
  readonly reader: boolean;
}
const constantsOf = new WeakMap<DatabaseSchema, Constants>();
const boundHeld = new WeakMap<DatabaseSchema, Map<string, DatabaseSchema>>();
const basesOf = new WeakMap<DatabaseSchema, DatabaseSchema>();
const BOUND_HELD = 16;
function constantsIn(base: DatabaseSchema): Constants {
  let found = constantsOf.get(base);
  if (found) return found;
  const tables = new Set<string>();
  let day = false,
    reader = false;
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    let says = false;
    const kind = (node as { k?: unknown }).k;
    if (kind === 'today') {
      says = true;
      day = true;
    } else if (kind === 'me') {
      says = true;
      reader = true;
    }
    for (const value of Object.values(node)) if (walk(value)) says = true;
    return says;
  };
  for (const table of base.tables)
    if (table.computed && Object.values(table.computed).some((computed) => walk(computed.expr))) tables.add(table.id);
  constantsOf.set(base, (found = { tables, day, reader }));
  return found;
}
function bound(base: DatabaseSchema, app: AppDef, now: Date, me: string | null, zone: string | undefined): DatabaseSchema {
  const constants = constantsIn(base);
  if (!constants.tables.size) return base;
  const values = computedConstants(app, now, me, zone);
  const key = `${constants.day ? values.today : ''}\0${constants.reader ? (me ?? '\u0001') : ''}`;
  let held = boundHeld.get(base);
  const found = held?.get(key);
  if (found) {
    held!.delete(key);
    held!.set(key, found);
    return found;
  }
  const copy = captureTenantData({
    ...base,
    tables: base.tables.map((table) =>
      constants.tables.has(table.id)
        ? {
            ...table,
            computed: Object.fromEntries(
              Object.entries(table.computed!).map(([name, computed]) => [
                name,
                { ...computed, expr: foldConstants(computed.expr as ComputedNode, values, true) },
              ]),
            ),
          }
        : table,
    ),
  });
  boundMade++;
  basesOf.set(copy, base);
  if (!held) boundHeld.set(base, (held = new Map()));
  held.set(key, copy);
  while (held.size > BOUND_HELD) held.delete(held.keys().next().value!);
  return copy;
}
let boundMade = 0;

/* The instant a request's statements write for `now` (computed.ts statementInstant): one per request, the same for
   every statement in it. A tenant HTTP request fixes it as it starts (withRequestInstant, tenantHttp.ts), so a
   catalog served anywhere in that request, and every statement written after, reads the one instant. Elsewhere —
   a notice's mail, a public page's read — serving a catalog says it for what follows from there, as folding it
   into that catalog did; never kept past the work it was said in, so no request reads another's. */
interface RequestInstant {
  readonly at: string;
  /** Said for the whole request, not by one serving of the catalog. */
  readonly fixed: boolean;
}
const requestInstant = new AsyncLocalStorage<RequestInstant>();
readStatementInstantFrom(() => requestInstant.getStore()?.at);

/** Run one request's work at one instant: every catalog it is served and every statement it writes read it. */
export function withRequestInstant<T>(at: Date, work: () => T): T {
  return requestInstant.run({ at: at.toISOString(), fixed: true }, work);
}

/** The instant this serving reads: its request's where one is fixed, else the one given, said for what follows. */
function servedInstant(now: Date): string {
  const held = requestInstant.getStore();
  if (held?.fixed) return held.at;
  const at = now.toISOString();
  requestInstant.enterWith({ at, fixed: false });
  return at;
}

/** The kept catalog a served one is a request's copy of (bound), or the catalog itself. */
export function servedBaseOf(schema: DatabaseSchema): DatabaseSchema {
  return basesOf.get(schema) ?? schema;
}

/** For tests: how many request copies of a kept catalog were made rather than found. */
export function tenantServedCopiesMade(): number {
  return boundMade;
}

/* A tenant's catalog was built afresh on every read request — its tables copied, every segment of every resource
   parsed to see whether the reader may be served it, the result copied again whole — and then fingerprinted whole
   by the metadata projection and parsed against by every list as a catalog no parse had seen: on a large App
   most of a request's CPU (a field report: 380 ms of CPU for a list's first page on half a core). It is a pure
   function of the context's captured catalog and capabilities (frozen, and the same objects on every request of
   one tenant's roles: tenantReadScope.ts keeps them), the App (another object on a reload), the reader's zone,
   and only as much of the clock and the reader as building it read (query.ts readsOf): nothing, the App's
   calendar day, or the instant — which is never kept — and the reader's email. A computed column's constants are
   not read while building: they are left as written and folded per request (bound, above), because an App whose
   SLA columns say `now` read the instant on every build, so nothing of its catalog was ever kept. So it is built
   once per all of those and kept, frozen, with them; nothing a tenant's rows say is in it. */
const SERVED_HELD = 64;
interface Held {
  /** What building this catalog read of the clock and the reader: the same for every build of the same inputs. */
  reads?: { clock: 0 | 1 | 2; reader: boolean };
  /** Each catalog built, by the day and reader it read, least recently used first. */
  readonly served: Map<string, DatabaseSchema>;
}
const NO_CAPABILITIES = Object.freeze({});
const heldServed = new WeakMap<DatabaseSchema, WeakMap<object, WeakMap<AppDef, Map<string, Held>>>>();
let servedBuilt = 0;
function heldFor(context: ServedContext, app: AppDef): Held {
  let byCapabilities = heldServed.get(context.schema);
  if (!byCapabilities) heldServed.set(context.schema, (byCapabilities = new WeakMap()));
  const capabilities = context.capabilities ?? NO_CAPABILITIES;
  let byApp = byCapabilities.get(capabilities);
  if (!byApp) byCapabilities.set(capabilities, (byApp = new WeakMap()));
  let byZone = byApp.get(app);
  if (!byZone) byApp.set(app, (byZone = new Map()));
  const zone = context.zone ?? '';
  let held = byZone.get(zone);
  if (!held) byZone.set(zone, (held = { served: new Map() }));
  return held;
}

/** For tests: how many served catalogs were built rather than found. */
export function tenantServedSchemasBuilt(): number {
  return servedBuilt;
}

function servedAfresh(context: ServedContext, app: AppDef, now: Date, me: string | null, symbolic: boolean) {
  // Use the existing reverse-relation spelling understood by resolveAggregate,
  // not a physical constraint name or another protocol-specific alias registry.
  const foreignKeys = context.schema.foreignKeys.map((fk) => ({
    name: `${fk.from.table}.${fk.from.columns.join('+')}`,
    from: fk.from,
    to: fk.to,
    ...(fk.onDelete === undefined ? {} : { onDelete: fk.onDelete }),
  }));
  if (new Set(foreignKeys.map((fk) => fk.name)).size !== foreignKeys.length) return denyTenant();
  const served: DatabaseSchema = {
    label: app.name,
    dialect: context.schema.dialect,
    readAt: context.schema.readAt,
    tables: context.schema.tables.map((table) => ({
      id: table.id,
      name: table.id,
      schema: '',
      isView: table.isView,
      insertable: context.capabilities?.resources[table.id]?.insertable ?? false,
      deletable: context.capabilities?.resources[table.id]?.deletable ?? false,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        writable: context.capabilities?.resources[table.id]?.write.includes(column.name) ?? false,
        ...(column.identity === undefined ? {} : { identity: column.identity }),
        ...(column.default === undefined ? {} : { hasDefault: true }),
        ...(column.references === undefined ? {} : { references: column.references }),
        ...(column.allowed === undefined ? {} : { allowed: column.allowed }),
        ...(column.flag ? { flag: true } : {}),
        ...(column.text === undefined ? {} : { text: column.text }),
      })),
    })),
    foreignKeys,
  };
  /* withRollups, with what the App's catalog read of the clock and the reader watched: which segments a reader is
     served depends on the catalog's names alone, never on the instant it was parsed at. */
  const read = readsOf(() => appCatalog(app, withLabelTemplates(app, served), now, me, context.zone, symbolic));
  return { value: captureTenantData(servedSegments(read.value)), clock: read.clock, reader: read.reader };
}
