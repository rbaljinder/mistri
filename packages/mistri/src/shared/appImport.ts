/**
 * Importing records from a CSV file: what an App opts into (`import` on a
 * resource or a list view), which fields a file's columns may fill, the
 * mapping a header suggests, how one cell becomes one value in the App's
 * locale, and the error file a person downloads to fix what was refused.
 *
 * Shared, so the dialog that maps and previews a file and the server that
 * checks and writes it (server/app/appImport.ts) read one rule each. The
 * server is the authority: the browser's reading of a cell is a preview,
 * and every row is judged again, under the reader's own grants, when it is
 * checked and when it is written.
 */
import { majorToMinor } from '@mistriwork/engine/shared/moneyEntry.js';
import { csvField, CRLF } from '@mistriwork/engine/shared/csv.js';
import { commandReferenceProblem, parseCommandReference, type AppCommandField, type AppCommandReference } from './command.js';
import type { AppImportDef, ImportApp } from './appImportDeclaration.js';
import { allowKeys, humanName, plainRecord, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import {
  columnKind,
  isBinaryType,
  labelColumn,
  looksLikeDate,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';

/** `import` on a resource: true, or `{ command, match }`. */
export function parseImportDef(raw: unknown, at: string): AppImportDef | undefined {
  const here = `${at}, "import"`;
  if (raw === false) return undefined;
  if (raw === true) return {};
  const declared = plainRecord(raw, here, 'true, or an object { command, match } naming the command each row runs');
  allowKeys(declared, ['command', 'match'], here);
  const def: AppImportDef = {};
  if (declared.command !== undefined) def.command = parseCommandReference(declared.command, `${here} "command"`);
  if (declared.match !== undefined) {
    const match = declared.match;
    if (
      !Array.isArray(match) ||
      !match.length ||
      match.some((column) => typeof column !== 'string' || !column.trim() || column.includes('.'))
    ) {
      throw new Error(`${here} "match" must list the resource's own columns that find the record each row runs on.`);
    }
    def.match = match.map((column) => (column as string).trim());
    if (new Set(def.match).size !== def.match.length) throw new Error(`${here} "match" names a column twice.`);
  }
  if (def.command && !def.match) {
    throw new Error(`${here} runs "${def.command.id}" on a record each row names: say which columns find it, as match: ['…'].`);
  }
  if (def.match && !def.command) {
    throw new Error(
      `${here} has "match" and no "command": a plain import creates records, so there is nothing to find. Drop "match", or name the command each row runs.`,
    );
  }
  return def;
}

/** `import` on a list view: false turns off the resource's, anything else is the view's own. */
export function parseViewImport(raw: unknown, at: string): AppImportDef | false {
  if (raw === false) return false;
  return parseImportDef(raw, at) ?? false;
}

/**
 * Why an import cannot be offered over this catalog, or undefined. A plain
 * import needs a table with a primary key (its rows are named and reported
 * by it). A command import needs a command on this resource that
 * names one record, input of plain fields a column can fill, and `match`
 * columns of the table that are not also the command's inputs.
 */
export function importProblem(def: AppImportDef, table: TableMeta, schema: DatabaseSchema): string | undefined {
  if (table.isView) return 'import writes records, and this is a view.';
  if (!table.columns.some((column) => column.primaryKey)) return 'import needs a table with a primary key.';
  if (!def.command) return undefined;
  const reference = commandReferenceProblem(def.command, table.id, schema);
  if (reference) return `import command "${def.command.id}": ${reference}`;
  if ((def.command.targets ?? 'one') !== 'one')
    return `import command "${def.command.id}" targets many records; each row runs a command on one.`;
  const group = def.command.input.find((field) => field.type === 'group' || field.type === 'lines');
  if (group)
    return `import command "${def.command.id}" asks for "${group.name}", ${group.type === 'lines' ? 'lines' : 'a group'}; a column of a file fills one plain field.`;
  for (const column of def.match ?? []) {
    if (!table.columns.some((c) => c.name === column)) return `import match "${column}" is not a column of "${table.name}".`;
    if (def.command.input.some((field) => field.name === column)) {
      return `import match "${column}" is also an input of "${def.command.id}"; a column either finds the record or fills the command.`;
    }
  }
  return undefined;
}

/* ---------- the fields a column may fill ---------- */

type ImportFieldKind = 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'reference' | 'choice';

export interface ImportField {
  /** The column (a plain import, or a command's `match`) or the command input's name. */
  name: string;
  label: string;
  kind: ImportFieldKind;
  /** A file must give it: no default, not nullable, or a required command input. */
  required: boolean;
  /** A `match` column: it finds the record rather than filling a value. */
  match?: true;
  /** The table a reference points at, and the column it points to. */
  references?: { table: string; column: string };
  /** The values the column or the choice takes. */
  allowed?: ReadonlyArray<{ value: string | number; label?: string }>;
  /** A command input's own bounds, said to the reader beside a refused value. */
  field?: AppCommandField;
  /** Other captions a header may say it by: a reference's own paths' ("SKU" for `product_id`, by `product_id.sku`). */
  aliases?: string[];
  /** Money kept as minor units (money.ts): the file says the figure, "19.99", in this currency, and 1999 is stored. */
  minor?: string;
  /** Where each row says its own currency (`currency: { column }`): that row's cell of this column, when it names one. */
  minorBy?: string;
}

const INTEGER = /^(tinyint|smallint|mediumint|int|integer|int2|int4|int8|bigint|serial|bigserial|smallserial)\b/i;

function columnField(column: ColumnMeta, label: string | undefined): ImportField {
  const kind = columnKind(column.type);
  const required =
    !column.nullable &&
    column.default === undefined &&
    !column.hasDefault &&
    !column.identity &&
    // An integer key the database numbers itself (SQLite's rowid alias) is left to it.
    !(column.primaryKey && INTEGER.test(column.type.trim()));
  return {
    name: column.name,
    label: label ?? humanName(column.name),
    kind: column.references
      ? 'reference'
      : column.allowed?.length
        ? 'choice'
        : kind === 'number'
          ? INTEGER.test(column.type.trim())
            ? 'integer'
            : 'number'
          : kind === 'boolean'
            ? 'boolean'
            : kind === 'date' || looksLikeDate(column)
              ? 'date'
              : 'text',
    required,
    ...(column.references ? { references: { ...column.references } } : {}),
    ...(column.allowed?.length ? { allowed: column.allowed.map((value) => ({ value, label: vocabularyWord(value) })) } : {}),
  };
}

/**
 * The fields a file's columns may fill, in the table's order. A plain import:
 * every column this reader may write, except the ones only actions move, a
 * binary column and one the database always numbers. A command import: the
 * `match` columns, then the command's inputs.
 */
export function importFields(
  table: TableMeta,
  def: AppImportDef,
  labelOf: (column: string) => string | undefined = () => undefined,
  /** The currency a column kept in minor units is written in, by its display rule; undefined for any other. */
  minorOf: (column: string) => string | undefined = () => undefined,
  /** The column a minor column's row names its own currency in, when its rule says `currency: { column }`. */
  minorByOf: (column: string) => string | undefined = () => undefined,
): ImportField[] {
  if (def.command) {
    const matched = (def.match ?? []).flatMap((name) => {
      const column = table.columns.find((c) => c.name === name);
      return column ? [{ ...columnField(column, labelOf(name)), required: true, match: true as const }] : [];
    });
    const inputs = def.command.input.flatMap((field): ImportField[] => {
      // A sheet's column holds one value; questions defined in rows are an object of them, which no column fills.
      if (field.type === 'group' || field.type === 'lines' || field.type === 'defined') return [];
      const base = { name: field.name, label: field.label, required: field.required === true, field };
      switch (field.type) {
        case 'number':
          return [{ ...base, kind: field.integer ? 'integer' : 'number' }];
        case 'boolean':
          return [{ ...base, kind: 'boolean' }];
        case 'date':
          return [{ ...base, kind: 'date' }];
        case 'choice':
          return [{ ...base, kind: 'choice', allowed: field.options.map((option) => ({ value: option.value, label: option.label })) }];
        case 'reference':
          return [{ ...base, kind: 'reference', references: { table: field.from, column: field.by } }];
        default:
          return [{ ...base, kind: 'text' }];
      }
    });
    return [...matched, ...inputs];
  }
  return table.columns
    .filter(
      (column) => column.writable !== false && column.changesBy !== 'actions' && !isBinaryType(column.type) && column.identity !== 'always',
    )
    .map((column) => {
      const field = columnField(column, labelOf(column.name));
      const minor = field.kind === 'integer' ? minorOf(column.name) : undefined;
      const by = minor ? minorByOf(column.name) : undefined;
      return minor ? { ...field, minor, ...(by ? { minorBy: by } : {}) } : field;
    });
}

/* ---------- a header's suggested field ---------- */

/** A header or a caption reduced to its letters and digits: "Unit cost", "unit_cost" and "UNIT COST" are one. */
function headerKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The field each header fills, or null: by the caption the App gives it,
 * then by its name, then by its name without a reference's `_id` ("Supplier"
 * for `supplier_id`). Each field is suggested once, to the first header that
 * names it; the reader confirms or changes every one.
 */
export function suggestMapping(header: readonly string[], fields: readonly ImportField[]): Array<string | null> {
  const taken = new Set<string>();
  const keys = fields.map(
    (field) =>
      new Set(
        [
          headerKey(field.label),
          headerKey(field.name),
          headerKey(humanName(field.name)),
          headerKey(field.name.replace(/_id$/, '')),
          ...(field.aliases ?? []).map(headerKey),
        ].filter(Boolean),
      ),
  );
  const first = header.map((text) => {
    const key = headerKey(text);
    if (!key) return null;
    const index = fields.findIndex((field, i) => !taken.has(field.name) && keys[i].has(key));
    if (index < 0) return null;
    taken.add(fields[index].name);
    return fields[index].name;
  });
  /* Then a header that ends in a field's own name — "Product name" for
     `name` — where exactly one field still free says so. */
  return first.map((name, column) => {
    if (name) return name;
    const key = headerKey(header[column]);
    const candidates = fields.filter(
      (field) => !taken.has(field.name) && headerKey(field.name).length >= 4 && key.endsWith(headerKey(field.name)),
    );
    if (candidates.length !== 1) return null;
    taken.add(candidates[0].name);
    return candidates[0].name;
  });
}

/** Why a mapping cannot be used, or undefined: every column's field is one of these, none twice, every required one present. */
export function mappingProblem(mapping: ReadonlyArray<string | null>, fields: readonly ImportField[], columns: number): string | undefined {
  if (mapping.length !== columns) return 'The mapping names a field for each column of the file.';
  const seen = new Set<string>();
  for (const name of mapping) {
    if (name === null) continue;
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) return `"${name}" is not a field this import fills.`;
    if (seen.has(name)) return `Two columns fill "${field.label}"; choose one.`;
    seen.add(name);
  }
  const missing = fields.filter((field) => field.required && !seen.has(field.name));
  if (missing.length) return `No column fills ${missing.map((field) => `"${field.label}"`).join(', ')}, which every row needs.`;
  if (!seen.size) return 'No column is mapped to a field.';
  return undefined;
}

