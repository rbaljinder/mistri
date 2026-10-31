/**
 * The schema model every adapter produces, and the whole reason this tool
 * can exist for more than one database.
 *
 * Most database clients treat a schema as a list of tables. The interesting
 * structure is the edges: which column points at which table, and — the part
 * almost nothing surfaces well — which columns elsewhere point back at the row
 * you are looking at. Answering that second question is what turns a database
 * from a list into something you can walk.
 *
 * Relational databases hand you both directions for free. `information_schema`
 * knows every foreign key, so the reverse map is a filter over a list you
 * already have. Adapters do the dialect-specific reading; everything above
 * this file works on the model below and never learns which database it is.
 */

import { isLabelTemplate, LABEL_SEGMENT, parseLabelTemplate } from './recordLabel.js';
import type { Rollup } from './rollups.js';
import type { TagSet } from './tagLists.js';
import type { ComputedColumn } from './computed.js';

export interface ColumnMeta {
  name: string;
  /** The database's own type string, shown as-is. Normalising it loses detail. */
  type: string;
  nullable: boolean;
  /** True for the column(s) forming the primary key. */
  primaryKey: boolean;
  /** Server-projected editing affordance, never authority. Absent preserves existing behavior. */
  writable?: boolean;
  /** Server-projected: the column changes only through the App's actions
      (transitions), so editors do not offer it. Never authority. */
  changesBy?: 'actions';
  /** Set when this column references another table. */
  references?: { table: string; column: string };
  /** Declared default, if any. */
  default?: string;
  /** Public presence hint when a private schema projection omits the SQL default. */
  hasDefault?: boolean;
  /** Catalog-confirmed automatic identity assignment; absent is not a type-based guess. */
  identity?: 'always' | 'by-default';
  /**
   * The values the database will accept, when it says so — an enum type, a
   * native enum, a `CHECK (status IN (...))`.
   *
   * Absent when the column is unconstrained *or* when the adapter could not
   * read the constraint, which are not the same thing; nothing may present
   * this as "anything else is invalid".
   */
  allowed?: string[];
  /**
   * The database pins this integer to 0 and 1 (`CHECK (flag IN (0, 1))`), the
   * flag of a dialect with no boolean type: it reads as yes or no, as a
   * declared BOOLEAN does (`isFlagColumn`). The stored value stays 0 or 1.
   */
  flag?: true;
  /**
   * What the database holds a text column's length and form to: a
   * `varchar(n)`'s n as `max`, and on PostgreSQL a CHECK in the simple form
   * `char_length(col) >= n` as `min` or `col ~ '…'` as `pattern` (a whole-value
   * JavaScript pattern). Display evidence like `allowed`; an App's own `text`
   * rule wins key by key (textRules.ts). Absent where it says nothing a form can check.
   */
  text?: { min?: number; max?: number; pattern?: string };
  comment?: string;
  /**
   * An App's machine over this column (appMachine.ts), as the query language
   * reads it: `status is open` is a state that is not final, `status is
   * onBench` one of a group the machine names. Set on an App's catalog only.
   */
  states?: MachineStates;
}

/** A machine's states as a condition reads them: the open ones, the final ones, and the named groups. */
export interface MachineStates {
  open: readonly string[];
  final: readonly string[];
  groups?: Readonly<Record<string, readonly string[]>>;
}

/** One foreign-key reference a column carries, and whether the key it came
 * from has more than one column. */
export interface ColumnReferenceCandidate {
  readonly reference: { table: string; column: string };
  readonly composite: boolean;
}
export type ColumnReferenceChoice = { kind: 'one'; reference: { table: string; column: string } } | { kind: 'none' } | { kind: 'conflict' };

/**
 * The one link a reader follows from a column that sits in several keys.
 *
 * Several references on one column is ordinary schema, not a mistake: a tenant
 * table's ownership column carries its own single-column reference to the
 * tenancy profile (the framework requires exactly that) and its part in each
 * composite tenant key. So the question is never whether to accept them, only
 * which one `references` says. A single-column key is the column's own target,
 * so it wins. Two single-column keys disagreeing is the real contradiction:
 * the column claims to be two different things, and a catalog that attests a
 * write boundary refuses it. Components of composite keys that disagree name
 * no single link, so the column shows none — every edge is still in
 * `foreignKeys`, where the walk reads both directions anyway.
 *
 * Both callers read the same verdict, and they answer `conflict` differently on
 * purpose. The scoped catalogs attest a write boundary, so a contradiction
 * there refuses the whole catalog: a lease may not write through metadata it
 * cannot vouch for. The adapters' own `describe`, which reads databases this
 * tool did not design, shows the column no link and carries on — refusing
 * there would blank an entire existing database in the browser over one odd
 * pair of keys. Do not "fix" the second into the first.
 */
