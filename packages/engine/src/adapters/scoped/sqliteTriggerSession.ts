/**
 * SQLite's second look at what an accepted trigger wrote (docs/trigger-effects.md, decision 2): the proof
 * (triggerProof.ts) reaches every row an effect names before and after its statement, and this checks that the
 * database did no more. From the first write that fires an accepted trigger, a session records the transaction's
 * changes; before COMMIT its changeset is read, and every change SQLite marks indirect — made by a trigger, not by
 * the transaction's own statements — must be a row the proof reached. One that is not refuses the transaction
 * whole, so a trigger the grammar misread cannot write past it.
 *
 * A change is matched by what it did as well as by its key: an insert the proof reached is no warrant for an update
 * of a row with that key. A table's `ON CONFLICT REPLACE` turns an insert into an overwrite of the row already
 * there, which the changeset records as an update (triggerEffects.ts refuses such a table as an effect's; this
 * would still see it). A changeset folds the changes to one row into one: an insert then an update is an insert, an
 * update then a delete a delete, and a delete then an insert of the same key an update.
 *
 * A change SQLite calls direct is not always only the transaction's own: one to a row the transaction wrote itself
 * stays direct however many triggers write that row after (sqlite3session_indirect), so a trigger the proof never
 * reached could rewrite such a row unseen. After each of the transaction's own statements the witness keeps what the
 * changeset says of the row it wrote, and from then on that row's change must stay as kept unless the proof reached
 * it since: checked after every later statement and before COMMIT. What a trigger writes to that row within the very
 * statement that writes it folds into the statement's own change and is not told apart.
 *
 * A scoped delete never cascades (scopedTransaction.ts refuses one others reference), so a trigger is the only
 * source of an indirect change here. A session sees only tables with a primary key, so an effect on one without is
 * refused when it is proven.
 */
import type { DatabaseSync, Session } from 'node:sqlite';
import { recordRefusalCause } from '../../shared/refusal.js';
import type { TableMeta } from '../../shared/schema.js';
import { ScopeRefusal } from './scopedTransaction.js';
import type { TriggerChange } from './triggerProof.js';

export interface TriggerWitness {
  /** Before a statement that fires an accepted trigger: from here on, the transaction's changes are recorded. */
  watch(): void;
  /** A row the proof reached. */
  proven(change: TriggerChange): void;
  /**
   * After one of the transaction's own statements, the row it wrote: its table and primary key, and for an update the
   * values it set (a key it changed is the row's key now). Every row an earlier statement wrote is still as that
   * statement left it, or the proof reached it since, or `refuse` throws.
   */
  wrote(table: string, key: Readonly<Record<string, unknown>>, values?: Readonly<Record<string, unknown>>): void;
  /**
   * A row's key as its table stores it, read by the key a write names (or that key, where no row has it): what a
   * delete is told by, read before the row is gone. `wrote` reads the stored key itself after an insert or update.
   */
  stored(table: string, key: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  /** Before COMMIT: every indirect change is one the proof reached, and every row the transaction wrote is as it last
   * left it or reached since, or `refuse` throws. Ends the session. */
  settle(): void;
  /** Ends the session without a look: the transaction is rolling back. */
  close(): void;
}

type Value = string | number | null | undefined;

/** One change of a changeset: its table, its operation, whether a trigger made it, its primary key's values by column
 * position, and every value it records (an update's old values then its new, undefined where a column is unchanged). */
interface Change {
  readonly table: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly indirect: boolean;
  readonly key: ReadonlyMap<number, Value>;
  readonly values: readonly Value[];
}

const OPS: Record<number, Change['op']> = { 18: 'insert', 23: 'update', 9: 'delete' };

/** The changes of a changeset (sqlite.org/sessionintro.html, "changeset format"). */
export function readChangeset(bytes: Uint8Array): Change[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('utf-8', { fatal: false });
  let at = 0;
  const varint = (): number => {
    let value = 0;
    for (let i = 0; i < 9; i++) {
      const byte = bytes[at++];
      if (i === 8) return value * 256 + byte;
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    return value;
  };
  const value = (): Value => {
    const type = bytes[at++];
    switch (type) {
      case 0:
        return undefined;
      case 1: {
        const big = view.getBigInt64(at);
        at += 8;
        return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
      }
      case 2: {
        const float = view.getFloat64(at);
        at += 8;
        return float;
      }
      case 3:
      case 4: {
        const length = varint();
        const part = bytes.subarray(at, at + length);
        at += length;
        return type === 3 ? text.decode(part) : `x'${Buffer.from(part).toString('hex')}'`;
      }
      case 5:
        return null;
      default:
        throw new Error(`a changeset value of type ${type}`);
    }
  };
  const changes: Change[] = [];
  let table = '';
  let pk: number[] = [];
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x54) {
      const columns = varint();
      pk = [...bytes.subarray(at, at + columns)];
      at += columns;
      const end = bytes.indexOf(0, at);
      table = text.decode(bytes.subarray(at, end));
      at = end + 1;
      continue;
    }
    const op = OPS[marker];
    if (!op) throw new Error(`a changeset operation of ${marker}`);
    const indirect = bytes[at++] !== 0;
    const record = () => pk.map(() => value());
    const first = record();
    const second = op === 'update' ? record() : [];
    // An update's old record carries its primary key; an insert's new and a delete's old carry every column.
    const key = new Map<number, Value>();
    pk.forEach((flag, index) => flag && key.set(index, first[index]));
    changes.push({ table, op, indirect, key, values: [...first, ...second] });
  }
  return changes;
}

