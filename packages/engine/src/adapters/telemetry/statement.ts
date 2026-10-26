/**
 * What a statement is, said without anything it carries: its kind and the
 * table it names first. `SELECT loan`, `UPDATE "orders"`, `BEGIN`. That is
 * the OpenTelemetry `db.query.summary`, and it is all a database span
 * exports — never the text, whose literals can be anybody's data, and never
 * a parameter.
 */
const KINDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'START',
  'SET',
  'SHOW',
  'PRAGMA',
  'EXPLAIN',
  'CREATE',
  'ALTER',
  'DROP',
  'ANALYZE',
  'VACUUM',
  'LOCK',
  'CALL',
  'VALUES',
  'REPLACE',
  'MERGE',
  'TRUNCATE',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'DECLARE',
  'FETCH',
  'CLOSE',
  'COPY',
  'GRANT',
  'REVOKE',
  'KILL',
  'USE',
  'DO',
  'RESET',
  'DISCARD',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'ATTACH',
  'DETACH',
  'REINDEX',
]);

interface StatementSummary {
  /** `db.operation.name`: the statement's first keyword, upper-cased, or `OTHER`. */
  operation: string;
  /** `db.collection.name`: the first table it reads or writes, unquoted, when one can be told. */
  table?: string;
  /** `db.query.summary`. */
  summary: string;
}

/* A quoted identifier or a bare one, optionally schema-qualified. Only the
   last part is kept: a schema name says nothing a table name does not, and a
   tenant's schema is the tenant. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = new RegExp(`^(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s*\\.\\s*(${IDENT}))?`);
const unquote = (name: string) =>
  name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : /^[`[]/.test(name) ? name.slice(1, -1) : name;

/** Strip comments and string literals, so a keyword inside either is never read as the statement's. */
function skeleton(text: string, limit = 4000): string {
  return text
    .slice(0, limit)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function tableAfter(text: string, keyword: RegExp): string | undefined {
  const at = keyword.exec(text);
  if (!at) return undefined;
  const rest = text.slice(at.index + at[0].length).trimStart();
  if (rest.startsWith('(')) return undefined;
  const match = QUALIFIED.exec(rest);
  if (!match) return undefined;
  const last = match[3] ?? match[2] ?? match[1];
  const name = unquote(last);
  // A keyword where a name was expected (`FROM (SELECT…)`, `DELETE FROM ONLY`) is no table.
  return /^(select|only|lateral|unnest|json_each|generate_series|values)$/i.test(name) ? undefined : name.slice(0, 128);
}

export function summarizeStatement(text: string): StatementSummary {
  const body = skeleton(text).trim();
  const word = /^[A-Za-z]+/.exec(body)?.[0]?.toUpperCase();
  const operation = word && KINDS.has(word) ? word : 'OTHER';
  let table: string | undefined;
  switch (operation) {
    case 'SELECT':
    case 'WITH':
    case 'DELETE':
    case 'EXPLAIN':
      table = tableAfter(body, /\bFROM\s+/i);
      break;
    case 'INSERT':
    case 'REPLACE':
      table = tableAfter(body, /\bINTO\s+/i);
      break;
    case 'UPDATE':
      table = tableAfter(body, /^UPDATE\s+(?:ONLY\s+)?/i);
      break;
    case 'TRUNCATE':
      table = tableAfter(body, /^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?/i);
      break;
    case 'PRAGMA':
      table = /^PRAGMA\s+(?:\w+\.)?(\w+)/i.exec(body)?.[1]?.toLowerCase();
      break;
    default:
      break;
  }
  // A WITH names its CTEs first; the statement it wraps is the one that acts.
  if (operation === 'WITH') {
    const main = /\)\s*(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*$/i.exec(body);
    if (main) {
      const inner = summarizeStatement(main[0].slice(main[0].indexOf(main[1])));
      return { operation: inner.operation, ...(inner.table ? { table: inner.table } : {}), summary: inner.summary };
    }
  }
  return { operation, ...(table ? { table } : {}), summary: table && operation !== 'PRAGMA' ? `${operation} ${table}` : operation };
}

/**
 * A statement's shape for grouping: the text with literals and numbers
 * blanked, whitespace folded. Two runs of one shape with different
 * parameters are the N+1 pattern the observer flags. Local only.
 */
export function statementShape(text: string): string {
  // Whole, not cut short: a long shared prefix (a row scope's CTEs) would make ten different statements one shape.
  return skeleton(text, 50_000)
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}
