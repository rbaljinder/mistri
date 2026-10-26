/**
 * What one subscriber is told of one change row: only rows they could read
 * now, or could read just before the change (DESIGN §4).
 *
 *   1. Tenant. An entry of a tenant's table reaches a subscriber of that
 *      tenant alone; an entry whose tenant the capture could not read
 *      reaches no tenant subscriber.
 *   2. Grants. A table outside the reader's readable set is dropped, and so is
 *      an update whose written columns are all ones they cannot read (a
 *      column a readable computed column or rollup reads counts as read).
 *   3. Row scope. Where the reader's scope for the table is `true`, nothing
 *      more is asked. Otherwise a key is sent when its row is in scope after
 *      the change (asked of the database, once per distinct scope in a batch,
 *      through the reader's own read path) or was in scope before it (the
 *      before image the capture kept, judged here). A change too wide to key
 *      (`many`) goes only to readers whose scope is `true`.
 *
 * Nothing else leaves: no value, actor, tenant, scope or position. A change
 * no key of which passes sends nothing at all, so a subscriber cannot tell
 * it happened.
 *
 * The before image is judged in JavaScript, never in SQL, and fails closed:
 * an operator that cannot be judged exactly the way the database would judge
 * it (a pattern, a text comparison under a collation, a column compared with
 * a column, a column the image does not hold) is false. A scope is groups of
 * conditions ORed, each group ANDed, with no negation of a group, so a false
 * condition can only ever make fewer rows visible: a reader may miss being
 * told a row left their scope, and then sees it gone at their next refresh;
 * they are never told of one they could not see.
 */
import { createHash } from 'node:crypto';
import type { Condition } from '@mistriwork/engine/shared/filter.js';
import type { RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import type { LiveEntry, LiveKey, LiveKind, StoredLiveChange } from '../../adapters/live/liveChange.js';

/** One table a subscriber may be told of, by its physical name in the change store. */
export interface LiveGrant {
  /** The id the reader's catalog knows the table by: what the event names. */
  readonly id: string;
  /** Its key columns, as the change store keys rows. */
  readonly key: readonly string[];
  /** Columns the reader reads, directly or through a computed column or rollup; `all` for every one. */
  readonly columns: ReadonlySet<string> | 'all';
  /** The reader's row scope on the table: `true` for every row. */
  readonly scope: true | RowScopeFilter;
  /** The scope's digest, with the App and table: subscribers that share one share a probe. */
  readonly fingerprint: string;
}

/** What a subscriber reads on one database, resolved under their own grants and session. */
export interface LiveAuthority {
  /** The verified account, to mark the subscriber's own changes `self`; '' for none. */
  readonly actor: string;
  /** A tenant App's tenant: entries of any other tenant, or of none, are not theirs. */
  readonly tenant?: string;
  readonly tables: ReadonlyMap<string, LiveGrant>;
  /** Which of `keys` of the physical `table` the grant's scope admits now, as `keyText`. Asked only for a scoped grant. */
  probe(table: string, keys: readonly LiveKey[]): Promise<ReadonlySet<string>>;
}

/** What one subscriber is told of a stretch of changes, by the table id it knows. */
export interface LiveDelivery {
  tables: Map<string, { keys: Map<string, LiveKey> | 'many'; kinds: Set<LiveKind> }>;
  /** Every change told was the subscriber's own. */
  self: boolean;
  /** A change was too wide to key on a table the reader reads under a scope: on a replay, the subscriber is reset. */
  unkeyed: boolean;
}

export const emptyDelivery = (): LiveDelivery => ({ tables: new Map(), self: true, unkeyed: false });

/** A key as one comparable text: its columns sorted, each value with its type. */
export const keyText = (key: LiveKey): string =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  );

/** The digest a scope is shared by: equal only for the same App, table and filter. */
export function scopeFingerprint(owner: string, table: string, scope: true | RowScopeFilter): string {
  if (scope === true) return '';
  return createHash('sha256')
    .update(JSON.stringify([owner, table, scope]))
    .digest('base64url');
}

/* ---------- the before image, judged in JavaScript ---------- */

type Scalar = string | number | boolean | null;

/* Every engine's default text comparison folds at least this much or nothing; `!=` is believed only where values differ after it. */
const folded = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+$/u, '');

/* One value as a stored scalar compares with another: a number and its text are the same key on every engine. */
const same = (a: Scalar, b: unknown): boolean => a !== null && b !== null && b !== undefined && (a === b || String(a) === String(b));

