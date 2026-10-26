/**
 * What has to exist first, and what comes apart in which order.
 *
 * Every foreign key is a statement about time: a row cannot point at a row
 * that is not there yet, and a row that is pointed at cannot leave before the
 * rows pointing at it. Building test data means knowing that order, and
 * deriving it by hand from a catalog is exactly the work this tool already
 * did to draw the graph.
 *
 * A topological sort, with the two things a topological sort usually leaves
 * out said out loud:
 *
 *   - **Cycles.** Two tables that point at each other have no order. Rather
 *     than picking one and pretending, the cycle is named — and where one of
 *     its edges is nullable, the way through is named too: insert with the
 *     column null, then update it once the other row exists.
 *   - **Self-references.** `work_order.parent_id → work_order` is not a
 *     cycle between tables and does not affect the order at all, but it does
 *     mean the rows inside that table have an order of their own. Reported
 *     separately, because it is a different problem with a different answer.
 *
 * Ties break alphabetically. A stable answer is worth more than a marginally
 * shorter one: an order that changes between runs makes a fixture that
 * "sometimes works", which is the failure this exists to prevent.
 */
import { findTable, type DatabaseSchema } from './schema.js';

interface Requirement {
  /** The table that must have the row already. */
  table: string;
  /** The columns pointing at it. */
  via: string[];
  /**
   * Whether every one of those columns may be null.
   *
   * A nullable reference is a requirement you can postpone: insert the row
   * without it, then update. That is the only way out of a cycle, so it is
   * worth saying even where the order came out fine.
   */
  optional: boolean;
}

interface OrderPlan {
  /** Parents first: insert in this order and no reference dangles. */
  insert: string[];
  /** Children first: the reverse, which is what teardown needs. */
  remove: string[];
  /** Per table, what must exist before it. */
  requires: Record<string, Requirement[]>;
  /** Tables whose order could not be decided, grouped by the cycle they are in. */
  cycles: string[][];
  /** Tables that point at themselves: an order *within* the table. */
  selfReferencing: string[];
}

/**
 * @param tables The tables to order. Omitted means every table in the schema.
 *   Names are resolved through `findTable`, so a bare name works where the
 *   schema qualifies it.
 */
export function insertOrder(schema: DatabaseSchema, tables?: string[]): OrderPlan {
  const wanted = tables?.length
    ? tables.map((name) => findTable(schema, name)?.id ?? name)
    : schema.tables.filter((t) => !t.isView).map((t) => t.id);
  const inSet = new Set(wanted);

  const requires: Record<string, Requirement[]> = {};
  const selfReferencing: string[] = [];
  /* `after.get(a)` holds the tables that must come *after* a — the edges of
     the sort, pointing the way an insert travels. */
  const after = new Map<string, Set<string>>(wanted.map((id) => [id, new Set<string>()]));
  const waitingOn = new Map<string, number>(wanted.map((id) => [id, 0]));

  for (const fk of schema.foreignKeys) {
    const from = fk.from.table;
    const to = fk.to.table;
    if (!inSet.has(from)) continue;
    if (from === to) {
      if (!selfReferencing.includes(from)) selfReferencing.push(from);
      continue;
    }
    /* A reference out of the set is still a requirement — the row it points
       at has to exist — but it cannot be ordered, because it is not part of
       what was asked about. It belongs in `requires` and not in the sort. */
    const columns = findTable(schema, from)?.columns ?? [];
    const optional = fk.from.columns.every((name) => columns.find((c) => c.name === name)?.nullable !== false);
    (requires[from] ??= []).push({ table: to, via: fk.from.columns, optional });
    if (!inSet.has(to)) continue;
    if (after.get(to)!.has(from)) continue;
    after.get(to)!.add(from);
    waitingOn.set(from, (waitingOn.get(from) ?? 0) + 1);
  }

  const insert: string[] = [];
  const ready = wanted.filter((id) => !waitingOn.get(id)).sort();
  while (ready.length) {
    const id = ready.shift()!;
    insert.push(id);
    /* Sorted on the way in, so the answer does not depend on the order the
       catalog happened to list the keys in. */
    for (const next of [...after.get(id)!].sort()) {
      const left = (waitingOn.get(next) ?? 0) - 1;
      waitingOn.set(next, left);
      if (left === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  /* Whatever is left is in a cycle, or behind one. Grouped so the answer
     names the knot rather than listing its members. */
  const stuck = wanted.filter((id) => !insert.includes(id));
  const cycles = groupCycles(stuck, after);

  for (const list of Object.values(requires)) {
    list.sort((a, b) => a.table.localeCompare(b.table));
  }

  return {
    insert,
    remove: [...insert].reverse(),
    requires,
    cycles,
    selfReferencing: selfReferencing.sort(),
  };
}

/**
 * The knots, as knots.
 *
 * Two tables pointing at each other and a third waiting behind them are one
 * problem with one fix, and three lines saying "could not be ordered" is
 * three problems to work out are the same one.
 */
function groupCycles(stuck: string[], after: Map<string, Set<string>>): string[][] {
  const left = new Set(stuck);
  const groups: string[][] = [];
  while (left.size) {
    const start = [...left].sort()[0];
    const group = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      for (const next of after.get(id) ?? []) {
        if (!left.has(next) || group.has(next)) continue;
        group.add(next);
        queue.push(next);
      }
      /* Both directions: a cycle is only visible if the walk can go back the
         way the arrows came. */
      for (const [other, targets] of after) {
        if (!left.has(other) || group.has(other) || !targets.has(id)) continue;
        group.add(other);
        queue.push(other);
      }
    }
    for (const id of group) left.delete(id);
    groups.push([...group].sort());
  }
  return groups;
}
