/**
 * Rich text on the way in: every value is sanitized here before it is
 * written, and Markdown is read into the same HTML first.
 *
 * The allowlist is shared/richText.ts, the one the browser draws by. The
 * sanitizer is sanitize-html — a maintained HTML parser and filter that needs
 * no DOM in Node, so the server holds no browser to judge markup — and the
 * Markdown reader is marked. Both are loaded the first time a rich text value
 * is read, so an App without one never pays for them.
 *
 * What the server writes is the editor's own form: a task list is
 * `<ul data-type="taskList"><li data-type="taskItem" data-checked="true">`, a
 * mention is `<span data-type="mention" data-id="ada">@ada</span>` (its text
 * is the handle, so `notify` rules' `mentions` find it), a picture is one of
 * the App's attachments by its file route address. Pasted Word, Outlook or
 * Google Docs markup reduces to the same few elements: their styles,
 * classes, comments and namespaced tags are not in the list.
 */
import { createRequire } from 'node:module';
import type { IOptions, Attributes } from 'sanitize-html';
import type { Marked as MarkedInstance, Tokens } from 'marked';
import {
  RICH_TEXT_DROPPED,
  RICH_TEXT_ELEMENTS,
  RICH_TEXT_MOST,
  richTextAttribute,
  richTextPlain,
} from '@mistriwork/engine/shared/richText.js';

const load = createRequire(import.meta.url);

type Sanitize = (dirty: string, options: IOptions) => string;
let sanitizer: Sanitize | undefined;
let markdown: MarkedInstance | undefined;

/** Headings past the three a value keeps are said at the nearest kept level. */
const HEADINGS: Readonly<Record<string, string>> = Object.freeze({ h1: 'h2', h5: 'h4', h6: 'h4', del: 's', strike: 's' });

/** Where a rich text value's pictures may come from: the App's file resources, by table id. Absent, any table. */
interface RichTextScope {
  images?: ReadonlySet<string>;
}

function options(scope: RichTextScope): IOptions {
  const allowedAttributes: Record<string, string[]> = {};
  for (const [element, attributes] of Object.entries(RICH_TEXT_ELEMENTS))
    allowedAttributes[element] = element === 'a' ? [...attributes, 'rel', 'target'] : [...attributes];
  const keep =
    (element: string) =>
    (tagName: string, attribs: Attributes): { tagName: string; attribs: Attributes } => {
      const named = HEADINGS[tagName] ?? element;
      const kept: Attributes = {};
      for (const name of RICH_TEXT_ELEMENTS[named] ?? []) {
        const value = attribs[name];
        if (typeof value !== 'string') continue;
        const judged = richTextAttribute(named, name, value, scope.images);
        if (judged !== undefined) kept[name] = judged;
      }
      /* A link opens beside the App, and tells the page it opens nothing about this one. */
      if (named === 'a' && kept.href) Object.assign(kept, { rel: 'noopener noreferrer', target: '_blank' });
      return { tagName: named, attribs: kept };
    };
  const transformTags: Record<string, (tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes }> = {};
  for (const element of [...Object.keys(RICH_TEXT_ELEMENTS), ...Object.keys(HEADINGS)]) transformTags[element] = keep(element);
  return {
    allowedTags: Object.keys(RICH_TEXT_ELEMENTS),
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto'],
    /* A picture is the App's own attachment, a path on this server: no scheme at all. */
    allowedSchemesByTag: { img: [] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedStyles: {},
    allowedClasses: { code: ['language-*'] },
    allowVulnerableTags: false,
    disallowedTagsMode: 'discard',
    nonTextTags: [...RICH_TEXT_DROPPED],
    transformTags,
    /* A link with no address is its words; a span that is not a mention is its words; a picture with no address is nothing. */
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') return !frame.attribs.src;
      if (frame.tag === 'a' && !frame.attribs.href) return 'excludeTag';
      if (frame.tag === 'span' && frame.attribs['data-type'] !== 'mention') return 'excludeTag';
      return false;
    },
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
  };
}

/**
 * A value as it may be stored: the allowlist's elements and attributes and
 * nothing else, and '' where no word or picture is left. Idempotent: a
 * sanitized value sanitizes to itself.
 */