/** What a change did to its row, comparable: an undefined (unchanged) value is told from a null. */
const signature = (change: Change) =>
  JSON.stringify([change.op, change.values.map((value) => (value === undefined ? { unchanged: true } : value))]);

/* A key's values as the changeset says them (readChangeset): a BLOB as its `x'…'` hex, which String() said as its
   bytes' digits ("1,2"), so a row the transaction wrote by a BLOB key was never found in the changeset. */
const keyText = (columns: readonly string[], values: readonly unknown[]) =>
  JSON.stringify(
    columns
      .map((column, index) => {
        const value = values[index];
        return [
          column.toLowerCase(),
          value === null ? null : value instanceof Uint8Array ? `x'${Buffer.from(value).toString('hex')}'` : String(value),
        ] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/* Said as every row-scope refusal is (scopedTransaction.ts), the reason recorded beneath for the operator. */
const refuse = (reason: string): never => {
  throw recordRefusalCause(new ScopeRefusal('This operation is not available in the current row scope.'), reason);
};

export function sqliteTriggerWitness(db: DatabaseSync, tables: readonly TableMeta[]): TriggerWitness {
  let session: Session | undefined;
  /** Keys the proof reached, by lower-cased table and what it did to each; and the inserts it proved whose key the database assigned. */
  const reached = new Map<string, Set<string>>();
  const did = (op: Change['op'], key: string) => `${op}\u0000${key}`;
  const keyless = new Map<string, number>();
  /** Rows the proof reached since the transaction's own rows were last looked at, as `table\u0000key`. */
  let recent = new Set<string>();
  /** The transaction's own rows, as `table\u0000key`, with what the changeset said of each after the statement that wrote it last. */
  const own = new Map<string, string>();
  const columnsOf = new Map<string, string[]>();
  const tableOf = (name: string) => tables.find((table) => table.id.toLowerCase() === name.toLowerCase());
  const end = () => {
    try {
      session?.close();
    } catch {
      /* A session over a closed handle has nothing left to say. */
    }
    session = undefined;
  };
  return {
    watch() {
      session ??= db.createSession();
    },
    proven(change) {
      const table = tableOf(change.table);
      if (!table?.columns.some((column) => column.primaryKey))
        return refuse(
          `The trigger ${JSON.stringify(change.trigger)} writes "${change.table}", which has no primary key: SQLite cannot witness its rows.`,
        );
      const name = table.id.toLowerCase();
      if (!change.key) {
        keyless.set(name, (keyless.get(name) ?? 0) + 1);
        return;
      }
      const key = keyText(Object.keys(change.key), Object.values(change.key));
      const keys = reached.get(name) ?? new Set<string>();
      keys.add(did(change.kind, key));
      reached.set(name, keys);
      recent.add(`${name}\u0000${key}`);
    },
    wrote(name, key, values) {
      if (!session) return;
      const table = tableOf(name);
      if (!table) return;
      const columns = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
      const at = (named: Readonly<Record<string, unknown>>) =>
        `${table.id.toLowerCase()}\u0000${keyText(
          columns,
          columns.map((column) => named[column]),
        )}`;
      // An update that changes the key leaves the old key deleted and the new one inserted: both are its own.
      const moved = {
        ...key,
        ...Object.fromEntries(columns.filter((column) => values && column in values).map((column) => [column, values![column]])),
      };
      const written = new Set([at(storedKey(table, key)), at(storedKey(table, moved))]);
      const changes = current(session.changeset());
      ownStill(changes, written);
      for (const row of written) own.set(row, changes.get(row)?.signature ?? 'absent');
    },
    settle() {
      if (!session) return;
      const bytes = session.changeset();
      end();
      const changes = current(bytes);
      ownStill(changes);
      for (const { change, name, key } of changes.values()) {
        if (!change.indirect) continue;
        const proven = reached.get(name);
        // An update in the changeset is the proof's update, or its delete and then its insert of the same key.
        if (
          proven?.has(did(change.op, key)) ||
          (change.op === 'update' && proven?.has(did('delete', key)) && proven.has(did('insert', key)))
        )
          continue;
        const left = keyless.get(name) ?? 0;
        if (change.op === 'insert' && left > 0) {
          keyless.set(name, left - 1);
          continue;
        }
        return refuse(
          `A trigger ${change.op === 'insert' ? 'inserted' : change.op === 'update' ? 'updated' : 'deleted'} a row of "${change.table}" ` +
            "that no accepted effect reached: SQLite's session saw it, the proof did not, and nothing the transaction wrote is kept.",
        );
      }
    },
    stored(name, key) {
      const table = tableOf(name);
      return session && table ? storedKey(table, key) : key;
    },
    close: end,
  };

  /**
   * `key` as the row it names stores it, read back by the table's own comparison, or `key` where no row has it. The
   * changeset names a row by what is stored: a NOCASE key written as "ABC" is the row "abc", an INTEGER one written as
   * "1.0" the row 1, and kept under the key as sent, the transaction's own row was never found in it.
   */
  function storedKey(table: TableMeta, key: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const columns = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    const bound = columns.map((column) => key[column]);
    if (bound.some((value) => value === undefined || value === null)) return key;
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const statement = db.prepare(
      `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table.id)} WHERE ${columns.map((column) => `${quote(column)} = ?`).join(' AND ')}`,
    );
    // Read as the changeset reads them (readChangeset): an integer past 2^53 is its digits.
    statement.setReadBigInts(true);
    const rows = statement.all(...(bound as Array<string | number | bigint | Uint8Array>)) as Array<Record<string, unknown>>;
    if (rows.length !== 1) return key;
    return Object.fromEntries(
      columns.map((column) => {
        const value = rows[0][column];
        return [
          column,
          typeof value === 'bigint'
            ? value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(value)
              : value.toString()
            : value,
        ];
      }),
    );
  }

  /** A changeset's changes by `table\u0000key`, each with its lower-cased table, its key as `keyText` says it, and its signature. */
  function current(bytes: Uint8Array) {
    const result = new Map<string, { change: Change; name: string; key: string; signature: string }>();
    for (const change of readChangeset(bytes)) {
      const name = change.table.toLowerCase();
      let columns = columnsOf.get(name);
      if (!columns) {
        columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all(change.table) as { name: string }[]).map((row) => row.name);
        columnsOf.set(name, columns);
      }
      const positions = [...change.key.keys()];
      const key = keyText(
        positions.map((index) => columns[index]),
        positions.map((index) => change.key.get(index)),
      );
      result.set(`${name}\u0000${key}`, { change, name, key, signature: signature(change) });
    }
    return result;
  }

  /** Every row of the transaction's own, but those in `except`, as the statement that wrote it left it, or reached by the proof
   * since it was last looked at (and kept as it is now). */
  function ownStill(changes: ReturnType<typeof current>, except?: ReadonlySet<string>) {
    for (const [row, kept] of own) {
      if (except?.has(row)) continue;
      const now = changes.get(row)?.signature ?? 'absent';
      if (now === kept) continue;
      // The session is kept: a command that caught this refusal and went on is refused again before COMMIT.
      if (!recent.has(row))
        return refuse(
          `A trigger wrote a row of "${row.slice(0, row.indexOf('\u0000'))}" that the transaction wrote itself and no accepted effect ` +
            "reached: SQLite's session saw it, the proof did not, and nothing the transaction wrote is kept.",
        );
      own.set(row, now);
    }
    recent = new Set();
  }
}
