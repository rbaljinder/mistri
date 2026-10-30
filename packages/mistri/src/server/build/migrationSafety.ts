/**
 * `mistri check --deploy`, the migrations step: whether a migration that is
 * about to run would break the code that is still running.
 *
 * A deploy replaces instances one at a time and migrates before or while it
 * does, so for a while the old code runs against the new schema. A statement
 * that removes or reshapes something the old code reads or writes (a dropped
 * column, a renamed table, a new NOT NULL column the old INSERT does not fill)
 * turns that window into errors. The safe order is expand, deploy, contract:
 * add the new shape beside the old, ship code that uses it, remove the old
 * shape in a later migration. A statement that is that last step, on purpose,
 * says so with a `-- mistri: contract` comment on the line before it, which
 * makes it a note.
 *
 * The reading is deliberately tolerant and shallow: comments, string literals,
 * dollar-quoted bodies and quoted identifiers are blanked (keeping every line
 * where it was), the rest is split on top-level semicolons and each statement
 * is matched by shape. It is not a SQL parser; it names the common hazards and
 * will miss an unusual spelling. A statement it cannot place is not reported.
 */

type MigrationHazard =
  | 'DROP TABLE'
  | 'DROP COLUMN'
  | 'RENAME TABLE'
  | 'RENAME COLUMN'
  | 'ALTER COLUMN TYPE'
  | 'SET NOT NULL'
  | 'ADD COLUMN NOT NULL without DEFAULT'
  | 'DROP VIEW'
  | 'DROP FUNCTION';

export interface MigrationFinding {
  code: 'migration-breaks-running-code';
  /** A note for a statement marked `-- mistri: contract`. */
  severity: 'warning' | 'error' | 'info';
  file: string;
  line: number;
  kind: MigrationHazard;
  message: string;
  fix: string;
}

const WHY: Record<MigrationHazard, { why: string; fix: string }> = {
  'DROP TABLE': {
    why: 'the code still running reads and writes this table, and fails on its next query',
    fix: 'Expand/contract: stop using the table in code and deploy that, then drop it in a later migration marked `-- mistri: contract`.',
  },
  'DROP COLUMN': {
    why: 'the code still running selects or inserts this column, and fails on its next query',
    fix: 'Expand/contract: deploy code that no longer reads or writes the column, then drop it in a later migration marked `-- mistri: contract`.',
  },
  'RENAME TABLE': {
    why: 'the code still running uses the old name, which no longer exists',
    fix: 'Expand/contract: create the new table (or a view under the new name), move reads and writes over and deploy, then drop the old one in a later migration marked `-- mistri: contract`.',
  },
  'RENAME COLUMN': {
    why: 'the code still running uses the old name, which no longer exists',
    fix: 'Expand/contract: add the new column and fill it (a trigger keeps both in step), deploy code that uses it, then drop the old one in a later migration marked `-- mistri: contract`.',
  },
  'ALTER COLUMN TYPE': {
    why: 'it rewrites the table under a lock and the code still running may send or expect the old type',
    fix: 'Expand/contract: add a column of the new type, backfill it, deploy code that uses it, then drop the old column in a later migration marked `-- mistri: contract`.',
  },
  'SET NOT NULL': {
    why: 'the code still running may write NULL here, and its inserts and updates start failing',
    fix: 'Expand/contract: deploy code that always writes the column, backfill the NULLs, then set NOT NULL in a later migration marked `-- mistri: contract`.',
  },
  'ADD COLUMN NOT NULL without DEFAULT': {
    why: 'the code still running does not know the column, so its inserts leave it out and fail',
    fix: 'Expand: add the column with a DEFAULT (or nullable), deploy code that sets it, then tighten it in a later migration marked `-- mistri: contract`.',
  },
  'DROP VIEW': {
    why: 'the code still running may select from this view',
    fix: 'Expand/contract: stop reading the view in code and deploy that, then drop it in a later migration marked `-- mistri: contract`. To change a view, use CREATE OR REPLACE VIEW.',
  },
  'DROP FUNCTION': {
    why: 'the code still running, or a trigger or view, may call this function',
    fix: 'Expand/contract: stop calling the function and deploy that, then drop it in a later migration marked `-- mistri: contract`. To change one, use CREATE OR REPLACE FUNCTION.',
  },
};

interface Cleaned {
  /** The text with comments, strings, quoted identifiers and dollar-quoted bodies blanked; every newline kept. */
  text: string;
  /** Line numbers (1-based) of a `-- mistri: contract` comment. */
  markers: Set<number>;
}

const MARKER = /mistri:\s*contract\b/i;