export function chooseColumnReference(candidates: readonly ColumnReferenceCandidate[]): ColumnReferenceChoice {
  const spelling = (reference: { table: string; column: string }) => JSON.stringify([reference.table, reference.column]);
  const own = new Map<string, { table: string; column: string }>();
  const parts = new Map<string, { table: string; column: string }>();
  for (const candidate of candidates) {
    (candidate.composite ? parts : own).set(spelling(candidate.reference), candidate.reference);
  }
  if (own.size > 1) return { kind: 'conflict' };
  for (const reference of own.values()) return { kind: 'one', reference };
  if (parts.size === 1) for (const reference of parts.values()) return { kind: 'one', reference };
  return { kind: 'none' };
}

/**
 * The columns a connection's `"hidden"` keeps from everything served over it
 * (server hiddenColumns.ts), on the table it cut them from. A symbol, so the
 * names ride along with the served catalog on the server and are never
 * written into a JSON answer: they are what lets an App's own `hidden` name a
 * column the connection already hides, rather than be told it is no column.
 */
export const CONNECTION_HIDDEN: unique symbol = Symbol('mistri.connectionHidden');

export interface TableMeta {
  /** What the connection hides of this table (CONNECTION_HIDDEN); never serialized. */
  readonly [CONNECTION_HIDDEN]?: readonly string[];
  name: string;
  /** Server-projected delete affordance, never authority; may account for hidden columns. */
  deletable?: boolean;
  /** Server capability projection; omitted retains ordinary insert behavior. */
  insertable?: boolean;
  /** Schema/namespace the table lives in. Empty when the database has none. */
  schema: string;
  /** Qualified name used everywhere as the table's identity. */
  id: string;
  columns: ColumnMeta[];
  /**
   * The engine this table is read on, where an App's catalog merges sources on
   * more than one connection (appSourceCatalog.ts). The merged catalog's own
   * `dialect` is the default source's and says nothing about another's tables.
   * Absent on a one-connection catalog, where `dialect` is every table's.
   */
  sourceDialect?: Dialect;
  /** Approximate row count when the database can give one cheaply. */
  approxRows?: number;
  /** An App's record name for this table, as a template ('PO-{id}'), where it
      serves one: what makes `$label` a path here (recordLabel.ts). */
  labelTemplate?: string;
  /** Set where that template is the key in the App's own words ('SO-{id}'),
      so a grid's key column reads as the record's name (appRecordLabels.ts). */
  keyLabel?: true;
  /** An App's rollups over the rows that point at this table, by name, where
      it serves them: numbers read like columns and never written, which is
      why they are not among `columns` (rollups.ts). */
  rollups?: Record<string, Rollup>;
  /** An App's computed columns on this table, by name, where it serves them to this reader: expressions over
      its columns, read like columns and never written, beside `columns` for the reason rollups are (computed.ts). */
  computed?: Record<string, ComputedColumn>;
  /** An App's tags on this table's records, where it serves them to this reader: read as `tags`, beside `columns`
      for the reason rollups are (tagLists.ts). */
  tags?: TagSet;
  /** An App's segments on this table (appSegments.ts): a name and the conditions it stands for, which the query
      language reads as a word (`overdue and mine`) and writes inline. Set on an App's catalog only, and served to a
      reader only where every column they name is one the reader may read. */
  segments?: Readonly<Record<string, string>>;
  comment?: string;
  /**
   * The columns the source can filter by, when it cannot filter by every one:
   * an API filters only where it documents a parameter (adapters/http).
   * Absent means any column, as for every database.
   */
  filterable?: string[];
  /**
   * The columns the source can sort by, when it cannot sort by every one: an
   * API sorts by the values it documents (adapters/http). Absent means the
   * database's own rule applies (see `indexed`).
   */
  sortable?: string[];
  /** `false` when the source reports no totals (an API): lists page without one, and nothing asks for a count. */
  countable?: false;
  /** True for views — read-only, and worth saying so rather than surprising. */
  isView: boolean;
  /** An App's union (appUnions.ts): read by asking each branch it holds, never as a table. */
  union?: import('./servedApp.js').UnionTable;
  /**
   * Columns that lead an index, primary key included.
   *
   * Only the *leading* column of each index, because that is the only one an
   * `ORDER BY` can be satisfied by: an index on `(customer_id, opened_at)`
   * makes `ORDER BY customer_id` free and `ORDER BY opened_at` a full sort.
   * Recording the whole index would invite the wrong conclusion.
   *
   * Absent rather than empty when the adapter does not report indexes, so
   * "no indexes" and "we did not look" stay distinguishable.
   */
  indexed?: string[];
  /**
   * Columns unique on their own by a constraint or a whole-table unique
   * index (not a partial or expression one): what an App's natural-key
   * address (`address:`) must be proven to be before it is accepted.
   * Absent when there are none or the adapter cannot say, and either way
   * nothing is proven.
   */
  unique?: string[];
  /**
   * Pairs of columns unique together, and by nothing more, by a constraint or
   * a whole-table unique index (`UNIQUE (tenant_id, number)`): in a tenant
   * App, a natural key unique within its tenant (appAddress.ts). Absent as
   * `unique` is: nothing proven.
   */
  uniquePairs?: Array<[string, string]>;
  /**
   * Columns a trigram index (PostgreSQL's pg_trgm, GIN or GiST) covers, at any
   * position: the only index a `contains` search (ILIKE '%x%') can use. Like
   * `indexed`, absent means the adapter did not look — only PostgreSQL does.
   */
  trigram?: string[];
}

