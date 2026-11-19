/**
 * Which tables' text keys a tenant App's store fills (`fillsKey`, engine form.ts): a tenant-owned resource whose single
 * text key nothing in the catalog fills and that its `address` does not name, since an address is a key a person types
 * and reads. Set where the App's catalog is built for a tenant deployment (tenantEnrollment.ts) and where `mistri check`
 * judges a form, so the New form, the check and the writer all read one answer.
 */
import { fillableKey } from '@mistriwork/engine/shared/form.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from './app.js';

function fillsKeyOf(table: TableMeta, resource: { readonly owner?: string; readonly address?: string } | undefined): boolean {
  if (resource?.owner !== 'tenant') return false;
  const key = fillableKey(table);
  return key !== null && resource.address !== key;
}

/** The table, marked where its store fills its key. */
export function withFillsKey(table: TableMeta, resource: Parameters<typeof fillsKeyOf>[1]): TableMeta {
  return fillsKeyOf(table, resource) ? { ...table, fillsKey: true } : table;
}

/** The catalog an App serves in a tenant deployment, each table marked where its store fills its key. */
export function withFillsKeys(app: Pick<AppDef, 'resources'>, schema: DatabaseSchema): DatabaseSchema {
  return { ...schema, tables: schema.tables.map((table) => withFillsKey(table, app.resources?.[table.id])) };
}
