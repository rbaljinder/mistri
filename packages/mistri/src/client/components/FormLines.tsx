/**
 * A record's lines, edited as a grid, and the figures its form says live.
 *
 * Two places draw the grid. A New form with `form.lines` asks the record's
 * lines under its fields, and they are inserted with it (NewRecord.tsx). The
 * save is one request the server writes in one transaction
 * (server/http/formLinesWrite.ts), each row judged as its own write would be.
 * And a command's `field.lines` input asks them in its form (CommandLines.tsx),
 * for its handler to write: there a column may be copied from the record a
 * line's reference names as it is picked (a variant's price), shown and never
 * sent, and the line's money figures are added up under the grid.
 * What is checked here (a required value, an amount) only saves a round trip;
 * the server judges again.
 *
 * The grid reads as an order's lines read on paper, and becomes a form only
 * where it is touched: each cell is a box with no edge until its row is under
 * the pointer or the box has the focus. A column is laid out by its kind — a
 * reference wide, with the record's photo and its second line where the
 * referenced resource's display rule names them; a count narrow, right-aligned,
 * in tabular figures; money with its currency's sign in the box and its
 * minor-unit decimals once it is left. A computed column of the line that
 * reads only what the line holds (`amount: quantity * unit_price`) is said
 * beside it, read-only, as the line is filled in. Moving a line is a drag on
 * its handle, Alt and an arrow on the handle, or its menu; removing it is the
 * menu's. Narrower than a grid fits (a drawer, a phone), each line is a block
 * of its own: its reference across the top, its figures under it.
 *
 * `LiveValues` says the form's computed columns and rollups as it is filled
 * in, worked out by the evaluator the server's statement agrees with
 * (shared/formLines.ts), as an order's summary: the parts a total adds up,
 * each with its sign, then the total. It writes nothing: the saved record's
 * figures are the server's.
 *
 * Fetched the first time a New form has lines or live figures (appnav.js names it
 * for the kit's form: shellMode.ts `formLines`), and with a command form that asks lines.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, columnDisplay, columnLabel, findTable, labelPath, recordLabel, state } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { defaultCurrency, formatLocale, formatMoney, formatNumber } from '@mistriwork/kit/client/locale.js';
import { autoKey, isRequired } from '@mistriwork/engine/shared/form.js';
import { liveValues, typedValue, type DraftValues } from '../../shared/formLines.js';
import { currencyDigits, minorFigure, rowCurrency } from '@mistriwork/engine/shared/money.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { columnKind, primaryKey, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { sumTerms } from './totalTerms.js';
import { computedReads, type ComputedValue } from '@mistriwork/engine/shared/computed.js';
import type { FieldError } from '@mistriwork/kit/client/fieldErrors.js';
import { booleanChoices } from '@mistriwork/kit/client/rowEditing.js';
import { ValueControl } from '@mistriwork/kit/client/components/GridCellEditor.js';
import { singleReference } from '@mistriwork/kit/client/components/gridCellModel.js';
import { columnInput } from '@mistriwork/kit/client/components/inputRenderers.js';
import { MinorMoneyInput, minorProblem } from '@mistriwork/kit/client/components/MinorMoneyInput.js';
import type { LineDraft } from '@mistriwork/kit/client/shellMode.js';
import { RecordPicker } from '@mistriwork/kit/client/components/RecordPicker.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { Button } from '@mistriwork/ui/Button.js';
import { useAvatarPhotos } from '@mistriwork/kit/client/components/avatarPhotos.js';
import { usePointerDrag, type DropPoint } from '@mistriwork/kit/client/components/usePointerDrag.js';
import { dressFor, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { say } from '../copy/forms/components/FormLines.js';
import './FormLines.css';

/* One row of the grid, as the kit's New form holds it (shellMode.ts): its values as the inputs hold them (stored units). */
export type { LineDraft };

let lastLine = 0;
export const blankLine = (): LineDraft => ({ id: ++lastLine, values: {} });

const ruleOf = (table: TableMeta, column: string) => columnDisplay(table.id, column) as DisplayRule | null;
const minorRule = (table: TableMeta, column: string) => {
  const rule = ruleOf(table, column);
  return rule?.format === 'money' && rule.minor ? rule : undefined;
};

/**
 * What is wrong with each line before the wire, keyed `${row}.${column}`: a
 * required value left empty, an amount that is not one of its currency.
 * `filled` names the columns the save fills (the reference, the place).
 */
