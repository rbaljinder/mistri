/**
 * An import, run: a CSV file's rows read against the fields its mapping
 * names, each cell read in the App's locale, references found by the record
 * they name, and every row judged by the same writer every other write goes
 * through — the reader's grants, field grants, row scope or row policy, the
 * resource's validation and transitions, and the database's own constraints.
 *
 * A plain import checks each row alone, in a transaction that is always
 * rolled back, so a check writes nothing and says what is wrong with every
 * row rather than the first. Its commit is one transaction: every row or
 * none. A command import runs the
 * resource's declared command once per run — a row, or the consecutive rows
 * that agree on its `group` columns — on the record the `match` columns find,
 * or creating one (`targets: 'none'`) — prepared and executed exactly as the
 * command's own route would, so it never goes around the command. Its check
 * runs each run's handler in a transaction that is always rolled back (the
 * executor's trial), and says what each would create, update or refuse.
 *
 * The HTTP route (http/importRoutes.ts) builds the runtime: which writer,
 * which reader, whose commands.
 */
import { randomUUID } from 'node:crypto';
import type { Adapter, InsertRequest } from '@mistriwork/engine/adapters/adapter.js';
import { attributeAction } from '@mistriwork/engine/adapters/writeAttribution.js';
import { commandInputProblems, type CommandInputReason } from '../../shared/commandInput.js';
import { columnCaption } from '@mistriwork/engine/shared/columnCaption.js';
import { evaluateFormRules } from '../../shared/formRules.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { columnKind, findTable, primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { type AppDef } from '../../shared/app.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { CsvError, parseCsv } from '../../shared/csvParse.js';
import {
  importFields,
  mappingProblem,
  namingColumns,
  readCell,
  type ImportField,
  type ImportReport,
  type ImportRequest,
  type ImportRowProblem,
  type ImportRun,
} from '../../shared/appImport.js';
import type { AppCommandGroup } from '@mistriwork/engine/schema/model.js';
import { IMPORT_LIMITS } from '../../shared/appImportDeclaration.js';
import { importDeclaration, type AppImportDef } from '../../shared/appImportDeclaration.js';
import type { ViewCondition, ViewDef } from '@mistriwork/engine/shared/viewPaths.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { readView } from '@mistriwork/engine/server/resourceReadOperations.js';
import { appError } from './appErrors.js';
import { narrowedFixedColumns } from '../../shared/appNarrowed.js';

/** The request is not an import this reader may run: said as a 403 or 404, never as a row. */
export class ImportUnavailable extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'ImportUnavailable';
  }
}

/** Where a plain import's rows go: tried alone and rolled back, or written together. */
export interface ImportWriter {
  /** Throws what the writer refuses; writes nothing either way. */
  trial(request: InsertRequest): Promise<void>;
  /** Every request in one transaction, or none of them. */
  commit(requests: InsertRequest[]): Promise<unknown>;
}

/** Where a command import's rows go: the command's own prepare and execute, and its trial, which writes nothing. */
interface ImportCommands {
  prepare(body: unknown): Promise<unknown>;
  execute(body: unknown): Promise<unknown>;
  /** The handler run in a transaction that is always rolled back: no receipt, no journal entry, no effects. */
  trial(body: unknown): Promise<unknown>;
}

interface ImportRuntime {
  /** The App as this reader is served it: an import whose command they may not run is not in it. */
  app: AppDef;
  /** The reader's catalog: the columns they may read, which they may write. */
  schema: DatabaseSchema;
  /** Authorized reads, for names and targets. */
  reader: Adapter;
  locale: string;
  now: () => Date;
  person?: QueryPerson;
  signal: AbortSignal;
  writer?: ImportWriter;
  commands?: ImportCommands;
  /** What a command's writes are called in the record history. */
  commandLabel?: string;
}