/* ---------- one cell ---------- */

/** One cell read: a value, a reference still to be found by name, nothing (an empty cell), or why not. */
type CellReading = { value: string | number | boolean } | { lookup: string } | { empty: true } | { problem: string };

const TRUE_WORDS = new Set(['true', 'yes', 'y', 't', '1', 'on', 'x', '✓']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'f', '0', 'off']);

/** The grouping and decimal marks a locale writes a number with. */
function numberMarks(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
  };
}

/**
 * A number as the App's locale writes it: "1,234.50" in en-US, "1.234,50" in
 * de-DE, a currency sign, spaces and parentheses for a negative tolerated.
 * Grouping must fall in threes, so "1.5" read in de-DE is refused rather
 * than taken as fifteen.
 */
export function parseLocaleNumber(text: string, locale: string): number | undefined {
  const { group, decimal } = numberMarks(locale);
  let t = text.trim().replace(/[\s  ]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  // A currency sign or code before or after the figure.
  t = t.replace(/^[^\d+\-.,]+/, '').replace(/[^\d.,]+$/, '');
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  } else if (t.startsWith('+')) t = t.slice(1);
  const groupMark = group === ' ' || group === ' ' ? '' : group;
  const [whole, fraction, extra] = t.split(decimal);
  if (extra !== undefined || whole === undefined) return undefined;
  let digits = whole;
  if (groupMark && whole.includes(groupMark)) {
    const escaped = groupMark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(whole)) return undefined;
    digits = whole.split(groupMark).join('');
  }
  const plain = fraction === undefined ? digits : `${digits}.${fraction}`;
  if (!/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(plain)) return undefined;
  const n = Number(plain);
  return Number.isFinite(n) ? (negative ? -n : n) : undefined;
}

