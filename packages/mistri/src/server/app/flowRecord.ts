/**
 * What a flow's rows may say about the record they run on (appFlows.ts),
 * judged against the catalog: its stored columns, its date columns, whether
 * a condition reads, and whom a notify step may tell. A condition is held to what a command's own
 * read can answer in its transaction — the record's stored columns, by name
 * — because that is where the run asks it (flowCommand.ts): a rollup, a
 * computed column or a path through a reference would be accepted by the
 * form and then fail every run, so the form refuses it instead.
 */
import { flowsProblem, type FlowBinding, type FlowRecordShape } from '../../shared/appFlows.js';
import type { AppDef } from '../../shared/appModel.js';
import { parseQuery } from '@mistriwork/engine/shared/query.js';
import { columnKind, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';

export interface ServedFlows {
  readonly resource: string;
  readonly binding: FlowBinding;
  readonly table: TableMeta;
  readonly from: TableMeta;
  readonly steps: TableMeta;
  readonly record: FlowRecordShape;
}

/** The record shape a flow's conditions, dates and `changes` are judged against. */
function flowRecordShape(app: AppDef, schema: DatabaseSchema, resource: string, table: TableMeta): FlowRecordShape {
  const derived = new Set([
    ...Object.keys(app.resources?.[resource]?.rollups ?? {}),
    ...Object.keys(app.resources?.[resource]?.computed ?? {}),
  ]);
  const stored = table.columns.filter((column) => !derived.has(column.name));
  const declared = app.resources?.[resource]?.types ?? {};
  const narrowed: DatabaseSchema = { ...schema, tables: [{ ...table, columns: stored }] };
  const audiences = new Set(
    (app.resources?.[resource]?.notify ?? []).flatMap((rule) => (typeof rule.on === 'object' && 'flow' in rule.on ? [rule.on.flow] : [])),
  );
  return Object.freeze({
    columns: new Set(stored.map((column) => column.name)),
    audiences,
    dates: new Set(
      stored.filter((column) => columnKind(column.type) === 'date' || Object.hasOwn(declared, column.name)).map((column) => column.name),
    ),
    condition(text: string): boolean {
      if (text.length > 1000) return false;
      const parsed = parseQuery(`${table.id} ${text}`, { schema: narrowed });
      if (parsed.errors.length || !parsed.query) return false;
      const { query } = parsed;
      // A filter and nothing else: a sort, a column list or a path is not a condition about this one record.
      if (query.orderBy.length || query.columns.length || query.limit !== undefined) return false;
      const groups = query.filter.groups;
      if (!groups.length) return false;
      return groups.flat().every((condition) => !condition.column.includes('.') && (!condition.other || !condition.other.includes('.')));
    },
  });
}

/** Every resource's flows this catalog can run, with the tables they read. A binding it cannot is left out: resolveResources says why. */
export function servedFlows(app: AppDef, schema: DatabaseSchema): ServedFlows[] {
  const declared = (id: string) => (Object.hasOwn(app.resources ?? {}, id) ? tableNamed(schema, id) : undefined);
  return Object.entries(app.resources ?? {}).flatMap(([resource, def]) => {
    const binding = def.flows;
    const table = binding && tableNamed(schema, resource);
    if (!binding || !table) return [];
    const from = declared(binding.from),
      steps = declared(binding.steps);
    if (flowsProblem(binding, table, from, steps, def.machine?.column)) return [];
    return [Object.freeze({ resource, binding, table, from: from!, steps: steps!, record: flowRecordShape(app, schema, resource, table) })];
  });
}
