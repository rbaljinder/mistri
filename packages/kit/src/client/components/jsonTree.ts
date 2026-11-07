/**
 * What the JSON viewer knows beyond a value's layout: where each part is (its
 * path, said the way code reaches it), what a filter finds, what Copy takes,
 * what a string is when it is a color or an id, and the raw text as tokens to
 * tint. A module of its own, loaded with the viewer (JsonView.tsx is fetched
 * on demand): jsonModel.ts is on every first page for the grid's one-line
 * preview, and none of this is.
 */
import { isContainer, JsonBig, prettyJson, scalarOf, sizeOf } from './jsonModel.js';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * A child's path, as JavaScript would reach it: `a.b[2].c`, and a key that is
 * not an identifier in brackets, quoted as JSON quotes it — `headers["x-id"]`,
 * `[""]` — so a path pasted into a console or a jq-like query finds the value.
 * The path is also the node's identity in the viewer: two different places
 * can never be said the same way.
 */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  if (IDENTIFIER.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

/** The text a value is copied as: a string as itself (what is pasted into a search box), anything else as its JSON. */
export function copyTextOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof JsonBig) return value.text;
  if (value === undefined || value === null) return 'null';
  if (isContainer(value)) return prettyJson(value);
  return String(value);
}

/** A scalar's JSON text: what the filter reads beside what the reader sees. */
function rawTextOf(value: unknown): string {
  if (value instanceof JsonBig) return value.text;
  if (value === null || value === undefined) return 'null';
  return String(value);
}

/** What a scalar is said as on screen, where the filter can mark it. */
export function shownTextOf(value: unknown, locale: string | undefined): string {
  const said = scalarOf(value, locale);
  switch (said.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return said.on ? 'true' : 'false';
    case 'empty':
      return '""';
    default:
      return said.text;
  }
}

/** How many nodes a document has, counting no further than `cap`: the filter is offered only past a screenful. */
export function nodeCount(value: unknown, cap: number): number {
  let count = 0;
  const walk = (item: unknown): void => {
    if (count >= cap || !isContainer(item)) return;
    for (const child of Object.values(item)) {
      if (count >= cap) return;
      count += 1;
      walk(child);
    }
  };
  walk(value);
  return count;
}

/** Whether anything in the document folds: Expand all and Collapse all are offered only then. */
export function hasNested(value: unknown): boolean {
  return isContainer(value) && Object.values(value).some((child) => isContainer(child) && sizeOf(child) > 0);
}

/** What a filter found: the paths whose key matched, whose value matched, and the containers holding either. */
export interface Found {
  query: string;
  keys: ReadonlySet<string>;
  values: ReadonlySet<string>;
  /** Containers with a match somewhere inside them: these open, so every match is in view. */
  inside: ReadonlySet<string>;
  count: number;
}

/** The most nodes one filter reads: a document past this is searched in its first part, which is still more than any page shows. */
const SEARCH_LIMIT = 200_000;

/**
 * Every key and value the text appears in, case aside. A value is read both as
 * its JSON (`12500`, `true`, `null`, `2026-11-04T16:42:09Z`) and as the viewer
 * says it (`12,500`, `Nov 4, 2026`), so either spelling finds it. Array
 * positions are not keys: `0` would match every list.
 */
export function search(value: unknown, query: string, locale: string | undefined): Found | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  const keys = new Set<string>();
  const values = new Set<string>();
  const inside = new Set<string>();
  const has = (text: string) => text.toLocaleLowerCase().includes(needle);
  let read = 0;
  const walk = (item: unknown, path: string): boolean => {
    if (!isContainer(item)) return false;
    let found = false;
    const indexed = Array.isArray(item);
    for (const [key, child] of Object.entries(item)) {
      if (++read > SEARCH_LIMIT) break;
      const here = childPath(path, indexed ? Number(key) : key);
      if (!indexed && has(key)) {
        keys.add(here);
        found = true;
      }
      if (isContainer(child)) {
        if (walk(child, here)) {
          inside.add(here);
          found = true;
        }
      } else if (has(rawTextOf(child)) || has(shownTextOf(child, locale))) {
        values.add(here);
        found = true;
      }
    }
    return found;
  };
  walk(value, '');
  return { query: query.trim(), keys, values, inside, count: keys.size + values.size };
}

/** Whether a path is a match or holds one: an entry past a list's page is still drawn when it is. */
export function isFound(found: Found | null, path: string): boolean {
  return !!found && (found.keys.has(path) || found.values.has(path) || found.inside.has(path));
}

/** The pieces of a text around each place a query appears, case aside: the odd ones are the matches. */
export function splitOnMatches(text: string, query: string): string[] {
  if (!query) return [text];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.split(new RegExp(`(${escaped})`, 'giu'));
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A string that is a machine's word rather than a person's: a hex color (drawn
 * with a swatch of itself), a uuid, an email address. Each is set in the code
 * face, where `0`/`O` and `l`/`1` are told apart and every uuid lines up.
 */
export function textFace(text: string): { code: boolean; swatch?: string } {
  if (HEX_COLOR.test(text)) return { code: true, swatch: text };
  return { code: UUID.test(text) || EMAIL.test(text) };
}

/** One piece of a line of raw JSON, by what it is. */
export interface Token {
  kind: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space';
  text: string;
}

/* One token at a time from the line's start: a string (a key when a colon
   follows it), a number, a literal, a punctuation mark, a run of spaces. The
   text is the viewer's own pretty-printing, so it is always JSON; anything
   else (it cannot happen) is passed through as punctuation, never dropped. */
const TOKEN = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false)|(null)|([{}[\],:])|(\s+)/y;
const COLON_NEXT = /\s*:/y;

/** A line of JSON text as tokens; together their text is the line, character for character. */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < line.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(line);
    if (!m) {
      tokens.push({ kind: 'punct', text: line[at] });
      at += 1;
      continue;
    }
    const [text, string, number, boolean, nul, , space] = m;
    COLON_NEXT.lastIndex = at + text.length;
    const kind: Token['kind'] =
      string !== undefined
        ? COLON_NEXT.test(line)
          ? 'key'
          : 'string'
        : number !== undefined
          ? 'number'
          : boolean !== undefined
            ? 'boolean'
            : nul !== undefined
              ? 'null'
              : space !== undefined
                ? 'space'
                : 'punct';
    tokens.push({ kind, text });
    at += text.length;
  }
  return tokens;
}

/** A document's raw text, pretty-printed (big integers as their digits), a line of tokens at a time. */
export function rawLines(value: unknown): string[] {
  return prettyJson(value).split('\n');
}