function condition(row: Readonly<Record<string, Scalar>>, test: Condition): boolean {
  if (test.other !== undefined || test.column.includes('.') || !Object.hasOwn(row, test.column)) return false;
  const value = row[test.column];
  switch (test.op) {
    case 'isNull':
      return value === null;
    case 'isNotNull':
      return value !== null;
    case '=':
      return same(value, test.value);
    case 'in':
      return Array.isArray(test.value) && test.value.some((item) => same(value, item));
    case '!=':
      if (value === null || test.value === undefined || test.value === null || Array.isArray(test.value)) return false;
      if (typeof value === 'number' && typeof test.value === 'number') return value !== test.value;
      return folded(String(value)) !== folded(String(test.value));
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (typeof value !== 'number' || typeof test.value !== 'number') return false;
      return test.op === '>'
        ? value > test.value
        : test.op === '>='
          ? value >= test.value
          : test.op === '<'
            ? value < test.value
            : value <= test.value;
    }
    default:
      return false;
  }
}

/** Whether a scope admitted a row as it stood, where that can be told exactly; false wherever it cannot. */
function scopeAdmitted(scope: RowScopeFilter, row: Readonly<Record<string, Scalar>>): boolean {
  return scope.groups.some((group) => group.length > 0 && group.every((test) => condition(row, test)));
}

/* ---------- one subscriber, one change ---------- */

/** The probes of one batch, shared by every subscriber of the same scope. */
export type ProbeMemo = Map<string, Promise<ReadonlySet<string>>>;

const keyOf = (image: Readonly<Record<string, Scalar>>, columns: readonly string[]): LiveKey | undefined => {
  const out: Record<string, string | number> = {};
  for (const column of columns) {
    const value = image[column];
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    out[column] = value;
  }
  return out;
};

/**
 * Add what `authority` may be told of `change` to `into`. `memo` shares the
 * batch's probes by fingerprint and keys, so forty readers of one scope cost
 * one statement.
 */
export async function deliverChange(
  change: StoredLiveChange,
  authority: LiveAuthority,
  into: LiveDelivery,
  memo: ProbeMemo,
): Promise<boolean> {
  let told = false;
  for (const entry of change.entries) {
    const grant = authority.tables.get(entry.table);
    if (!grant) continue;
    if (authority.tenant !== undefined && entry.tenant !== authority.tenant) continue;
    if (entry.kind === 'update' && grant.columns !== 'all' && entry.columns?.length) {
      const readable = grant.columns;
      if (!entry.columns.some((column) => readable.has(column))) continue;
    }
    const keys = await visibleKeys(entry, grant, authority, memo);
    if (keys === undefined) {
      into.unkeyed = true;
      continue;
    }
    if (keys !== 'many' && !keys.length) continue;
    told = true;
    let table = into.tables.get(grant.id);
    if (!table) into.tables.set(grant.id, (table = { keys: new Map(), kinds: new Set() }));
    table.kinds.add(entry.kind);
    if (keys === 'many' || table.keys === 'many') table.keys = 'many';
    else for (const key of keys) table.keys.set(keyText(key), key);
  }
  if (told && !(authority.actor && change.actor === authority.actor)) into.self = false;
  return told;
}

/* The keys of an entry this reader may hear of: all of them under `true`,
   `many` where it says so and the scope is `true`, undefined where it says
   `many` under a scope (not sendable), else those visible before or after. */
async function visibleKeys(
  entry: LiveEntry,
  grant: LiveGrant,
  authority: LiveAuthority,
  memo: ProbeMemo,
): Promise<readonly LiveKey[] | 'many' | undefined> {
  /* A key column the reader cannot read is a value they were never given: the table is named, the keys are not. */
  const keyed = grant.columns === 'all' || grant.key.every((column) => (grant.columns as ReadonlySet<string>).has(column));
  if (grant.scope === true) return entry.keys === 'many' || !keyed ? 'many' : entry.keys;
  if (entry.keys === 'many') return undefined;
  const scope = grant.scope;
  const visible = new Map<string, LiveKey>();
  for (const image of entry.before ?? []) {
    if (!scopeAdmitted(scope, image)) continue;
    const key = keyOf(image, grant.key);
    if (key) visible.set(keyText(key), key);
  }
  /* A delete leaves no row to ask about: only the before image can show it. */
  if (entry.kind !== 'delete') {
    const asked = entry.keys.filter((key) => !visible.has(keyText(key)));
    if (asked.length) {
      const id = `${grant.fingerprint}\u0000${entry.table}\u0000${asked.map(keyText).sort().join('\u0000')}`;
      let found = memo.get(id);
      if (!found) {
        found = authority.probe(entry.table, asked).catch((): ReadonlySet<string> => new Set());
        memo.set(id, found);
      }
      const admitted = await found;
      for (const key of asked) if (admitted.has(keyText(key))) visible.set(keyText(key), key);
    }
  }
  if (!visible.size) return [];
  return keyed ? [...visible.values()] : 'many';
}