/** Why the request's own shape is refused, before any file is read. */
export function readImportRequest(body: Record<string, unknown>): ImportRequest {
  const allowed = new Set(['app', 'table', 'view', 'name', 'csv', 'mapping', 'mode', 'skipRefused']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ImportUnavailable(400, `An import request has no "${unknown}".`);
  const { table, view, name, csv, mapping, mode, skipRefused } = body;
  if (typeof table !== 'string' || !table) throw new ImportUnavailable(400, 'An import names the table it fills.');
  if (view !== undefined && (typeof view !== 'string' || !view)) throw new ImportUnavailable(400, "An import's view is a view key.");
  if (typeof csv !== 'string') throw new ImportUnavailable(400, 'An import carries the file as text.');
  if (Buffer.byteLength(csv, 'utf8') > IMPORT_LIMITS.bytes) {
    throw new ImportUnavailable(400, `The file is larger than ${IMPORT_LIMITS.bytes / 1024 / 1024} MB. Split it and import each part.`);
  }
  if (
    !Array.isArray(mapping) ||
    mapping.length > IMPORT_LIMITS.columns ||
    mapping.some((item) => item !== null && (typeof item !== 'string' || !item || item.length > 128))
  ) {
    throw new ImportUnavailable(400, "An import's mapping names a field, or null, for each column.");
  }
  if (mode !== 'check' && mode !== 'commit') throw new ImportUnavailable(400, 'An import\'s mode is "check" or "commit".');
  if (skipRefused !== undefined && typeof skipRefused !== 'boolean') throw new ImportUnavailable(400, '"skipRefused" is true or false.');
  // A file's name is only ever words in a reply; it never names a place on disk.
  const named =
    typeof name === 'string'
      ? name
          .replace(/[\p{Cc}/\\]/gu, '')
          .trim()
          .slice(0, 120)
      : undefined;
  return {
    table,
    ...(view ? { view } : {}),
    ...(named ? { name: named } : {}),
    csv,
    mapping: mapping as Array<string | null>,
    mode,
    ...(skipRefused ? { skipRefused: true } : {}),
  };
}

/** A row as read from its cells: values, references still to find, and what is already wrong. */
interface ReadRow {
  index: number;
  line: number;
  values: Record<string, string | number | boolean | null>;
  lookups: Map<string, string>;
  /** `withRun`: a row refused only because another row of its run is. */
  problems: Array<{ field?: string; message: string; withRun?: true }>;
}

const REASONS: Record<CommandInputReason, string> = {
  shape: 'This is not what the command takes.',
  required: 'A value is required.',
  type: 'This is not the right kind of value.',
  text: 'This is not text.',
  too_short: 'This is too short.',
  too_long: 'This is too long.',
  format: 'This is not in the expected format.',
  pattern: 'This is not in the expected form.',
  below_min: 'This is below the smallest value allowed.',
  above_max: 'This is above the largest value allowed.',
  integer: 'This is not a whole number.',
  precision: 'This has more decimals than the currency has.',
  not_below: 'This must be below its pair.',
  not_above: 'This must be above its pair.',
  choice: 'This is not one of the choices.',
  too_few: 'This has too few entries.',
  too_many: 'This has too many entries.',
  exclusive: 'This choice stands alone.',
};

export async function runImport(runtime: ImportRuntime, request: ImportRequest): Promise<ImportReport> {
  const { app, schema } = runtime;
  const declared = importDeclaration(app as never, request.table, request.view);
  const table = findTable(schema, request.table);
  if (!declared || !table) throw new ImportUnavailable(404, 'This list does not import files.');
  const def = declared.def;
  if (def.command ? !runtime.commands : !runtime.writer || table.insertable === false) {
    throw new ImportUnavailable(403, 'Access to this resource is denied.');
  }
  const labelOf = (column: string) => columnCaption(app.resources ?? {}, schema, table.id, column);
  /* A column kept in minor units is read in its rule's currency, else the App's (money.ts). */
  const ruleOf = (column: string) => {
    const resources = (app.resources ?? {}) as Record<string, { display?: Record<string, unknown> }>;
    const rule = (resources[table.id] ?? resources[table.name])?.display?.[column] as
      | { format?: string; minor?: true; currency?: string; currencyColumn?: string }
      | undefined;
    return rule?.format === 'money' && rule.minor ? rule : undefined;
  };
  const minorOf = (column: string) => {
    const rule = ruleOf(column);
    return rule ? (rule.currency ?? (app as { ui?: { currency?: string } }).ui?.currency ?? 'USD') : undefined;
  };
  /* Where each row says its own currency, a row's figure is read in it: "1,500" yen is 1500, not 150000. */
  const fields = importFields(
    table,
    def,
    labelOf,
    minorOf,
    (column) => ruleOf(column)?.currencyColumn,
    narrowedFixedColumns(table, app.resources?.[table.id]?.query),
  );
  const fieldLabel = (name: string) => fields.find((field) => field.name === name)?.label ?? humanName(name);

  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(request.csv, { maxRows: IMPORT_LIMITS.rows, maxColumns: IMPORT_LIMITS.columns, maxField: IMPORT_LIMITS.field });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { outcome: 'not_applied', rows: 0, ready: 0, refused: [], error: `Line ${error.line}: ${error.message}` };
  }
  const { header, rows, lines } = parsed;
  const mappingIssue = mappingProblem(request.mapping, fields, header.length);
  if (mappingIssue) return { outcome: 'not_applied', rows: rows.length, ready: 0, refused: [], error: mappingIssue };
  if (!rows.length) return { outcome: 'not_applied', rows: 0, ready: 0, refused: [], error: 'The file has a header and no rows.' };

  const read = rows.map((cells, index) => readRow(cells, index, lines[index], header.length, request.mapping, fields, runtime.locale));
  await resolveReferences(runtime, fields, read);
  checkCancelled(runtime.signal);

  return def.command
    ? commandImport(runtime, request, table, declared, def, fields, fieldLabel, read)
    : plainImport(runtime, request, table, fields, fieldLabel, read);
}

