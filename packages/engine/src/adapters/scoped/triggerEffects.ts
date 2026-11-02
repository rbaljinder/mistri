/**
 * What a trigger's keyed effects reach, judged against the catalog they run
 * in (docs/trigger-effects.md). The grammar (sqliteTriggers.ts,
 * postgresTriggers.ts) reads what a body says; this decides whether the
 * platform can bound it, once per catalog read:
 *
 * - every table an effect names is an ordinary table of the catalog that a
 *   scoped write could itself target (not a view, a TEMP shadow, a table
 *   with rules or row security, or on PostgreSQL one in a partition or
 *   inheritance hierarchy, which no scoped write targets);
 * - every key covers a key the catalog proves unique as the trigger compares
 *   it ({@link EffectCatalog.keys}), so it reaches one row at most, and names
 *   only columns that exist;
 * - each of its equalities compares two columns of the same type and
 *   collation ({@link EffectCatalog.comparison}), so the row the trigger finds
 *   is the row the proof reads by the same value: a cast on one side (a
 *   `char(3)` against a `text` key drops trailing spaces), a looser collation
 *   on one side (NOCASE against BINARY) or a nondeterministic one would match
 *   rows the proof never read;
 * - each side of each key is of a type a scoped write takes as a row's identity
 *   (keyTypes.ts): a jsonb key the driver reads as another value, or a SQLite
 *   decimal said with its scale, names a row the database does not compare;
 * - an update sets no key column and no column another table references, and
 *   a delete removes no row of a table another table's foreign key references,
 *   as the person's own delete may not (scopedTransaction.ts remove): a cascade
 *   would reach rows nobody keyed, and a NO ACTION or RESTRICT reference would
 *   refuse the delete exactly when a row (hidden or not) still points at it;
 * - an insert or update writes no table whose schema declares a conflict
 *   clause of its own ({@link EffectCatalog.conflicts}): under a statement that
 *   names none (a scoped delete), that clause, not the proof, decides which
 *   row the write replaces;
 * - no effect writes the table the trigger fires on: its own row is the write
 *   the policy already bounds, and another of its rows would fire the same
 *   triggers mid-statement;
 * - what each write fires on its table is validation-only or keyed in turn,
 *   with no cycle and a chain at most {@link MAX_TRIGGER_DEPTH} keyed triggers
 *   deep.
 *
 * A trigger that fails any of this keeps its effects for `mistri check` to
 * name, with `unaccepted` saying why; naming it in an App does not unblock a
 * write. Whether a trigger is named, and whether its keys are in a person's
 * scope, are the transaction's to judge (triggerProof.ts).
 */
import type { DatabaseSchema, TableMeta } from '../../shared/schema.js';
import { keyTypeRefusal } from './keyTypes.js';
import { firedBy, type EffectRef, type EffectTerm, type ScopeTrigger, type TriggerEffect } from './scopeTriggers.js';

/** The longest chain of keyed-effect triggers one write may start, itself included. */
const MAX_TRIGGER_DEPTH = 4;

/** What the resolution needs of a scope catalog. */
export interface EffectCatalog {
  readonly schema: DatabaseSchema;
  /** Tables a scoped write may target with no trigger in the way. */
  readonly writable: ReadonlySet<string>;
  /** Tables whose triggers decide each write, with those triggers as the grammar read them. */
  readonly triggered: ReadonlyMap<string, readonly ScopeTrigger[]>;
  /** SQLite folds ASCII case in names; PostgreSQL names exactly. */
  readonly foldCase: boolean;
  /** PostgreSQL: the tables in a partition or inheritance hierarchy, which no scoped write targets (ScopeCatalog.hierarchy). */
  readonly hierarchy?: ReadonlySet<string>;
  /**
   * SQLite: the conflict clause a table's schema declares on a constraint, other than ABORT (`ON CONFLICT REPLACE`),
   * or why its schema could not be read for one; undefined where it declares none. A scoped insert or update says
   * `OR ABORT`, which overrides every clause a trigger's statement meets; a scoped delete cannot (SQLite has no
   * `DELETE OR ABORT`), so a trigger it fires writes under the table's own clause.
   */
  readonly conflicts?: (table: TableMeta) => string | undefined;
  /**
   * Tables a scoped write cannot target for what the catalog holds beyond their triggers (row-level security, a rule,
   * no UPDATE for the writer), with what blocks each. A write's own catalog keeps these out of `writable` and
   * `triggered` already; `mistri check` reads them apart, so it refuses what the write refuses.
   */
  readonly blocked?: ReadonlyMap<string, string>;
  /**
   * The column sets a table's rows are unique on under the comparison a key makes: SQLite its primary key, where its
   * index (if any) uses each column's own collation; PostgreSQL each valid, whole-table unique index on plain columns
   * whose every column uses its own collation and its type's default B-tree operator class. Stricter than
   * `TableMeta.unique`, which an App's address relies on, and kept apart from it.
   */
  readonly keys: (table: TableMeta) => readonly (readonly string[])[];
  /** How a column compares in a key equality; undefined where the catalog cannot say, which refuses the key. */
  readonly comparison: (table: TableMeta, column: string) => KeyComparison | undefined;
}

