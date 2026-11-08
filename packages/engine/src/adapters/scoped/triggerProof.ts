/**
 * A scoped write that fires a trigger the App named: each row the trigger's
 * keyed effects reach, proven inside the person's rows (docs/trigger-effects.md,
 * Option 1). A trigger never gives authority — every key it writes or reads
 * must be one the policy admits, checked under the same locks a parent key
 * gets, and where a key outside it is refused with the answer a hidden row
 * gets, never one that tells a hidden row from a missing one.
 *
 * Before the statement that fires it, from the request's values and the row
 * already read and locked for the write's own guard:
 *
 * - an effect's update or delete locks its row (FOR UPDATE on PostgreSQL;
 *   SQLite's BEGIN IMMEDIATE already holds the database) and reads it under
 *   the policy: exactly one row, or refused;
 * - a keyed read holds its row (FOR SHARE) and counts it under the policy:
 *   exactly one, or refused, so whether the trigger raises cannot say whether
 *   a hidden row exists;
 * - an inserted row is judged by the policy's rule for its table, evaluated on
 *   the values the trigger gives it, and its references checked like any new
 *   row's;
 * - every reference an insert gives or an update sets is checked before the
 *   statement where its value is known then, so a parent that does not exist
 *   answers as a hidden one does, not with the database's foreign key error. A
 *   reference given by an expression only the statement computes is refused.
 *
 * Every row an update, a delete or a keyed read reaches is named by a key
 * known before the statement. A key only the statement can tell — a value the
 * database assigns (an id, a default), a value a trigger computes — is
 * refused: proven after the statement, it would be proven against the row the
 * trigger had already changed, which can be one the trigger moved into the
 * person's rows. An insert alone may wait for the statement, where what its
 * row's place in the policy depends on is assigned by it; such an insert may
 * fire no keyed trigger on its table, whose own proof would come after it ran.
 * An updated row is read again after the statement, so a trigger cannot move
 * it out of the person's rows, and the references it set are checked. What
 * each effect fires on its own table is proven the same way, to the depth the
 * catalog allowed (triggerEffects.ts).
 */
import type { Filter, ScopedReads } from '../adapter.js';
import type { Condition } from '../../shared/filter.js';
import type { RowScope, RowScopeFilter, ViaCondition } from '../../shared/rowScope.js';
import type { ForeignKey, TableMeta } from '../../shared/schema.js';
import { overlaid, storedText, withStoredText } from './storedText.js';
import { firedBy, type EffectRef, type EffectTerm, type ScopeTrigger, type TriggerEffect, type TriggeringWrite } from './scopeTriggers.js';

/** The triggers an App accepts, as its transaction hands them to the engine. */
export interface TriggerAcceptance {
  /**
   * Each physical table's named triggers, each with the digest authority.lock approved for it (undefined where the
   * lock records none yet: the server's start and `mistri check` refuse a stale lock, this pins a recorded one).
   */
  readonly named: ReadonlyMap<string, ReadonlyMap<string, string | undefined>>;
  /**
   * Told of each row an accepted trigger changed, once the statement that fired it is proven, and awaited: the
   * engine's own witness, record history and live sync are told through it, on the transaction's writer.
   */
  readonly changed?: (change: TriggerChange) => void | Promise<void>;
}

/** What a scoped transaction is given to accept triggers: the App's acceptance, and the policy it runs under. */
export interface ScopedTriggers {
  readonly acceptance: TriggerAcceptance;
  readonly scope: RowScope;
  /** The engine's own witness of what the triggers wrote, where it keeps one (SQLite's session). */
  readonly watch?: () => void;
  /** This module's proof, which the engine loads where a transaction accepts triggers rather than at startup. */
  readonly prove: typeof createTriggerProof;
}

/** A row a trigger changed. */
export interface TriggerChange {
  readonly table: string;
  readonly kind: 'insert' | 'update' | 'delete';
  /** Its primary key; absent where the database assigned it and nothing read it back (an insert's generated id). */
  readonly key?: Readonly<Record<string, unknown>>;
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
  /** The trigger, and the table it fired on. */
  readonly trigger: string;
  readonly on: string;
}

