/**
 * The catalog a tenant context is served over HTTP (tenantHttp.ts): the
 * context's own captured catalog, rebuilt as plain display evidence — the
 * scope catalog stays the authority the reads are checked against — with
 * what an App's catalog carries on the ordinary host as well.
 */
import { withLabelTemplates, withRollups, type AppDef } from '../../shared/app.js';
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
  return captureTenantData(withRollups(app, withLabelTemplates(app, served), now, me, context.zone));
}