/** What a catalog says beyond its schema and triggers, read by the engine's own catalog (`Adapter.triggerKeys` for a check). */
export type TriggerKeyFacts = Pick<EffectCatalog, 'keys' | 'comparison' | 'hierarchy' | 'conflicts' | 'blocked'>;

/** What decides whether two values of a column are equal, as a trigger's key equality compares them. */
export interface KeyComparison {
  /** SQLite: the column's affinity; PostgreSQL: its base type and type modifier, its domains unwrapped. */
  readonly type: string;
  /** The collation it compares under ('' for a type without one). */
  readonly collation: string;
  /** False where equal under that collation is not equal bytes (a nondeterministic collation). */
  readonly exact: boolean;
  /** For a refusal: the type and collation as a person reads them. */
  readonly said: string;
  /** Whether the type is one a scoped write takes as a row's identity (keyTypes.ts); a key of any other is refused. */
  readonly keyable: boolean;
  /** For that refusal: the column's type as declared. */
  readonly declared: string;
}

const fold = (name: string) => name.replace(/[A-Z]/g, (char) => char.toLowerCase());

class Unaccepted extends Error {}
const refuse = (reason: string): never => {
  throw new Unaccepted(reason);
};

/** Each trigger of `catalog.triggered`, its effects resolved to table ids and real column names, judged. */
export function resolveTriggerEffects(catalog: EffectCatalog): Map<string, readonly ScopeTrigger[]> {
  const same = catalog.foldCase ? fold : (name: string) => name;
  const tables = new Map<string, TableMeta>();
  for (const table of catalog.schema.tables) {
    // SQLite names a table by its name; PostgreSQL's grammar asks for `schema.name`.
    tables.set(catalog.foldCase ? fold(table.name) : `${table.schema}.${table.name}`, table);
  }
  const column = (table: TableMeta, name: string): string =>
    table.columns.find((candidate) => same(candidate.name) === same(name))?.name ??
    refuse(`it names a column ${JSON.stringify(name)} that ${JSON.stringify(table.name)} does not have`);
  const referenced = new Set(catalog.schema.foreignKeys.flatMap((key) => key.to.columns.map((name) => `${key.to.table}\u0000${name}`)));
  // Any reference, whatever its ON DELETE: a cascade reaches rows nobody keyed, a RESTRICT says whether one exists.
  const referencedTables = new Set(catalog.schema.foreignKeys.map((key) => key.to.table));

  /** One effect, its table and columns resolved; throws Unaccepted. */
  const effect = (own: TableMeta, raw: TriggerEffect): TriggerEffect => {
    const table = tables.get(catalog.foldCase ? fold(raw.table) : raw.table);
    if (table && catalog.hierarchy?.has(table.id))
      return refuse(
        `it ${raw.kind === 'read' ? 'reads' : 'writes'} ${JSON.stringify(raw.table)}, part of a partition or inheritance hierarchy, ` +
          'which writes under a row policy do not support yet',
      );
    const blocked = table && catalog.blocked?.get(table.id);
    if (blocked) return refuse(`it ${raw.kind === 'read' ? 'reads' : 'writes'} ${JSON.stringify(raw.table)}, which has ${blocked}`);
    if (!table || table.isView || (!catalog.writable.has(table.id) && !catalog.triggered.has(table.id)))
      return refuse(`it ${raw.kind === 'read' ? 'reads' : 'writes'} ${JSON.stringify(raw.table)}, which a scoped write cannot reach`);
    if (table.id === own.id) return refuse('it writes the table it fires on');
    if (raw.kind === 'insert' || raw.kind === 'update') {
      const conflict = catalog.conflicts?.(table);
      if (conflict)
        return refuse(
          `it ${raw.kind === 'insert' ? 'inserts into' : 'updates'} ${JSON.stringify(table.name)}, whose schema declares ${conflict}: ` +
            'under a delete, which cannot say OR ABORT, that clause and not the proof decides which row the write replaces',
        );
    }
    const ref = (value: EffectRef): EffectRef => ({ row: value.row, column: column(own, value.column) });
    const term = (value: EffectTerm): EffectTerm => ('row' in value ? ref(value) : value);
    let key: Record<string, EffectRef> | undefined;
    if (raw.key) {
      key = {};
      for (const [name, value] of Object.entries(raw.key)) key[column(table, name)] = ref(value);
      const named = new Set(Object.keys(key));
      if (!catalog.keys(table).some((columns) => columns.length > 0 && columns.every((name) => named.has(name))))
        return refuse(
          `its ${raw.kind === 'read' ? 'read of' : 'write to'} ${JSON.stringify(table.name)} is not by ${catalog.foldCase ? 'the primary key' : 'a key'} of it`,
        );
      /* The proof reads the row by the key column's own comparison (`column = $1`); the trigger compares under
         whatever the two sides of its equality resolve to. Only where both are the same do they find one row. */
      for (const [name, value] of Object.entries(key)) {
        const theirs = catalog.comparison(table, name);
        const ours = catalog.comparison(own, value.column);
        const said = `${JSON.stringify(table.name)}.${name} = ${value.row.toUpperCase()}.${value.column}`;
        if (!theirs || !ours) return refuse(`its key ${said} compares columns whose type or collation mistri cannot read`);
        if (!theirs.keyable)
          return refuse(
            `its key ${said} is not one a scoped write can prove: ${keyTypeRefusal(catalog.foldCase ? 'sqlite' : 'postgres', table.name, name, theirs.declared)}`,
          );
        if (!ours.keyable)
          return refuse(
            `its key ${said} is not one a scoped write can prove: ${keyTypeRefusal(catalog.foldCase ? 'sqlite' : 'postgres', own.name, value.column, ours.declared)}`,
          );
        if (!theirs.exact)
          return refuse(`its key ${said} compares under a nondeterministic collation (${theirs.said}), where equal is not one value`);
        if (theirs.type !== ours.type || theirs.collation !== ours.collation)
          return refuse(
            `its key ${said} compares ${theirs.said} with ${ours.said}: a key's two sides must have the same type and collation, or the row it finds is not the one proven`,
          );
      }
    }
    /* Each row an effect reaches is told by its primary key (triggerProof.ts said: history and live sync file it
       there), whatever the effect keys it by; a key that is the primary key was judged above, in its own words. A
       primary key of a type off the list (keyTypes.ts) names a row the database does not compare, as a scoped write's
       own target's would (scopedTransaction.ts target). */
    for (const name of table.columns.filter((candidate) => candidate.primaryKey).map((candidate) => candidate.name)) {
      const compared = catalog.comparison(table, name);
      const reaches = `it ${raw.kind === 'read' ? 'reads' : 'writes'} ${JSON.stringify(raw.table)}, whose primary key`;
      if (!compared) return refuse(`${reaches} is of a type mistri cannot read`);
      if (!compared.keyable)
        return refuse(
          `${reaches} cannot name its rows: ${keyTypeRefusal(catalog.foldCase ? 'sqlite' : 'postgres', table.name, name, compared.declared)}`,
        );
    }
    let values: Record<string, EffectTerm> | undefined;
    if (raw.values) {
      values = {};
      for (const [name, value] of Object.entries(raw.values)) {
        const real = column(table, name);
        values[real] = term(value);
        if (raw.kind === 'read') continue;
        const meta = table.columns.find((candidate) => candidate.name === real)!;
        if (meta.writable === false) refuse(`it writes the generated column ${JSON.stringify(real)} of ${JSON.stringify(table.name)}`);
        if (raw.kind === 'update' && (meta.primaryKey || (key && Object.hasOwn(key, real))))
          refuse(`it changes the key of ${JSON.stringify(table.name)}`);
        if (raw.kind === 'update' && referenced.has(`${table.id}\u0000${real}`))
          refuse(`it changes ${JSON.stringify(real)} of ${JSON.stringify(table.name)}, which another table references`);
      }
    }
    if (raw.kind === 'delete' && referencedTables.has(table.id))
      refuse(
        `it deletes from ${JSON.stringify(table.name)}, which a foreign key references: whether the delete runs would say whether a row the principal cannot see references it`,
      );
    return { kind: raw.kind, table: table.id, ...(key ? { key } : {}), ...(values ? { values } : {}) };
  };

  /* Each keyed trigger once, resolved; then depth and cycles over the graph of what each effect fires. */
  const resolved = new Map<ScopeTrigger, { effects?: TriggerEffect[]; unaccepted?: string }>();
  for (const [id, triggers] of catalog.triggered) {
    const own = catalog.schema.tables.find((table) => table.id === id);
    for (const trigger of triggers) {
      if (trigger.validates || !trigger.effects) continue;
      if (!own) {
        resolved.set(trigger, { unaccepted: 'its table is not in the catalog' });
        continue;
      }
      try {
        resolved.set(trigger, {
          effects: trigger.effects.map((raw) => effect(own, raw)),
          ...(trigger.unaccepted ? { unaccepted: trigger.unaccepted } : {}),
        });
      } catch (error) {
        if (!(error instanceof Unaccepted)) throw error;
        resolved.set(trigger, { unaccepted: trigger.unaccepted ?? error.message });
      }
    }
  }

  /** The keyed triggers an effect fires on its table; throws Unaccepted where one fired is neither validation-only nor keyed. */
  const fires = (raw: TriggerEffect): ScopeTrigger[] => {
    if (raw.kind === 'read') return [];
    const write = { kind: raw.kind, ...(raw.kind === 'update' ? { set: Object.keys(raw.values ?? {}) } : {}) };
    const fired = firedBy(catalog.triggered.get(raw.table) ?? [], write, catalog.foldCase);
    for (const next of fired) {
      if (next.validates) continue;
      const entry = resolved.get(next);
      // A CHECK, a default or a domain calling a function of the database's (PostgreSQL) is run, not fired, and never keyed.
      if (!entry?.effects || entry.unaccepted)
        refuse(
          `its write to ${JSON.stringify(raw.table)} ${next.kind ? `runs the ${next.kind}` : 'fires'} ${JSON.stringify(next.name)}, ` +
            `${entry?.unaccepted ?? next.why ?? 'which is not validation-only'}`,
        );
    }
    return fired.filter((next) => !next.validates);
  };
  const depths = new Map<ScopeTrigger, number>();
  const visiting = new Set<ScopeTrigger>();
  const depth = (trigger: ScopeTrigger): number => {
    const known = depths.get(trigger);
    if (known !== undefined) return known;
    if (visiting.has(trigger)) return refuse('its effects fire it again');
    visiting.add(trigger);
    try {
      let deepest = 0;
      for (const raw of resolved.get(trigger)?.effects ?? []) for (const next of fires(raw)) deepest = Math.max(deepest, depth(next));
      const result = deepest + 1;
      if (result > MAX_TRIGGER_DEPTH) refuse(`its effects start a chain of more than ${MAX_TRIGGER_DEPTH} triggers`);
      depths.set(trigger, result);
      return result;
    } finally {
      visiting.delete(trigger);
    }
  };

  const result = new Map<string, readonly ScopeTrigger[]>();
  for (const [id, triggers] of catalog.triggered) {
    result.set(
      id,
      triggers.map((trigger) => {
        const entry = resolved.get(trigger);
        if (!entry) return trigger;
        const base = { ...trigger, ...(entry.effects ? { effects: entry.effects } : {}) };
        if (entry.unaccepted) return { ...base, unaccepted: entry.unaccepted };
        try {
          return { ...base, depth: depth(trigger) };
        } catch (error) {
          if (!(error instanceof Unaccepted)) throw error;
          return { ...base, unaccepted: error.message };
        }
      }),
    );
  }
  return result;
}
