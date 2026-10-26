/**
 * Stamps: the values a fixed action's `set` may write that are not
 * literals. The constants `now`, `today` and `me` from `@mistriwork/mistri/app` —
 * `now` the moment the server writes the change, `today` the App's day then,
 * `me` the signed-in person who made it — and a constant expression in the
 * computed-column grammar, `computed.date('today + 14 days')`:
 *
 *   action('Resolve', { set: { status: 'resolved', resolved_at: now, resolved_by: me } })
 *   action('Snooze', { set: { follow_up_on: computed.date('today + 14 days') } })
 *
 * The model carries the constants as the words 'now', 'today' and 'me'
 * (autoValues.ts), and an expression as its text after `=` ('=today + 14
 * days'), so no literal is ever read as one: a literal that spells either
 * is refused where the action is read.
 *
 * They are reserved in a fixed action's `set` on every column, not only on the
 * columns where they mean something: one word, one meaning, and a stamp on a
 * column that cannot hold it is a load refusal rather than the text "now"
 * stored in a status. The browser sends the word; the server resolves it
 * inside the write (appStamps on the server), so the value is never the
 * client's to choose. An expression reads no column: what depends on the
 * record is a command handler's.
 *
 * Pure over one column's catalog entry, so the App's load check, `mistri
 * check` and the server's compile ask the same question.
 */
