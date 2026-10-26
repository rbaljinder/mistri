/**
 * What changing a table or a column would break — asked before the change.
 *
 * The counterpart of `impact.ts`, which answers the same question about one
 * *row*. This one is about the shape: "I am about to drop `customer.id`",
 * "I want to put NOT NULL on `invoice.status`", "can this column be UNIQUE".
 *
 * It exists because that question is the one an agent writing a migration
 * cannot answer from the repository. Grep finds every mention of a column in
 * the codebase; it cannot say that 3 of 2,005 rows are null, that two tables
 * point at the column with no index leading on them, or that a delete rule
 * three tables away turns a `DROP` into a silent cascade. Those facts live in
 * the database, they are the ones that make a migration fail at the worst
 * possible moment, and tablewalk is already holding all of them.
 *
 * Everything here is a read. Nothing in this module alters anything, and the
 * tool that wraps it is annotated read-only — the point is to be the thing you
 * consult *before* reaching for DDL, which tablewalk deliberately does not do.
 *
 * Two rules it keeps:
 *
 *   - **A count without its delete rule is not an answer.** The same three
 *     rows are three deletions, three holes, or a refusal depending on it, and
 *     the same is true of a dropped column. So every dependent carries its
 *     rule, and an absent rule reads as "do not know" rather than "no action".
 *   - **"We did not look" is not "nothing".** `indexed` is absent on adapters
 *     that do not report indexes, and that stays absent all the way out rather
 *     than being flattened to `false` — advising someone their foreign key is
 *     unindexed when nobody checked is worse than saying nothing.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import {
  findTable,
  referencesFrom,
  referencesTo,
  type DatabaseSchema,
  type DeleteRule,
  type ForeignKey,
} from '@mistriwork/engine/shared/schema.js';
import { inBatches } from '@mistriwork/engine/server/impact.js';

/** One table that points at the thing being changed. */
interface Dependent {
  constraint: string;
  /** The table holding the reference — the "many" end in the usual case. */
  table: string;
  /** Its columns. */
  columns: string[];
  /** The columns of ours they point at. */
  toColumns: string[];
  onDelete?: DeleteRule;
  /**
   * Whether every referencing column may be null, and so whether those rows
   * can survive the thing they point at going away.
   */
  nullable: boolean;
  /** An index leads on the referencing column. Absent means nobody looked. */
  indexed?: boolean;
  /** How many rows it holds — the blast radius, in real numbers. */
  rows?: number;
}

/** What the table being changed points at, in the other direction. */
interface Reference {
  constraint: string;
  columns: string[];
  table: string;
  toColumns: string[];
  onDelete?: DeleteRule;
}

/** The facts about one column that decide whether a change to it will take. */
interface ColumnFacts {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string;
  allowed?: string[];
  references?: { table: string; column: string };
  /** An index leads on it. Absent means the adapter does not report indexes. */
  indexed?: boolean;
  /** How many rows hold null. Only counted when the column allows null. */
  nulls?: number;
}

interface ChangeImpact {
  table: string;
  column?: string;
  rows?: number;
  columnFacts?: ColumnFacts;
  referencedBy: Dependent[];
  references: Reference[];
  /**
   * The consequences, in sentences.
   *
   * The structured fields above are what a caller should branch on; these are
   * what makes the answer usable without branching on anything. Each one names
   * the table, the number and the rule that produced it, so a reader can check
   * the claim against the fields rather than trusting the prose.
   */
  notes: string[];
}

/**
 * Read the facts, then say what they mean.
 *
 * `column` narrows the question: without it this is "what depends on this
 * table", with it "what depends on this column" — which is the narrower and
 * far more common migration. A named column that no foreign key touches still
 * gets its own facts, because `NOT NULL` and `UNIQUE` are changes that break
 * on the data rather than on the graph.
 */
