/**
 * Documents: a record put on paper — an invoice, a packing slip, a payslip, a
 * quote.
 *
 * A document is an App page that says `document: { label, number, size,
 * description }`. Its sections are the page sections a reader already knows
 * (fields, related lists, notes), so its reads are a record page's: planned
 * by the same route, asked through the same reads, under the same grants,
 * row scope and tenant as the record's own page. Nothing is read for paper
 * that the record's page could not read, and nothing new is served to make
 * it: the browser's print engine is the renderer, and "Save as PDF" is the
 * browser's.
 *
 * It is addressed under the record it is of, its key the last segment —
 * `/atelier/orders/12/invoice` — the place a record's tab is said, so the
 * address grammar (appAddress.ts) reads it unchanged. A document is never the
 * page a record opens through, never a route of its own, and never in a menu:
 * it is reached from its record, as a verb.
 *
 * Pure, and shared: the parser and the check here, the client's sheet and the
 * server's address book read the same rules.
 */
import { allowKeys, isRecord } from './model.js';
import type { PageDef, PageSection, SectionWidth } from './pageModel.js';

/** What a page's `document` takes. `label` names it (the verb on its record, its heading on paper); `description` is
    the sender's lines under the letterhead's name. */
export const DOCUMENT_KEYS = ['label', 'number', 'size', 'description'] as const;
/** Sheet sizes: ISO A4, or US Letter. */
const DOCUMENT_SIZES = ['a4', 'letter'] as const;
export type DocumentSize = (typeof DOCUMENT_SIZES)[number];
/** What paper draws: the record's own fields, the rows that point at it, and the author's words. */
const DOCUMENT_SECTION_KINDS = ['fields', 'list', 'note'] as const;
/** Every line is on paper, up to the most a related list reads at once; a page that would be longer says so. */
const DOCUMENT_LINES = 500;

export interface PageDocument {
  /** "Invoice", "Packing slip", "Payslip": the verb on the record, and the sheet's heading. */
  label: string;
  /** A field path of the base whose value is the document's number. Absent: the record's own name. */
  number?: string;
  /** Absent: the paper of the App's locale — Letter in North America and the Philippines, A4 elsewhere. */
  size?: DocumentSize;
  /** The sender's lines under the letterhead's name: an address, a registration. Newlines are kept. */
  description?: string;
}

/** A page's document, as one page body states it. */
export function parseDocument(raw: unknown, at: string): PageDocument {
  const where = `${at}, "document"`;
  if (!isRecord(raw)) throw new Error(`${where} is an object: { label: 'Invoice', number: 'invoice_no' }.`);
  allowKeys(raw, DOCUMENT_KEYS, where);
  if (typeof raw.label !== 'string' || !raw.label.trim())
    throw new Error(`${where} has no "label": a document is named by what it is, "Invoice" or "Packing slip".`);
  if (
    raw.number !== undefined &&
    (typeof raw.number !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw.number))
  )
    throw new Error(`${where}: "number" is a field of the record, "invoice_no" or "pay_run_id.reference".`);
  if (raw.size !== undefined && !(DOCUMENT_SIZES as readonly unknown[]).includes(raw.size))
    throw new Error(`${where}: "size" is ${DOCUMENT_SIZES.map((size) => `"${size}"`).join(' or ')}.`);
  if (raw.description !== undefined && (typeof raw.description !== 'string' || !raw.description.trim()))
    throw new Error(`${where}: "description" is text, the sender's lines under the name.`);
  return {
    label: raw.label.trim(),
    ...(raw.number === undefined ? {} : { number: raw.number as string }),
    ...(raw.size === undefined ? {} : { size: raw.size as DocumentSize }),
    ...(raw.description === undefined ? {} : { description: (raw.description as string).trim() }),
  };
}

/**
 * What a document's sections may be, refused section by section: paper has no
 * aside, no tabs and nothing to operate, and a list on it is every line — a
 * table whose header repeats on each sheet — never a gallery, a card or a
 * page of rows. Its lists read every line, up to DOCUMENT_LINES, unless the
 * author says fewer.
 */
export function documentSections(sections: readonly PageSection[], at: string): PageSection[] {
  return sections.map((section, i) => {
    const where = `${at}, section ${i + 1}`;
    if (!(DOCUMENT_SECTION_KINDS as readonly string[]).includes(section.kind))
      throw new Error(`${where} is a "${section.kind}" section; a document draws fields, related lists and notes on paper.`);
    if (section.kind === 'fields' && (section.presentation === 'card' || section.presentation === 'header'))
      throw new Error(`${where} is a "${section.presentation}"; on paper fields are a summary, properties, facts, a table or a headline.`);
    if (section.region === 'aside')
      throw new Error(`${where} is in the aside; a document is one sheet wide, so place sections side by side with "width".`);
    if (section.tab !== undefined) throw new Error(`${where} has a "tab"; paper has no tabs, so every section of a document is drawn.`);
    if (section.kind === 'fields' && section.actions?.length) throw new Error(`${where} has "actions"; paper has nothing to press.`);
    if (section.kind !== 'list') return section;
    if (section.presentation !== undefined || section.create || section.rowActions)
      throw new Error(`${where} is a list of the record's lines on paper: no presentation, create or row actions.`);
    return section.limit === undefined ? { ...section, limit: DOCUMENT_LINES } : section;
  });
}

/* Where Letter is the paper in the drawer: ISO 216 everywhere else. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'PR', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'HN', 'BZ']);

/** The sheet a document is printed on: its own `size`, else the paper the App's (or tenant's) locale buys. */
export function paperSize(document: Pick<PageDocument, 'size'>, locale: string | undefined): DocumentSize {
  if (document.size) return document.size;
  let region: string | undefined;
  try {
    region = locale ? new Intl.Locale(locale).maximize().region : undefined;
  } catch {
    region = undefined;
  }
  return region && LETTER_REGIONS.has(region) ? 'letter' : 'a4';
}

/** Whether a page is a document rather than a screen. */
export const isDocument = (page: { document?: unknown }): boolean => page.document !== undefined;

/**
 * A document's key is the last segment of its record's address, where a record
 * page's tab is said: `/orders/12/invoice`. A tab of the same word on a page
 * over the same table would be two things at one address, and a record's page
 * never opens through a document.
 */
export function documentProblems(
  pages: readonly PageDef[],
  pageOf: Readonly<Record<string, string | undefined>>,
  tabWord: (token: string) => string,
  where: string,
): string[] {
  const problems: string[] = [];
  const documents = pages.filter(isDocument);
  for (const document of documents) {
    for (const page of pages) {
      if (isDocument(page) || page.base !== document.base) continue;
      const words = new Set<string>();
      for (const section of page.sections) {
        if (section.tab) words.add(tabWord(`tab:${section.tab}`));
        if (section.kind === 'list' && section.title) words.add(tabWord(`tab:${section.title}`));
      }
      if (words.has(document.id))
        problems.push(
          `${where}: pages "${document.id}" is a document at /<record>/${document.id}, which the page "${page.id}" already answers to as a tab. Give the document another key.`,
        );
    }
  }
  for (const [resource, id] of Object.entries(pageOf)) {
    const named = id === undefined ? undefined : documents.find((page) => page.id === id);
    if (named)
      problems.push(
        `${where}: resources "${resource}", "page" names "${named.id}", which is a document: a record opens on a page, and its documents are verbs on it.`,
      );
  }
  return problems;
}

/** The share of a 12-column sheet a section's width takes, as the page's grid says it. */
export const SHEET_SPAN: Readonly<Record<SectionWidth, number>> = { full: 12, half: 6, third: 4, 'two-thirds': 8 };
