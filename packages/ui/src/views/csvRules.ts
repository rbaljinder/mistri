/* How a CsvImportWizard reads a file: where its cells end, which of its numbers are numbers, and which column is
   which field. They stand apart from the component so each can be held to the file that broke it. */

/** A parse that stopped: the line it stopped at, and why in the importer's words. */
interface CsvParseError {
  line: number;
  message: string;
}

/** A CSV text as rows of cells, the separator its header line uses, and the reason it could not be read whole. */
interface CsvParsed {
  headers: string[];
  rows: string[][];
  delimiter: ',' | ';' | '\t';
  error?: CsvParseError;
}

const DELIMITERS = [',', ';', '\t'] as const;

/* The separator is read off the header line: whichever of comma, semicolon and tab divides it into the most cells,
   counted outside quotes. A spreadsheet in a locale whose decimal mark is the comma exports with semicolons, and a
   paste from a sheet arrives with tabs; read as comma-separated, either was one column wide. */
function detectDelimiter(text: string): CsvParsed['delimiter'] {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]! += 1;
  }
  let best: CsvParsed['delimiter'] = ',';
  for (const candidate of DELIMITERS) if (counts[candidate]! > counts[best]!) best = candidate;
  return best;
}

/**
 * Reads RFC 4180 text: quoted cells holding the separator, a line break or a doubled quote, and `\r\n`, `\n` or
 * `\r` between rows. A quote opens a quoted cell only at the cell's start (`5" pipe` is a cell with an inch mark in
 * it), and a quoted cell that never closes stops the parse with the line it opened on: it used to take every later
 * row into itself without a word, and the import was silently short.
 */
export function parseCsvText(raw: string): CsvParsed {
  const text = raw.replace(/^﻿/, '').trim();
  const delimiter = detectDelimiter(text);
  if (!text) return { headers: [], rows: [], delimiter };

  const parsedRows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let line = 1;
  let quoteOpenedAt = 0;
  let rowsAtQuote = 0;

  const endRow = () => {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell.length > 0)) parsedRows.push(currentRow);
    currentRow = [];
    currentCell = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    const lineBreak = ch === '\n' || ch === '\r';
    if (ch === '\r' && next === '\n') i += 1;
    if (lineBreak) line += 1;

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += lineBreak ? '\n' : ch;
      }
      continue;
    }

    if (ch === '"' && currentCell.trim() === '') {
      inQuotes = true;
      quoteOpenedAt = line;
      rowsAtQuote = parsedRows.length;
      currentCell = '';
    } else if (ch === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (lineBreak) {
      endRow();
    } else {
      currentCell += ch;
    }
  }

  let error: CsvParseError | undefined;
  if (inQuotes) {
    /* The row the quote opened in is not kept: where it ends is exactly what is not known. */
    parsedRows.length = rowsAtQuote;
    error = {
      line: quoteOpenedAt,
      message: `Line ${quoteOpenedAt} opens a quoted value that is never closed, so the rows from there on cannot be told apart. Close the quote (or double a quote that is part of the value) and load the file again.`,
    };
  } else {
    endRow();
  }

  if (parsedRows.length === 0) return { headers: [], rows: [], delimiter, error };

  const headers = parsedRows[0]!.map((h, idx) => h || `Column ${idx + 1}`);
  const rows = parsedRows.slice(1).map((row) => Array.from({ length: headers.length }, (_, c) => row[c] ?? ''));
  return { headers, rows, delimiter, error };
}

/** What a number cell came to: a number, the text kept as it was (and why), or not a number at all. */
type CsvNumber =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string; reason: 'too-large' | 'ambiguous' }
  | { kind: 'invalid' };

const GROUPED_BY_COMMA = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const GROUPED_BY_DOT = /^[+-]?\d{1,3}(\.\d{3})+,\d+$/;
const DECIMAL_COMMA = /^[+-]?\d+,\d+$/;
const INTEGER = /^[+-]?\d+$/;