export function lineProblems(
  table: TableMeta,
  columns: readonly string[],
  rows: readonly LineDraft[],
  filled: readonly string[] = [],
): Record<string, string> {
  const problems: Record<string, string> = {};
  const assigned = autoKey(table);
  rows.forEach((row, i) => {
    for (const name of columns) {
      const column = table.columns.find((c) => c.name === name);
      if (!column || filled.includes(name)) continue;
      const value = row.values[name] ?? '';
      const rule = minorRule(table, name);
      if (value === '' && isRequired(column, assigned))
        problems[`${i}.${name}`] = say('fill', {
          column: labelOf(table, column),
        });
      else if (rule) {
        const problem = minorProblem(value, rowCurrency(rule, row.values, rule.currency || defaultCurrency()));
        if (problem) problems[`${i}.${name}`] = problem;
      }
    }
  });
  return problems;
}

/** A line's values as the save sends them: what its inputs hold, an empty box left to the database on a new row and cleared on a kept one. */
export function lineValues(row: LineDraft, columns: readonly string[]): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const name of columns) {
    const value = row.values[name];
    if (value === undefined || (value === '' && !row.key)) continue;
    values[name] = value === '' ? null : value;
  }
  return values;
}

/** The server's word on a line's field, which it says as `order_line[2].quantity` (recordWriteOperations.ts). */
export function lineServerProblems(table: TableMeta, errors: readonly FieldError[]): Record<string, string> {
  const prefix = `${table.name}[`;
  return Object.fromEntries(
    errors.flatMap((error) => {
      if (!error.field.startsWith(prefix)) return [];
      const m = /^\[(\d+)\]\.(.+)$/.exec(error.field.slice(table.name.length));
      return m ? [[`${m[1]}.${m[2]}`, error.message]] : [];
    }),
  );
}

function labelOf(table: TableMeta, column: ColumnMeta): string {
  return (columnLabel(table.id, column.name) as string | null) ?? humanName(column.name);
}

