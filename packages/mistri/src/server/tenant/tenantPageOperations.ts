import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { pageAbouts, walksRelation } from '@mistriwork/engine/shared/pageModel.js';
import { resolveOf, resolvePath, type OfKeys, type PageDef } from '@mistriwork/engine/shared/page.js';
import { planPageSections } from '@mistriwork/engine/shared/pagePlans.js';
import { findTable, labelColumn, primaryKey, referencesTo, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { readHttpPolicyRecord } from '../policy/appPolicyHttp.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { readCount, DEFAULT_COUNT_LIMIT, readRecords } from '@mistriwork/engine/server/resourceReadOperations.js';
import { captureTenantData, denyTenant, TenantRequestFault } from '@mistriwork/engine/server/evidence.js';

async function rootRow(adapter: Adapter, schema: DatabaseSchema, tableId: string, key: Record<string, string | number>, wanted: string[]) {
  // One exact-key read both admits the root and supplies its plan values.
  // Looking up an accessible child never grants access to the guessed root.
  // No record this context reads has the key: a missing one and another
  // tenant's answer alike, so neither says which it was. An address from
  // another customer, pasted or followed, is the ordinary not-found, not a
  // denial of the context, which still reads all it did. A table this
  // context does not have is no record's address: that stays a denial.
  if (!findTable(schema, tableId)) return denyTenant();
  try {
    return await readHttpPolicyRecord(adapter, schema, tableId, key, wanted);
  } catch (error) {
    throw error instanceof AppAccessDenied ? new TenantRequestFault(404, 'not_found') : error;
  }
}

/** Caller must hold one genuine context across all reads and buffered release.
 * No partial result recovery: a membership/source failure invalidates the whole
 * page, not just whichever child happened to be counted when it changed. */
export async function tenantPagePlan(
  adapter: Adapter,
  schema: DatabaseSchema,
  page: PageDef,
  key: Record<string, string | number>,
  now: Date,
) {
  /* A custom section is planned like any other: its declared reads become
     views over this context's schema, which the client runs through the same
     tenant-scoped reads as every list (pagePlans.ts), and the record it is
     given is the one this scoped read admits below. */
  const ofs = pageAbouts(page);
  const resolved = ofs.map((of) => {
    const relation = resolveOf(schema, page.base, of);
    if (!relation.fk || relation.error) return denyTenant();
    return { of, fk: relation.fk };
  });
  const needed = (tableId: string, of?: string): string[] => {
    const table = findTable(schema, tableId);
    if (!table) return denyTenant();
    const columns = new Set(primaryKey(table));
    for (const section of page.sections) {
      /* Only a section that walks a path from the root needs the keys it starts from; a timeline's streams each say whose. */
      if (!walksRelation(section) || (section.kind !== 'timeline' && section.of !== of)) continue;
      // A similar list walks no path: its record's values are read with the root row.
      if (section.kind === 'list' && section.similar) continue;
      // A stream is about the record, or about the row its `about` names.
      for (const relation of section.kind === 'timeline' ? section.streams.filter((stream) => stream.of === of) : [section]) {
        const path = resolvePath(schema, relation.from, relation.path).path;
        if (!path || path.endsAt !== tableId) return denyTenant();
        for (const column of path.hops[path.hops.length - 1].to.columns) columns.add(column);
      }
    }
    return [...columns];
  };
  const valuesFor = (row: Record<string, unknown>, columns: string[]): Record<string, string | number> =>
    Object.fromEntries(
      columns.map((column) => {
        const value = row[column];
        // A nullable alternate unique key is not a relationship to every child
        // with NULL. Refuse rather than emitting an IS NULL or undefined filter.
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return denyTenant();
        return [column, value];
      }),
    );
  const rootColumns = needed(page.base);
  // A matched list's values come from this same scoped read of the record, never the request.
  const likeColumns = page.sections.flatMap((section) =>
    section.kind === 'list' && section.similar ? [...section.similar.same, ...Object.keys(section.similar.near ?? {})] : [],
  );
  const row = await rootRow(adapter, schema, page.base, key, [
    ...rootColumns,
    ...resolved.flatMap(({ fk }) => fk.from.columns),
    ...likeColumns,
  ]);
  const storedKey = valuesFor(row, rootColumns);
  const ofKeys: OfKeys = {};
  for (const { of, fk } of resolved) {
    const values = fk.from.columns.map((column) => row[column]);
    if (values.some((value) => value === null)) {
      ofKeys[of] = null;
      continue;
    }
    if (values.some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) return denyTenant();
    const target = Object.fromEntries(fk.to.columns.map((column, index) => [column, values[index] as string | number]));
    const columns = needed(fk.to.table, of);
    const { result } = await readRecords(adapter, schema, {
      table: fk.to.table,
      columns,
      filter: { groups: [fk.to.columns.map((column) => ({ column, op: '=' as const, value: target[column] }))] },
      limit: 2,
      offset: 0,
    });
    // Do not turn a hidden parent into a filter containing its guessed key.
    if (result.rows.length !== 1) return denyTenant();
    ofKeys[of] = valuesFor(result.rows[0], columns);
  }
  const plans = planPageSections(schema, page, storedKey, ofKeys, now, row);
  if (plans.some((plan) => ('error' in plan && plan.error) || (plan.kind === 'timeline' && plan.streams.some((stream) => stream.error))))
    return denyTenant();
  return captureTenantData({ page, plans });
}

export async function tenantReferences(adapter: Adapter, schema: DatabaseSchema, tableId: string, key: Record<string, string | number>) {
  const incoming = referencesTo(schema, tableId);
  const row = await rootRow(
    adapter,
    schema,
    tableId,
    key,
    incoming.flatMap((fk) => fk.to.columns),
  );
  const references = [];
  for (const fk of incoming) {
    const values = fk.to.columns.map((column) => row[column]);
    if (values.some((value) => value === null)) continue;
    if (values.some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) return denyTenant();
    const filter = {
      groups: [fk.from.columns.map((column, index) => ({ column, op: '=' as const, value: values[index] as string | number }))],
    };
    // Bounded as the ordinary host bounds a reference: "10,000+" past it.
    const { count, capped } = await readCount(adapter, schema, {
      table: fk.from.table,
      filter,
      exact: true,
      countLimit: DEFAULT_COUNT_LIMIT,
    });
    references.push({
      table: fk.from.table,
      columns: fk.from.columns,
      toColumns: fk.to.columns,
      constraint: fk.name,
      count,
      ...(capped ? { capped } : {}),
      filter,
      label: labelColumn(findTable(schema, fk.from.table)!),
    });
  }
  return captureTenantData({ table: tableId, primaryKey: primaryKey(findTable(schema, tableId)!), references });
}
