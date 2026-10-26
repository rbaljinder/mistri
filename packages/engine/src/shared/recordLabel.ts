/**
 * A record's name as a template: `recordLabel: 'PO-{id}'`, `'{product_id.name} × {qty}'`.
 *
 * A record label used to be one column or one path, and a table with no name
 * of its own — a purchase order, an order line — was titled by its key: "3".
 * A template says the name in words around the columns that make it, and
 * the name is computed where every other value is, in the statement: a list,
 * a picker, a breadcrumb and a reference to the record all read the same
 * `$label` path, sort by it and search it, on every engine, with nothing for
 * the browser to assemble from columns it may not have fetched.
 *
 * `$label` is a path's last segment (`purchase_order_id.$label`), legal
 * where a table carries a template (`TableMeta.labelTemplate`, which an App
 * serves), and compiled from the view's `labels` (prefix → template), which
 * the server's read fills from that catalog — never from a request.
 */

/** The last segment that names a record's templated label. */
export const LABEL_SEGMENT = '$label';

/* A path part may carry a mask, which only the server writes (appRecordLabels.ts):
   `{token|masked}` draws a placeholder for any value, `{token|masked:ENC:}` for a
   value starting with that prefix — a column's `masked` display rule
   reaching the record's name, which is computed in the statement. */
type LabelPart = { text: string } | { path: string; mask?: { prefix?: string }; words?: Record<string, string> };
const MASK_MARK = '|masked';
/* Or its words: `{token|words:…}`, the column's display rule (`values`,
   `humanize`, a vocabulary's words) reaching the name the way it reaches a
   cell, so a visit is "Ada Park · Annual physical", not "… · annual
   physical". The map is URI-encoded JSON, so no brace or bar in a word
   ends the field early. */
const WORDS_MARK = '|words:';

/** Whether an authored record label is a template rather than a path. */
export const isLabelTemplate = (text: unknown): text is string => typeof text === 'string' && text.includes('{');

/** The prefix a `$label` path hangs off ('' for the base's own), or undefined for any other path. */
export function labelPrefix(path: string): string | undefined {
  if (path === LABEL_SEGMENT) return '';
  return path.endsWith(`.${LABEL_SEGMENT}`) ? path.slice(0, -LABEL_SEGMENT.length - 1) : undefined;
}

/* Literal text is written into the statement as a quoted string, so it is
   held to what every engine reads the same way inside quotes: no backslash
   (MySQL's escape), no control characters. A quote is doubled when written. */
const unsafe = (character: string) => character === '\\' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f;
const FIELD = /^[A-Za-z_$][\w$]*(?:\+[A-Za-z_$][\w$]*)*(?:\.[A-Za-z_$][\w$]*(?:\+[A-Za-z_$][\w$]*)*)*$/;

/** A template's parts, or why it is not one. */
export function parseLabelTemplate(template: string): { parts: LabelPart[]; paths: string[] } | { problem: string } {
  /* The author's length: the words the server marks a field with are not theirs. */
  if (template.replace(/\|words:[^}]*/g, '').length > 200) return { problem: 'a record label template is at most 200 characters.' };
  const parts: LabelPart[] = [];
  const paths: string[] = [];
  let rest = template;
  while (rest) {
    const open = rest.indexOf('{');
    const close = rest.indexOf('}');
    if (close !== -1 && (open === -1 || close < open)) return { problem: `"${template}" has a "}" with no "{" before it.` };
    if (open === -1) {
      parts.push({ text: rest });
      break;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open) });
    const end = rest.indexOf('}', open);
    if (end === -1) return { problem: `"${template}" opens a "{" it never closes.` };
    let field = rest.slice(open + 1, end);
    let words: Record<string, string> | undefined;
    const worded = field.indexOf(WORDS_MARK);
    if (worded !== -1) {
      words = readWords(field.slice(worded + WORDS_MARK.length));
      if (!words) return { problem: `"{${field}}" in "${template}" is not a column or a reference path, like {id} or {customer_id.name}.` };
      field = field.slice(0, worded);
    }
    const marked = field.indexOf(MASK_MARK);
    const path = (marked === -1 ? field : field.slice(0, marked)).trim();
    const after = marked === -1 ? undefined : field.slice(marked + MASK_MARK.length);
    if (!FIELD.test(path) || path.split('.').includes(LABEL_SEGMENT) || (after !== undefined && after !== '' && !after.startsWith(':'))) {
      return { problem: `"{${field}}" in "${template}" is not a column or a reference path, like {id} or {customer_id.name}.` };
    }
    parts.push({ path, ...(after === undefined ? {} : { mask: after ? { prefix: after.slice(1) } : {} }), ...(words ? { words } : {}) });
    paths.push(path);
    rest = rest.slice(end + 1);
  }
  if (!paths.length) return { problem: `"${template}" names no column; put one in braces, like "PO-{id}".` };
  for (const part of parts) {
    if ('text' in part && [...part.text].some(unsafe)) {
      return { problem: `"${template}" holds a backslash or a control character, which a record label cannot.` };
    }
  }
  return { parts, paths };
}

/* A words map as a field carries it, or undefined when it is not one: every
   key and word a string every engine reads alike inside quotes. */
function readWords(encoded: string): Record<string, string> | undefined {
  let map: unknown;
  try {
    map = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const entries = Object.entries(map as Record<string, unknown>);
  if (!entries.length || entries.some(([key, word]) => typeof word !== 'string' || [...key, ...word].some(unsafe))) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** A template field for a path whose stored values are said as words, as the server writes it into a served template. */
export const wordedField = (path: string, words: Record<string, string>): string =>
  `{${path}${WORDS_MARK}${encodeURIComponent(JSON.stringify(words))}}`;

/** A template field for a masked path, as the server writes it into a served template. */
export const maskedField = (path: string, prefix?: string): string => `{${path}${MASK_MARK}${prefix ? `:${prefix}` : ''}}`;

/** Whether an authored template writes a mask itself: that is the column's display rule's to say. */
export const writesMask = (template: string): boolean => template.includes(MASK_MARK) || template.includes(WORDS_MARK);

/**
 * The name a record with no name of its own is given: its noun and its key,
 * "Purchase order #3", rather than the bare key a title and a breadcrumb
 * used to show. One key column only: a composite key is not one number.
 */
export function nounTemplate(noun: string, key: string): string {
  const word =
    [...noun]
      .filter((character) => character !== '{' && character !== '}' && !unsafe(character))
      .join('')
      .trim() || 'Record';
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} #{${key}}`;
}
