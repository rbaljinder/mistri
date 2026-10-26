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
 * resource's declared command once per row, on the record the row's `match`
 * columns find — prepared and executed exactly as the command's own route
 * would, so it never goes around the command — and reports each row.
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
} from '../../shared/appImport.js';
import { IMPORT_LIMITS } from '../../shared/appImportDeclaration.js';
import { importDeclaration, type AppImportDef } from '../../shared/appImportDeclaration.js';
import type { ViewCondition, ViewDef } from '@mistriwork/engine/shared/viewPaths.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { readView } from '@mistriwork/engine/server/resourceReadOperations.js';
import { appError } from './appErrors.js';

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

/** Where a command import's rows go: the command's own prepare and execute. */
interface ImportCommands {
  prepare(body: unknown): Promise<unknown>;
  execute(body: unknown): Promise<unknown>;
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
  problems: Array<{ field?: string; message: string }>;
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
  const fields = importFields(table, def, labelOf, minorOf, (column) => ruleOf(column)?.currencyColumn);
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
 * its key, its record name (a column, or a templated `$label`), the column
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
  const naming = namingColumns(parent, keyColumn, app.resources?.[tableId]?.recordLabel);
  const kindOf = (path: string) =>
    path === '$label' ? 'text' : columnKind(parent.columns.find((column) => column.name === path)?.type ?? '');
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
    const { result } = await readView(runtime.reader, schema, view, { limit: 5000 }, 'none');
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
  for (const text of texts) {
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
  const keyColumns = primaryKey(table);
  const inputs = fields.filter((field) => !field.match);
  const standing = textToView(runtime.schema, `${table.id} ${declared.query ?? ''}`.trim(), {
    id: 'import',
    name: 'import',
    now: runtime.now(),
    ...(runtime.person ? { me: runtime.person } : {}),
  });
  if (!standing.view || standing.errors.length) throw new ImportUnavailable(404, 'This list does not import files.');
  const base = standing.view;
  const ready = new Map<number, { key: Record<string, string | number>; input: Record<string, unknown> }>();
  const targeted = new Map<string, number>();
  for (const row of rows) {
    if (row.problems.length) continue;
    checkCancelled(runtime.signal);
    // The record the row runs on: the list's own question and the row's match columns, exactly one.
    const conditions: ViewCondition[] = (def.match ?? []).map((column) => ({
      path: column,
      op: '=' as const,
      value: row.values[column] as string | number,
    }));
    const groups = (base.filter?.groups.length ? base.filter.groups : [[]]).map((group) => [...group, ...conditions]);
    const found = await readView(
      runtime.reader,
      runtime.schema,
      { id: 'import', name: 'import', base: base.base, columns: keyColumns.map((path) => ({ path })), filter: { groups } },
      { limit: 2 },
      'none',
    );
    const described = (def.match ?? [])
      .map((column) => `${fieldLabel(column)} ${row.lookups.get(column) ?? String(row.values[column])}`)
      .join(', ');
    if (found.result.rows.length !== 1) {
      row.problems.push({
        message: found.result.rows.length
          ? `${described} finds more than one record; add a column that tells them apart.`
          : `No record in this list has ${described}.`,
      });
      continue;
    }
    const key = Object.fromEntries(keyColumns.map((column) => [column, found.result.rows[0][column] as string | number]));
    const said = JSON.stringify(key);
    if (targeted.has(said)) {
      row.problems.push({ message: `This row finds the same record as row ${targeted.get(said)! + 1}; each record is imported once.` });
      continue;
    }
    targeted.set(said, row.index);
    const input: Record<string, unknown> = {};
    for (const field of inputs) {
      const value = row.values[field.name];
      if (value === undefined || value === null) continue;
      input[field.name] = field.kind === 'date' && typeof value === 'string' ? value.slice(0, 10) : value;
    }
    // The command's own reading of its input, every problem at once.
    const problems = commandInputProblems(command.input, input);
    if (problems.length) {
      for (const problem of problems)
        row.problems.push({ ...(problem.path ? { field: problem.path.replace(/[[.].*$/, '') } : {}), message: REASONS[problem.reason] });
      continue;
    }
    try {
      await commands.prepare({ command: command.id, commandVersion: command.version, key });
      ready.set(row.index, { key, input });
    } catch (error) {
      row.problems.push(commandRefusal(error));
    }
  }
  let refused = refusedRows(rows, fieldLabel);
  if (request.mode === 'check') return { outcome: 'checked', rows: rows.length, ready: ready.size, refused };
  if ((refused.length && !request.skipRefused) || !ready.size) {
    return {
      outcome: 'not_applied',
      rows: rows.length,
      ready: ready.size,
      refused,
      ...(ready.size ? {} : { error: 'No row can be imported.' }),
    };
  }
  let applied = 0;
  let stopped: string | undefined;
  for (const row of rows) {
    const job = ready.get(row.index);
    if (!job) continue;
    if (stopped || runtime.signal.aborted) {
      row.problems.push({ message: stopped ? "Not run: an earlier row's outcome is unknown." : 'Not run: the import was cancelled.' });
      continue;
    }
    try {
      // Each row prepared again, for the revision it holds now, then run.
      const prepared = (await commands.prepare({ command: command.id, commandVersion: command.version, key: job.key })) as {
        expectedVersion?: unknown;
      };
      if (typeof prepared?.expectedVersion !== 'number') throw new Error('The command did not prepare.');
      await attributeAction(runtime.commandLabel, () =>
        commands.execute({
          command: command.id,
          commandVersion: command.version,
          key: job.key,
          expectedVersion: prepared.expectedVersion,
          idempotencyKey: `import-${randomUUID().replace(/-/g, '')}`,
          input: job.input,
        }),
      );
      applied++;
    } catch (error) {
      row.problems.push(commandRefusal(error));
      if ((error as { outcome?: string }).outcome === 'unknown') stopped = 'unknown';
    }
  }
  refused = refusedRows(rows, fieldLabel);
  return {
    outcome: stopped ? 'unknown' : applied === ready.size ? 'applied' : applied ? 'partial' : 'not_applied',
    rows: rows.length,
    ready: ready.size,
    applied,
    refused,
  };
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
