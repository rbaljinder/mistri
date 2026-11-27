/**
 * Which tables' text keys a tenant App's store fills (`fillsKey`, engine form.ts): a tenant-owned resource whose single
 * text key nothing in the catalog fills and that its `address` does not name, since an address is a key a person types
 * and reads. Set where the App's catalog is built for a tenant deployment (tenantEnrollment.ts) and where `mistri check`
 * judges a form, so the New form, the check and the writer all read one answer.
 */
import type { TableShardPlacement } from '@mistriwork/engine/shared/shardPlan.js';
import { fillableKey } from '@mistriwork/engine/shared/form.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from './app.js';

function fillsKeyOf(
  table: TableMeta,
  resource: { readonly owner?: string; readonly address?: string; readonly placement?: TableShardPlacement } | undefined,
): boolean {
  const placement = resource?.placement;
  if (placement?.kind === 'sharded' && (placement.id === 'vbucket-int64' || placement.id === 'vbucket-ulid')) {
    const textKey = fillableKey(table);
    if (textKey !== null) return resource?.address !== textKey;
    if (placement.id === 'vbucket-int64') {
      const pk = table.columns.filter((c) => c.primaryKey);
      if (pk.length === 1) {
        const [col] = pk;
        const ok =
          col &&
          !col.identity &&
          col.default === undefined &&
          col.hasDefault !== true &&
          !col.references &&
          /^(?:bigint|int8|integer)$/i.test(col.type ?? '');
        if (ok) return resource?.address !== col.name;
      }
    }
    return false;
  }
  if (resource?.owner !== 'tenant') return false;
  const key = fillableKey(table);
  return key !== null && resource.address !== key;
}

/** The table, marked where its store fills its key. */
export function withFillsKey(table: TableMeta, resource: Parameters<typeof fillsKeyOf>[1]): TableMeta {
  return fillsKeyOf(table, resource) ? { ...table, fillsKey: true } : table;
}

/** The catalog an App serves in a tenant or sharded deployment, each table marked where its store fills its key. */
export function withFillsKeys(app: Pick<AppDef, 'resources'>, schema: DatabaseSchema): DatabaseSchema {
  return { ...schema, tables: schema.tables.map((table) => withFillsKey(table, app.resources?.[table.id])) };
}
