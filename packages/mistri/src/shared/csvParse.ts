/*
 * Reading CSV, the other direction from csv.ts: a record at a time, from
 * text pushed in pieces, under limits that are checked as it goes. The
 * browser reads a file's first lines with it to offer a mapping; the server
 * reads the whole upload with it (appImport.ts) and never holds more than the
 * field and the record it is on, plus what the caller keeps.
 */

/** What a reader will take before it stops with a CsvError. */
interface CsvLimits {
  /** Records after the header. */
  maxRows: number;
  /** Fields in any one record. */
  maxColumns: number;
  /** Characters in any one field. */
  maxField: number;
}

/** A file that is not CSV the reader can use, said with the line it stopped on. */
export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

const DELIMITERS = [',', ';', '\t'] as const;
type CsvDelimiter = (typeof DELIMITERS)[number];

/**
 * The separator a file uses, read from its first line: a spreadsheet saved in
 * a locale whose decimal mark is a comma writes semicolons, and a tab-separated
 * paste is common. The one that splits the header into the most fields wins,
 * quoted text stepped over; a line that none of them splits is comma-separated.
 */
export function sniffDelimiter(start: string): CsvDelimiter {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of start.replace(/^﻿/, '')) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: CsvDelimiter = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * RFC 4180 with the leniencies spreadsheets need: CRLF, LF or a lone CR ends
 * a record; a byte-order mark before the first field is not part of it; a
 * wholly empty line is skipped (a trailing line break, a blank row left in a
 * sheet). What it refuses rather than guesses at: text after a closing quote
 * (`"ab"c`), a quote left open at the end, and anything past the limits.
 */
export class CsvReader {
  private field = '';
  private record: string[] = [];
  /** 0 outside quotes, 1 inside, 2 just after a closing quote. */
  private quote: 0 | 1 | 2 = 0;
  /** A CR was the last character: an LF next is the same line break. */
  private afterCr = false;
  private started = false;
  private line = 1;
  private recordLine = 1;
  private rows = -1;
  private stopped = false;

  constructor(
    private readonly onRecord: (fields: string[], line: number) => void,
    private readonly limits: CsvLimits,
    private readonly delimiter: CsvDelimiter = ',',
  ) {}

  push(chunk: string): void {
    if (this.stopped) return;
    let text = chunk;
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.afterCr) {
        this.afterCr = false;
        if (ch === '\n') continue;
      }
      if (this.quote === 1) {
        if (ch === '"') {
          this.quote = 2;
          continue;
        }
        // A line break inside a value is kept as one LF, whichever the file wrote.
        if (ch === '\n' || ch === '\r') {
          this.line++;
          if (ch === '\r') this.afterCr = true;
          this.append('\n');
          continue;
        }
        this.append(ch);
        continue;
      }
      if (this.quote === 2) {
        if (ch === '"') {
          this.quote = 1;
          this.append('"');
          continue;
        }
        if (ch !== this.delimiter && ch !== '\n' && ch !== '\r') {
          throw this.fail('A quoted field is followed by more text; a closing quote ends a field only before a separator or a line break.');
        }
        this.quote = 0;
      }
      if (ch === this.delimiter) {
        this.endField();
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r') this.afterCr = true;
        this.endRecord();
        this.line++;
        this.recordLine = this.line;
        continue;
      }
      if (ch === '"' && this.field === '') {
        this.quote = 1;
        continue;
      }
      this.append(ch);
    }
  }

  /** The end of the text: a last record without a line break is still a record. */
  end(): void {
    if (this.stopped) return;
    if (this.quote === 1) throw this.fail('A quoted field is never closed.');
    this.quote = 0;
    if (this.field !== '' || this.record.length) this.endRecord();
    this.stopped = true;
  }

  private append(ch: string): void {
    if (this.field.length >= this.limits.maxField) {
      throw this.fail(`A field is longer than ${this.limits.maxField.toLocaleString('en-US')} characters.`);
    }
    this.field += ch;
  }

  private endField(): void {
    if (this.record.length >= this.limits.maxColumns) {
      throw this.fail(`A line has more than ${this.limits.maxColumns} fields.`);
    }
    this.record.push(this.field);
    this.field = '';
    this.quote = 0;
  }

  private endRecord(): void {
    this.endField();
    const fields = this.record;
    this.record = [];
    if (fields.length === 1 && fields[0] === '') return;
    this.rows++;
    if (this.rows > this.limits.maxRows) {
      throw this.fail(`The file has more than ${this.limits.maxRows.toLocaleString('en-US')} rows. Split it and import each part.`);
    }
    this.onRecord(fields, this.recordLine);
  }

  private fail(message: string): CsvError {
    this.stopped = true;
    return new CsvError(message, this.recordLine);
  }
}

/** A header and its rows, each with the line it started on, from text in hand. */
interface ParsedCsv {
  header: string[];
  rows: string[][];
  lines: number[];
  delimiter: CsvDelimiter;
}

/** The whole text, read through a CsvReader in pieces. */
export function parseCsv(text: string, limits: CsvLimits): ParsedCsv {
  const delimiter = sniffDelimiter(text.slice(0, 64 * 1024));
  let header: string[] | undefined;
  const rows: string[][] = [];
  const lines: number[] = [];
  const reader = new CsvReader(
    (fields, line) => {
      if (!header) {
        header = fields;
        return;
      }
      rows.push(fields);
      lines.push(line);
    },
    limits,
    delimiter,
  );
  for (let at = 0; at < text.length; at += 64 * 1024) reader.push(text.slice(at, at + 64 * 1024));
  reader.end();
  if (!header) throw new CsvError('The file is empty: it needs a header line naming its columns.', 1);
  return { header, rows, lines, delimiter };
}