/**
 * One foreign key edge, stored once and read in both directions.
 *
 * `from` is the side holding the column, which is the "many" end in the usual
 * case. A reverse lookup is every edge whose `to.table` is the table in hand.
 */
/** What the database does to the referencing rows when the referenced row goes. */
export type DeleteRule = 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';

export interface ForeignKey {
  name: string;
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
  /**
   * The constraint's `ON DELETE` action.
   *
   * Carried because "three rows point at this one" is not an answer to "what
   * happens if I delete it" — under `cascade` those three rows go too and so
   * may their children; under `restrict` the delete simply fails; under `set
   * null` they survive with a hole where the reference was. Three different
   * outcomes behind one number, and a tool that shows the number without the
   * rule is inviting the reader to guess which.
   *
   * Absent when the adapter does not report it, which is a "do not know" and
   * must not be read as `no action`.
   */
  onDelete?: DeleteRule;
  /**
   * An App's declared reference (`references:` on a resource): a soft key
   * the database does not know, joined like a real one within one connection.
   * Never authority: no write, cascade or delete impact reads it, and it
   * never enters a scoped catalog's fingerprint, which is the database's.
   */
  declared?: true;
  /**
   * A declared reference to a table in another source, on another
   * connection: no statement can join it, so it is read in two steps, the
   * list and then one batched read of the targets it names through the
   * target source's own scoped reads (appStitchedReads.ts). Shown and
   * followed like any reference; never filtered, sorted, grouped or rolled
   * up through.
   */
  stitched?: true;
}

/**
 * A dialect's spelling of an `ON DELETE` action, normalised.
 *
 * Each engine words these differently — SQLite in prose, Postgres as
 * a single character — and the difference is not interesting upstream. Shared
 * so the adapters cannot drift on a value the delete dialog reads
 * literally.
 *
 * Unrecognised returns undefined rather than a default: "the adapter did not
 * report it" and "the constraint says NO ACTION" lead to different advice, and
 * conflating them presents an unknown as harmless.
 */
export function deleteRuleOf(raw: unknown): DeleteRule | undefined {
  switch (
    String(raw ?? '')
      .trim()
      .toUpperCase()
  ) {
    // Postgres stores confdeltype as one character.
    case 'C':
    case 'CASCADE':
      return 'cascade';
    case 'N':
    case 'SET NULL':
      return 'set null';
    case 'D':
    case 'SET DEFAULT':
      return 'set default';
    case 'R':
    case 'RESTRICT':
      return 'restrict';
    case 'A':
    case 'NO ACTION':
      return 'no action';
    default:
      return undefined;
  }
}

export interface DatabaseSchema {
  /** What to call this connection in the UI. */
  label: string;
  /** Which adapter produced it, for dialect-specific affordances. */
  dialect: Dialect;
  tables: TableMeta[];
  foreignKeys: ForeignKey[];
  /** When this was read. Introspection is on connect, not on every request. */
  readAt: string;
}

/** `http` is an API read through its description (src/adapters/http), not a database: no SQL reaches it. */
export type Dialect = 'postgres' | 'sqlite' | 'mssql' | 'http';

/** Diagrams and exports also accept authored shapes without introspection
    metadata: the tables and keys, the rest optional. Named for what it is —
    a subset of the introspected schema — and not `SchemaShape`, which is the
    public veneer's table → columns map in packages/mistri/schema/app.d.ts. */
export type SchemaSubset = Pick<DatabaseSchema, 'tables' | 'foreignKeys'> & Partial<Pick<DatabaseSchema, 'label' | 'dialect' | 'readAt'>>;

/* ---------- derived views over the model ---------- */

/**
 * Columns elsewhere that point at this table — the "what refers to me"
 * question. Deliberately derived rather than stored, so it cannot drift from
 * the foreign key list it is computed from.
 */
/** A column of the table, or a rollup or a computed column its catalog serves (rollups.ts, computed.ts): what a measure may read. */
export function columnOrRollup(table: TableMeta, name: string): boolean {
  return (
    table.columns.some((column) => column.name === name) ||
    Boolean(table.rollups && Object.hasOwn(table.rollups, name)) ||
    Boolean(table.computed && Object.hasOwn(table.computed, name))
  );
}

