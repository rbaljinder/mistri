/** Shared catalog evidence for PostgreSQL command stores, independent of their writers. */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { EPOCHLESS_TTL_MS } from '@mistriwork/engine/adapters/postgresSchemaEpoch.js';
import { RUNTIME_SCHEMA, runtimeName } from '@mistriwork/engine/shared/runtimeTables.js';

let layoutWindow = EPOCHLESS_TTL_MS;
/** For a suite whose cases alter a store's layout and expect its very next transaction to refuse: zero describes the
    layout in every transaction, as every transaction did before the window. Returns what it replaced. */
export function trustStoreLayoutsFor(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('A layout trust window is a whole number of milliseconds.');
  const was = layoutWindow;
  layoutWindow = ms;
  return was;
}

/**
 * A store's layout attestations, kept across its transactions. A background
 * store's poller ran one in every transaction, a catalog description per store
 * a second or so even on a database with nothing to do: most of PlanetScale's
 * CPU under a large tenant App. A layout that passed stands for the window the adapter's
 * own catalog answers stand for without the epoch store (EPOCHLESS_TTL_MS), and
 * is forgotten at once when a transaction of the store fails other than by a
 * refusal of its own (a table or column that moved fails a statement). The
 * meta rows the attestations also read are data, and are read every time.
 * One per opened store, so one database: nothing here outlives the store.
 */
export interface LayoutTrust {
  /** `attest` (the description and its comparison), unless the layout under `prefix` passed within the window. */
  through(prefix: string, attest: () => Promise<void>): Promise<void>;
  forget(): void;
}

export function layoutTrust(window: number = layoutWindow, clock: () => number = Date.now): LayoutTrust {
  const passed = new Map<string, number>();
  return {
    async through(prefix, attest) {
      const at = passed.get(prefix),
        now = clock();
      if (at !== undefined && now >= at && now - at < window) return;
      passed.delete(prefix);
      await attest();
      passed.set(prefix, now);
    },
    forget: () => passed.clear(),
  };
}

export interface PostgresRelationDescription {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  columns: Array<{ name: string; type: string; notnull: boolean; collation: string | null; default: string | null }>;
  constraints: string[];
  indexes: string[];
  triggers: number;
  rules: number;
  policies: number;
}

/**
 * Every relation in the runtime schema (shared/runtimeTables.ts) whose name
 * starts with the store's prefix, given as the store names it (`__mistri_job_`,
 * which is `job_` inside the schema), with everything that could change what a
 * write to it means. Relations that are themselves indexes are listed under
 * their table instead, so an index added by hand shows up where it acts.
 * Case-insensitive on the prefix, like the SQLite catalog read, so a look-alike
 * in another case still collides. Other schemas are the App's: a table there
 * cannot be the store, whatever it is called, and the App catalog refuses one
 * named with the reserved prefix anyway (adapters/reservedSql.ts).
 * NOT NULL is read off the column: PostgreSQL 18 also catalogues it as a
 * constraint and earlier versions do not, and the layout is the same on both.
 */