import {
  columnKind,
  isFlagColumn,
  momentColumn,
  tableNamed,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { grantsByRole, isTenantApp, type AppDef } from './appModel.js';
import { personTable } from './appMe.js';
import { ComputedError, computedKind, computedReads, readsNow, type ComputedNode } from '@mistriwork/engine/shared/computed.js';
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import { formShownFields } from '@mistriwork/engine/shared/form.js';
import { formDefaultWord } from './formRules.js';

const STAMP_WORDS = ['now', 'today', 'me'] as const;

/** How the model marks a `set` value that is an expression: its text after this. */
export const SET_EXPRESSION = '=';

/** A stamp in a fixed action's `set`: one of the words, or an expression's text after `=`. */
const isStampWord = (value: unknown): value is string =>
  typeof value === 'string' && ((STAMP_WORDS as readonly string[]).includes(value) || value.startsWith(SET_EXPRESSION));

/** What a stamp column is written as: a calendar day, an instant, the signed-in account, or an expression's value. */
export type StampColumn =
  | { word: 'now'; as: 'date' | 'instant' | 'instant-zoned' }
  | { word: 'me'; person?: true }
  | { word: string; expr: ComputedNode; as: 'date' | 'instant' | 'instant-zoned' | 'number' | 'boolean' };

/* A DATE is a calendar day; a TIMESTAMP or DATETIME is an instant. A bare
   TIME is a time of day, which "the moment this changed" is not. */
const DAY = /^date$/i;
const INSTANT = /timestamp|datetime/i;
const ZONED = /timestamptz|with time zone/i;

/**
 * A TIMESTAMP or DATETIME that carries no zone (Postgres `timestamp`, MySQL
 * `DATETIME`, SQLite's text datetimes). It holds the wall clock of the App's
 * `ui.timezone`, UTC when the App names none: the one rule every server write
 * and every form default follows, so a value reads the same wherever it came from.
 */
export const zonelessInstant = (type: string | undefined): boolean => INSTANT.test(type ?? '') && !ZONED.test(type ?? '');
/* A calendar day by its type alone: `columnKind` says 'date' for every date
   or time type, so a timestamp read through it would be cut at midnight. */
export const calendarDay = (type: string | undefined): boolean => DAY.test((type ?? '').trim());
/* Text a person's sign-in fits in. uuid and json are text to the query
   language, but an email is neither. */
const TEXT = /char|text|clob/i;
const NOT_TEXT = /uuid|json|enum/i;

/**
 * A `set` expression's tree and what it comes to, or why it is not one: it
 * parses in the computed-column grammar, reads no column, and comes to a
 * date, a number or a yes-or-no.
 */
export function setExpression(
  text: string,
): { expr: ComputedNode; kind: 'date' | 'number' | 'boolean'; now: boolean } | { problem: string } {
  let expr: ComputedNode;
  try {
    expr = parseComputed(text, () => false);
  } catch (error) {
    return { problem: `"${text}" is not an expression: ${error instanceof ComputedError ? error.message : String(error)}` };
  }
  const reads = computedReads(expr);
  if (reads.length) {
    return {
      problem:
        `"${text}" reads "${reads[0]}". A set expression reads no column — today, now, me, numbers and dates — ` +
        "and a value worked out from the record is a command handler's.",
    };
  }
  let kind;
  try {
    kind = computedKind(expr, () => undefined);
  } catch (error) {
    return { problem: `"${text}": ${(error as Error).message}` };
  }
  if (kind !== 'date' && kind !== 'number' && kind !== 'boolean') {
    return {
      problem: `"${text}" comes to ${kind === 'span' ? 'a span of days' : `a ${kind}`}; a set expression comes to a date, a number or a yes-or-no.`,
    };
  }
  return { expr, kind, now: readsNow(expr) };
}

/**
 * How `column` holds `word`, or why it cannot: the one rule an action's `set`,
 * a machine's `since`, a state's own stamp and a command's write all follow.
 * `reference` is the table the column points at, if any; `people` the table
 * people are rows of (`auth.me`). `me` on a reference to it is the signed-in
 * person's row, as a form's `me` is; on a reference to any other table no
 * account maps to a row, so it is refused rather than guessed.
 */
export function stampColumn(
  word: string,
  column: ColumnMeta,
  reference: string | false,
  people?: string,
): { column: StampColumn } | { problem: string } {
  const type = (column.type ?? '').trim();
  if (column.primaryKey) return { problem: `"${column.name}" is part of the key, and a stamp does not move a key.` };
  if (word === 'today' || word.startsWith(SET_EXPRESSION)) return expressionColumn(word, column, type, reference !== false);
  if (word === 'now') {
    const held = momentColumn(column);
    if (held) return { column: { word, as: held } };
    return {
      problem:
        `"${column.name}" is ${type || 'untyped'}, and the constant now is written only to a DATE, TIMESTAMP or DATETIME column, ` +
        'or a text column named for a moment (ends _at or _on). Declare the column as one of those, or set a literal.',
    };
  }
  if (reference) {
    if (people && reference === people) return { column: { word: 'me', person: true } };
    return {
      problem:
        `"${column.name}" references ${reference}, and the constant me is the signed-in person: their row of the table auth.me names` +
        (people ? ` (${people})` : ', which this App does not name') +
        ', or their email on a text column, like approved_by TEXT.',
    };
  }
  if (!TEXT.test(type) || NOT_TEXT.test(type) || columnKind(type) !== 'text') {
    return {
      problem: `"${column.name}" is ${type || 'untyped'}, and the constant me is the signed-in account's email, which only a text column holds.`,
    };
  }
  return { column: { word: 'me' } };
}

/* `today` is the expression it reads as; any other is its text after `=`. */
function expressionColumn(
  word: string,
  column: ColumnMeta,
  type: string,
  reference: boolean,
): { column: StampColumn } | { problem: string } {
  const text = word === 'today' ? 'today' : word.slice(SET_EXPRESSION.length);
  const judged = setExpression(text);
  if ('problem' in judged) return judged;
  const said = word === 'today' ? 'the constant today' : `"${text}"`;
  if (reference) return { problem: `"${column.name}" references another table, and ${said} is not a row.` };
  if (judged.kind === 'date') {
    if (judged.now) {
      if (INSTANT.test(type)) return { column: { word, expr: judged.expr, as: ZONED.test(type) ? 'instant-zoned' : 'instant' } };
      return {
        problem: `"${column.name}" is ${type || 'untyped'}, and ${said} is a moment, written only to a TIMESTAMP or DATETIME column.`,
      };
    }
    if (DAY.test(type)) return { column: { word, expr: judged.expr, as: 'date' } };
    return {
      problem:
        `"${column.name}" is ${type || 'untyped'}, and ${said} is a day, written only to a DATE column` +
        (INSTANT.test(type) ? ' (a moment is said from now: "now + 14 days").' : '.'),
    };
  }
  if (judged.kind === 'boolean') {
    if (isFlagColumn(column)) return { column: { word, expr: judged.expr, as: 'boolean' } };
    return { problem: `"${column.name}" is ${type || 'untyped'}, and ${said} is a yes-or-no, written only to a boolean column.` };
  }
  if (columnKind(type) === 'number' && !isFlagColumn(column)) return { column: { word, expr: judged.expr, as: 'number' } };
  return { problem: `"${column.name}" is ${type || 'untyped'}, and ${said} is a number, written only to a numeric column.` };
}

/** The table `column` points at, by its declared reference or a foreign key; false for none. */
function referencedTable(column: ColumnMeta, table: TableMeta, schema: DatabaseSchema): string | false {
  if (column.references) return tableNamed(schema, column.references.table)?.id ?? column.references.table;
  const fk = schema.foreignKeys.find(
    (key) => key.from.table === table.id && key.from.columns.length === 1 && key.from.columns[0] === column.name,
  );
  return fk ? fk.to.table : false;
}

/** Table id → column → stamp word → how the server writes the stamp a fixed action sets there. */
export type AppStampRules = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, StampColumn>>>;

/** A fixed action's stamps, each judged against its column. The first column
    that cannot hold its stamp is the action's problem. */
export function actionStamps(
  action: { id: string; set?: Readonly<Record<string, unknown>> },
  table: TableMeta,
  schema: DatabaseSchema,
  people?: string,
): { stamps: Map<string, StampColumn>; problem?: string } {
  const stamps = new Map<string, StampColumn>();
  for (const [column, value] of Object.entries(action.set ?? {})) {
    if (!isStampWord(value)) continue;
    const meta = table.columns.find((candidate) => candidate.name === column);
    if (!meta) continue;
    const judged = stampColumn(value, meta, referencedTable(meta, table, schema), people);
    if ('problem' in judged) {
      const said = value.startsWith(SET_EXPRESSION) ? value.slice(SET_EXPRESSION.length) : value;
      return { stamps, problem: `action "${action.id}" sets "${column}" to '${said}': ${judged.problem}` };
    }
    stamps.set(column, judged.column);
  }
  return { stamps };
}

/**
 * The columns an App's fixed actions stamp, keyed by table id. A stamp the
 * server could not write is a problem before the App starts, never a word
 * stored as text.
 */
export function appStampRules(
  app: AppDef,
  schema: DatabaseSchema,
): { rules: Map<string, Map<string, Map<string, StampColumn>>>; problems: string[] } {
  const exact = grantsByRole(app);
  const people = personTable(app, schema).table?.id;
  const rules = new Map<string, Map<string, Map<string, StampColumn>>>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (!table) continue;
    for (const action of resource.actions ?? []) {
      if (action.command) continue;
      const { stamps, problem } = actionStamps(action, table, schema, people);
      if (problem) {
        problems.push(`resources "${name}", ${problem}`);
        continue;
      }
      for (const [column, stamp] of stamps) {
        const columns = rules.get(table.id) ?? new Map<string, Map<string, StampColumn>>();
        columns.set(column, (columns.get(column) ?? new Map<string, StampColumn>()).set(stamp.word, stamp));
        rules.set(table.id, columns);
      }
    }
  }
  return { rules, problems };
}