function readRow(
  cells: string[],
  index: number,
  line: number,
  width: number,
  mapping: ReadonlyArray<string | null>,
  fields: readonly ImportField[],
  locale: string,
): ReadRow {
  const row: ReadRow = { index, line, values: {}, lookups: new Map(), problems: [] };
  if (cells.length > width) row.problems.push({ message: `The line has ${cells.length} fields; the header names ${width}.` });
  /* A row's own currency, from the cell its money says it in (`currency: { column }`), when the file maps one. */
  const said = (name: string) => {
    const at = mapping.indexOf(name);
    const code = at < 0 ? '' : (cells[at] ?? '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : undefined;
  };
  mapping.forEach((name, column) => {
    if (name === null) return;
    const field = fields.find((candidate) => candidate.name === name)!;
    const reading = readCell(field, cells[column] ?? '', locale, field.minorBy ? said(field.minorBy) : undefined);
    if ('problem' in reading) row.problems.push({ field: field.name, message: reading.problem });
    else if ('lookup' in reading) row.lookups.set(field.name, reading.lookup);
    else if ('value' in reading) row.values[field.name] = reading.value;
    else if (field.required) row.problems.push({ field: field.name, message: 'A value is required.' });
  });
  return row;
}

const checkCancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new ImportUnavailable(400, 'The import was cancelled.');
};

/* ---------- a reference, by the record's name ---------- */

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Every reference cell found by the record it names, a batch per field: by
 * the resource's `address` natural key first, exactly, when it declares one;
 * then by its key, its record name (a column, or a templated `$label`), the column
 * the catalog names it by, or a column the database keeps unique. One
 * record, or the row is refused — none found, or several a name could mean.
 * Read under the reader's grants: a record they cannot read is not found.
 */
async function resolveReferences(runtime: ImportRuntime, fields: readonly ImportField[], rows: ReadRow[]): Promise<void> {
  for (const field of fields) {
    if (field.kind !== 'reference' || !field.references) continue;
    const texts = [...new Set(rows.flatMap((row) => (row.lookups.has(field.name) ? [row.lookups.get(field.name)!] : [])))];
    if (!texts.length) continue;
    const found = await findByName(runtime, field.references.table, field.references.column, texts);
    for (const row of rows) {
      const text = row.lookups.get(field.name);
      if (text === undefined) continue;
      const match = found.get(text);
      if (match && 'value' in match) row.values[field.name] = match.value;
      else row.problems.push({ field: field.name, message: match?.problem ?? `"${text}" names no record.` });
    }
  }
}

