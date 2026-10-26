/**
 * One value, rendered by what it is — shared by every view that shows fields.
 *
 * `Dressed` is the app's dress when a display rule reaches the value: a
 * currency, a percent with its bar, a toned pill, a relative day. `Value`
 * is the plain rendering by the grid's planner. `RefJump` is a foreign key
 * as the walk it is: the value, the table it points at, a hover that shows
 * the row, a click that goes there.
 */
import { Fragment, type ReactNode } from 'react';
import { api, columnDisplay, emptyWord, findTable, openRecord, refsFrom, state } from '../core.js';
import { opensRecord } from '../recordIntent.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { dressFor, linkFor, maskedText, ruleSays, type DisplayRule } from './valueModel.js';
import { rowCurrency } from '@mistriwork/engine/shared/money.js';
import { dueOpen } from './dueOpen.js';
import { JsonValue } from './JsonValue.js';
import { jsonValueOf, previewOf } from './jsonModel.js';
import { TAGS_TYPE, tagChips } from '@mistriwork/engine/shared/tagLists.js';
import { AvatarText, Dressed, Said } from './Dressed.js';
import { ValueSlot } from './valueRenderers.js';
import { say } from '../copy/record/components/Value.js';
import { shellBody } from '../shellHost.js';

/* Drawn here and in the grid; the rules that draw them read no global (Dressed.tsx). */
export { AvatarText, Dressed };

/** A value that is a link: mail, a call, or a web page, which opens beside the App rather than in place of it. */
function ValueLink({ link }: { link: NonNullable<ReturnType<typeof linkFor>> }) {
  const text = breakable(link.text);
  /* The break points are not words: the link is named by its text whole. */
  const named = { title: link.text, ...(typeof text === 'string' ? {} : { 'aria-label': link.text }) };
  return link.kind === 'url' ? (
    <a className="value-link" href={link.href} target="_blank" rel="noopener noreferrer" {...named}>
      {text}
    </a>
  ) : (
    <a className="value-link" href={link.href} {...named}>
      {text}
    </a>
  );
}

/* An address has no spaces, so where a value wraps it would break mid-word.
   It may break after an @ or a slash and before a dot, a hyphen or a query's
   marks — where a reader sees the parts — and nowhere else unless one part
   alone is wider than its column (overflow-wrap). The text is unchanged. */
