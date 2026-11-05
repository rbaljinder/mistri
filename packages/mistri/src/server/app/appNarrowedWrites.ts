/**
 * Writes through a narrowed resource (appNarrowed.ts), kept inside its query. The resource layer (appResources.ts)
 * hands every write that names one here, on every door: a record save, a command's `tx`, an import, the App's API
 * and MCP, an action or a machine's step all reach the database through it.
 *
 * - An insert takes the query's equalities: `kind = order` sets `kind` to `order` on the new row. A value the
 *   request gives that contradicts one is refused, and a query that is not plain equalities (an `in`, a range, an
 *   `or`) cannot say what a new row holds, so it takes none.
 * - An update or a delete finds its row by its key and the query, locked first, so no other writer can move it
 *   between the look and the write: a row outside the query is answered as a key nothing holds is. An update may
 *   not leave it: an equality it contradicts is refused before the write, and the row is read again after it, on
 *   the query, inside the same transaction, so any other condition the new values break rolls the write back.
 *
 * Every check runs in the write's own transaction, beside it: the facade's writes outside one are run in one here.
 */
import {
  Refusal,
  WriteConflict,
  type DeleteRequest,
  type InsertRequest,
  type TellRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { Filter } from '@mistriwork/engine/shared/filter.js';

type Value = string | number | boolean | null;

/**
 * A write a narrowed resource's query does not allow, said in its own sentence. A Refusal, so the record routes say it
 * as they say any; its own class, so a command says it as `ineligible_state` with that sentence
 * (businessCommandExecution.ts), never as a retry that could not succeed.
 */
export class NarrowedRefusal extends Refusal {
  constructor(message: string) {
    super(message);
    this.name = 'NarrowedRefusal';
  }
}

/** The values a new row of a narrowed resource takes from its query: each equality of its one group, or why it has none. */
function narrowedEqualities(filter: Filter): Record<string, Value> | string {
  if (filter.groups.length !== 1) return 'its query has more than one group of conditions (an "or")';
  const values: Record<string, Value> = Object.create(null);
  for (const condition of filter.groups[0]!) {
    const { column, op, value } = condition;
    if (op !== '=' || condition.other !== undefined || value === undefined || Array.isArray(value))
      return `its query says more of "${column}" than one value`;
    if (Object.hasOwn(values, column) && String(values[column]) !== String(value))
      return `its query asks two values of "${column}", which no row holds`;
    values[column] = value;
  }
  return values;
}

/** Whether a value given for a column is the one an equality fixes, as text: a form sends `5` for a number as `"5"`. */
const same = (given: Value | undefined, fixed: Value): boolean => given !== null && given !== undefined && String(given) === String(fixed);

const keyText = (key: Record<string, string | number>) =>
  Object.entries(key)
    .map(([column, value]) => `${column} = ${JSON.stringify(value)}`)
    .join(', ');

/** The same answer the adapters give a key that matches no row, so a row outside the query is no row of the resource. */
function missing(kind: 'update' | 'delete', expected: UpdateRequest['expected']): never {
  if (kind === 'update' && expected !== undefined) throw new WriteConflict();
  throw new Refusal(
    kind === 'update'
      ? 'Refused: that key matches 0 rows, not 1. An update is only allowed when it is certain which row it changes.'
      : 'Refused: that key matches 0 rows, not 1. A delete is only allowed when it is certain which row it removes.',
  );
}

interface NarrowedTable {
  /** The resource's name, as the App and every message says it. */
  readonly resource: string;
  /** Its table, in the database's names. */
  readonly physical: string;
  readonly filter: Filter;
}

/** The query's conditions ANDed with the row's key: one row of the resource, or none. */
const onKey = (table: NarrowedTable, key: Record<string, string | number>): Filter => {
  const own = Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }));
  return { groups: table.filter.groups.map((group) => [...own, ...group]) };
};

/**
 * One transaction's writes to a narrowed resource, each in the database's names. `tx` is the physical transaction
 * (or the row-policy writer over it); its reads here are its own, so they see what its writes wrote.
 */
export function narrowedWrites(tx: WriteTransaction, table: NarrowedTable) {
  const { resource, physical } = table;
  const inside = async (key: Record<string, string | number>): Promise<boolean> =>
    (await tx.query({ table: physical, filter: onKey(table, key), columns: Object.keys(key), limit: 2, offset: 0 })).rows.length === 1;
  /* Locked before it is looked at (PostgreSQL's FOR UPDATE; SQLite's writer is the transaction's alone), so the
     row read is the one the write changes. */
  const found = async (key: Record<string, string | number>): Promise<boolean> => {
    if (tx.lockRecord) await tx.lockRecord({ table: physical, key });
    return inside(key);
  };
  /* The first equality a request's values break, said as the resource's: `"orderEvents" holds only rows where kind = "order"`. */
  const contradicted = (values: Readonly<Record<string, Value>>): { said: string; given: Value } | undefined => {
    const fixed = narrowedEqualities(table.filter);
    if (typeof fixed === 'string') return undefined;
    const column = Object.keys(fixed).find((name) => Object.hasOwn(values, name) && !same(values[name], fixed[name]));
    if (column === undefined) return undefined;
    return { said: `"${resource}" holds only rows where ${column} = ${JSON.stringify(fixed[column])}`, given: values[column]! };
  };
  return {
    async insert(request: InsertRequest) {
      const fixed = narrowedEqualities(table.filter);
      if (typeof fixed === 'string')
        throw new NarrowedRefusal(
          `"${resource}" cannot add a row: ${fixed}, so a new row's values cannot be read off it. ` +
            "Add it through its table's own resource, or give the resource a query of plain equalities.",
        );
      const contradiction = contradicted(request.values ?? {});
      if (contradiction) throw new NarrowedRefusal(`${contradiction.said}, and this row gives ${JSON.stringify(contradiction.given)}.`);
      const result = await tx.insert({ ...request, table: physical, values: { ...request.values, ...fixed } });
      /* The database's own reading of the new row: a default or a trigger may still have moved it. */
      if (!(await inside(result.key)))
        throw new NarrowedRefusal(`The new "${resource}" row (${keyText(result.key)}) is not one its query reads, so it was not added.`);
      return result;
    },
    async update(request: UpdateRequest) {
      if (!(await found(request.key))) return missing('update', request.expected);
      const contradiction = contradicted(request.values ?? {});
      if (contradiction)
        throw new NarrowedRefusal(
          `${contradiction.said}; this change gives ${JSON.stringify(contradiction.given)}, which would move the row out of it.`,
        );
      const result = await tx.update({ ...request, table: physical });
      if (!(await inside(request.key)))
        throw new NarrowedRefusal(
          `This change would move the "${resource}" row (${keyText(request.key)}) out of the rows its query reads, so it was not made. ` +
            "Change it through its table's own resource.",
        );
      return result;
    },
    async remove(request: DeleteRequest) {
      if (!(await found(request.key))) return missing('delete', undefined);
      return tx.remove({ ...request, table: physical });
    },
    async tell(request: TellRequest) {
      if (!tx.tell) throw new Refusal('This transaction cannot tell anyone about a record.');
      if (!(await inside(request.key))) throw new NarrowedRefusal(`"${resource}" has no row ${keyText(request.key)}.`);
      return tx.tell({ ...request, table: physical });
    },
  };
}