async function findByName(
  runtime: ImportRuntime,
  tableId: string,
  keyColumn: string,
  texts: string[],
): Promise<Map<string, { value: string | number } | { problem: string }>> {
  const { schema, app } = runtime;
  const answers = new Map<string, { value: string | number } | { problem: string }>();
  const parent = findTable(schema, tableId);
  const noun = (app.resources?.[tableId]?.noun?.one ?? humanName(parent?.name ?? tableId)).toLowerCase();
  if (!parent || !parent.columns.some((column) => column.name === keyColumn)) {
    for (const text of texts) answers.set(text, { problem: `"${text}" names a ${noun}, which you cannot read.` });
    return answers;
  }
  const kindOf = (path: string) =>
    path === '$label' ? 'text' : columnKind(parent.columns.find((column) => column.name === path)?.type ?? '');
  /* The natural key is unique among the records the reader may read (within the tenant, in a tenant App), so a
     text it holds names that one record exactly; a name only answers what the key did not. */
  const address = app.resources?.[tableId]?.address;
  let named = texts;
  if (address && parent.columns.some((column) => column.name === address)) {
    const found = await matchColumns(runtime, parent, keyColumn, [address], kindOf, texts);
    for (const [text, keys] of found) if (keys.size === 1) answers.set(text, { value: [...keys.values()][0] });
    named = texts.filter((text) => !answers.has(text));
    if (!named.length) return answers;
  }
  const naming = namingColumns(parent, keyColumn, app.resources?.[tableId]?.recordLabel);
  const matches = await matchColumns(runtime, parent, keyColumn, naming, kindOf, named);
  for (const text of named) {
    const keys = matches.get(text);
    if (!keys?.size) answers.set(text, { problem: `No ${noun} is named "${text}".` });
    else if (keys.size > 1)
      answers.set(text, {
        problem: `"${text}" could name ${keys.size} records of ${noun}; use the one's own ${humanName(keyColumn)} instead.`,
      });
    else answers.set(text, { value: [...keys.values()][0] });
  }
  return answers;
}

/* The records whose `naming` columns hold one of the texts, read under the reader's grants, 200 texts at a time. */
async function matchColumns(
  runtime: ImportRuntime,
  parent: TableMeta,
  keyColumn: string,
  naming: readonly string[],
  kindOf: (path: string) => string,
  texts: readonly string[],
): Promise<Map<string, Map<string, string | number>>> {
  const matches = new Map<string, Map<string, string | number>>();
  for (let at = 0; at < texts.length; at += 200) {
    checkCancelled(runtime.signal);
    const chunk = texts.slice(at, at + 200);
    const groups: ViewCondition[][] = naming.flatMap((path) => {
      const kind = kindOf(path);
      const values = kind === 'number' ? chunk.filter((text) => NUMBER_TEXT.test(text)).map(Number) : kind === 'text' ? chunk : [];
      return values.length ? [[{ path, op: 'in' as const, value: values }]] : [];
    });
    if (!groups.length) continue;
    const view: ViewDef = {
      id: 'import',
      name: 'import',
      base: parent.id,
      columns: [...new Set([keyColumn, ...naming])].map((path) => ({ path })),
      filter: { groups },
    };
    const { result } = await readView(runtime.reader, runtime.schema, view, { limit: 5000 }, 'none');
    for (const row of result.rows) {
      const key = row[keyColumn];
      if (typeof key !== 'string' && typeof key !== 'number') continue;
      for (const path of naming) {
        const said = row[path];
        if (said === null || said === undefined) continue;
        const text = String(said);
        if (!chunk.includes(text)) continue;
        const keys = matches.get(text) ?? new Map<string, string | number>();
        keys.set(String(key), key);
        matches.set(text, keys);
      }
    }
  }
  return matches;
}

/* ---------- a plain import ---------- */

