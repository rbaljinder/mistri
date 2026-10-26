/**
 * What the dev observer never shows, even to the author on their own machine:
 * a credential, and a column the connection or the App hides.
 *
 * The author may be browsing real data, over a connection whose `hidden`
 * rule exists exactly so that a password hash or a token is never on a
 * screen. So the observer masks on the way in — nothing unmasked is ever
 * kept in its buffer — by three rules:
 *
 * - by name: a header, a JSON key or a statement's column that is a
 *   credential (`authorization`, `cookie`, `password`, `*_token`, `secret`…),
 *   and every parameter of a statement on the auth store's own tables;
 * - by declaration: a column the connection's `hidden` rule or the App's
 *   `hidden` names, shown as masked with a "hidden" badge rather than left out,
 *   so the author sees that a value was there;
 * - by value: every secret this process was given — a connection's password,
 *   the auth secret, a token in the environment — replaced wherever it
 *   appears, in a log line as much as in a body.
 */
export const MASKED_CREDENTIAL = '[masked: credential]';
export const MASKED_HIDDEN = '[masked: hidden column]';

const CREDENTIAL =
  /pass(word|wd|phrase)?$|^pwd$|secret|token|api[-_]?key|^authorization$|cookie|credential|private[-_]?key|(^|_)hash$|salt|^otp$|^session(id|_id)?$|signature|^code_verifier$/i;
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-mistri-account',
  'x-csrf-token',
]);
/* An OpenID Connect sign-in's query parameters, in a request's address or a redirect's Location. */
const OAUTH_PARAMETERS =
  /(?<=[?&#])(code|state|nonce|id_token|access_token|refresh_token|code_verifier|code_challenge|login_hint)=[^&#\s"']*/g;
/* The auth store's tables: every value in them is someone's identity or credential. */
const AUTH_TABLES = /^(session|account|verification|user|accountaudit|mistri\.auth_.*|__mistri_api_token.*)$/i;

export interface MaskRules {
  /** Hidden columns, as table (id, bare name or "*") → column patterns with `*` wildcards. */
  hidden: ReadonlyArray<{ table: string; columns: readonly string[] }>;
  /** Secret values this process holds, replaced wherever they appear. */
  secrets: ReadonlySet<string>;
}

const wildcard = (pattern: string) =>
  new RegExp(
    `^${pattern
      .trim()
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

export class Masker {
  private hidden: Array<{ table: string; columns: RegExp[] }> = [];
  private secrets: string[] = [];
  constructor(rules: MaskRules = { hidden: [], secrets: new Set() }) {
    this.update(rules);
  }

  update(rules: MaskRules): void {
    this.hidden = rules.hidden.map((rule) => ({ table: rule.table.toLowerCase(), columns: rule.columns.map(wildcard) }));
    // Longest first, so a secret that contains another is replaced whole. Short strings are too likely to be words.
    this.secrets = [...rules.secrets].filter((secret) => secret.length >= 6).sort((a, b) => b.length - a.length);
  }

  credential(name: string): boolean {
    return CREDENTIAL.test(name);
  }

  /** Whether a column is hidden, in `table` when known. */
  hiddenColumn(column: string, table?: string): boolean {
    const bare = table?.split('.').pop()?.toLowerCase();
    return this.hidden.some(
      (rule) =>
        (rule.table === '*' || !table || rule.table === table.toLowerCase() || rule.table === bare) &&
        rule.columns.some((pattern) => pattern.test(column)),
    );
  }

  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join('••••••');
    /* A sign-in's addresses carry what signs someone in: an authorization
       code, its state and nonce, a token. Only a sign-in's: a list's `?code=`
       refinement is a column's value. */
    return /\/api\/auth\/|[?&]redirect_uri=/.test(out)
      ? out.replace(OAUTH_PARAMETERS, (_, name: string) => `${name}=${MASKED_CREDENTIAL}`)
      : out;
  }

  /** A value under a key: masked when the key is a credential or a hidden column, walked otherwise. */
  value(value: unknown, table?: string, depth = 0): unknown {
    if (typeof value === 'string') return this.json(value, table, depth) ?? this.text(value);
    if (value === null || typeof value !== 'object' || depth > 12) return value;
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => this.value(item, table, depth + 1));
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `(${value.byteLength} bytes)`;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value).slice(0, 500)) {
      out[key] = this.credential(key)
        ? MASKED_CREDENTIAL
        : this.hiddenColumn(key, table)
          ? MASKED_HIDDEN
          : this.value(inner, table, depth + 1);
    }
    return out;
  }

  /** A string that is JSON — an audit row's changes, a stored payload — masked by key like any object, and kept a string. */
  private json(text: string, table: string | undefined, depth: number): string | undefined {
    const trimmed = text.trimStart();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('[')) || text.length > 256 * 1024 || depth > 12) return undefined;
    try {
      return JSON.stringify(this.value(JSON.parse(text), table, depth + 1));
    } catch {
      return undefined;
    }
  }

  headers(headers: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      out[name] =
        CREDENTIAL_HEADERS.has(name.toLowerCase()) || this.credential(name)
          ? MASKED_CREDENTIAL
          : typeof value === 'string'
            ? this.text(value)
            : value;
    }
    return out;
  }

  /** A body: JSON walked by key, anything else masked by value. */
  body(body: string, table?: string): string {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(this.value(JSON.parse(trimmed), table), null, 2);
      } catch {
        /* a truncated body is text */
      }
    }
    return this.text(body).replace(
      /("?(?:password|token|secret|api[_-]?key)"?\s*[:=]\s*)("[^"]*"|[^\s&,}]+)/gi,
      `$1${JSON.stringify(MASKED_CREDENTIAL)}`,
    );
  }

  /** A statement's parameters, each masked when the column it binds is a credential or hidden. */
  params(sql: string, params: unknown, table?: string): unknown {
    if (table && AUTH_TABLES.test(table)) return Array.isArray(params) ? params.map(() => MASKED_CREDENTIAL) : MASKED_CREDENTIAL;
    if (params && typeof params === 'object' && !Array.isArray(params)) return this.value(params, table);
    if (!Array.isArray(params)) return params;
    const columns = boundColumns(sql);
    return params.map((param, index) => {
      if (
        param &&
        typeof param === 'object' &&
        !Array.isArray(param) &&
        !Buffer.isBuffer(param) &&
        !(param instanceof Uint8Array) &&
        !(param instanceof Date)
      ) {
        return this.value(param, table);
      }
      const column = columns.get(index);
      if (column && this.credential(column)) return MASKED_CREDENTIAL;
      if (column && this.hiddenColumn(column, table)) return MASKED_HIDDEN;
      return typeof param === 'bigint' ? param.toString() : this.value(param, table);
    });
  }
}

/* Placeholders in statement order: `?`, `$n`, `:name`/`@name` are counted as
   the drivers count them. Literals and comments are blanked first, so a `?`
   inside a string is not a parameter. */
function placeholders(sql: string): Array<{ at: number; index: number }> {
  const blank = sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"]|"")*"/g, (m) => m.replace(/[?$]/g, ' '));
  const out: Array<{ at: number; index: number }> = [];
  let ordinal = 0;
  for (const match of blank.matchAll(/\$(\d+)|\?/g)) out.push({ at: match.index, index: match[1] ? Number(match[1]) - 1 : ordinal++ });
  return out;
}

const COLUMN = String.raw`(?:"((?:[^"]|"")+)"|\x60([^\x60]+)\x60|([A-Za-z_][\w$]*))`;

/**
 * Which column each parameter binds, where the statement says so plainly:
 * `col = ?`, `col IN (?, ?)`, `col LIKE $2`, and an INSERT's column list
 * against its VALUES. A parameter this cannot place is shown as it is —
 * masking by name is the rule, and by value the net beneath it.
 */
export function boundColumns(sql: string): Map<number, string> {
  const map = new Map<number, string>();
  const marks = placeholders(sql);
  if (!marks.length) return map;
  const nameAt = (match: RegExpExecArray) => match[1] ?? match[2] ?? match[3];
  const comparison = new RegExp(`${COLUMN}\\s*(?:=|<>|!=|<=|>=|<|>|\\bI?LIKE\\b|\\bIS\\b|\\bIN\\s*\\()\\s*(?:\\(\\s*)?$`, 'i');
  for (const mark of marks) {
    const before = sql.slice(Math.max(0, mark.at - 200), mark.at);
    const match = comparison.exec(before);
    if (match) {
      map.set(mark.index, nameAt(match)!);
      continue;
    }
    // Inside an IN list, the column is before the opening parenthesis.
    const inList = new RegExp(`${COLUMN}\\s+IN\\s*\\(([^()]*)$`, 'i').exec(before);
    if (inList) map.set(mark.index, nameAt(inList)!);
  }
  const insert = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+\\S+\\s*\\(([^)]*)\\)\\s*VALUES\\s*`, 'i').exec(sql);
  if (insert) {
    const columns = insert[1].split(',').map((column) => column.trim().replace(/^["`[]|["`\]]$/g, ''));
    const start = insert.index + insert[0].length;
    const inValues = marks.filter((mark) => mark.at >= start);
    // Rows of VALUES repeat the column list; ON CONFLICT … SET is placed by the comparison rule above.
    const tail = sql.slice(start);
    const end = /\)\s*(ON\s+CONFLICT|ON\s+DUPLICATE|RETURNING|$)/i.exec(tail);
    const limit = end ? start + end.index + 1 : sql.length;
    inValues
      .filter((mark) => mark.at < limit)
      .forEach((mark, position) => {
        if (!map.has(mark.index)) map.set(mark.index, columns[position % columns.length]);
      });
  }
  return map;
}