export async function describePostgresRelations(client: PgQuery, prefix: string): Promise<PostgresRelationDescription[]> {
  const name = runtimeName('postgres', prefix);
  const result = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.relrowsecurity AS rls,
            COALESCE((SELECT json_agg(json_build_object(
                'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
                'collation', (SELECT l.collname FROM pg_collation l WHERE l.oid = a.attcollation),
                'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
               FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS columns,
            COALESCE((SELECT json_agg(x.def) FROM (SELECT pg_get_constraintdef(co.oid) AS def
               FROM pg_constraint co WHERE co.conrelid = c.oid AND co.contype <> 'n') x), '[]'::json) AS constraints,
            COALESCE((SELECT json_agg(x.def) FROM (SELECT pg_get_indexdef(i.indexrelid) AS def
               FROM pg_index i WHERE i.indrelid = c.oid) x), '[]'::json) AS indexes,
            (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)::int AS triggers,
            (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = c.oid)::int AS rules,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $3 AND lower(substr(c.relname, 1, $2)) = $1 AND c.relkind <> 'i'`,
    [name.toLowerCase(), name.length, RUNTIME_SCHEMA],
  );
  return foldRelations(result.rows as unknown as PostgresRelationDescription[])
    .map((row) => ({
      ...row,
      constraints: row.constraints.map(unqualified).sort(byCodeUnit),
      indexes: [...row.indexes].sort(byCodeUnit),
    }))
    .sort((a, b) => byCodeUnit(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`));
}

/* A foreign key between two runtime tables prints its target qualified where
   the session's search_path leaves the runtime schema out, the usual case, and
   unqualified where a role's path names it: the same key, read one way. */
const QUALIFIED_TARGET = new RegExp(`\\bREFERENCES ${RUNTIME_SCHEMA}\\.`, 'g');
const unqualified = (constraint: string) => constraint.replace(QUALIFIED_TARGET, 'REFERENCES ');

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A constraint as PostgreSQL would read it back from a dump. `x BETWEEN 1 AND 9 AND y`
 * is stored, and first rendered, as `((x >= 1 AND x <= 9) AND y)`; pg_dump prints that
 * and the restore parses it again, where the grammar folds a left operand that is the
 * same operator into one list: `(x >= 1 AND x <= 9 AND y)`. The two are the same
 * constraint, so a strict comparison of the text refused every restored database as
 * "could not be verified". Both sides of a comparison are put in the folded form here,
 * which loosens nothing: only a left operand of the identical operator loses its
 * parentheses, and any other difference in the text still differs. (Letting the server
 * canonicalize instead would need the table to parse each CHECK against, per relation,
 * in a transaction that attestation, a read, does not otherwise open.)
 */
export function foldConstraint(text: string): string {
  const fold = (source: string): string => {
    let out = '';
    for (let i = 0; i < source.length;) {
      const ch = source[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === ch) {
            if (source[j + 1] === ch) j += 2;
            else break;
          } else j++;
        }
        out += source.slice(i, j + 1);
        i = j + 1;
      } else if (ch === '(') {
        let depth = 0;
        let j = i;
        for (; j < source.length; j++) {
          const c = source[j];
          if (c === "'" || c === '"') {
            j++;
            while (j < source.length && !(source[j] === c && source[j + 1] !== c)) j += source[j] === c ? 2 : 1;
          } else if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        out += `(${fold(source.slice(i + 1, j))})`;
        i = j + 1;
      } else {
        out += ch;
        i++;
      }
    }
    return unwrapLeft(out);
  };
  return fold(text);
}

/** At one level, `(a AND b) AND c` becomes `a AND b AND c`; likewise OR. */
function unwrapLeft(level: string): string {
  for (const op of [' AND ', ' OR ']) {
    for (;;) {
      if (!level.startsWith('(') || !level.includes(op)) break;
      const close = matching(level);
      if (close < 0 || !level.startsWith(op, close + 1)) break;
      const inner = level.slice(1, close);
      if (!topLevel(inner).includes(op) || topLevel(inner).includes(op === ' AND ' ? ' OR ' : ' AND ')) break;
      level = inner + level.slice(close + 1);
    }
  }
  return level;
}

/** The index of the ")" closing the "(" that opens the text, or -1. */
function matching(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && !(text[i] === c && text[i + 1] !== c)) i += text[i] === c ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The text with everything inside parentheses or quotes blanked out. */
function topLevel(text: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && !(text[i] === c && text[i + 1] !== c)) i += text[i] === c ? 2 : 1;
      out += '_';
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

/** Descriptions with each constraint folded and the list re-sorted: what attestation compares. */
export function foldRelations<T extends { constraints: string[] }>(relations: readonly T[]): T[] {
  return relations.map((relation) => ({
    ...relation,
    constraints: relation.constraints.map(foldConstraint).sort(byCodeUnit),
  }));
}