/**
 * Reads a number cell without guessing. Commas are dropped only where they can be nothing but digit grouping
 * ("1,234,567", "1,234.50"), a single comma is a decimal mark only where it cannot be grouping ("1,5", "0,25",
 * and "1.234,56"), and "1,234" — one thousand two hundred and thirty-four, or one and a bit — is left as the text
 * it is for a person to settle. Every comma used to be stripped, which made 15 of "1,5". An integer past
 * 2^53 is left as text too: as a number its last digits are rounded, and such a value is an id, not a quantity.
 */
export function coerceCsvNumber(raw: string): CsvNumber {
  const cleaned = raw.replace(/[$%\s]/g, '');
  if (cleaned === '') return { kind: 'invalid' };

  let normal = cleaned;
  if (cleaned.includes(',')) {
    if (GROUPED_BY_COMMA.test(cleaned) && (cleaned.includes('.') || cleaned.split(',').length > 2)) normal = cleaned.replace(/,/g, '');
    else if (GROUPED_BY_DOT.test(cleaned)) normal = cleaned.replace(/\./g, '').replace(',', '.');
    else if (GROUPED_BY_COMMA.test(cleaned)) return { kind: 'text', value: raw.trim(), reason: 'ambiguous' };
    else if (DECIMAL_COMMA.test(cleaned)) normal = cleaned.replace(',', '.');
    else return { kind: 'invalid' };
  }

  const value = Number(normal);
  if (!Number.isFinite(value)) return { kind: 'invalid' };
  if (INTEGER.test(normal) && !Number.isSafeInteger(value)) return { kind: 'text', value: normal, reason: 'too-large' };
  return { kind: 'number', value };
}

/* A name as its words: "renewalDate", "renewal_date" and "Renewal date" are all renewal + date. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_SYNONYMS: Record<string, string[]> = {
  email: ['mail', 'contactemail', 'primaryemail', 'eaddress'],
  company: ['organization', 'org', 'account', 'customer', 'business', 'vendor'],
  name: ['fullname', 'title', 'displayname', 'recordname'],
  arr: ['amount', 'value', 'annualvalue', 'revenue', 'price', 'cost', 'acv', 'mrr'],
  amount: ['value', 'annualvalue', 'revenue', 'price', 'cost', 'total'],
  date: ['created', 'createdat', 'renewal', 'renewaldate', 'duedate', 'timestamp'],
  renewaldate: ['renewal', 'expires', 'expirydate'],
  tier: ['plan', 'plantier', 'segment', 'edition', 'level'],
};

const within = (few: string[], many: string[]): boolean => few.length > 0 && few.every((word) => many.includes(word));

/**
 * How well a CSV header names a schema field, 0 to 100; 55 and over is offered as the match.
 *
 * Names are compared word by word, never letter by letter. The comparison used to ask whether one squashed name
 * contained the other, with no least length, so the header "id" matched the field "Paid amount" (pa-id-amount) and
 * a column of record ids was mapped into a money field without anyone choosing it.
 */
export function headerSimilarity(csvHeader: string, field: { key: string; label: string }): number {
  const h = squash(csvHeader);
  const k = squash(field.key);
  const l = squash(field.label);
  if (!h) return 0;
  if (h === k || h === l) return 100;

  const headerWords = wordsOf(csvHeader);
  const keyWords = wordsOf(field.key);
  const labelWords = wordsOf(field.label);

  if ((FIELD_SYNONYMS[k] ?? []).includes(h)) return 90;

  for (const [canonical, aliases] of Object.entries(FIELD_SYNONYMS)) {
    const fieldIsCanonical = k === canonical || l === canonical || keyWords.includes(canonical) || labelWords.includes(canonical);
    if (fieldIsCanonical && (aliases.includes(h) || aliases.some((alias) => headerWords.includes(alias)))) return 82;
  }

  if (within(headerWords, labelWords) || within(labelWords, headerWords)) return 75;
  if (within(headerWords, keyWords) || within(keyWords, headerWords)) return 70;

  const fieldWords = [...keyWords, ...labelWords].filter((word) => word.length > 2);
  const shared = headerWords.filter((word) => word.length > 2 && fieldWords.includes(word)).length;
  return shared > 0 ? 55 + shared * 10 : 0;
}