async function plainImport(
  runtime: ImportRuntime,
  request: ImportRequest,
  table: TableMeta,
  fields: readonly ImportField[],
  fieldLabel: (name: string) => string,
  rows: ReadRow[],
): Promise<ImportReport> {
  const writer = runtime.writer!;
  const rules = runtime.app.resources?.[table.id]?.validation;
  // Two rows of one file cannot both hold a value the database keeps unique.
  const unique = [...new Set([...primaryKey(table), ...(table.unique ?? [])])].filter((column) =>
    fields.some((field) => field.name === column),
  );
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.problems.length) continue;
    for (const column of unique) {
      const value = row.values[column];
      if (value === undefined || value === null) continue;
      const said = `${column}\u0000${String(value)}`;
      if (seen.has(said))
        row.problems.push({ field: column, message: `"${String(value)}" is also on row ${seen.get(said)! + 1}; it must be unique.` });
      else seen.set(said, row.index);
    }
    // The resource's own rules, in its own words, before the database is asked.
    if (rules?.length) {
      const judged = evaluateFormRules(rules, row.values, table.columns, { mode: 'preview' });
      for (const [field, messages] of Object.entries(judged.errors)) {
        for (const message of messages) row.problems.push({ field, message });
      }
    }
  }
  const requests = new Map<number, InsertRequest>();
  for (const row of rows) {
    if (row.problems.length) continue;
    checkCancelled(runtime.signal);
    const insert: InsertRequest = { table: table.id, values: { ...row.values } };
    try {
      await writer.trial(insert);
      requests.set(row.index, insert);
    } catch (error) {
      row.problems.push(...refusalOf(error, fieldLabel));
    }
  }
  const refused = refusedRows(rows, fieldLabel);
  if (request.mode === 'check') return { outcome: 'checked', rows: rows.length, ready: requests.size, refused };
  if ((refused.length && !request.skipRefused) || !requests.size) {
    return {
      outcome: 'not_applied',
      rows: rows.length,
      ready: requests.size,
      refused,
      ...(requests.size ? {} : { error: 'No row can be imported.' }),
    };
  }
  try {
    await attributeAction('Import', () => writer.commit([...requests.values()]));
    return { outcome: 'applied', rows: rows.length, ready: requests.size, applied: requests.size, refused };
  } catch (error) {
    // One transaction: nothing was written, unless its outcome is unknown.
    const failure = appError(error, 'write');
    const unknown = failure.code === 'write_unconfirmed';
    return {
      outcome: unknown ? 'unknown' : 'not_applied',
      rows: rows.length,
      ready: 0,
      refused,
      error: unknown ? failure.message : `Nothing was imported: ${failure.message} Check the file again; a record may have changed since.`,
    };
  }
}

/** What a writer's refusal says about one row, in the App's words, never the driver's. */
function refusalOf(error: unknown, fieldLabel: (name: string) => string): Array<{ field?: string; message: string }> {
  const failure = appError(error, 'write', false, fieldLabel);
  /* The App's rules say why in the rule's own words, which an import does not repeat; a constraint the database
     enforced names its field in plain words (appErrors.ts), which it does. */
  if (failure.fields?.length)
    return failure.fields.map((item) => ({
      field: item.field,
      message: failure.code === 'validation_failed' ? "This value does not meet the App's rules." : item.message,
    }));
  if (failure.code === 'write_unconfirmed') return [{ message: 'The database did not accept this row.' }];
  if (failure.columns?.length)
    return [
      {
        message: failure.message.replace(/"([^"]+)"/g, (said, name: string) =>
          failure.columns!.includes(name) ? `"${fieldLabel(name)}"` : said,
        ),
      },
    ];
  return [{ message: failure.message }];
}

function refusedRows(rows: readonly ReadRow[], fieldLabel: (name: string) => string): ImportRowProblem[] {
  return rows
    .filter((row) => row.problems.length)
    .map((row) => ({
      row: row.index + 1,
      line: row.line,
      problems: row.problems.map((problem) =>
        problem.field ? { field: fieldLabel(problem.field), message: problem.message } : { message: problem.message },
      ),
    }));
}

/* ---------- a command import ---------- */