/** The order a locale writes a numeric date's parts in: ['month', 'day', 'year'] for en-US. */
function dateOrder(locale: string): Array<'day' | 'month' | 'year'> {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
    .formatToParts(new Date(Date.UTC(2006, 0, 2)))
    .flatMap((part) => (part.type === 'day' || part.type === 'month' || part.type === 'year' ? [part.type] : []));
}

const pad = (n: number) => String(n).padStart(2, '0');

function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A date as ISO (`2026-03-14`, with a time after `T` or a space) or as the
 * App's locale writes one numerically (`3/14/2026` in en-US, `14.03.2026` in
 * de-DE). A two-digit year says too little and is refused, as is a day that
 * does not exist. Returned as `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM:SS` when
 * the cell gave a time.
 */
export function parseLocaleDate(text: string, locale: string): string | undefined {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  const time = (h?: string, m?: string, s?: string) => {
    if (h === undefined) return '';
    const [hh, mm, ss] = [Number(h), Number(m), Number(s ?? 0)];
    return hh < 24 && mm < 60 && ss < 60 ? ` ${pad(hh)}:${pad(mm)}:${pad(ss)}` : undefined;
  };
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const clock = time(iso[4], iso[5], iso[6]);
    return realDate(year, month, day) && clock !== undefined ? `${iso[1]}-${iso[2]}-${iso[3]}${clock}` : undefined;
  }
  const local = /^(\d{1,4})[/.\- ](\d{1,2})[/.\- ](\d{1,4})\.?(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!local) return undefined;
  const order = dateOrder(locale);
  const parts: Record<string, string> = {};
  order.forEach((type, i) => {
    parts[type] = local[i + 1];
  });
  if (!parts.year || parts.year.length !== 4) return undefined;
  const [year, month, day] = [Number(parts.year), Number(parts.month), Number(parts.day)];
  const clock = time(local[4], local[5], local[6]);
  if (!realDate(year, month, day) || clock === undefined) return undefined;
  return `${year}-${pad(month)}-${pad(day)}${clock}`;
}

