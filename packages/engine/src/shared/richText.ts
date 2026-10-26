/**
 * Rich text: what a stored value may hold, and its plain words.
 *
 * A rich text value is HTML, kept to one small allowlist — paragraphs and
 * line breaks, bold, italic, strike and underline, links, three heading
 * levels, bullet, numbered and task lists, a quote, inline code and a code
 * block, simple tables, an @-mention, and a picture that is one of this App's
 * own attachments. Nothing else: no style, no script, no event handler, no
 * class but a code block's language.
 *
 * Two sides read this one list. The server writes nothing else
 * (server/richText.ts, on every write of a rich text column or input), and
 * the browser draws nothing else (components/RichText.tsx), whatever the
 * database holds: a value written outside the App — by SQL, by another
 * program, before the column was declared rich — is drawn through the same
 * allowlist, never trusted for being in the database.
 *
 * The plain text twin is derived, never stored: `richTextPlain` reads the
 * words out of a value, for a list cell's excerpt, a notice, a plain email
 * and an export. A search of the column matches the stored HTML's words, so
 * a word reads the same; a tag name is not a word anyone searches for.
 */

/** Where a rich text value is said in one line: a list cell, a card, a timeline row's excerpt. */
const RICH_TEXT_EXCERPT = 160;

/**
 * A stored mention's handle (`data-id`): the value of the people's `by`
 * column — a word, a number, a UUID, or an email. An email's `@` and `+` are
 * in it: a people resource keyed by email was offered nobody, and a mention
 * of one was dropped on save and never told.
 */
export const MENTION_HANDLE = /^[A-Za-z0-9_][A-Za-z0-9_.+@-]{0,253}$/;

/** The most words after an @ that are each looked for (shared/mentionLookup.ts): "@Morgan Tr" narrows two Morgans,
    and a space after the second word ends the name, so the list the editor offers closes there. */
export const MENTION_QUERY_WORDS = 2;

/** The most characters a rich text value holds, as stored HTML, unless its field says fewer. */
export const RICH_TEXT_MOST = 200_000;

/**
 * The elements a value may hold, each with the attributes it keeps. An
 * attribute's value is judged by `richTextAttribute` below.
 */
export const RICH_TEXT_ELEMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  p: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  s: [],
  u: [],
  a: ['href'],
  h2: [],
  h3: [],
  h4: [],
  ul: ['data-type'],
  ol: ['start'],
  li: ['data-type', 'data-checked'],
  blockquote: [],
  code: ['class'],
  pre: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  span: ['data-type', 'data-id', 'data-kind'],
  img: ['src', 'alt'],
});

/** Elements dropped with everything inside them: their content is code or chrome, never words. */
export const RICH_TEXT_DROPPED = Object.freeze([
  'script',
  'style',
  'template',
  'iframe',
  'object',
  'embed',
  'noscript',
  'textarea',
  'select',
  'button',
  'svg',
  'math',
  'head',
  'title',
]);

/** A link's address: the web, or mail. Everything else (javascript:, data:, a relative path) is no link. */
export function richTextHref(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\s\p{Cc}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return value;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return value;
  } catch {
    /* not an absolute address */
  }
  return undefined;
}

/** The parameters an attachment's picture address may carry, and nothing else. */
const IMAGE_PARAMS = new Set(['table', 'key', 'inline', 'variant']);

/**
 * A picture's address, when it is one of this App's own attachments: the file
 * route's inline mode for one row of a file resource,
 * `/api/file?table=<resource>&key=<the row's key as JSON>&inline=1`. Relative
 * to the App, so a mount point or a proxy's base path is the page's to add
 * (`served`). `tables` narrows it to the App's file resources where the
 * caller knows them (the server does). Anything else is no picture.
 */