export function referencesTo(schema: DatabaseSchema, tableId: string): ForeignKey[] {
  return schema.foreignKeys.filter((fk) => fk.to.table === tableId);
}

/** Columns on this table that point elsewhere. */
export function referencesFrom(schema: DatabaseSchema, tableId: string): ForeignKey[] {
  return schema.foreignKeys.filter((fk) => fk.from.table === tableId);
}

/* A frozen catalog's tables by id, made the first time one is looked up: a
   captured catalog, and those derived from it, cannot change, and startup
   looks the same few hundred tables up in one for every command, role and
   resource — by a scan, that was a large part of a large App's startup. A
   catalog that can still change (one being built) is scanned as before, and
   is never indexed, even once frozen later. The first of an id, as the scan finds it. */
const tableIndexes = new WeakMap<readonly TableMeta[], ReadonlyMap<string, TableMeta> | null>();
const fixed = (table: TableMeta) => Object.isFrozen(table) && 'value' in (Object.getOwnPropertyDescriptor(table, 'id') ?? {});

export function findTable(schema: DatabaseSchema, tableId: string): TableMeta | undefined {
  const tables = schema.tables;
  let index = tableIndexes.get(tables);
  if (index === undefined) {
    if (Object.isFrozen(tables) && tables.every(fixed)) {
      const byId = new Map<string, TableMeta>();
      for (const table of tables) if (!byId.has(table.id)) byId.set(table.id, table);
      index = byId;
    } else index = null;
    tableIndexes.set(tables, index);
  }
  return index ? index.get(tableId) : tables.find((t) => t.id === tableId);
}

/**
 * A table by its id, or by a bare name when only one table has it.
 *
 * A table's id is qualified where the engine qualifies things — `public.customer`
 * on Postgres — and nobody types that when there is
 * only one `customer`. Ambiguity is left unresolved rather than guessed: two
 * schemas with a `customer` each is exactly when picking one silently writes
 * to the wrong database.
 */