export async function changeImpact(adapter: Adapter, schema: DatabaseSchema, tableId: string, column?: string): Promise<ChangeImpact> {
  const table = findTable(schema, tableId);
  if (!table) {
    throw new Error(`No table called "${tableId}" in this database.`);
  }

  const meta = column ? table.columns.find((c) => c.name.toLowerCase() === column.toLowerCase()) : undefined;
  if (column && !meta) {
    throw new Error(`"${column}" is not a column on ${table.id}. It has: ${table.columns.map((c) => c.name).join(', ')}.`);
  }

  /* Narrowed to the named column when there is one: a foreign key pointing at
     `customer.id` is irrelevant to a change to `customer.email`, and listing
     it anyway is how a report becomes noise nobody reads to the end of. */
  const incoming = referencesTo(schema, table.id).filter(
    (fk) => !meta || fk.to.columns.some((c) => c.toLowerCase() === meta.name.toLowerCase()),
  );
  const outgoing = referencesFrom(schema, table.id).filter(
    (fk) => !meta || fk.from.columns.some((c) => c.toLowerCase() === meta.name.toLowerCase()),
  );

  /* One count per dependent table, batched. `deleteImpact` bounds its width
     for the same reason: a dozen unbounded table scans is how one question
     monopolises the connection everything else is waiting on. */
  const counts = await inBatches(incoming, 4, async (fk) => {
    try {
      return await adapter.count(fk.from.table);
    } catch {
      /* A table that cannot be counted — a permission, a view over something
         missing — must not take the rest of the report down with it. */
      return undefined;
    }
  });

  const referencedBy: Dependent[] = incoming.map((fk, i) => ({
    constraint: fk.name,
    table: fk.from.table,
    columns: fk.from.columns,
    toColumns: fk.to.columns,
    onDelete: fk.onDelete,
    nullable: nullableRef(schema, fk),
    indexed: indexedRef(schema, fk),
    rows: counts[i],
  }));

  const references: Reference[] = outgoing.map((fk) => ({
    constraint: fk.name,
    columns: fk.from.columns,
    table: fk.to.table,
    toColumns: fk.to.columns,
    onDelete: fk.onDelete,
  }));

  let rows: number | undefined;
  try {
    rows = await adapter.count(table.id);
  } catch {
    rows = undefined;
  }

  let columnFacts: ColumnFacts | undefined;
  if (meta) {
    /* Counted only where it can be non-zero. On a NOT NULL column the answer
       is already known, and spending a scan to be told zero is a scan the
       person waiting did not need. */
    let nulls: number | undefined;
    if (meta.nullable) {
      try {
        nulls = await adapter.count(table.id, {
          groups: [[{ column: meta.name, op: 'isNull' }]],
        });
      } catch {
        nulls = undefined;
      }
    }
    columnFacts = {
      name: meta.name,
      type: meta.type,
      nullable: meta.nullable,
      primaryKey: meta.primaryKey,
      ...(meta.default !== undefined ? { default: meta.default } : {}),
      ...(meta.allowed ? { allowed: meta.allowed } : {}),
      ...(meta.references ? { references: meta.references } : {}),
      ...(leads(schema, table.id, meta.name) === undefined ? {} : { indexed: leads(schema, table.id, meta.name) }),
      ...(nulls === undefined ? {} : { nulls }),
    };
  }

  return {
    table: table.id,
    ...(meta ? { column: meta.name } : {}),
    ...(rows === undefined ? {} : { rows }),
    ...(columnFacts ? { columnFacts } : {}),
    referencedBy,
    references,
    notes: notesFor({
      table: table.id,
      ...(meta ? { column: meta.name } : {}),
      ...(rows === undefined ? {} : { rows }),
      ...(columnFacts ? { columnFacts } : {}),
      referencedBy,
      references,
      notes: [],
    }),
  };
}

/** Does an index lead on this column? `undefined` when nobody looked. */
function leads(schema: DatabaseSchema, tableId: string, column: string): boolean | undefined {
  const table = findTable(schema, tableId);
  if (!table || table.indexed === undefined) return undefined;
  return table.indexed.some((c) => c.toLowerCase() === column.toLowerCase());
}