const listed = (values: ReadonlyArray<{ value: string | number; label?: string }>) => {
  const words = values.slice(0, 8).map((item) => `"${item.label ?? item.value}"`);
  return `${words.join(', ')}${values.length > 8 ? ', …' : ''}`;
};

/**
 * One cell as the value its field takes. Text is kept as written (trimmed);
 * a reference is left to be found by the record's name (`lookup`), which only
 * the server can do, under the reader's grants.
 */
export function readCell(
  field: ImportField,
  cell: string,
  locale: string,
  /** The row's own currency, read from its `minorBy` cell, where the file says one. */
  currency?: string,
): CellReading {
  const text = cell.trim();
  if (text === '') return { empty: true };
  switch (field.kind) {
    case 'integer':
    case 'number': {
      const n = parseLocaleNumber(text, locale);
      if (n === undefined) return { problem: `"${text}" is not a number.` };
      /* An amount is read as the figure a sheet says, and stored as the minor units it is. */
      if (field.minor) {
        const code = currency || field.minor;
        const minor = majorToMinor(n, code);
        return minor === undefined ? { problem: `"${text}" has more decimals than ${code} is written with.` } : { value: minor };
      }
      if (field.kind === 'integer' && !Number.isInteger(n)) return { problem: `"${text}" is not a whole number.` };
      return { value: n };
    }
    case 'boolean': {
      const word = text.toLowerCase();
      if (TRUE_WORDS.has(word)) return { value: true };
      if (FALSE_WORDS.has(word)) return { value: false };
      return { problem: `"${text}" is not yes or no.` };
    }
    case 'date': {
      const date = parseLocaleDate(text, locale);
      return date ? { value: date } : { problem: `"${text}" is not a date. Write it as ${sampleDate(locale)} or 2026-03-14.` };
    }
    case 'choice': {
      const allowed = field.allowed ?? [];
      const lower = text.toLowerCase();
      const found =
        allowed.find((item) => String(item.value) === text) ??
        allowed.find((item) => String(item.value).toLowerCase() === lower) ??
        allowed.find((item) => (item.label ?? '').toLowerCase() === lower) ??
        allowed.find((item) => vocabularyWord(String(item.value)).toLowerCase() === lower);
      return found ? { value: found.value } : { problem: `"${text}" is not one of ${listed(allowed)}.` };
    }
    case 'reference':
      return { lookup: text };
    default:
      return { value: text };
  }
}

function sampleDate(locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 2, 14)),
  );
}

/**
 * The columns that name a record of `table` when a file refers to it: its
 * key, the resource's own record name when that is a column, the column the
 * catalog would name it by, and every single column the database keeps
 * unique (a SKU, a bin's code). `$label` stands for a templated name.
 */