function breakable(text: string): ReactNode {
  const parts = text.split(/(?<=[@/])|(?=[.\-_?#&=])/);
  if (parts.length < 2) return text;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

interface ValueProps {
  col: ColumnMeta | undefined;
  value: unknown;
  /** The table the value belongs to, for the app's dress. Absent in the workbench's raw readings. */
  tableId?: string;
  /** Keep long text inline in constrained previews; full fields retain their prose layout. */
  compact?: boolean;
  /** Whether an address, a number or a page may be a link. Not where the value
      stands inside a target of its own — a card, a row that opens — since a
      link inside a button is neither; a compact value is one of those unless
      its caller says. */
  links?: boolean;
  /** Formatted text drawn whole even where the value is compact: a conversation's message is read, not glanced at. */
  wholeText?: boolean;
  /** The record the value is of, where a money rule reads its currency from another of its columns (money.ts). */
  row?: Readonly<Record<string, unknown>>;
  /** Money drawn among others: whether the set says its cents (centsAmong). Left out, the figure's own decide. */
  cents?: boolean;
}

/** A value as the record and the page show it: dressed when the app says, plain otherwise. */
export function Value(props: ValueProps) {
  const { col, value, tableId, compact = false } = props;
  const rule = tableId === undefined ? null : (columnDisplay(tableId, col?.name ?? '') as DisplayRule | null);
  /* The App's own renderer, where its display rule names one: the value drawn
     the platform's way until it has arrived, and whenever it cannot draw. An
     empty value is the platform's to say, as it is in a grid cell. */
  const renderer = rule?.component?.id;
  if (
    renderer &&
    tableId !== undefined &&
    maskedText(rule, value) === undefined &&
    value !== null &&
    value !== undefined &&
    shellBody().classList.contains('app-mode')
  ) {
    const { component: _component, ...rest } = rule!;
    return (
      <ValueSlot
        id={renderer}
        value={value}
        column={{ name: col?.name ?? '', resource: tableId }}
        context="record"
        compact={compact}
        {...ruleSays(rest, value)}
        fallback={<PlatformValue {...props} />}
      />
    );
  }
  /* A rule's `face` sets the column's values in that face; the wrapper exists only then. */
  return rule?.face ? (
    <span className={`face-${rule.face}`}>
      <PlatformValue {...props} />
    </span>
  ) : (
    <PlatformValue {...props} />
  );
}

function PlatformValue({ col, value, tableId, compact = false, links = !compact, wholeText = false, row, cents }: ValueProps) {
  if (value === null || value === undefined)
    return (
      <span className="null" title="null">
        {emptyWord()}
      </span>
    );
  /* A record's tags (tagLists.ts) are chips wherever a value is drawn: a phone's row cards said Thread's as the
     JSON the database answered. */
  if (col?.type === TAGS_TYPE) {
    const chips = tagChips(value);
    if (!chips.length)
      return (
        <span className="null" title="null">
          {emptyWord()}
        </span>
      );
    return (
      <span className="value-tags">
        {chips.map((chip) => (
          <span key={chip.label} className={`record-tag tone tone-${chip.tone ?? 'neutral'}`}>
            {chip.label}
          </span>
        ))}
      </span>
    );
  }
  const json = jsonValueOf(col, value);
  if (json) return compact ? <span className="json-preview-text">{previewOf(json.value)}</span> : <JsonValue value={json.value} />;
  const declared = tableId === undefined ? null : (columnDisplay(tableId, col?.name ?? '') as DisplayRule | null);
  /* A money column whose currency is the record's own: the code its row holds. */
  const owned =
    declared?.currencyColumn && row
      ? { ...declared, currency: rowCurrency(declared, row, declared.currency ?? '') || undefined }
      : declared;
  const priced = owned && cents !== undefined && owned.format === 'money' ? { ...owned, cents } : owned;
  /* A due date passed on a row still open is drawn in the warning tone (dueOpen.ts). */
  const rule = priced?.format === 'relative' && dueOpen(tableId, col?.name ?? '', row) ? { ...priced, open: true } : priced;
  /* An address, a number or a page is something to act on: in an App it is
     a link (by its rule, or by a column named for it); the Workbench shows
     the data as it is. */
  /* A masked value is the placeholder before it is anything else: not a link to the value, not the author's renderer. */
  const mask = tableId === undefined ? undefined : maskedText(rule, value);
  if (mask !== undefined) return <Dressed dress={{ kind: 'masked', text: mask }} compact={compact} />;
  const link = tableId === undefined || !links ? null : linkFor(col?.name, value, rule, shellBody().classList.contains('app-mode'));
  if (link) return <ValueLink link={link} />;
  const dress = tableId === undefined ? null : dressFor(rule, value);
  if (dress) return <Dressed dress={dress} compact={compact && !(wholeText && dress.kind === 'richText')} />;
  /* In an App a vocabulary's value is a word, as its chip says it ("On hold"
     for `on_hold`); the Workbench shows the data exactly. */
  return <Said col={col} value={value} compact={compact} app={shellBody().classList.contains('app-mode')} />;
}

interface Fk {
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
}

/**
 * The whole key a composite reference names, read off the row it sits in:
 * a chip that opened with only its own column carried half a key.
 */
function referenceKey(
  table: TableMeta,
  columnName: string,
  row: Record<string, unknown>,
  targetTable: string,
): Record<string, unknown> | null {
  const fk = ((state as { schema?: unknown }).schema ? (refsFrom(table.id) as Fk[]) : []).find(
    (f) => f.to.table === targetTable && f.from.columns.length > 1 && f.from.columns.includes(columnName),
  );
  if (!fk) return null;
  const values = fk.from.columns.map((c) => row[c]);
  if (values.some((v) => v === null || v === undefined)) return null;
  return Object.fromEntries(fk.to.columns.map((c, i) => [c, values[i]]));
}

/**
 * The record a reference names, by the key its address is made of. A real
 * foreign key names the primary key already; an App's declared reference
 * (a soft key, `product_sku` → `product.sku`) names another unique column,
 * so the primary key is read once, through the reader's own grants. A value
 * nothing matches opens nothing, as a dangling key would.
 */
async function byPrimaryKey(target: TableMeta, column: string, value: unknown): Promise<Record<string, unknown> | null> {
  const keys = target.columns.filter((item) => item.primaryKey).map((item) => item.name);
  if (!keys.length || (keys.length === 1 && keys[0] === column)) return { [column]: value };
  try {
    const data = (await api('/api/query', {
      table: target.id,
      columns: keys,
      filter: { groups: [[{ column, op: '=', value: value as string | number }]] },
      limit: 1,
      offset: 0,
    })) as { rows?: Array<Record<string, unknown>> };
    const row = data.rows?.[0];
    return row ? Object.fromEntries(keys.map((name) => [name, row[name]])) : null;
  } catch {
    return null;
  }
}

interface RefJumpProps {
  references: { table: string; column: string };
  value: unknown;
  /** The referenced record's name, when the page fetched it; the id stays in the tooltip. */
  label?: unknown;
  table?: TableMeta;
  column?: string;
  row?: Record<string, unknown>;
  /** A card's title or its "View dealer" foot: the same jump, said and dressed as the card needs. */
  className?: string;
  text?: string;
}

/* A signature points at the file row its picture is kept in: the record shows the picture, not a link to the file. */
export function RefJump(props: RefJumpProps) {
  const { table, column, value } = props;
  const rule = table && column ? (columnDisplay(table.id, column) as DisplayRule | null) : null;
  if (rule?.signature && typeof rule.signature === 'object' && value !== null && value !== undefined && value !== '')
    return <Value col={{ name: column } as ColumnMeta} value={value} tableId={table!.id} />;
  return <RefJumpLink {...props} />;
}

function RefJumpLink({ references, value, label, table, column, row, className, text }: RefJumpProps) {
  const target = findTable(references.table) as TableMeta | undefined;
  const key = table && column && row ? referenceKey(table, column, row, references.table) : null;
  const named = label !== undefined && label !== null && String(label) !== '';
  const peek =
    value !== null && value !== undefined && value !== ''
      ? { 'data-ref-table': references.table, 'data-ref-column': references.column, 'data-ref-value': String(value) }
      : {};
  return (
    <button
      type="button"
      className={className ? `ref-jump ${className}` : 'ref-jump'}
      title={
        named
          ? say('openReference', { label: String(label), table: references.table, key: String(value) })
          : say('openTableKey', { table: references.table, key: String(value) })
      }
      {...peek}
      data-opens={target && key ? opensRecord(target.id, key) : undefined}
      onClick={() => {
        if (!target) return;
        /* In the view the walk is already in: a reference followed from a page
           opens the referenced record as a page. */
        const title = `${references.table} ${String(value)}`;
        if (key) {
          void openRecord(target.id, key, title);
          return;
        }
        void byPrimaryKey(target, references.column, value).then((found) => {
          if (found) void openRecord(target.id, found, title);
        });
      }}
    >
      <span className="ref-jump-value">{text ?? (named ? String(label) : String(value))}</span>
      {/* The pill says what a bare id is an id *of*; a chip already showing
          the record's name does not need "Australia" explained as a country. */}
      {!named && text === undefined && <span className="ref-jump-table">{references.table}</span>}
    </button>
  );
}