/** The sign a currency is written with here: "$", "€", "CHF". */
export function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat(formatLocale(), { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')
        ?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/* ---------- columns by kind ---------- */

/**
 * How a line's column is drawn. The App's own input for it (`inputs`), a
 * vocabulary and a date keep the control a cell edits with (GridCellEditor's
 * `ValueControl`); a reference, money, a number and text are the grid's own
 * cells, which read as a table until touched.
 */
type CellKind = 'reference' | 'money' | 'number' | 'text' | 'control';

function cellKind(table: TableMeta, column: ColumnMeta): CellKind {
  if (columnInput(table.id, column.name)) return 'control';
  if (column.references && singleReference(table, column) && findTable(column.references.table)) return 'reference';
  if (column.allowed?.length || booleanChoices(column, null)) return 'control';
  const kind = columnKind(column.type);
  if (kind === 'date') return 'control';
  if (ruleOf(table, column.name)?.format === 'money') return 'money';
  return kind === 'number' ? 'number' : 'text';
}

/**
 * The line's own figures: each computed column that reads nothing but the
 * line's plain columns (`quantity * unit_price`), worked out as it is typed.
 * One that reads through a reference or a rollup waits for the saved row.
 */
function lineFigures(table: TableMeta, shown: readonly string[]): string[] {
  return Object.entries(table.computed ?? {})
    .filter(([name, computed]) => {
      if (shown.includes(name)) return false;
      const reads = computedReads(computed.expr);
      return reads.length > 0 && reads.every((path) => !path.includes('.') && table.columns.some((c) => c.name === path));
    })
    .map(([name]) => name);
}

/**
 * A computed figure's dress: its own rule, else — an amount worked out of one
 * money column, `quantity * unit_price` — that column's, so a line's amount
 * is money in the same units and currency as the price it was made of.
 */
function figureRule(table: TableMeta, name: string): DisplayRule | null {
  const own = ruleOf(table, name);
  if (own || !table.computed?.[name]) return own;
  const money = computedReads(table.computed[name].expr).filter((path) => ruleOf(table, path)?.format === 'money');
  return money.length === 1 ? ruleOf(table, money[0]) : null;
}

/** A live figure in its column's dress: money as money, minor units in their currency, a count as a number. */
function sayFigure(rule: DisplayRule | null, value: ComputedValue, draft: DraftValues): string {
  if (value === null) return '—';
  if (typeof value === 'object') return 'day' in value ? value.day : value.instant.toISOString();
  const shaped = rule?.currencyColumn
    ? {
        ...rule,
        currency: rowCurrency(rule, draft, rule.currency ?? '') || undefined,
      }
    : rule;
  const dress = typeof value === 'number' ? dressFor(shaped, value) : null;
  /* Beside the money typed in this grid, which keeps its cents, a figure keeps them too: a line of 2 × $38.00 is
     $76.00, not the "$76" a whole number says elsewhere (formatMoney), which read as rounded next to its price.
     A part taken off a total is said with the minus sign, not a hyphen. */
  if (dress && 'text' in dress && typeof dress.text === 'string' && dress.kind === 'money') {
    const currency = shaped?.currency || defaultCurrency();
    const major = Number(shaped?.minor ? (minorFigure(value as number, currency) ?? value) : value);
    const digits = currencyDigits(currency);
    const said = Number.isFinite(major)
      ? formatMoney(major, currency, { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : dress.text;
    return said.replace(/^-/, '−');
  }
  if (typeof value === 'number') return formatNumber(value);
  return typeof value === 'boolean' ? (value ? say('common.yes') : say('common.no')) : value;
}

/** Figures worked out of one row, by the evaluator the server agrees with; nothing where the catalog has changed under it. */
function figuresOf(schema: DatabaseSchema | null, table: TableMeta, names: readonly string[], values: DraftValues, lines = {}) {
  if (!schema || !names.length) return {} as Record<string, ComputedValue>;
  try {
    return liveValues(schema, table, names, values, lines);
  } catch {
    return {} as Record<string, ComputedValue>;
  }
}

/* ---------- a reference, with its record's photo and second line ---------- */

type Photo = Exclude<NonNullable<DisplayRule['avatar']>, boolean>;

/** What a reference cell draws of the record it names, beside the name: from the referenced resource's own display rule. */
interface Face {
  column: string;
  target: TableMeta;
  valueColumn: string;
  key: string;
  /** The record's column holding the key its photo is of: its own key, or the reference it is named through. */
  owner: string;
  subtitle?: string;
  photo?: Photo;
}

function faceOf(column: ColumnMeta): Face | undefined {
  const target = column.references ? (findTable(column.references.table) as TableMeta | undefined) : undefined;
  const key = target ? primaryKey(target) : [];
  /* The column the record is named by: its label path, or a label template's first column (`{title} · {sku}`). */
  const path = target ? (labelPath(target) as string | undefined) : undefined;
  const naming = path && !path.startsWith('$') ? path : /\{([^}]+)\}/.exec(String((target && recordLabel(target)) ?? ''))?.[1];
  if (!target || key.length !== 1 || !naming) return undefined;
  const [own, far, more] = naming.split('.');
  if (more !== undefined) return undefined;
  const second = (rule: DisplayRule | null) =>
    typeof rule?.subtitle === 'string' ? target.columns.find((c) => c.name === rule.subtitle && !c.references) : undefined;
  const photoOf = (rule: DisplayRule | null) => (rule?.avatar && typeof rule.avatar === 'object' ? rule.avatar : undefined);
  let face: Pick<Face, 'owner' | 'subtitle' | 'photo'>;
  if (far === undefined) {
    const rule = ruleOf(target, own);
    const sub = second(rule);
    const photo = photoOf(rule);
    face = { owner: key[0], ...(sub ? { subtitle: sub.name } : {}), ...(photo ? { photo } : {}) };
  } else {
    /* Named through a reference (a variant as `{product_id.title} · {color} / {size}`): the photo is the record
       it names, by that column's own rule there, owned through the reference; the second line is the rule on
       the reference itself, a column of this record (`product_id: { subtitle: 'sku' }`). */
    const via = target.columns.find((c) => c.name === own && c.references);
    const named = via ? (findTable(via.references!.table) as TableMeta | undefined) : undefined;
    if (!via || !named || via.references!.column !== primaryKey(named)[0]) return undefined;
    const sub = second(ruleOf(target, own));
    const photo = photoOf(ruleOf(named, far));
    face = { owner: own, ...(sub ? { subtitle: sub.name } : {}), ...(photo ? { photo } : {}) };
  }
  if (!face.subtitle && !face.photo) return undefined;
  return { column: column.name, target, valueColumn: column.references!.column, key: key[0], ...face };
}

const said = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/** A record's photo in its square, or the square alone: the cell keeps its size whether the picture has come or not. */
function Thumb({ src }: { src?: string }) {
  return <span className="lines-thumb">{src ? <img src={src} alt="" loading="lazy" decoding="async" /> : null}</span>;
}

/** One choice in a reference cell's list: its photo, its name and its second line. */
function FaceOption({
  face,
  row,
  label,
  rows,
}: {
  face: Face;
  row: Record<string, unknown>;
  label: string;
  rows: readonly Record<string, unknown>[];
}) {
  /* Every choice asks with the same rows, so the list's photos are one question. */
  const photos = useAvatarPhotos(
    face.photo
      ? [
          {
            name: 'choice',
            display: { avatar: face.photo },
            photoOwner: face.owner,
          },
        ]
      : [],
    rows,
  );
  return (
    <span className="lines-choice">
      {face.photo && <Thumb src={photos('choice', row[face.owner])} />}
      <span className="lines-choice-text">
        <span className="picker-option-label">{label}</span>
        {face.subtitle && <span className="lines-ref-sub">{said(row[face.subtitle])}</span>}
      </span>
    </span>
  );
}

/** The chosen records of every reference column with a face, one question per column, and their photos. */
function useFaces(faces: readonly Face[], rows: readonly LineDraft[]) {
  const connection = state.activeConnection;
  const asked = faces.map((face) => [...new Set(rows.map((row) => row.values[face.column]).filter(Boolean))].sort());
  const answers = useQueries({
    queries: faces.map((face, i) => ({
      queryKey: ['lines-faces', connection, face.target.id, face.valueColumn, face.owner, face.subtitle, asked[i]],
      enabled: asked[i].length > 0,
      staleTime: 60_000,
      placeholderData: (previous: Record<string, unknown>[] | undefined) => previous,
      queryFn: async () => {
        const data = (await api('/api/query', {
          ...ownedBy(connection),
          table: face.target.id,
          columns: [...new Set([face.key, face.owner, face.valueColumn, ...(face.subtitle ? [face.subtitle] : [])])],
          filter: {
            groups: [
              [
                {
                  column: face.valueColumn,
                  op: 'in' as const,
                  value: asked[i],
                },
              ],
            ],
          },
          limit: asked[i].length,
          offset: 0,
        })) as { rows?: Record<string, unknown>[] };
        return data.rows ?? [];
      },
    })),
  });
  const owners = faces.flatMap((face, i) =>
    face.photo ? (answers[i]?.data ?? []).map((row) => ({ [face.column]: row[face.owner] }) as Record<string, unknown>) : [],
  );
  const photos = useAvatarPhotos(
    faces.flatMap((face) =>
      face.photo
        ? [
            {
              name: face.column,
              display: { avatar: face.photo },
              photoOwner: face.column,
            },
          ]
        : [],
    ),
    owners,
  );
  return (column: string, value: string): { photo?: string; subtitle?: string } => {
    const i = faces.findIndex((face) => face.column === column);
    if (i < 0 || !value) return {};
    const row = answers[i]?.data?.find((each) => said(each[faces[i].valueColumn]) === value);
    return {
      photo: row ? photos(column, row[faces[i].owner]) : undefined,
      subtitle: row && faces[i].subtitle ? said(row[faces[i].subtitle!]) : '',
    };
  };
}

/* ---------- columns copied from the record a reference names ---------- */

/**
 * A command's `copy`: each copied column of a line filled from the record its
 * reference names (`unit_price_amount` ← `variant_id.price_amount`), asked once
 * per reference column for every record the lines name. A line whose reference
 * is empty, or names a record not yet read, holds nothing there.
 */
function useCopies(
  table: TableMeta,
  copy: Readonly<Record<string, string>>,
  rows: readonly LineDraft[],
  onChange: (rows: LineDraft[]) => void,
) {
  const connection = state.activeConnection;
  const vias = [...new Set(Object.values(copy).map((path) => path.split('.')[0]))].flatMap((via) => {
    const reference = table.columns.find((c) => c.name === via)?.references;
    const target = reference ? (findTable(reference.table) as TableMeta | undefined) : undefined;
    if (!reference || !target) return [];
    const reads = Object.entries(copy)
      .filter(([, path]) => path.split('.')[0] === via)
      .map(([column, path]) => ({ column, read: path.split('.')[1] }));
    const asked = [...new Set(rows.map((row) => row.values[via]).filter(Boolean))].sort();
    return [{ via, target, valueColumn: reference.column, reads, asked }];
  });
  const answers = useQueries({
    queries: vias.map((each) => ({
      queryKey: ['lines-copies', connection, each.target.id, each.valueColumn, each.reads.map((r) => r.read), each.asked],
      enabled: each.asked.length > 0,
      staleTime: 60_000,
      placeholderData: (previous: Record<string, unknown>[] | undefined) => previous,
      queryFn: async () => {
        const data = (await api('/api/query', {
          ...ownedBy(connection),
          table: each.target.id,
          columns: [...new Set([each.valueColumn, ...each.reads.map((r) => r.read)])],
          filter: { groups: [[{ column: each.valueColumn, op: 'in' as const, value: each.asked }]] },
          limit: each.asked.length,
          offset: 0,
        })) as { rows?: Record<string, unknown>[] };
        return data.rows ?? [];
      },
    })),
  });
  const read = vias.map((_, i) => answers[i]?.data);
  useEffect(() => {
    let changed = false;
    const next = rows.map((row) => {
      const values = { ...row.values };
      vias.forEach((each, i) => {
        const record = read[i]?.find((candidate) => said(candidate[each.valueColumn]) === (row.values[each.via] ?? ''));
        for (const { column, read: from } of each.reads) {
          const value = record ? said(record[from]) : '';
          if ((values[column] ?? '') !== value) {
            values[column] = value;
            changed = true;
          }
        }
      });
      return { ...row, values };
    });
    if (changed) onChange(next);
  });
}

/* ---------- money ---------- */

/** An amount as the cell shows it once left: in its currency, with its decimals; text that is no amount stays as typed. */
function shownMoney(text: string, digits: number, currency: string): string {
  if (!/^-?\d+(\.\d*)?$/.test(text.trim())) return text;
  const [, decimals = ''] = text.trim().split('.');
  return decimals.length > digits
    ? text
    : formatMoney(Number(text), currency, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function MoneyCell({
  value,
  currency,
  minor,
  onChange,
  input,
}: {
  value: string;
  currency: string;
  minor: boolean;
  onChange: (value: string) => void;
  input: {
    'aria-label': string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  };
}) {
  const [focused, setFocused] = useState(false);
  const digits = currencyDigits(currency);
  /* At rest the figure reads as the amount column's do, "$148.00"; in the box the sign stands before what is typed. */
  const box = (text: string, typed: (next: string) => void) => (
    <span className="lines-box lines-money">
      {focused && (
        <span className="lines-affix" aria-hidden="true">
          {currencySymbol(currency)}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        className="lines-input is-figure"
        autoComplete="off"
        {...input}
        value={focused ? text : shownMoney(text, digits, currency)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => typed(event.target.value)}
      />
    </span>
  );
  return minor ? (
    <MinorMoneyInput value={value} currency={currency} onChange={onChange}>
      {box}
    </MinorMoneyInput>
  ) : (
    box(value, onChange)
  );
}

/* ---------- the grid ---------- */

/** Six dots: what a line is lifted by. */
function Grip() {
  return (
    <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true" focusable="false">
      {[2, 7, 12].flatMap((y) => [1.5, 6.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
    </svg>
  );
}

export function LinesEditor({
  title,
  table,
  columns,
  rows,
  onChange,
  ordered = false,
  max = 64,
  problems = {},
  disabled = false,
  titleShown = true,
  summary,
  description,
  copy,
  where,
  subtotal = false,
}: {
  title: string;
  /** A line under the title: what the lines are for, or what happens to them. */
  description?: string;
  /** Columns of the line filled from the record a reference names, shown read-only and never typed (`useCopies`). */
  copy?: Readonly<Record<string, string>>;
  /** A reference column → the rows its picker offers (a command's `query`): a variant for sale, not every variant. */
  where?: Readonly<Record<string, string>>;
  /** Where no `summary` is given, the line's money figures added up under the grid. */
  subtotal?: boolean;
  /** False where a section's own heading already says it: the legend is then for assistive technology alone. */
  titleShown?: boolean;
  table: TableMeta;
  columns: readonly string[];
  rows: readonly LineDraft[];
  onChange: (rows: LineDraft[]) => void;
  /** The rows' places are kept (`order`): each can move up and down. */
  ordered?: boolean;
  max?: number;
  /** What is wrong, by `${row}.${column}`: the form's own checks, then the server's. */
  problems?: Record<string, string>;
  disabled?: boolean;
  /** The figures the lines add up to, beside Add line, their values under the amounts (`LiveValues`). */
  summary?: ReactNode;
}) {
  const shown = columns.map((name) => table.columns.find((c) => c.name === name)).filter((c): c is ColumnMeta => Boolean(c));
  const kinds = shown.map((column) => cellKind(table, column));
  const copied = Object.keys(copy ?? {}).filter((name) => table.columns.some((c) => c.name === name));
  const figures = useMemo(() => lineFigures(table, [...columns, ...copied]), [table, columns, copied.join()]);
  useCopies(table, copy ?? {}, rows, onChange);
  const figured = rows.map((row) => figuresOf(state.schema as DatabaseSchema | null, table, figures, row.values));
  /* The money a line works out, added up: an order's subtotal, said as the line's own figures are. */
  const sums = subtotal && !summary ? figures.filter((name) => figureRule(table, name)?.format === 'money') : [];
  const faces = shown.flatMap((column, i) => (kinds[i] === 'reference' ? (faceOf(column) ?? []) : []));
  const faceFor = useFaces(faces, rows);
  const added = useRef<number | null>(null);
  /* After a move the focus stays on what moved it: the handle, or the menu's button. */
  const refocus = useRef<{ line: number; what: string } | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [moved, setMoved] = useState('');
  const [dropAt, setDropAt] = useState<{
    line: number;
    side: 'before' | 'after';
  } | null>(null);
  /* A new line takes the focus in its first box, so a keyboard adds lines as fast as it types them. */
  useEffect(() => {
    if (added.current !== null) {
      body.current?.querySelector<HTMLElement>(`tr[data-line="${added.current}"] input`)?.focus();
      added.current = null;
    }
    if (refocus.current) {
      body.current?.querySelector<HTMLElement>(`tr[data-line="${refocus.current.line}"] ${refocus.current.what}`)?.focus();
      refocus.current = null;
    }
  });
  const set = (i: number, name: string, value: string | null) =>
    onChange(rows.map((row, at) => (at === i ? { ...row, values: { ...row.values, [name]: value ?? '' } } : row)));
  const place = (from: number, to: number, focus?: string) => {
    if (to < 0 || to >= rows.length || to === from) return;
    const next = [...rows];
    const [line] = next.splice(from, 1);
    next.splice(to, 0, line);
    if (focus) refocus.current = { line: line.id, what: focus };
    setMoved(say('lineMoved', { n: to + 1, count: rows.length }));
    onChange(next);
  };
  const remove = (i: number) => {
    const next = rows.filter((_, at) => at !== i);
    /* The focus goes to the line that took its place, else the one above, else Add line. */
    const heir = next[Math.min(i, next.length - 1)];
    if (heir) refocus.current = { line: heir.id, what: '.row-actions-trigger' };
    onChange(next);
  };
  const drag = usePointerDrag<number>({
    over: (line, at) => setDropAt(dropOf(line, at)),
    drop: (line, at) => {
      const target = dropOf(line, at);
      const from = rows.findIndex((row) => row.id === line);
      if (!target || from < 0) return;
      let to = rows.findIndex((row) => row.id === target.line) + (target.side === 'after' ? 1 : 0);
      if (to > from) to -= 1;
      place(from, to, '.lines-grip');
    },
    end: () => setDropAt(null),
    items: 'tr[data-line]',
  });
  /* Where a line let go over `at` lands: before or after the row under it, never beside itself. */
  const dropOf = (line: number, at: DropPoint | null): { line: number; side: 'before' | 'after' } | null => {
    if (!at) return null;
    const under = at.item ? Number(at.item.dataset.line) : rows[rows.length - 1]?.id;
    if (under === undefined || under === line) return null;
    return { line: under, side: at.item && at.upper ? 'before' : 'after' };
  };
  const gripKeys = (event: KeyboardEvent, i: number) => {
    const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!by || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    place(i, i + by, '.lines-grip');
  };
  const currencyOf = (column: ColumnMeta, row: LineDraft) => {
    const rule = ruleOf(table, column.name);
    return rowCurrency(rule ?? {}, row.values, rule?.currency || defaultCurrency());
  };
  const columnClass = (kind: CellKind) => `is-${kind}`;
  const span = shown.length + copied.length + figures.length + (ordered ? 1 : 0) + 1;
  const copiedLabel = (name: string) => (columnLabel(table.id, name) as string | null) ?? humanName(name);
  return (
    <fieldset className="form-lines" disabled={disabled}>
      <legend className={titleShown ? undefined : 'visually-hidden'}>{title}</legend>
      {description && <p className="form-lines-description">{description}</p>}
      <div className="form-lines-body">
        <table className={`form-lines-grid${ordered ? ' is-ordered' : ''}`}>
          <colgroup>
            {ordered && <col className="lines-col-grip" />}
            {shown.map((column, i) => (
              <col key={column.name} className={`lines-col-${kinds[i]}`} />
            ))}
            {copied.map((name) => (
              <col key={name} className="lines-col-figure" />
            ))}
            {figures.map((name) => (
              <col key={name} className="lines-col-figure" />
            ))}
            <col className="lines-col-menu" />
          </colgroup>
          <thead>
            <tr>
              {ordered && <th aria-hidden="true" />}
              {shown.map((column, i) => (
                <th key={column.name} scope="col" className={columnClass(kinds[i])}>
                  {labelOf(table, column)}
                </th>
              ))}
              {copied.map((name) => (
                <th key={name} scope="col" className="is-figure">
                  {copiedLabel(name)}
                </th>
              ))}
              {figures.map((name) => (
                <th key={name} scope="col" className="is-figure">
                  {(columnLabel(table.id, name) as string | null) ?? humanName(name)}
                </th>
              ))}
              <th>
                <span className="visually-hidden">{say('lineActionsHeading')}</span>
              </th>
            </tr>
          </thead>
          <tbody ref={body} data-drop-zone="">
            {rows.map((row, i) => {
              const n = i + 1;
              return (
                <tr
                  key={row.id}
                  data-line={row.id}
                  {...(dropAt?.line === row.id ? { 'data-drop': dropAt.side } : {})}
                  {...(drag.dragging === row.id ? { 'data-lifted': '' } : {})}
                >
                  {ordered && (
                    <td className="lines-handle">
                      <button
                        type="button"
                        className="lines-grip"
                        aria-label={say('moveLine', { n })}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        title={say('moveLineHint')}
                        onPointerDown={(event) => {
                          const line = event.currentTarget.closest('tr');
                          if (line) drag.start(event, row.id, line);
                        }}
                        onKeyDown={(event) => gripKeys(event, i)}
                      >
                        <Grip />
                      </button>
                    </td>
                  )}
                  {shown.map((column, at) => {
                    const kind = kinds[at];
                    const problem = problems[`${i}.${column.name}`];
                    const errorId = problem ? `line-${row.id}-${column.name}-error` : undefined;
                    const label = `${labelOf(table, column)}, ${n}`;
                    const value = row.values[column.name] ?? '';
                    const input = {
                      'aria-label': label,
                      ...(problem
                        ? {
                            'aria-invalid': true as const,
                            'aria-describedby': errorId,
                          }
                        : {}),
                    };
                    let cell: ReactNode;
                    if (kind === 'reference') {
                      const face = faces.find((each) => each.column === column.name);
                      const target = findTable(column.references!.table) as TableMeta;
                      const known = face ? faceFor(column.name, value) : {};
                      cell = (
                        <span className={`lines-box lines-ref${face?.photo ? ' has-thumb' : ''}${face?.subtitle ? ' has-sub' : ''}`}>
                          {face?.photo && <Thumb src={known.photo} />}
                          <span className="lines-ref-text">
                            <RecordPicker
                              table={target}
                              valueColumn={column.references!.column}
                              value={value}
                              onChange={(next) => set(i, column.name, next)}
                              ariaLabel={label}
                              invalid={input['aria-invalid'] === true}
                              {...(input['aria-describedby'] ? { describedBy: input['aria-describedby'] } : {})}
                              app
                              hideKey={Boolean(face)}
                              {...(where?.[column.name] ? { where: where[column.name] } : {})}
                              editing={{ onStateChange: () => {} }}
                              {...(face
                                ? {
                                    face: {
                                      columns: [...new Set([face.key, face.owner, ...(face.subtitle ? [face.subtitle] : [])])],
                                      draw: (choice, name, all) => <FaceOption face={face} row={choice} label={name} rows={all} />,
                                    },
                                  }
                                : {})}
                            />
                            {face?.subtitle && <span className="lines-ref-sub">{known.subtitle}</span>}
                          </span>
                        </span>
                      );
                    } else if (kind === 'money') {
                      cell = (
                        <MoneyCell
                          value={value}
                          currency={currencyOf(column, row)}
                          minor={Boolean(minorRule(table, column.name))}
                          onChange={(next) => set(i, column.name, next)}
                          input={input}
                        />
                      );
                    } else if (kind === 'number' || kind === 'text') {
                      cell = (
                        <span className="lines-box">
                          <input
                            type="text"
                            className={`lines-input${kind === 'number' ? ' is-figure' : ''}`}
                            autoComplete="off"
                            {...(kind === 'number' ? { inputMode: 'decimal' as const } : {})}
                            {...input}
                            value={value}
                            onChange={(event) => set(i, column.name, event.target.value)}
                          />
                        </span>
                      );
                    } else {
                      cell = (
                        <span className="lines-box lines-control">
                          <ValueControl
                            table={table}
                            column={column}
                            value={value}
                            onChange={(next) => set(i, column.name, next)}
                            label={label}
                            row={row.values}
                            invalid={Boolean(problem)}
                            describedBy={errorId}
                          />
                        </span>
                      );
                    }
                    return (
                      <td
                        key={column.name}
                        className={`${columnClass(kind)}${at === 0 ? ' lines-lead' : ''}${problem ? ' is-invalid' : ''}`}
                        data-label={labelOf(table, column)}
                      >
                        {cell}
                        {problem && (
                          <span id={errorId} className="insert-missing">
                            {problem}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {copied.map((name) => (
                    <td key={name} className="is-figure lines-figure lines-copied" data-label={copiedLabel(name)}>
                      {sayFigure(ruleOf(table, name), typedValue(table, name, row.values[name]), row.values)}
                    </td>
                  ))}
                  {figures.map((name) => (
                    <td
                      key={name}
                      className="is-figure lines-figure"
                      data-label={(columnLabel(table.id, name) as string | null) ?? humanName(name)}
                    >
                      {sayFigure(figureRule(table, name), figured[i][name] ?? null, row.values)}
                    </td>
                  ))}
                  <td className="lines-menu">
                    <DropMenu
                      className="row-actions-menu"
                      triggerClassName="ghost row-actions-trigger"
                      triggerLabel={say('lineActions', { n })}
                      triggerTitle={say('lineActions', { n })}
                      label="⋯"
                      popupClassName="page-actions-popup"
                      align="end"
                    >
                      {ordered && (
                        <DropItem className="page-actions-item" disabled={i === 0} onClick={() => place(i, i - 1, '.row-actions-trigger')}>
                          {say('moveUp')}
                        </DropItem>
                      )}
                      {ordered && (
                        <DropItem
                          className="page-actions-item"
                          disabled={i === rows.length - 1}
                          onClick={() => place(i, i + 1, '.row-actions-trigger')}
                        >
                          {say('moveDown')}
                        </DropItem>
                      )}
                      <DropItem className="page-actions-item is-danger" onClick={() => remove(i)}>
                        {say('removeLine')}
                      </DropItem>
                    </DropMenu>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr className="lines-empty">
                <td colSpan={span}>{say('noLinesYet')}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="form-lines-foot">
          <Button
            intent="quiet"
            size="compact"
            className="lines-add"
            disabled={rows.length >= max}
            onClick={() => {
              const line = blankLine();
              added.current = line.id;
              onChange([...rows, line]);
            }}
          >
            + {say('addLine')}
          </Button>
          {summary}
          {sums.length > 0 && (
            <dl className="form-live lines-summary" aria-live="polite">
              {sums.map((name) => {
                const amounts = figured.map((each) => each[name]).filter((v): v is number => typeof v === 'number');
                const total = amounts.length ? amounts.reduce((a, b) => a + b, 0) : null;
                return (
                  <div key={name} className="lines-summary-row">
                    <dt>{sums.length === 1 ? say('subtotal') : copiedLabel(name)}</dt>
                    <dd>{sayFigure(figureRule(table, name), total, rows[0]?.values ?? {})}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
        <div className="visually-hidden" aria-live="polite">
          {moved}
        </div>
      </div>
    </fieldset>
  );
}

/* ---------- the summary ---------- */

/** The summary's rows: the live names, and where the last is a sum, the record's own columns it adds, in its order. */
function summaryRows(table: TableMeta, names: readonly string[]): Array<{ name: string; sign: number; live: boolean }> {
  const total = names[names.length - 1];
  const terms = total && table.computed?.[total] ? sumTerms(table.computed[total].expr) : undefined;
  const live = (name: string) => names.includes(name);
  const parts =
    terms
      ?.filter(
        (term) => live(term.path) || (ruleOf(table, term.path)?.format === 'money' && table.columns.some((c) => c.name === term.path)),
      )
      .map((term) => ({
        name: term.path,
        sign: term.sign,
        live: live(term.path),
      })) ?? [];
  const before = names.slice(0, -1).filter((name) => !parts.some((part) => part.name === name));
  return [
    ...before.map((name) => ({ name, sign: 1, live: true })),
    ...parts.filter((part) => part.name !== total),
    ...(total ? [{ name: total, sign: 1, live: true }] : []),
  ];
}

/** The form's `live` figures, worked out from its draft and lines as they change: an order's summary, its total last. */
export function LiveValues({
  table,
  names,
  values,
  lines,
}: {
  table: TableMeta;
  names: readonly string[];
  values: DraftValues;
  /** Each collection's rows, by the child table's id. */
  lines: Readonly<Record<string, readonly LineDraft[]>>;
}) {
  const figures = useMemo(() => {
    const rows = Object.fromEntries(Object.entries(lines).map(([id, held]) => [id, held.map((row) => row.values)]));
    /* A catalog that changed under the form says nothing rather than something wrong. */
    return figuresOf(state.schema as DatabaseSchema | null, table, names, values, rows);
  }, [table, names, values, lines]);
  const known = names.filter((name) => Object.hasOwn(figures, name));
  if (!known.length) return null;
  const rows = summaryRows(table, known);
  return (
    <dl className="form-live lines-summary" aria-live="polite">
      {rows.map(({ name, sign, live }, i) => {
        const value = live ? figures[name] : typedValue(table, name, values[name]);
        const signed = typeof value === 'number' && sign < 0 ? -value : value;
        return (
          <div key={name} className={i === rows.length - 1 ? 'lines-summary-row is-total' : 'lines-summary-row'}>
            <dt>{(columnLabel(table.id, name) as string | null) ?? humanName(name)}</dt>
            <dd>{sayFigure(ruleOf(table, name), signed ?? null, values)}</dd>
          </div>
        );
      })}
    </dl>
  );
}