/** Can every referencing column hold null — so can those rows survive? */
function nullableRef(schema: DatabaseSchema, fk: ForeignKey): boolean {
  const child = findTable(schema, fk.from.table);
  if (!child) return false;
  return fk.from.columns.every((name) => {
    const col = child.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    /* A column we cannot find is not evidence that it is nullable. */
    return col ? col.nullable : false;
  });
}

/** Does an index lead on the referencing side? `undefined` when unknown. */
function indexedRef(schema: DatabaseSchema, fk: ForeignKey): boolean | undefined {
  return leads(schema, fk.from.table, fk.from.columns[0]);
}

/**
 * Turn the facts into the sentences somebody would write after reading them.
 *
 * Ordered by how much they change the plan: what refuses the change outright,
 * then what silently destroys data, then what will merely be slow.
 */
function notesFor(impact: ChangeImpact): string[] {
  const notes: string[] = [];
  const { columnFacts: col, referencedBy, references, rows } = impact;
  const what = impact.column ? `${impact.table}.${impact.column}` : impact.table;

  if (col?.primaryKey) {
    notes.push(
      `${what} is part of the primary key` +
        (referencedBy.length ? `, and ${referencedBy.length} table${referencedBy.length === 1 ? '' : 's'} reference it.` : '.'),
    );
  }

  /* The change that fails on the data rather than on the graph, and the most
     common one to get wrong: the column is full of nulls and the migration
     that adds NOT NULL is written as though it is not. */
  if (col && col.nullable && !col.primaryKey && col.nulls !== undefined) {
    const of = rows === undefined ? '' : ` of ${rows.toLocaleString()}`;
    notes.push(
      col.nulls > 0
        ? `${col.nulls.toLocaleString()}${of} rows hold null, so NOT NULL would be refused until they ` + `are filled or given a default.`
        : `No row${of} holds null, so NOT NULL would be accepted today — nothing stops the next insert ` + `from breaking that.`,
    );
  }

  for (const dep of referencedBy) {
    const count = dep.rows === undefined ? 'an unknown number of' : dep.rows.toLocaleString();
    const held = `${count} row${dep.rows === 1 ? '' : 's'} in ${dep.table}`;
    if (dep.onDelete === 'cascade') {
      notes.push(
        `${dep.table}.${dep.columns.join(', ')} cascades: removing what it points at takes ${held} with it, ` +
          `and anything cascading from those.`,
      );
    } else if (dep.onDelete === 'set null') {
      notes.push(`${dep.table}.${dep.columns.join(', ')} is set null on delete: ${held} would survive with a hole.`);
    } else if (dep.onDelete === undefined) {
      notes.push(
        `${dep.table}.${dep.columns.join(', ')} points at ${what} and its delete rule was not reported, ` +
          `so what happens to ${held} is unknown rather than nothing.`,
      );
    } else {
      notes.push(
        `${dep.table}.${dep.columns.join(', ')} points at ${what} under \`${dep.onDelete}\`, ` +
          `so the change is refused while ${held} remain${dep.rows === 1 ? 's' : ''}.`,
      );
    }
    if (!dep.nullable) {
      notes.push(`${dep.table}.${dep.columns.join(', ')} is NOT NULL, so those rows cannot be left pointing at nothing.`);
    }
    if (dep.indexed === false) {
      notes.push(
        `No index leads on ${dep.table}.${dep.columns[0]}, so every check of this constraint scans ` +
          `${dep.rows === undefined ? 'the whole table' : `${dep.rows.toLocaleString()} rows`}.`,
      );
    }
  }

  if (col?.allowed?.length) {
    notes.push(`The database constrains it to: ${col.allowed.join(', ')}. Widening it means changing that too.`);
  }

  if (!referencedBy.length && !references.length) {
    notes.push(`Nothing in this database references ${what}, so the change is contained to ${impact.table}.`);
  }

  return notes;
}
