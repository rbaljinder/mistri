/**
 * Narrowed resources (Preview): one table read as several resources, each standing on fixed conditions —
 * `orderEvents: { physical: 'audit_event', query: 'kind = order' }` beside `chatEvents: { physical: 'audit_event',
 * query: 'kind = conversation' }`, each its own list, record page and reverse list, and each free to say what its
 * `correlation_id` names (`references`), which the database cannot say for a column that points at one of two tables.
 *
 * The conditions are a filter, never a grant. The resource layer ANDs them into every read of the resource
 * (appResources.ts), under the table's own row policy; a row outside them is no record of the resource. A narrowed
 * resource is read-only for now: keeping a written row inside its conditions — an insert that sets them, an update
 * that may not move a row out — is the next step, and until it is taken the App says so here rather than at a write.
 *
 * What parsing alone can see is judged here; the conditions are judged against the table where the catalog is built.
 */
import type { AppDef } from './appModel.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';

/** What a narrowed resource may not declare, each a way the App would write through it. */
const WRITES = [
  ['access', 'access: "write"'],
  ['delete', 'delete'],
  ['actions', 'actions'],
  ['machine', 'a machine'],
  ['import', 'an import'],
  ['settings', 'settings'],
  ['file', 'a file'],
  ['clone', 'a clone'],
  ['consumes', 'stock it consumes'],
  ['restocks', 'stock it restocks'],
] as const;

/* What a narrowed resource may not declare because it follows the table's writes: the physical table's every write
   fires it, whatever the resource's conditions say, so a conversation's event would notify about an order. */
const ON_WRITES = [
  ['notify', 'notify'],
  ['flows', 'flows'],
  ['triggers', 'triggers'],
  ['search', 'a search pack'],
] as const;

/** The table a resource binds, as the App names it: its `physical`, else its own name. */
const tableOf = (name: string, resource: { physical?: string }) => resource.physical ?? name.slice(name.indexOf('.') + 1);

/** Refuses what a narrowed resource cannot be yet, and a table bound twice without a query. */
export function checkNarrowed(app: AppDef, where: string): void {
  const resources = app.resources ?? {};
  const narrowed = Object.entries(resources).filter(([, resource]) => resource.query !== undefined);
  if (!narrowed.length) {
    /* No query anywhere: two names for one table is the catalog's old refusal, said with the way out. */
    twice(app, where);
    return;
  }
  for (const [name, resource] of narrowed) {
    const at = `${where}: resources "${name}"`;
    if (app.auth?.rows === 'tenant')
      throw new Error(`${at} has a "query", which a tenant App does not take yet: its rows are read through tenant membership alone.`);
    for (const [key, said] of WRITES) {
      if (resource[key] === undefined) continue;
      throw new Error(
        `${at} has a "query" and ${said}. A narrowed resource is read-only for now (Preview): write through its table's own resource.`,
      );
    }
    for (const [key, said] of ON_WRITES) {
      if (resource[key] === undefined) continue;
      throw new Error(
        `${at} has a "query" and ${said}, which follow every write to its table, not only the rows its query reads. ` +
          "Declare them on the table's own resource.",
      );
    }
  }
  for (const [name, resource] of Object.entries(resources)) {
    for (const [column, reference] of Object.entries(resource.references ?? {})) {
      if (resources[reference.to]?.query === undefined) continue;
      throw new Error(
        `${where}: resources "${name}", references "${column}" points at "${reference.to}", which has a "query". ` +
          "A reference names a table's own resource; a narrowed one is read through its table's.",
      );
    }
  }
  twice(app, where);
}

/** A table bound by more than one resource: every binding but one says its query. */
function twice(app: AppDef, where: string): void {
  const plain = new Map<string, string>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (resource.query !== undefined) continue;
    const table = `${resource.source ?? ''}\u0000${tableOf(name, resource)}`;
    const first = plain.get(table);
    if (first !== undefined)
      throw new Error(
        `${where}: resources "${first}" and "${name}" both bind the table "${tableOf(name, resource)}". ` +
          'A table may be bound again only with a "query" (Preview), the conditions that resource reads, such as query: "kind = order".',
      );
    plain.set(table, name);
  }
}

/* ---------- overlapping conditions: a warning, never a refusal ---------- */

/** The values one condition admits of a column, when it is an equality or an `in`: what two queries can be told apart by. */
function admits(condition: Condition): { column: string; values: Set<string> } | undefined {
  if (condition.op === '=' && condition.value !== undefined && !Array.isArray(condition.value))
    return { column: condition.column, values: new Set([String(condition.value)]) };
  if (condition.op === 'in' && Array.isArray(condition.value))
    return { column: condition.column, values: new Set(condition.value.map(String)) };
  return undefined;
}

/** Whether two groups of conditions are proven apart: one column each pins to values the other never takes. */
function apart(a: readonly Condition[], b: readonly Condition[]): boolean {
  for (const left of a) {
    const one = admits(left);
    if (!one) continue;
    for (const right of b) {
      const other = admits(right);
      if (!other || other.column !== one.column) continue;
      if (![...one.values].some((value) => other.values.has(value))) return true;
    }
  }
  return false;
}

/**
 * The pairs of narrowed resources on one table whose conditions may both hold of a row: a row then has two
 * records, one under each. Proven apart only where an equality or an `in` on one column takes disjoint values in
 * every pair of their groups; anything else is said as a possible overlap, which `mistri check` warns of.
 */
export function narrowedOverlaps(narrowed: ReadonlyArray<{ name: string; table: string; filter: Filter }>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < narrowed.length; i++) {
    for (let j = i + 1; j < narrowed.length; j++) {
      const a = narrowed[i]!,
        b = narrowed[j]!;
      if (a.table !== b.table) continue;
      const separated = a.filter.groups.every((left) => b.filter.groups.every((right) => apart(left, right)));
      if (!separated) pairs.push([a.name, b.name]);
    }
  }
  return pairs;
}