/** One command run: its rows, the record it updates (or none, when it creates), and the input they make. */
interface CommandRun {
  rows: ReadRow[];
  outcome: 'create' | 'update' | 'refused';
  key: Record<string, string | number>;
  input: Record<string, unknown>;
  problems: Array<{ field?: string; message: string }>;
  writes: Record<string, number>;
  ran?: false;
}

/**
 * A command import's runs: consecutive rows that agree on the `group` columns
 * are one run, one row is one run without it. Rows are never reordered: the
 * same values further down the file start a run of their own. A row whose
 * group cell is empty, or unreadable, stands alone.
 */
export function importRuns<Row extends { values: Record<string, unknown>; lookups: Map<string, string> }>(
  rows: readonly Row[],
  group: readonly string[] | undefined,
): Row[][] {
  if (!group?.length) return rows.map((row) => [row]);
  const runs: Row[][] = [];
  let last: string | undefined;
  for (const row of rows) {
    const said = group.map((name) => row.lookups.get(name) ?? row.values[name]);
    const key = said.some((value) => value === undefined || value === null || value === '') ? undefined : JSON.stringify(said);
    if (key !== undefined && key === last) runs[runs.length - 1].push(row);
    else runs.push([row]);
    last = key;
  }
  return runs;
}

async function commandImport(
  runtime: ImportRuntime,
  request: ImportRequest,
  table: TableMeta,
  declared: { query?: string },
  def: AppImportDef,
  fields: readonly ImportField[],
  fieldLabel: (name: string) => string,
  rows: ReadRow[],
): Promise<ImportReport> {
  const command = def.command!;
  const commands = runtime.commands!;
  const creates = command.targets === 'none';
  const keyColumns = primaryKey(table);
  // The run's first row fills the top level; each row of a run fills one entry of the repeated group.
  const topLevel = fields.filter((field) => !field.in);
  const inputs = topLevel.filter((field) => field.field && (creates || !field.match));
  const repeated = def.group
    ? (command.input.find((field) => field.type === 'group' && field.repeat) as AppCommandGroup | undefined)
    : undefined;
  const entries = fields.filter((field) => field.in);
  const standing = textToView(runtime.schema, `${table.id} ${declared.query ?? ''}`.trim(), {
    id: 'import',
    name: 'import',
    now: runtime.now(),
    ...(runtime.person ? { me: runtime.person } : {}),
  });
  if (!standing.view || standing.errors.length) throw new ImportUnavailable(404, 'This list does not import files.');
  const base = standing.view;
  const said = (row: ReadRow, name: string) => row.lookups.get(name) ?? row.values[name];
  const valueOf = (field: ImportField, value: unknown) => (field.kind === 'date' && typeof value === 'string' ? value.slice(0, 10) : value);
  const runs: CommandRun[] = importRuns(rows, def.group).map((members) => ({
    rows: members,
    outcome: 'refused',
    key: {},
    input: {},
    problems: [],
    writes: {},
  }));
  const targeted = new Map<string, number>();
  for (const run of runs) {
    checkCancelled(runtime.signal);
    const [first] = run.rows;
    // A run's rows say its top-level fields alike: one that says another value is refused, by its row.
    for (const row of run.rows.slice(1)) {
      for (const field of topLevel) {
        if (row.problems.some((problem) => problem.field === field.name)) continue;
        if (JSON.stringify(said(row, field.name) ?? null) !== JSON.stringify(said(first, field.name) ?? null))
          row.problems.push({
            field: field.name,
            message: `This disagrees with row ${first.index + 1}, which starts its run; a run's rows say "${field.label}" alike.`,
          });
      }
    }
    if (repeated && run.rows.length > repeated.repeat!.max) {
      first.problems.push({
        message: `This run has ${run.rows.length} rows; "${repeated.label}" takes at most ${repeated.repeat!.max}. Split it.`,
      });
    }
    if (run.rows.some((row) => row.problems.length)) continue;
    // The record the run acts on: the list's own question and the first row's match columns.
    if (def.match?.length) {
      const conditions: ViewCondition[] = def.match.map((column) => ({
        path: column,
        op: '=' as const,
        value: first.values[column] as string | number,
      }));
      const groups = (base.filter?.groups.length ? base.filter.groups : [[]]).map((group) => [...group, ...conditions]);
      const found = await readView(
        runtime.reader,
        runtime.schema,
        { id: 'import', name: 'import', base: base.base, columns: keyColumns.map((path) => ({ path })), filter: { groups } },
        { limit: 2 },
        'none',
      );
      const described = def.match
        .map((column) => `${fieldLabel(column)} ${first.lookups.get(column) ?? String(first.values[column])}`)
        .join(', ');
      const hits = found.result.rows;
      if (hits.length > 1) {
        first.problems.push({ message: `${described} finds more than one record; add a column that tells them apart.` });
        continue;
      }
      if (hits.length === 1 && creates) {
        first.problems.push({ message: `${described} finds a record already; this import creates records.` });
        continue;
      }
      if (!hits.length && !creates) {
        first.problems.push({ message: `No record in this list has ${described}.` });
        continue;
      }
      if (hits.length) run.key = Object.fromEntries(keyColumns.map((column) => [column, hits[0][column] as string | number]));
      // Each record is imported once: by the key it finds, or, for one this import creates, by the values that find it.
      const target = hits.length ? JSON.stringify(run.key) : `new\u0000${JSON.stringify(def.match.map((column) => first.values[column]))}`;
      if (targeted.has(target)) {
        first.problems.push({
          message: hits.length
            ? `This row finds the same record as row ${targeted.get(target)! + 1}; each record is imported once.`
            : `Row ${targeted.get(target)! + 1} creates this record already; each record is imported once.`,
        });
        continue;
      }
      targeted.set(target, first.index);
    }
    for (const field of inputs) {
      const value = first.values[field.name];
      if (value !== undefined && value !== null) run.input[field.name] = valueOf(field, value);
    }
    if (repeated)
      run.input[repeated.name] = run.rows.map((row) => {
        const entry: Record<string, unknown> = {};
        for (const field of entries) {
          const value = row.values[field.name];
          if (value !== undefined && value !== null) entry[field.name.slice(repeated.name.length + 1)] = valueOf(field, value);
        }
        return entry;
      });
    // The command's own reading of its input, every problem at once, each on the row whose cell said it.
    const problems = commandInputProblems(command.input, run.input);
    for (const problem of problems) {
      const entry = repeated && new RegExp(`^${repeated.name}\\[(\\d+)\\]\\.([^[.]+)`).exec(problem.path);
      const row = entry ? (run.rows[Number(entry[1])] ?? first) : first;
      const field = entry ? `${repeated!.name}.${entry[2]}` : problem.path.replace(/[[.].*$/, '');
      row.problems.push({ ...(field ? { field } : {}), message: REASONS[problem.reason] });
    }
    if (problems.length) continue;
    run.outcome = creates ? 'create' : 'update';
  }
  // Each run tried: its handler run in a transaction that is always rolled back, under the same grants as its commit.
  for (const run of runs) {
    if (run.outcome === 'refused') continue;
    checkCancelled(runtime.signal);
    try {
      const body = await envelope(command, commands, run);
      if (request.mode === 'check') {
        const trial = (await commands.trial(body)) as { ran?: boolean; writes?: Record<string, number> };
        if (trial?.ran === false) {
          run.ran = false;
          run.problems.push({ message: 'Checked without running: calls a provider.' });
        } else run.writes = { ...(trial?.writes ?? {}) };
      }
    } catch (error) {
      run.rows[0].problems.push(commandRefusal(error));
      run.outcome = 'refused';
    }
  }
  settleRuns(runs);
  const readyRows = (list: readonly CommandRun[]) => list.reduce((sum, run) => sum + run.rows.length, 0);
  const ready = runs.filter((run) => run.outcome !== 'refused');
  let refused = refusedRows(rows, fieldLabel);
  if (request.mode === 'check')
    return { outcome: 'checked', rows: rows.length, ready: readyRows(ready), refused, runs: reportRuns(runs, fieldLabel) };
  if ((refused.length && !request.skipRefused) || !ready.length) {
    return {
      outcome: 'not_applied',
      rows: rows.length,
      ready: readyRows(ready),
      refused,
      runs: reportRuns(runs, fieldLabel),
      ...(ready.length ? {} : { error: 'No row can be imported.' }),
    };
  }
  // The commit runs the inputs the check tried, each run its own transaction.
  let applied = 0;
  let stopped: string | undefined;
  for (const run of ready) {
    if (stopped || runtime.signal.aborted) {
      run.rows[0].problems.push({
        message: stopped ? "Not run: an earlier row's outcome is unknown." : 'Not run: the import was cancelled.',
      });
      run.outcome = 'refused';
      continue;
    }
    try {
      const body = await envelope(command, commands, run);
      await attributeAction(runtime.commandLabel, () => commands.execute(body));
      applied += run.rows.length;
    } catch (error) {
      run.rows[0].problems.push(commandRefusal(error));
      run.outcome = 'refused';
      if ((error as { outcome?: string }).outcome === 'unknown') stopped = 'unknown';
    }
  }
  settleRuns(runs);
  refused = refusedRows(rows, fieldLabel);
  const readyCount = readyRows(ready);
  return {
    outcome: stopped ? 'unknown' : applied === readyCount ? 'applied' : applied ? 'partial' : 'not_applied',
    rows: rows.length,
    ready: readyCount,
    applied,
    refused,
    runs: reportRuns(runs, fieldLabel),
  };
}

/* A run's command as its own route would be sent it: a record's prepared for the revision it holds now, a new one at 0. */
async function envelope(command: NonNullable<AppImportDef['command']>, commands: ImportCommands, run: CommandRun) {
  let expectedVersion = 0;
  if (run.outcome === 'update') {
    const prepared = (await commands.prepare({ command: command.id, commandVersion: command.version, key: run.key })) as {
      expectedVersion?: unknown;
    };
    if (typeof prepared?.expectedVersion !== 'number') throw new Error('The command did not prepare.');
    expectedVersion = prepared.expectedVersion;
  }
  return {
    command: command.id,
    commandVersion: command.version,
    key: run.key,
    expectedVersion,
    idempotencyKey: `import-${randomUUID().replace(/-/g, '')}`,
    input: run.input,
  };
}

/* A run is refused when any of its rows is; its other rows say why they were not imported. */
function settleRuns(runs: readonly CommandRun[]) {
  for (const run of runs) {
    const refusing = run.rows.find((row) => row.problems.length && !row.problems.every((problem) => problem.withRun));
    if (!refusing) continue;
    run.outcome = 'refused';
    for (const row of run.rows)
      if (!row.problems.length)
        row.problems.push({ message: `Not imported: row ${refusing.index + 1} of its run is refused.`, withRun: true });
  }
}

function reportRuns(runs: readonly CommandRun[], fieldLabel: (name: string) => string): ImportRun[] {
  return runs.map((run) => {
    const several = run.rows.length > 1;
    const problems = [
      ...run.rows.flatMap((row) =>
        row.problems
          .filter((problem) => !problem.withRun)
          .map((problem) => ({
            ...(problem.field ? { field: fieldLabel(problem.field) } : {}),
            message: several ? `Row ${row.index + 1}: ${problem.message}` : problem.message,
          })),
      ),
      ...run.problems,
    ];
    return {
      rows: run.rows.map((row) => row.index + 1),
      outcome: run.outcome,
      writes: run.writes,
      problems,
      ...(run.ran === false ? { ran: false as const } : {}),
    };
  });
}

function commandRefusal(error: unknown): { field?: string; message: string } {
  const refusal = error as { message?: unknown; field?: unknown; code?: unknown };
  if (typeof refusal?.code === 'string' && typeof refusal.message === 'string') {
    return { ...(typeof refusal.field === 'string' ? { field: refusal.field.replace(/[[.].*$/, '') } : {}), message: refusal.message };
  }
  return { message: 'The command could not run for this row.' };
}

/* A command's writes are its own to reverse: there is no generic inverse of
   a business rule, so a command import says so rather than offering one. */