export function namingColumns(table: TableMeta, key: string, recordLabel?: string | false): string[] {
  const named = typeof recordLabel === 'string' && !recordLabel.includes('.') && !recordLabel.includes('{') ? recordLabel : undefined;
  const templated = table.labelTemplate ? '$label' : undefined;
  const fallback = labelColumn(table);
  const unique = (table.unique ?? []).filter((column) => table.columns.some((c) => c.name === column));
  return [...new Set([key, ...(templated ? [templated] : []), ...(named ? [named] : []), ...(fallback ? [fallback] : []), ...unique])];
}

/* ---------- the exchange ---------- */

/** What the dialog sends: the file as text, and which field each column fills. */
export interface ImportRequest {
  app?: string;
  table: string;
  view?: string;
  /** The file's name, for the history's words; never a path the server opens. */
  name?: string;
  csv: string;
  mapping: Array<string | null>;
  /** `check` writes nothing; `commit` writes. */
  mode: 'check' | 'commit';
  /** On commit: leave the refused rows out and write the rest, rather than write nothing. */
  skipRefused?: boolean;
}

/** One refused row: its line in the file and what is wrong, by field where one is to blame. */
export interface ImportRowProblem {
  /** 1-based data row, the header not counted. */
  row: number;
  /** The line of the file it starts on. */
  line: number;
  problems: Array<{ field?: string; message: string }>;
}

export interface ImportReport {
  outcome: 'checked' | 'applied' | 'not_applied' | 'partial' | 'unknown';
  rows: number;
  /** Rows that pass (check) or were written (commit). */
  ready: number;
  applied?: number;
  refused: ImportRowProblem[];
  /** Said once for the whole file, when the file itself is the problem. */
  error?: string;
}

/**
 * The refused rows as a CSV to fix and import again: the line each came
 * from, the file's own columns, and what was wrong. Every cell goes through
 * csvField, so a value that would be a formula in a spreadsheet — `=cmd()`
 * in a name — is written as text, even though the file it came from held it.
 */
export function importErrorCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  refused: readonly ImportRowProblem[],
): string {
  const lines = [['Line', ...header, 'Problem'].map(csvField).join(',')];
  for (const problem of refused) {
    const cells = rows[problem.row - 1] ?? [];
    const said = problem.problems.map((p) => (p.field ? `${p.field}: ${p.message}` : p.message)).join(' ');
    lines.push([problem.line, ...header.map((_, i) => cells[i] ?? ''), said].map(csvField).join(','));
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * What an App's imports may not do where it serves them. A tenant App's host
 * serves its own import route, which writes every row in the member's own
 * context, with the tenant's ownership injected (tenant/tenantHttp.ts).
 */
export function checkImports(
  app: { auth?: { rows?: string }; resources?: Record<string, { import?: AppImportDef }>; views: Record<string, unknown> },
  where: string,
): void {
  /* Under a row policy a refused command fails the whole request's context, so
     rows run before it would be committed behind a failed reply. Plain imports
     are one transaction and are served there; command imports wait. */
  if (app.auth?.rows === 'policy') {
    const command = importCommandOccurrences(app)[0];
    if (command)
      throw new Error(
        `${where}: ${command.at} imports through the command "${command.reference.id}", which is not supported yet on an App with "auth.rows": "policy". Use a plain import, or none.`,
      );
  }
}

/** Every command an import runs, with where it is declared and the resource it acts on. */
export function importCommandOccurrences(app: ImportApp): Array<{ at: string; resource: string; reference: AppCommandReference }> {
  const found: Array<{ at: string; resource: string; reference: AppCommandReference }> = [];
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    if (block.import?.command) found.push({ at: `resources "${resource}"`, resource, reference: block.import.command });
  }
  for (const [key, view] of Object.entries(app.views ?? {})) {
    const listed = view as { table?: string; import?: AppImportDef | false };
    if (listed.table && listed.import && listed.import.command)
      found.push({ at: `view "${key}"`, resource: listed.table, reference: listed.import.command });
  }
  return found;
}

/** The resources a plain import (no command) writes to, with where it is declared. */
export function plainImportTargets(app: ImportApp): Array<{ at: string; resource: string }> {
  const found: Array<{ at: string; resource: string }> = [];
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    if (block.import && !block.import.command) found.push({ at: `resources "${resource}"`, resource });
  }
  for (const [key, view] of Object.entries(app.views ?? {})) {
    const listed = view as { table?: string; import?: AppImportDef | false };
    if (listed.table && listed.import && !listed.import.command) found.push({ at: `view "${key}"`, resource: listed.table });
  }
  return found;
}