export function richTextImage(
  raw: string,
  tables?: ReadonlySet<string>,
): { table: string; key: Record<string, string | number> } | undefined {
  const value = raw.trim();
  if (!value.startsWith('/api/file?') || value.length > 1024) return undefined;
  const params = new URLSearchParams(value.slice('/api/file?'.length));
  const names = [...params.keys()];
  if (names.some((name) => !IMAGE_PARAMS.has(name)) || new Set(names).size !== names.length) return undefined;
  const table = params.get('table');
  if (!table || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(table) || (tables && !tables.has(table))) return undefined;
  if (params.get('inline') !== '1') return undefined;
  const variant = params.get('variant');
  if (variant !== null && variant !== 'thumb') return undefined;
  let key: unknown;
  try {
    key = JSON.parse(params.get('key') ?? '');
  } catch {
    return undefined;
  }
  if (
    !key ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    !Object.keys(key).length ||
    Object.keys(key).length > 4 ||
    Object.entries(key).some(
      ([column, item]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(column) ||
        !((typeof item === 'string' && item.length <= 256) || (typeof item === 'number' && Number.isFinite(item))),
    )
  )
    return undefined;
  return { table, key: key as Record<string, string | number> };
}

/** The address a picture of one attachment row is stored as: the same form `richTextImage` reads. */
export function richTextImageAddress(table: string, key: Record<string, string | number>): string {
  return `/api/file?${new URLSearchParams({ table, key: JSON.stringify(key), inline: '1' })}`;
}

/**
 * Whether an attribute's value is kept on an element: a link's address, a
 * picture's, a task item's state, a list's kind, a mention's handle and
 * whether it names a group, a code block's language, a cell's span. Undefined drops it. The caller has already
 * checked the attribute is one the element keeps.
 */
export function richTextAttribute(element: string, name: string, value: string, images?: ReadonlySet<string>): string | undefined {
  if (name === 'href') return richTextHref(value);
  if (name === 'src') return richTextImage(value, images) ? value.trim() : undefined;
  if (name === 'alt') return value.slice(0, 300);
  if (name === 'data-type') {
    if (element === 'ul') return value === 'taskList' ? value : undefined;
    if (element === 'li') return value === 'taskItem' ? value : undefined;
    if (element === 'span') return value === 'mention' ? value : undefined;
    return undefined;
  }
  if (name === 'data-checked') return value === 'true' || value === 'false' ? value : undefined;
  if (name === 'data-kind') return element === 'span' && value === 'group' ? value : undefined;
  if (name === 'data-id') return MENTION_HANDLE.test(value) ? value : undefined;
  if (name === 'class') return element === 'code' && /^language-[A-Za-z0-9_+-]{1,32}$/.test(value) ? value : undefined;
  if (name === 'start' || name === 'colspan' || name === 'rowspan') return /^[1-9][0-9]{0,2}$/.test(value) ? value : undefined;
  return undefined;
}

/** Elements that end a line of the plain text: blocks, list items, a table's cells and rows. */
const BLOCK = /^(?:p|h[1-6]|li|blockquote|pre|tr|div|ul|ol|table|thead|tbody)$/i;

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/* Text that ends in a list item's dash or box: the item's first paragraph goes on that line. */
const ITEM_MARK = /\n(?:- |\[[ x]\] )[^\S\n]*$/;

/**
 * A rich text value's words: tags out, entities read, one line per block, a
 * list item after a dash, a task with its box, a picture as its description.
 * Pure text, never markup, whatever the value held — it is drawn as text.
 */
export function richTextPlain(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  let text = '';
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->/g;
  let at = 0;
  const dropped = new Set<string>(RICH_TEXT_DROPPED);
  let skipping: string | undefined;
  /* Outside a code block a line break in the source is a space, as a browser draws it. */
  let pre = 0;
  const words = (part: string) => (pre ? part : part.replace(/\s+/g, ' '));
  for (const match of html.matchAll(tag)) {
    if (!skipping) text += words(html.slice(at, match.index));
    at = match.index + match[0].length;
    const [, closing, rawName, attributes = ''] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = undefined;
      continue;
    }
    if (!closing && dropped.has(name)) {
      if (!/\/\s*$/.test(attributes)) skipping = name;
      continue;
    }
    if (name === 'pre') pre = Math.max(0, pre + (closing ? -1 : 1));
    if (name === 'br') text += '\n';
    else if (!closing && name === 'li') {
      const checked = /\bdata-checked\s*=\s*["']?(true|false)/i.exec(attributes)?.[1];
      text += `\n${checked === 'true' ? '[x] ' : checked === 'false' ? '[ ] ' : '- '}`;
    } else if (!closing && name === 'img') {
      const alt = /\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i.exec(attributes);
      const said = (alt?.[1] ?? alt?.[2] ?? '').trim();
      if (said) text += ` ${said} `;
    } else if ((name === 'td' || name === 'th') && closing) text += '\t';
    else if (BLOCK.test(name) && (closing || !ITEM_MARK.test(text))) text += '\n';
  }
  if (!skipping) text += words(html.slice(at));
  return decode(text)
    .replace(/[^\S\n\t]+/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\t ]+$/, '')
        .replace(/^[\t ]+/, '')
        .replace(/\s*\t\s*/g, ' · '),
    )
    .filter(Boolean)
    .join('\n');
}

/** A value's words in one line, cut at a word near `most` characters with an ellipsis: a cell, a card, an excerpt. */
export function richTextExcerpt(html: unknown, most = RICH_TEXT_EXCERPT): string {
  const line = richTextPlain(html).replace(/\s*\n\s*/g, ' · ');
  if (line.length <= most) return line;
  const cut = line.slice(0, most);
  const space = cut.lastIndexOf(' ');
  return `${(space > most * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·.,;:]+$/, '')}…`;
}

/** How many people and groups one value may @-mention: past it, it is a broadcast. */
const MOST_MENTIONED = 20;

/**
 * Who a value @-mentions, as the editor stores them: a person as
 * `<span data-type="mention" data-id="ada">`, a group (a team) with
 * `data-kind="group"` beside it. Each once, in order, at most twenty in all.
 * A mention is its stored handle, never the words drawn in it: the text
 * `@Ada` inside the span is how it reads, and nobody is found by it.
 */
export function richTextMentioned(html: unknown): { people: string[]; groups: string[] } {
  const people = new Set<string>(),
    groups = new Set<string>();
  if (typeof html !== 'string') return { people: [], groups: [] };
  for (const match of html.matchAll(/<span\b[^>]*\bdata-type\s*=\s*"mention"[^>]*>/gi)) {
    if (people.size + groups.size >= MOST_MENTIONED) break;
    const id = /\bdata-id\s*=\s*"([^"]*)"/i.exec(match[0])?.[1];
    if (!id || !MENTION_HANDLE.test(id)) continue;
    (/\bdata-kind\s*=\s*"group"/i.test(match[0]) ? groups : people).add(id);
  }
  return { people: [...people], groups: [...groups] };
}

/** The people's handles a value @-mentions (`<span data-type="mention" data-id="ada">`), each once, in order; a group's are `richTextMentioned`'s. */
export function richTextMentions(html: unknown): string[] {
  return richTextMentioned(html).people;
}