function clean(sql: string): Cleaned {
  const out: string[] = [];
  const markers = new Set<number>();
  let line = 1;
  let i = 0;
  const blank = (chunk: string) => chunk.replace(/[^\n]/g, ' ');
  const take = (end: number, keep: boolean) => {
    const chunk = sql.slice(i, end);
    out.push(keep ? chunk : blank(chunk));
    line += chunk.split('\n').length - 1;
    i = end;
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      if (MARKER.test(sql.slice(i, stop))) markers.add(line);
      take(stop, false);
    } else if (rest.startsWith('/*')) {
      // PostgreSQL nests block comments.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      if (MARKER.test(sql.slice(i, j))) markers.add(line);
      take(j, false);
    } else if (rest[0] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      take(Math.min(j + 1, sql.length), false);
    } else if (rest[0] === '"') {
      // A quoted identifier stays one word, so `"drop"` is not a keyword and `"order items"` is not two.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j += 1;
      }
      const end = Math.min(j + 1, sql.length);
      out.push(`"_"${blank(sql.slice(i + 3, end))}`);
      line += sql.slice(i, end).split('\n').length - 1;
      i = end;
    } else {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        take(close === -1 ? sql.length : close + tag[0].length, false);
      } else take(i + 1, true);
    }
  }
  return { text: out.join(''), markers };
}

interface Statement {
  text: string;
  line: number;
}

/** Split on semicolons outside parentheses (a CREATE FUNCTION body is already blanked). */
function statements(text: string): Statement[] {
  const found: Statement[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) found.push({ text: raw.trim().replace(/\s+/g, ' '), line: text.slice(0, start + lead).split('\n').length });
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return found;
}

/** Top-level comma-separated parts of `text` (ALTER TABLE takes several actions). */
function split(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth = Math.max(0, depth - 1);
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const NAME = String.raw`(?:"_"|[\w$]+)(?:\s*\.\s*(?:"_"|[\w$]+))?`;
const ALTER_TABLE = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}\s+(.*)$`, 'is');
const ADD_COLUMN =
  /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|INDEX|KEY)\b)\S+\s+\S+/i;

function hazardsOf(statement: string): MigrationHazard[] {
  const found: MigrationHazard[] = [];
  if (/^DROP\s+TABLE\b/i.test(statement)) return ['DROP TABLE'];
  if (/^DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i.test(statement)) return ['DROP VIEW'];
  if (/^DROP\s+(?:FUNCTION|PROCEDURE)\b/i.test(statement)) return ['DROP FUNCTION'];
  if (/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+RENAME\s+TO\b/i.test(statement)) return ['RENAME TABLE'];
  const alter = ALTER_TABLE.exec(statement);
  if (!alter) return found;
  for (const action of split(alter[1])) {
    if (/^DROP\s+COLUMN\b/i.test(action)) found.push('DROP COLUMN');
    else if (
      /^DROP\s+(?!CONSTRAINT\b|COLUMN\b)\S+\s*$/i.test(action) ||
      /^DROP\s+IF\s+EXISTS\s+\S+\s*(?:CASCADE|RESTRICT)?\s*$/i.test(action)
    )
      found.push('DROP COLUMN');
    else if (/^RENAME\s+(?:COLUMN\s+)?\S+\s+TO\b/i.test(action) && !/^RENAME\s+CONSTRAINT\b/i.test(action)) found.push('RENAME COLUMN');
    else if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(action)) found.push('ALTER COLUMN TYPE');
    else if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b/i.test(action)) found.push('SET NOT NULL');
    else if (
      ADD_COLUMN.test(action) &&
      /\bNOT\s+NULL\b/i.test(action) &&
      !/\b(?:DEFAULT|GENERATED|AUTOINCREMENT|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(action)
    )
      found.push('ADD COLUMN NOT NULL without DEFAULT');
  }
  return found;
}

/**
 * The statements in `sql` that break the code currently running. `strict` makes a finding an error rather than a
 * warning; a statement acknowledged with `-- mistri: contract` is a note either way.
 */
export function migrationFindings(file: string, sql: string, options: { strict?: boolean } = {}): MigrationFinding[] {
  const { text, markers } = clean(sql);
  const lines = text.split('\n');
  const acknowledged = (start: number): boolean => {
    if (markers.has(start)) return true;
    // The marker may sit anywhere in the comment lines directly above the statement.
    for (let n = start - 1; n >= 1 && !lines[n - 1].trim(); n -= 1) if (markers.has(n)) return true;
    return false;
  };
  const found: MigrationFinding[] = [];
  for (const statement of statements(text)) {
    for (const kind of hazardsOf(statement.text)) {
      const { why, fix } = WHY[kind];
      const ack = acknowledged(statement.line);
      found.push({
        code: 'migration-breaks-running-code',
        severity: ack ? 'info' : options.strict ? 'error' : 'warning',
        file,
        line: statement.line,
        kind,
        message: ack
          ? `${file}:${statement.line} ${kind}, marked as a contract step: ${why}, so deploy the code that stopped using it first.`
          : `${file}:${statement.line} ${kind}: ${why}.`,
        fix: ack ? 'Confirm no running version still depends on it.' : fix,
      });
    }
  }
  return found;
}