/** What the proof borrows from the scoped transaction it runs in. */
interface ProofTools {
  readonly tables: readonly TableMeta[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly triggered: ReadonlyMap<string, readonly ScopeTrigger[]> | undefined;
  readonly foldCase: boolean;
  /** The policy the transaction runs under, by physical table: a row a trigger inserts is judged by its table's rule. */
  readonly scope: RowScope;
  guards(): Pick<ScopedReads, 'query' | 'count'>;
  lockedRead(table: TableMeta, filter: Filter, within: Pick<ScopedReads, 'query' | 'count'>): Promise<{ rows: Record<string, unknown>[] }>;
  /** A row by its key under the guards, with its reference columns' stored text (storedText.ts), taking no lock. */
  read(table: TableMeta, filter: Filter): Promise<{ rows: Record<string, unknown>[] }>;
  parents(table: TableMeta, row: Record<string, unknown>, set?: ReadonlySet<string>): Promise<void>;
  /**
   * Before the statement: the references of `row` whose every column it holds, checked as `parents` checks them. A
   * parent that does not exist would fail the statement with the database's foreign key error, and a hidden one pass
   * it: checked first, both are the one refusal.
   */
  parentsBefore(table: TableMeta, row: Record<string, unknown>, set?: ReadonlySet<string>): Promise<void>;
  holdParent?(table: TableMeta, filter: Filter): Promise<void>;
  relied?(table: TableMeta): void;
  /** Before a statement that fires an accepted trigger: SQLite's session starts recording (sqliteTriggerSession.ts). */
  watch?(): void;
  refuse(reason: string): never;
}

type Row = Record<string, unknown>;
/** The row a trigger sees as NEW or OLD: null where there is none (OLD on an insert), and a column missing where its value is not known yet. */
export interface Images {
  readonly new: Row | null;
  readonly old: Row | null;
}
/** What runs right after the statement, given the triggering row as it then stands. */
export type Afterward = (images: Images) => Promise<void>;

const UNKNOWN: unique symbol = Symbol('unknown');
type Known = unknown;

/**
 * A column whose value the database assigns when a write gives none: SQLite's rowid alias takes the next id for an
 * explicit NULL too, so a NULL given there is not the row's key, and NEW holds the id the statement chose.
 */
const assigned = (table: TableMeta, column: string): boolean =>
  table.columns.find((candidate) => candidate.name === column)?.identity !== undefined;

/** A term that names a column of NEW or OLD: its value is the row's, known once the row is, never computed by the trigger. */
const refersToRow = (term: EffectTerm | undefined): boolean => term !== undefined && 'row' in term;

const comparable = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** A row without its generated columns: the database computes them, so a value read before the write may not hold after it. */
const writtenPart = (table: TableMeta, row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([name]) => table.columns.find((column) => column.name === name)?.writable !== false));