export function sanitizeRichText(html: string, scope: RichTextScope = {}): string {
  sanitizer ??= load('sanitize-html') as Sanitize;
  const clean = sanitizer(html, options(scope)).trim();
  return richTextPlain(clean) || /<img\b/i.test(clean) ? clean : '';
}

function reader(): MarkedInstance {
  if (markdown) return markdown;
  const { Marked } = load('marked') as { Marked: new (...args: unknown[]) => MarkedInstance };
  const instance = new Marked({ gfm: true, breaks: false, async: false });
  instance.use({
    renderer: {
      /* A list of tasks is the editor's: `- [x] done` is a checked task item, never a form control. */
      list(this: { listitem: (item: Tokens.ListItem) => string }, token: Tokens.List) {
        if (!token.items.some((item) => item.task)) return false;
        return `<ul data-type="taskList">${token.items.map((item) => this.listitem(item)).join('')}</ul>\n`;
      },
      listitem(this: { parser: { parse: (tokens: Tokens.Generic[]) => string } }, item: Tokens.ListItem) {
        if (!item.task) return false;
        return `<li data-type="taskItem" data-checked="${item.checked ? 'true' : 'false'}">${this.parser.parse(item.tokens)}</li>\n`;
      },
      checkbox() {
        return '';
      },
    },
  });
  markdown = instance;
  return instance;
}

/**
 * The most characters of Markdown read into one value. marked runs on the
 * event loop, and some of its work grows faster than its input: 30 KB of
 * `*_a` held the server for seconds, reachable from an anonymous public form.
 * Kept well under what the stored HTML may hold (RICH_TEXT_MOST), since
 * Markdown is the shorter spelling; longer text arrives as HTML.
 */
export const MARKDOWN_MOST = 20_000;
/* Emphasis delimiter runs past this are written as themselves: marked pairs
   each run against the ones after it, so the cost is in the runs, not the
   length. 256 is 128 emphasized phrases, more than a note carries. */
const DELIMITER_RUNS_MOST = 256;
/* A blockquote or list nested this deep recursed until the stack ran out. */
const DEEP_NESTING = /^(?:[ \t]{0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]))[ \t]*){32}/m;

/** Markdown read into a value: GitHub's flavour, tables and task lists included, then sanitized like any other. */
export function markdownToRichText(text: string, scope: RichTextScope = {}): string {
  if (text.length > MARKDOWN_MOST || DEEP_NESTING.test(text)) throw new RichTextRefusal('too_long');
  const runs = text.match(/[*_~]+/g)?.length ?? 0;
  const bounded =
    runs > DELIMITER_RUNS_MOST ? text.replace(/\\[\s\S]|[*_~]/g, (found) => (found.length === 2 ? found : `\\${found}`)) : text;
  return sanitizeRichText(reader().parse(bounded) as string, scope);
}

/** Why a rich text input was not read: not text, or past its size. */
export class RichTextRefusal extends Error {
  constructor(readonly reason: 'type' | 'too_long') {
    super('The rich text value is invalid.');
    this.name = 'RichTextRefusal';
  }
}

/**
 * A rich text value as an API, an agent or the editor sends it, read into the
 * HTML it is stored as. A string is HTML when it starts with a tag and
 * Markdown otherwise — an agent writes `**done**` and `- [ ] call back`;
 * `{ format: 'markdown' | 'html', text }` says which, where the text could be
 * either. Sanitized, and '' where nothing is left.
 */
export function readRichTextInput(value: unknown, scope: RichTextScope = {}, most = RICH_TEXT_MOST): string {
  let format: 'markdown' | 'html';
  let text: string;
  if (typeof value === 'string') {
    text = value;
    format = /^\s*</.test(value) ? 'html' : 'markdown';
  } else if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    ((value as { format?: unknown }).format === 'markdown' || (value as { format?: unknown }).format === 'html') &&
    typeof (value as { text?: unknown }).text === 'string'
  ) {
    format = (value as { format: 'markdown' | 'html' }).format;
    text = (value as { text: string }).text;
  } else throw new RichTextRefusal('type');
  /* Judged twice: what arrived, so a megabyte of markup is not parsed to learn it is too long, and what is kept. */
  if (text.length > most * 4) throw new RichTextRefusal('too_long');
  const html = format === 'markdown' ? markdownToRichText(text, scope) : sanitizeRichText(text, scope);
  if (html.length > most) throw new RichTextRefusal('too_long');
  return html;
}