/** A New form's `today`, `now` or `me` default on one column: how it is written, and whether the form asks for it. */
export interface DefaultStamp {
  readonly stamp: StampColumn;
  readonly shown: boolean;
}

/**
 * Table id → column → the constant a resource's New form defaults it to, for
 * the server to write on a create (appStamps on the server). A default its
 * column cannot hold is left out: the form's check says so (validateAppForm).
 */
export function formDefaultStamps(app: AppDef, schema: DatabaseSchema): Map<string, Map<string, DefaultStamp>> {
  const people = personTable(app, schema).table?.id;
  const found = new Map<string, Map<string, DefaultStamp>>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    const defaults = resource.form?.defaults;
    if (!table || !defaults) continue;
    // No show and no steps: the form asks for every editable column.
    const shown = formShownFields(resource.form);
    for (const [field, value] of Object.entries(defaults)) {
      const column = table.columns.find((candidate) => candidate.name === field);
      const word = column && formDefaultWord(column, value);
      if (!column || !word || (word === 'me' && !app.auth)) continue;
      const said = stampColumn(word, column, referencedTable(column, table, schema), people);
      if (!('column' in said)) continue;
      const columns = found.get(table.id) ?? new Map<string, DefaultStamp>();
      columns.set(field, Object.freeze({ stamp: said.column, shown: !shown || shown.includes(field) }));
      found.set(table.id, columns);
    }
  }
  return found;
}

/**
 * The stamps that need no catalog to judge, refused as the App is read: me
 * is somebody only where people sign in, and a tenant App's writes run on an
 * engine that does not resolve stamps yet, so either would store the word.
 */
export function checkStamps(app: AppDef, where: string): void {
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    for (const action of resource.actions ?? []) {
      if (action.command) continue;
      const stamped = Object.entries(action.set ?? {}).filter(([, value]) => isStampWord(value));
      if (!stamped.length) continue;
      if (isTenantApp(app)) {
        throw new Error(
          `${where}: resources "${name}", action "${action.id}" stamps "${stamped[0][0]}" with ${stamped[0][1]}, ` +
            'which a tenant App (auth.rows: "tenant") does not write yet. Write it in a command, from its now() and actor.',
        );
      }
      const me = stamped.find(([, value]) => value === 'me');
      if (me && !app.auth) {
        throw new Error(
          `${where}: resources "${name}", action "${action.id}" sets "${me[0]}" to me, the signed-in person, ` +
            'and this App has no sign-in. Add "auth", or set a literal.',
        );
      }
    }
  }
}