export function tableNamed(schema: DatabaseSchema, asked: string): TableMeta | undefined {
  const exact = findTable(schema, asked);
  if (exact) return exact;
  const matches = schema.tables.filter((t) => t.name === asked);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Whether a column should be treated as a date for *presentation* — offering
 * relative-date filters, rendering without a midnight time.
 *
 * Kept separate from `columnKind`, which feeds value coercion and must stay
 * strictly declaration-based: guessing wrong there would change what gets
 * written to the database. Guessing wrong here only offers a filter that does
 * not match, which the user sees immediately.
 *
 * The fallback exists because plenty of real schemas store dates in TEXT —
 * SQLite has no date type at all, so `opened_on TEXT` is idiomatic rather
 * than sloppy, and refusing to offer `last 30 days` on it would make the best
 * part of the language unavailable exactly where it is most needed.
 */
const DATE_NAME = /(^|_)(date|time|datetime|timestamp)(_|$)|_(at|on)$|^(created|updated|modified|deleted)(_|$)/i;

export function looksLikeDate(column: ColumnMeta): boolean {
  if (columnKind(column.type) === 'date') return true;
  // Only text columns get the name-based benefit of the doubt; a number named
  // `updated_at` is an epoch and comparing it to a timestamp string is wrong.
  return columnKind(column.type) === 'text' && DATE_NAME.test(column.name);
}

/**
 * The column a row is best identified by in a list or a breadcrumb.
 *
 * A primary key is correct and unreadable — nobody recognises a row by its
 * UUID. Prefer a human-meaningful column when the table has one, and say so
 * by returning the primary key only as a fallback.
 */
/* Order matters and is not arbitrary. Name-family columns come first because
   `title` on a table that also has `first_name` is a job title, not a label —
   ranking it higher labels every row in a staff list "Account Executive". */
const LABEL_CANDIDATES = [
  'name',
  'full_name',
  'display_name',
  'first_name',
  'username',
  'title',
  'label',
  'subject',
  'number',
  'email',
  'slug',
  'code',
];

/** The column that names each row by what it is called (`name`, `title`, `invoice_number`), never one picked only
    because it is text: the label of a table that has one, for a caller that must not take a guess for a name. */
export function rowName(table: TableMeta): string | undefined {
  const byName = LABEL_CANDIDATES.find((c) => table.columns.some((col) => col.name === c));
  if (byName) return byName;
  /* `number` above with its noun attached: `tracking_number`, `invoice_number`.
     It is how a person quotes the row, so it names the row before the first
     text column does, which on a shipment would be the carrier's id. */
  return table.columns.find((c) => /_number$/i.test(c.name))?.name;
}

export function labelColumn(table: TableMeta): string | undefined {
  const named = rowName(table);
  if (named) return named;
  /* A date is never a good label. Two rows created the same day are
     indistinguishable, and "2025-03-14" tells you nothing about *which*
     invoice you are looking at — the key at least identifies it. Before the
     demo declared proper date types this quietly labelled every invoice by
     its date, which looked plausible and was useless. */
  /* Nor is a column with a vocabulary. `status` is a text column and reads
     like one, but a name has to identify a row: labelling six hundred
     invoices "issued" is worse than labelling them by their key, because it
     looks like a name and distinguishes nothing. */
  /* Nor who stamped it: `received_by` reads like a name and is one, of the
     person who did something to the row — empty until they do, and the same
     on hundreds of rows after. And a column the row must have beats one it
     may leave blank: the first text column of a purchase order was a
     nullable `received_by`, and every order was named by nothing. */
  /* Nor a pointer: a text column that references another table holds that record's key, not this row's name. The
     one that mattered is a tenant table's ownership column (`tenant_id`, required and the same on every row), which
     named a list's search box and every row of a table with no name of its own. */
  const texts = table.columns.filter(
    (c) =>
      !c.primaryKey &&
      !c.references &&
      /char|text|varchar|string/i.test(c.type) &&
      !looksLikeDate(c) &&
      !c.allowed?.length &&
      !/_by$/i.test(c.name),
  );
  const firstText = texts.find((c) => !c.nullable) ?? texts[0];
  return firstText?.name ?? table.columns.find((c) => c.primaryKey)?.name;
}

/** Primary key columns, in declaration order. */
export function primaryKey(table: TableMeta): string[] {
  return table.columns.filter((c) => c.primaryKey).map((c) => c.name);
}

/* Tables that hold identities rather than things: the party-model pattern,
   where a person's name lives on `party` or `person` and everything else —
   employee, contact, supplier — points at it. Named the way labelColumn's
   candidates are, because the schema does not record "this link is 1:1" and
   the name is the signal actually present. */
const IDENTITY_TABLE = /(^|_)(party|parties|person|persons|people|user|users|profile|profiles|identity|identities)$/i;

/**
 * Where a row's name lives, as a view path.
 *
 * `labelColumn` answers "which of this table's own columns reads best", and
 * for a well-normalised table the honest answer is none of them: employee
 * carries `party_id`, and the name is `party.display_name`, one table away.
 * So when a table's best label is its own key, the question is asked one
 * forward hop further before giving up — a tool whose whole idea is walking
 * references should not call a person "30" when the walk it teaches would
 * have found the name.
 *
 * The hop is taken only across a link that is plausibly one-to-one: a
 * reference that *is* the whole primary key (the subtype pattern —
 * `person.party_id PRIMARY KEY REFERENCES party` — one-to-one by
 * construction), or a reference into an identity table. Not any reference
 * with a name on the other end: `invoice.customer_id` reaches a perfectly
 * good name that is not the invoice's — forty invoices share it, and a trail
 * of rows all called "Dry Creek Vineyards" identifies nothing.
 *
 * A table with a real label of its own keeps it, so nothing changes where
 * things already read well. Self-references are skipped: the manager's name
 * is not this row's name.
 */
export function labelPath(schema: DatabaseSchema, table: TableMeta, preferred?: string | false): string | undefined {
  /* A name the catalog computes — a template, or a column whose display rule
     masks it (appRecordLabels.ts) — is read where it is computed, even where
     the App named the column: the column itself would carry the value. */
  if (table.labelTemplate && preferred !== undefined && preferred !== false && !isLabelTemplate(preferred)) return LABEL_SEGMENT;
  // A projected false suppresses inference without revealing the unavailable path.
  if (preferred !== undefined && preferred !== false && isLabelTemplate(preferred)) {
    /* A template is computed in the statement as `$label`, where this catalog
       serves it; one that does not (a restricted projection) names the row by
       the template's first column rather than by nothing. */
    if (table.labelTemplate) return LABEL_SEGMENT;
    const parsed = parseLabelTemplate(preferred);
    return 'paths' in parsed ? parsed.paths[0] : undefined;
  }
  if (preferred !== undefined) return preferred === false ? undefined : preferred;
  // A table an App names by a template of its own (its noun and key) reads that.
  if (table.labelTemplate) return LABEL_SEGMENT;
  const own = labelColumn(table);
  const key = primaryKey(table);
  if (own && !key.includes(own)) return own;
  for (const column of table.columns) {
    const ref = column.references;
    if (!ref || ref.table === table.id) continue;
    const oneToOne = key.length === 1 && key[0] === column.name;
    const target = findTable(schema, ref.table);
    if (!target) continue;
    if (!oneToOne && !IDENTITY_TABLE.test(target.name)) continue;
    const theirs = labelColumn(target);
    if (!theirs || primaryKey(target).includes(theirs)) continue;
    return `${column.name}.${theirs}`;
  }
  return own;
}

/* ---------- ordering ---------- */

/* Text by its type name; an enum or a set is the engine's own type, which it already sorts as declared. */
const TEXT_TYPE = /char|text|string|clob|citext|^name$/i;

/**
 * The order a column's values sort in when it is not their text: the
 * vocabulary the database declares over a text column (`CHECK (stage IN
 * ('new', 'qualified', 'won', 'lost'))`), in the order it was written. A
 * pipeline sorted A → Z put "Closed lost" before "Qualification"; sorted as
 * declared it reads as the pipeline does. A native enum (Postgres) is
 * left alone, since the engine already orders it so, and free text has none.
 * Every value the column can hold is in the list or NULL, which is what lets
 * a page continue past one by naming the values after it (keysetPage.ts).
 */
export function declaredOrder(column: Pick<ColumnMeta, 'type' | 'allowed'> | undefined): readonly string[] | undefined {
  const allowed = column?.allowed;
  if (!allowed || allowed.length < 2 || !TEXT_TYPE.test(column.type) || /^\s*(enum|set)\b/i.test(column.type)) return undefined;
  return allowed;
}

export interface Order {
  column: string;
  direction: 'asc' | 'desc';
}

/* Columns that record when a row was last touched, then when it came into
   existence. Ordered by how well each answers "what has been happening here",
   which is the question a table you have just opened is usually being asked. */
const TOUCHED_NAME = /^(sys_)?(updated|modified|changed|last_updated)(_at|_on|_date)?$/i;
const CREATED_NAME = /^(sys_)?(created|inserted|added|opened|raised|issued|ordered|received|signed_up|joined)(_at|_on|_date)?$/i;

/**
 * The order a table's rows are shown in when the query does not say.
 *
 * There has to be one, and not for taste: `LIMIT`/`OFFSET` without `ORDER BY`
 * has no defined order in either SQLite or Postgres, so paging through an
 * unordered table can repeat a row on page two and never show another. The
 * database is free to hand back rows in whatever order it finds them, and
 * Postgres in particular will change its mind after an UPDATE moves a row.
 * A default order is what makes "Next" mean what it appears to mean.
 *
 * Given that it must exist, it may as well be useful. In order of preference:
 *
 *   1. When the row was last touched, newest first — *if the column is
 *      indexed*. On a table with an indexed `updated_at`, "what changed
 *      recently" is what people open it to see, and the database can answer it
 *      by walking the index backwards.
 *   2. When it was created, newest first, under the same condition.
 *   3. A single numeric primary key, descending. On an autoincrement key that
 *      is the same "newest first" by proxy.
 *   4. Any other primary key, ascending. A text key sorts alphabetically —
 *      `country` starting at ZW rather than AU would be perverse — and a
 *      composite key ascending groups its children under their parent, which
 *      is how `invoice_line` wants to be read.
 *   5. The label column, then the first column: neither is meaningful, but
 *      both are deterministic, which is the part that matters.
 *
 * The index condition is the one rule here that is not about taste. A default
 * that nobody asked for must not be a default that costs anything: `ORDER BY
 * updated_at DESC LIMIT 20` on an unindexed column is a full scan and a sort
 * of the whole table to return twenty rows, and it would happen on every table
 * you clicked. The primary key is always indexed, which is why it is the
 * fallback rather than merely one option among several.
 *
 * A table whose adapter does not report indexes at all gets the key, not a
 * guess — `indexed` is undefined rather than empty in that case precisely so
 * the two can be told apart.
 */
export function defaultOrder(table: TableMeta): Order[] {
  const indexed = new Set(table.indexed ?? []);
  const named = (test: RegExp) =>
    table.columns.find((c) => test.test(c.name) && (looksLikeDate(c) || columnKind(c.type) === 'number') && indexed.has(c.name));

  const touched = named(TOUCHED_NAME) ?? named(CREATED_NAME);
  if (touched) return withKey(table, [{ column: touched.name, direction: 'desc' }]);

  const key = primaryKey(table);
  if (key.length === 1) {
    const column = table.columns.find((c) => c.name === key[0])!;
    return [{ column: key[0], direction: columnKind(column.type) === 'number' ? 'desc' : 'asc' }];
  }
  if (key.length > 1) return key.map((column) => ({ column, direction: 'asc' as const }));

  const label = labelColumn(table);
  const fallback = label ?? table.columns[0]?.name;
  return fallback ? [{ column: fallback, direction: 'asc' }] : [];
}

/**
 * Make an order total by appending the primary key.
 *
 * Sorting by `status` leaves every row with the same status in an undefined
 * order relative to its neighbours — which is the paging bug again, one level
 * down: page one and page two disagree about which of two equal rows comes
 * first, so one is shown twice and one not at all. Appending the key breaks
 * every remaining tie the same way each time.
 *
 * A table with no primary key cannot be made stable this way, and is left
 * alone rather than given a guess.
 */
export function withKey(table: TableMeta, order: Order[]): Order[] {
  const chosen = new Set(order.map((o) => o.column));
  const key = primaryKey(table).filter((c) => !chosen.has(c));
  return [...order, ...key.map((column) => ({ column, direction: 'asc' as const }))];
}

/**
 * The order to actually run with, and whether the caller asked for it.
 *
 * `implicit` is reported rather than hidden: the grid shows which column it
 * sorted by, so a default order is something the reader can see and disagree
 * with rather than a silent rearrangement of their data.
 */
export function resolveOrder(table: TableMeta, requested: Order[] | undefined): { order: Order[]; implicit: boolean } {
  if (requested?.length) return { order: withKey(table, requested), implicit: false };
  return { order: defaultOrder(table), implicit: true };
}

/**
 * Reconstruct a table's DDL from the catalog.
 *
 * This is a *reconstruction*, and callers must say so. It is built from what
 * introspection captured — columns, types, nullability, defaults, keys — and
 * therefore omits anything the model does not carry: indexes, check
 * constraints, triggers, partitioning, storage parameters. Presenting it as
 * the definitive `CREATE TABLE` would be a lie that bites the first time
 * someone copies it into a migration.
 *
 * An adapter that can produce the database's own stored DDL should do so
 * instead; `SqliteAdapter` does, because `sqlite_master` keeps the original
 * statement text verbatim.
 */
export function renderDDL(schema: DatabaseSchema, tableId: string): string {
  const table = findTable(schema, tableId);
  if (!table) return `-- No table called "${tableId}".`;

  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
  /* A qualified name is two identifiers, not one containing a dot. Quoting
     `app.invoice_line` whole produces a table literally named "app.invoice_line",
     which is valid SQL for something that does not exist — the worst kind of
     wrong output, because it looks right until you run it. */
  const qualified = (id: string) => {
    const table = findTable(schema, id);
    return table?.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(id);
  };
  const width = Math.max(...table.columns.map((c) => c.name.length), 0);

  const lines = table.columns.map((col) => {
    const parts = [quote(col.name).padEnd(width + 2), col.type.toUpperCase()];
    if (!col.nullable) parts.push('NOT NULL');
    if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);
    return `  ${parts.join(' ')}`;
  });

  const pk = primaryKey(table);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map(quote).join(', ')})`);

  for (const fk of referencesFrom(schema, tableId)) {
    lines.push(
      `  CONSTRAINT ${quote(fk.name)} FOREIGN KEY (${fk.from.columns.map(quote).join(', ')}) ` +
        `REFERENCES ${qualified(fk.to.table)} (${fk.to.columns.map(quote).join(', ')})`,
    );
  }

  const header = table.isView
    ? `-- ${tableId} is a view. Its defining query was not captured;\n-- the columns below are what it returns.\nCREATE VIEW ${qualified(tableId)} (`
    : `CREATE TABLE ${qualified(tableId)} (`;

  const body = `${header}\n${lines.join(',\n')}\n);`;
  return table.comment ? `-- ${table.comment}\n${body}` : body;
}

/* ---------- column types ----------

   Lives here rather than beside the query language because the adapters need
   it too, and an adapter importing the query language would be a cycle: the
   language already imports the limit policy from the adapter layer. */

export type ColumnKind = 'number' | 'boolean' | 'date' | 'text' | 'other';

export function columnKind(type: string): ColumnKind {
  const t = (type ?? '').toLowerCase();
  if (/bool/.test(t)) return 'boolean';
  if (/int|serial|numeric|decimal|real|double|float|money/.test(t)) return 'number';
  if (/date|time/.test(t)) return 'date';
  if (/char|text|uuid|json|enum|clob/.test(t)) return 'text';
  return 'other';
}

/**
 * What an aggregate other than a count reads from a value of this type.
 * PostgreSQL has no sum, average, minimum, maximum or percentile of a boolean
 * ("function avg(boolean) does not exist"), where SQLite holds one as
 * 0 and 1 and add it up; read as an integer there, a won rate is the same
 * number on every engine, a computed yes-or-no or a stored one.
 */
export function aggregateInput(read: string, type: string | undefined, dialect: string | undefined): string {
  return dialect === 'postgres' && columnKind(type ?? '') === 'boolean' ? `CAST(${read} AS INTEGER)` : read;
}

/** A column that holds yes or no: declared BOOLEAN, or an integer a CHECK pins to 0 and 1. */
export function isFlagColumn(column: (Pick<ColumnMeta, 'type'> & { flag?: true }) | undefined): boolean {
  return Boolean(column) && (columnKind(column!.type) === 'boolean' || column!.flag === true);
}

/**
 * How a column holds the moment something happened, the one rule every `now`
 * the server writes follows (appStamps.ts): a DATE the App's day, a
 * TIMESTAMP or DATETIME an instant (zoned or the App's wall clock), and a text
 * column named for a moment — SQLite keeps dates as text — `_on` a day and
 * `_at` an instant, in the digits the typed column would hold. Undefined for
 * any other column, a TIME of day among them.
 */
export function momentColumn(column: Pick<ColumnMeta, 'name' | 'type'>): 'date' | 'instant' | 'instant-zoned' | undefined {
  const type = (column.type ?? '').trim();
  /* A SQLite text column the App declares a day (`types: { completed_on: 'date' }`, declaredDates.ts) reads `TEXT as date`. */
  if (/^date$|\sas date$/i.test(type)) return 'date';
  if (/timestamp|datetime/i.test(type)) return /timestamptz|with time zone/i.test(type) ? 'instant-zoned' : 'instant';
  if (!/char|text|clob/i.test(type) || /uuid|json|enum/i.test(type) || columnKind(type) !== 'text') return undefined;
  return column.name.endsWith('_on') ? 'date' : column.name.endsWith('_at') ? 'instant' : undefined;
}

/**
 * The column a state stamps as the record enters it, by its name: `ready_at`
 * (or `ready_on`) beside a `ready` state is written the moment the record
 * moves there, whatever moves it — a verb, a Save, a command — unless the
 * write says it itself. Never the machine's own column or its `since`, never a
 * key, a number or a flag.
 */
export function stateStampColumn(
  state: string,
  columns: readonly ColumnMeta[],
  machine: { column: string; since?: string },
): ColumnMeta | undefined {
  for (const suffix of ['_at', '_on']) {
    const column = columns.find((candidate) => candidate.name === `${state}${suffix}`);
    if (
      column &&
      !column.primaryKey &&
      column.name !== machine.column &&
      column.name !== machine.since &&
      !isFlagColumn(column) &&
      momentColumn(column) !== undefined
    )
      return column;
  }
  return undefined;
}

/**
 * Turn a value on its way *into* the database into the right JavaScript type
 * for its column.
 *
 * Everything typed into a text input arrives as a string, including "17901"
 * for a REAL column. SQLite's type affinity usually rescues that, but not
 * always — a column with BLOB affinity stores the characters — and Postgres
 * rejects it outright. Either way the stored value should be a number because
 * the column says so, not because the driver was forgiving.
 *
 * Unparseable input is passed through unchanged rather than coerced to NaN or
 * 0. Letting the database reject "abc" for an integer column gives the user a
 * real error; silently storing 0 gives them a wrong number.
 */
export function coerceForColumn(declaredType: string, value: string | number | boolean | null): string | number | boolean | null {
  if (value === null || typeof value !== 'string') return value;
  const kind = columnKind(declaredType);

  if (kind === 'number') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (kind === 'boolean') {
    if (/^(true|yes|1|t)$/i.test(value)) return true;
    if (/^(false|no|0|f)$/i.test(value)) return false;
    return value;
  }
  return value;
}

/** A column that holds bytes: BLOB (SQLite), bytea (Postgres), (VAR)BINARY. */
export function isBinaryType(type: string | undefined): boolean {
  return /^(blob|tinyblob|mediumblob|longblob|bytea|binary|varbinary)\b/i.test((type ?? '').trim());
}

/** A column that holds a JSON document: json and jsonb (Postgres), JSON (SQLite by declaration). */
export function isJsonType(type: string | undefined): boolean {
  return /^jsonb?\b/i.test((type ?? '').trim());
}

/** A column whose stored value an update can be compared on (scoped/updateGuard.ts): not a document, bytes, an array or a geometry. */
export function comparableType(type: string | undefined): boolean {
  return !/json|blob|binary|bytea|\[\]|geometry|geography|xml|interval|money|range/i.test(type ?? '');
}

/**
 * What an update of `values` expects the record to hold still: each column
 * it writes, as the list or record showed it (`row`). Sent as the update's
 * `expected`, it makes the write a compare-and-set, so a save made on a row
 * someone else has since changed is refused rather than written over theirs
 * — the lost update a writer pool would otherwise let through (server
 * writeLanes.ts). Undefined when the row does not hold every written column
 * as a plain value of a comparable type: the write is then as blind as ever.
 */
export function expectedValues(
  table: Pick<TableMeta, 'columns'>,
  values: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!row) return undefined;
  const expected: Record<string, string | number | boolean | null> = {};
  for (const column of Object.keys(values)) {
    const value = row[column];
    const meta = table.columns.find((item) => item.name === column);
    if (!meta || !Object.hasOwn(row, column) || !comparableType(meta.type)) return undefined;
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      return undefined;
    expected[column] = value as string | number | boolean | null;
  }
  return Object.keys(expected).length ? expected : undefined;
}