export function createTriggerProof(acceptance: TriggerAcceptance, tools: ProofTools) {
  const tableOf = (id: string): TableMeta =>
    tools.tables.find((table) => table.id === id) ??
    tools.refuse(`A trigger's effect reaches "${id}", which is not in this write's footprint.`);
  const hidden = (table: TableMeta, trigger: ScopeTrigger, on: string) =>
    `The trigger ${JSON.stringify(trigger.name)} on "${on}" reaches a row of "${table.id}" outside the principal's rows: the row policy (or tenant) does not admit it, or it does not exist.`;

  /** Whether `trigger` on `table` is one the App accepts: named, keyed, judged sound by the catalog, and its digest the one approved. */
  const accepts = (table: string, trigger: ScopeTrigger): boolean => {
    const named = acceptance.named.get(table);
    if (!named?.has(trigger.name) || !trigger.effects || trigger.unaccepted) return false;
    const approved = named.get(trigger.name);
    return approved === undefined || approved === trigger.digest;
  };
  /** Why a fired trigger that blocks is not accepted, for the refusal. */
  const unaccepted = (table: string, trigger: ScopeTrigger): string | undefined => {
    const named = acceptance.named.get(table);
    if (!named?.has(trigger.name)) return undefined;
    if (!trigger.effects) return `named by the App, but outside the keyed-effect grammar: ${trigger.why ?? 'it is not validation-only'}`;
    if (trigger.unaccepted) return `named by the App, but ${trigger.unaccepted}`;
    return 'named by the App, but its definition is not the one authority.lock approved';
  };
  /** The accepted triggers a write fires; refuses where it fires one that blocks and is not accepted. */
  const fired = (table: TableMeta, write: TriggeringWrite): ScopeTrigger[] => {
    const triggers = tools.triggered?.get(table.id);
    if (!triggers) return [];
    const all = firedBy(triggers, write, tools.foldCase);
    if (all.length) tools.relied?.(table);
    const keyed = all.filter((trigger) => !trigger.validates);
    const refused = keyed.find((trigger) => !accepts(table.id, trigger));
    if (refused)
      tools.refuse(
        `"${table.id}" cannot be written by a trigger under a row policy: the write fires ${JSON.stringify(refused.name)}, ${unaccepted(table.id, refused) ?? "which the App does not name in its resource's triggers"}.`,
      );
    return keyed;
  };

  const valueOf = (images: Images, ref: EffectRef): Known | typeof UNKNOWN => {
    const row = ref.row === 'new' ? images.new : images.old;
    if (row === null) return null;
    return Object.hasOwn(row, ref.column) ? (row[ref.column] ?? null) : UNKNOWN;
  };
  const termOf = (images: Images, term: EffectTerm): Known | typeof UNKNOWN =>
    'row' in term ? valueOf(images, term) : 'literal' in term ? term.literal : UNKNOWN;
  /** The stored text a term carries from the image it names (storedText.ts): a stored column copied as it is. */
  const textOf = (images: Images, term: EffectTerm): string | null | undefined => {
    if (!('row' in term)) return undefined;
    const row = term.row === 'new' ? images.new : images.old;
    const texts = storedText(row);
    return texts && row && Object.hasOwn(texts, term.column) && Object.hasOwn(row, term.column) ? texts[term.column] : undefined;
  };
  /** `row`, carrying the stored texts of the columns `terms` copy from an image unchanged. */
  const carried = (
    row: Row,
    images: Images,
    terms: Readonly<Record<string, EffectTerm>>,
    base: Readonly<Record<string, string | null>> = {},
  ) => {
    const texts: Record<string, string | null> = { ...base };
    for (const [column, term] of Object.entries(terms)) {
      const text = textOf(images, term);
      if (text === undefined) delete texts[column];
      else texts[column] = text;
    }
    return withStoredText(row, texts);
  };
  /** The effect's key as values: null where it reaches no row (a NULL never equals), UNKNOWN where the statement must tell. */
  const keyOf = (images: Images, effect: TriggerEffect, table: TableMeta): Row | null | typeof UNKNOWN => {
    const key: Row = {};
    let unknown = false;
    for (const [column, ref] of Object.entries(effect.key ?? {})) {
      const value = valueOf(images, ref);
      if (value === null) return null;
      if (value === UNKNOWN) unknown = true;
      else if (!comparable(value)) return tools.refuse(`A trigger's key for "${table.id}".${column} is not a text or a number.`);
      else key[column] = value;
    }
    return unknown ? UNKNOWN : key;
  };
  const filterOf = (key: Row): Filter => ({
    groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value: value as string | number }))],
  });
  const primaryKey = (table: TableMeta, row: Row): Row | undefined => {
    const columns = table.columns.filter((column) => column.primaryKey);
    if (!columns.length || columns.some((column) => !comparable(row[column.name]))) return undefined;
    return Object.fromEntries(columns.map((column) => [column.name, row[column.name]]));
  };
  /** The row an update leaves, as far as the images say: a column it sets by an expression is not known until it ran. */
  const updated = (table: TableMeta, stored: Row, images: Images, effect: TriggerEffect): Row => {
    const row = writtenPart(table, stored);
    for (const [column, term] of Object.entries(effect.values ?? {})) {
      const value = termOf(images, term);
      if (value === UNKNOWN) delete row[column];
      else row[column] = value;
    }
    return carried(row, images, effect.values ?? {}, storedText(stored));
  };

  /** Whether `value` stored in `column` equals `wanted` as the database would: only where JavaScript can say so for certain. */
  const equal = (table: TableMeta, column: string, value: unknown, wanted: unknown): boolean | typeof UNKNOWN => {
    if (value === null || wanted === null) return false;
    if (typeof value === typeof wanted && (typeof value === 'string' || typeof value === 'number')) return value === wanted;
    // An integer column compares a number and its canonical text alike on both engines (affinity, a cast of the parameter).
    const type = table.columns.find((candidate) => candidate.name === column)?.type ?? '';
    if (/int|serial/i.test(type) && comparable(value) && comparable(wanted)) return String(value) === String(wanted);
    return UNKNOWN;
  };
  const holds = (table: TableMeta, given: Condition | ViaCondition, row: Row): boolean | typeof UNKNOWN => {
    // A relationship test reads another table's rows, which a trigger's inserted row cannot say.
    if (given.via !== undefined) return UNKNOWN;
    const condition = given as Condition;
    if (condition.other !== undefined || condition.any !== undefined || condition.collation !== undefined) return UNKNOWN;
    if (!Object.hasOwn(row, condition.column)) return UNKNOWN;
    const value = row[condition.column];
    if (value === UNKNOWN) return UNKNOWN;
    if (condition.op === 'isNull') return value === null;
    if (condition.op === 'isNotNull') return value !== null;
    if (condition.op === '=') return equal(table, condition.column, value, condition.value);
    if (condition.op === 'in' && Array.isArray(condition.value)) {
      let unknown = false;
      for (const wanted of condition.value) {
        const same = equal(table, condition.column, value, wanted);
        if (same === true) return true;
        if (same === UNKNOWN) unknown = true;
      }
      return unknown ? UNKNOWN : false;
    }
    // A comparison whose answer depends on collation or type rules this side does not hold.
    return UNKNOWN;
  };
  /** Whether a row the trigger inserts lands inside the policy's rule for its table. */
  const admitted = (table: TableMeta, row: Row): boolean | typeof UNKNOWN => {
    const rule = tools.scope[table.id];
    if (rule === true) return true;
    if (!rule) return false;
    const filter = rule as RowScopeFilter;
    if (!filter.groups.length) return true;
    let unknown = false;
    for (const group of filter.groups) {
      let all: boolean | typeof UNKNOWN = true;
      for (const condition of group) {
        const result = holds(table, condition, row);
        if (result === false) {
          all = false;
          break;
        }
        if (result === UNKNOWN) all = UNKNOWN;
      }
      if (all === true) return true;
      if (all === UNKNOWN) unknown = true;
    }
    return unknown ? UNKNOWN : false;
  };

  /**
   * Before the statement: every effect of every accepted trigger the write fires, proven where its images already
   * say enough. Answers what runs right after the statement.
   */
  /**
   * The rows this statement's effects update or delete, by table and primary key, each with whether a write to it
   * fires a keyed trigger; the statement's own row is one. A row two writes reach is seen by the second as the first
   * left it, not as it was read and locked here: where either fires a keyed trigger, that trigger's keys would come
   * from an image of the row this proof never had (a value one effect set, read as the key of the next).
   */
  let reached = new Map<string, boolean>();
  const rowId = (table: TableMeta, row: Row) => JSON.stringify([table.id, primaryKey(table, row) ?? row]);
  const claim = (table: TableMeta, row: Row, firing: boolean, trigger: ScopeTrigger) => {
    const id = rowId(table, row);
    const prior = reached.get(id);
    if (prior !== undefined && (prior || firing))
      tools.refuse(
        `The trigger ${JSON.stringify(trigger.name)} reaches a row of "${table.id}" that this write already reaches, and a write to it fires a trigger that reads or writes another row: what that trigger sees depends on which write runs first, so it cannot be proven before the write.`,
      );
    reached.set(id, firing);
  };

  /** Whether a write to `table` fires a trigger there that reads or writes another row, accepted or not. */
  const firesKeyed = (table: TableMeta, write: TriggeringWrite): boolean =>
    (tools.triggered?.get(table.id) ?? []).some((next) => !next.validates && firedBy([next], write, tools.foldCase).length > 0);

  const before = async (table: TableMeta, write: TriggeringWrite, images: Images): Promise<Afterward[]> => {
    const afterwards: Afterward[] = [];
    const firing = fired(table, write);
    if (firing.length) tools.watch?.();
    for (const trigger of firing)
      for (const effect of trigger.effects!) afterwards.push(await effectBefore(table, trigger, effect, images));
    return afterwards;
  };

  const effectBefore = async (on: TableMeta, trigger: ScopeTrigger, effect: TriggerEffect, images: Images): Promise<Afterward> => {
    const table = tableOf(effect.table);
    const said = async (kind: TriggerChange['kind'], row: { key?: Row; before?: Row; after?: Row }) => {
      await acceptance.changed?.({ table: table.id, kind, ...row, trigger: trigger.name, on: on.id });
    };

    if (effect.kind === 'read') {
      const key = keyOf(images, effect, table);
      // Whether the trigger raises is read before anything else can be: a key the statement alone knows is not proven.
      if (key === UNKNOWN)
        return tools.refuse(
          `The trigger ${JSON.stringify(trigger.name)} reads a "${table.id}" row by a value only the write assigns: it cannot be proven before the write.`,
        );
      if (key) {
        const filter = filterOf(key);
        await tools.holdParent?.(table, filter);
        if ((await tools.guards().count(table.id, filter)) !== 1) return tools.refuse(hidden(table, trigger, on.id));
      }
      return async () => {};
    }

    if (effect.kind === 'insert') {
      /** The row it will insert, a column it gives by an expression or leaves to a default unknown. */
      const rowOf = (images: Images): Row => {
        const row: Row = {};
        for (const column of table.columns) {
          if (Object.hasOwn(effect.values ?? {}, column.name)) {
            const value = termOf(images, effect.values![column.name]);
            row[column.name] = value === null && column.identity !== undefined ? UNKNOWN : value;
          } else
            row[column.name] = column.default !== undefined || column.identity !== undefined || column.writable === false ? UNKNOWN : null;
        }
        return carried(row, images, effect.values ?? {});
      };
      const references = new Set(tools.foreignKeys.filter((fk) => fk.from.table === table.id).flatMap((fk) => fk.from.columns));
      const knownPart = (row: Row) =>
        withStoredText(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== UNKNOWN)), storedText(row));
      /* A reference no image will ever tell (an expression, a default): refused now, before the statement could fail on
         its foreign key for a parent that does not exist and pass for one that is hidden. */
      if ([...references].some((column) => rowOf({ new: null, old: null })[column] === UNKNOWN && !refersToRow(effect.values?.[column])))
        return tools.refuse(
          `The trigger ${JSON.stringify(trigger.name)} inserts a "${table.id}" row whose place in the principal's rows cannot be proven: a value the policy or a reference depends on is computed by the trigger or left to a default.`,
        );
      /** Its proof. */
      const prove = async (images: Images, last: boolean): Promise<Afterward | undefined> => {
        const row = rowOf(images);
        const verdict = admitted(table, row);
        const unknownReference = [...references].some((column) => row[column] === UNKNOWN);
        if ((verdict === UNKNOWN || unknownReference) && !last) return undefined;
        if (verdict === UNKNOWN || unknownReference)
          return tools.refuse(
            `The trigger ${JSON.stringify(trigger.name)} inserts a "${table.id}" row whose place in the principal's rows cannot be proven: a value the policy or a reference depends on is computed by the trigger or left to a default.`,
          );
        if (!verdict) return tools.refuse(hidden(table, trigger, on.id));
        const known = knownPart(row);
        await tools.parents(table, known, references);
        const chained = await before(table, { kind: 'insert' }, { new: known, old: null });
        return async () => {
          const key = primaryKey(table, known);
          for (const next of chained) await next({ new: known, old: null });
          await said('insert', { ...(key ? { key } : {}), after: known });
        };
      };
      const early = await prove(images, false);
      if (early) return early;
      // Proven after the statement, what its row fires on its table would be proven after that had run too.
      if (firesKeyed(table, { kind: 'insert' }))
        return tools.refuse(
          `The trigger ${JSON.stringify(trigger.name)} inserts a "${table.id}" row whose place in the principal's rows only the write can tell, and that insert fires a trigger that reads or writes another row: it cannot be proven before the write.`,
        );
      // Its row waits for the statement; the references it already names are checked before it.
      await tools.parentsBefore(table, knownPart(rowOf(images)), references);
      return async (after) => {
        const late = await prove(after, true);
        await late?.(after);
      };
    }

    // An update or a delete: one row, by a key known before the statement.
    const key = keyOf(images, effect, table);
    if (key === UNKNOWN)
      return tools.refuse(
        `The trigger ${JSON.stringify(trigger.name)} reaches a row of "${table.id}" by a value only the write assigns: it cannot be proven before the write.`,
      );
    const write: TriggeringWrite =
      effect.kind === 'update' ? { kind: 'update', set: Object.keys(effect.values ?? {}) } : { kind: 'delete' };
    let stored: Row | undefined;
    let chained: Afterward[] = [];
    if (key) {
      const result = await tools.lockedRead(table, filterOf(key), tools.guards());
      if (result.rows.length !== 1) return tools.refuse(hidden(table, trigger, on.id));
      stored = result.rows[0];
      claim(table, stored, firesKeyed(table, write), trigger);
      if (effect.kind === 'update') {
        const set = new Set(Object.keys(effect.values ?? {}));
        const sets = tools.foreignKeys
          .filter((fk) => fk.from.table === table.id)
          .flatMap((fk) => fk.from.columns.filter((column) => set.has(column)));
        // A reference set by an expression only the statement computes: whether its parent exists cannot be asked first.
        if (sets.some((column) => !refersToRow(effect.values?.[column]) && !('literal' in (effect.values?.[column] ?? {}))))
          return tools.refuse(
            `The trigger ${JSON.stringify(trigger.name)} sets a reference of "${table.id}" to a value only the write computes: whether that row exists and is the principal's cannot be proven before the write.`,
          );
        await tools.parentsBefore(table, updated(table, stored, images, effect), set);
      }
      chained = await before(
        table,
        write,
        effect.kind === 'update' ? { new: updated(table, stored, images, effect), old: stored } : { new: null, old: stored },
      );
    }
    return async () => {
      if (!key || !stored) return;
      if (effect.kind === 'delete') {
        for (const next of chained) await next({ new: null, old: stored });
        await said('delete', { ...(primaryKey(table, stored) ? { key: primaryKey(table, stored) } : {}), before: stored });
        return;
      }
      // Still inside the principal's rows after the trigger wrote it, and every reference it set checked.
      const result = await tools.read(table, filterOf(key));
      if (result.rows.length !== 1) return tools.refuse(hidden(table, trigger, on.id));
      const now = result.rows[0];
      const was = stored;
      /* A key or a referenced column the database generates moves with what the trigger set, which the catalog's
         judgment by name cannot see (triggerEffects.ts): one that moved is refused, as the person's own update is. */
      const shifted = table.columns
        .filter(
          ({ name, writable, primaryKey }) =>
            writable === false &&
            (primaryKey || tools.foreignKeys.some((fk) => fk.to.table === table.id && fk.to.columns.includes(name))) &&
            JSON.stringify(was[name]) !== JSON.stringify(now[name]),
        )
        .map((column) => column.name);
      if (shifted.length)
        return tools.refuse(
          `The trigger ${JSON.stringify(trigger.name)} changes "${table.id}".${shifted.join(', ')}: a key, or a column another table references, generated from the columns it sets.`,
        );
      // Every reference it set checked; one with a generated column with every update (scopedTransaction.ts parentChecks).
      await tools.parents(table, now, new Set(Object.keys(effect.values ?? {})));
      for (const next of chained) await next({ new: now, old: stored });
      await said('update', { ...(primaryKey(table, now) ? { key: primaryKey(table, now) } : {}), before: stored, after: now });
    };
  };

  /** A statement's proof: its own row (an update's or a delete's) the first reached, and every effect's after it. */
  const statement = async (table: TableMeta, write: TriggeringWrite, images: Images): Promise<Afterward[]> => {
    reached = new Map();
    if (images.old) reached.set(rowId(table, images.old), true);
    return before(table, write, images);
  };

  return { accepts, unaccepted, before: statement, images: imagesBefore };
}

/** What a scoped write's own row looks like to its triggers before the statement, by write. */
const imagesBefore = {
  /* A NULL given for a column the database assigns is not what NEW will hold: left unknown, like a value not given. */
  insert: (table: TableMeta, values: Row | undefined): Images => ({
    new: Object.fromEntries(Object.entries(values ?? {}).filter(([column, value]) => value != null || !assigned(table, column))),
    old: null,
  }),
  // NEW carries the stored texts of the columns the write leaves as they were (storedText.ts).
  update: (table: TableMeta, stored: Row, values: Row | undefined): Images => ({
    new: withStoredText({ ...writtenPart(table, stored), ...(values ?? {}) }, storedText(overlaid(stored, values))),
    old: stored,
  }),
  delete: (stored: Row): Images => ({ new: null, old: stored }),
};
