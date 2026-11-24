/**
 * Structured multi-row editors for repeating line items (with sortable handles and
 * live currency totals) and environment-style key/value pairs.
 */
'use client';

import * as React from 'react';
import { Sortable, SortableHandle, SortableItem } from '@mistriwork/ui/behaviors/index.js';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { Button } from './actions.js';
import { EmptyState } from './feedback.js';
import { wrapWithField, type FieldFrameProps } from './fieldShell.js';

/* ============================================================================
 * 5. LineItemsEditor (Sortable Repeating Structured Lines + Live Totals)
 * ========================================================================== */

/** Supported cell data kind for `LineItemsEditor` columns. */
export type LineItemColumnKind = 'text' | 'number' | 'money' | 'select' | 'computed';

/** Option entry for `'select'` columns in `LineItemsEditor`. */
export interface LineItemSelectOption {
  value: string;
  label: string;
}

/** Base row record edited by `LineItemsEditor`. */
export interface LineItemRow {
  id: string;
  [key: string]: string | number | undefined;
}

/** Column descriptor for `LineItemsEditor`. */
export interface LineItemColumn<TRow extends LineItemRow = LineItemRow> {
  key: string;
  label: React.ReactNode;
  kind: LineItemColumnKind;
  /** CSS Grid track width (e.g. `'2fr'`, `'110px'`, `'140px'`). */
  width?: string;
  align?: 'start' | 'end';
  placeholder?: string;
  /** Options when `kind === 'select'`. */
  options?: ReadonlyArray<LineItemSelectOption>;
  min?: number;
  max?: number;
  step?: number;
  /** Currency ISO code override for `kind === 'money'` or `'computed'`. */
  currency?: string;
  /** Include this column directly in the automatic `Subtotal` rollup. */
  sumInSubtotal?: boolean;
  /** Live row computation for `kind === 'computed'` (e.g. `(row) => Number(row.qty) * Number(row.unitPrice)`). */
  compute?: (row: TRow, rowIndex: number) => number;
}

/** Subtotal adjustment line (discount, shipping, surcharge) for `LineItemsEditor`. */
export interface LineItemsAdjustment {
  label: React.ReactNode;
  /** Positive for tax/shipping surcharges, negative for discounts/credits. */
  amount: number;
}

/** Props for the `LineItemsEditor` component. */
export interface LineItemsEditorProps<TRow extends LineItemRow = LineItemRow> extends FieldFrameProps {
  /** Structured column definitions. */
  columns: ReadonlyArray<LineItemColumn<TRow>>;
  /** Controlled line items array. */
  value?: ReadonlyArray<TRow>;
  /** Initial uncontrolled line items array. */
  defaultValue?: ReadonlyArray<TRow>;
  /** Emits updated line items on edit, reorder, add, or delete. */
  onValueChange?: (rows: TRow[]) => void;
  /** Optional factory for creating a new blank row when clicking `+ Add line`. */
  createRow?: () => TRow;
  /** Custom row total function overriding automatic `qty × price` / money column sum. */
  computeRowTotal?: (row: TRow, rowIndex: number) => number;
  /** Show an automatic read-only `Amount` column when `qty` + `money` columns exist and no `'computed'` column is defined. Defaults to `true`. */
  showAutoLineAmount?: boolean;
  /** Currency ISO code used for money symbols and summary totals. Defaults to `'USD'`. */
  currency?: string;
  /** Locale for number & currency formatting. Falls back to `<html lang>` and runtime default. */
  locale?: string;
  /** Optional tax rate (`0..1`, e.g. `0.0825` for 8.25%) added between Subtotal and Total. */
  taxRate?: number;
  taxLabel?: React.ReactNode;
  /** Optional extra summary adjustments (discounts, shipping, fees) applied to Subtotal. */
  adjustments?: ReadonlyArray<LineItemsAdjustment>;
  /** Show live `Subtotal` / `Total` summary footer. Defaults to `true`. */
  showSummary?: boolean;
  /** Allow drag-and-drop / keyboard reordering via `SortableHandle`. Defaults to `true`. */
  sortable?: boolean;
  addLabel?: React.ReactNode;
  empty?: EmptyStateSpec | React.ReactNode;
  minRows?: number;
  maxRows?: number;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  name?: string;
  ariaLabel?: string;
  words?: {
    amount?: string;
    subtotal?: string;
    total?: string;
    removeLine?: (index: number) => string;
    reorderLine?: (index: number) => string;
  };
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
}

let rowSeq = 0;

/* An id no row in `taken` holds, added to it. The counter restarts with the page while saved rows keep the ids they were
   given, so a reloaded `nx-kv-1` would otherwise meet a second one: two rows sharing a React key, edited and deleted as one. */
function freshRowId(prefix: string, taken: Set<string>): string {
  let id: string;
  do {
    rowSeq += 1;
    id = `${prefix}-${rowSeq}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

function getCurrencySymbol(currency: string, locale: string | undefined): string {
  try {
    return (
      new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

function formatMoneyAmount(amount: number, currency: string, locale: string | undefined): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(2)}`;
  }
}

function defaultColumnTrack<TRow extends LineItemRow>(col: LineItemColumn<TRow>): string {
  if (col.width) return col.width;
  switch (col.kind) {
    case 'text':
      return 'minmax(160px, 2.2fr)';
    case 'select':
      return 'minmax(130px, 1.3fr)';
    case 'number':
      return 'minmax(84px, 0.85fr)';
    case 'money':
    case 'computed':
      return 'minmax(112px, 1.1fr)';
  }
}

function renderStructuredEmpty(empty: EmptyStateSpec | React.ReactNode | undefined, fallbackText: React.ReactNode): React.ReactNode {
  if (empty !== undefined) {
    if (isEmptyStateSpec(empty)) {
      return <EmptyState title={empty.title} body={empty.body} action={empty.action} compact />;
    }
    return empty;
  }
  return fallbackText;
}

/** Sortable repeating line-items grid with live row amounts, tax, and currency totals. */
export function LineItemsEditor<TRow extends LineItemRow = LineItemRow>(props: LineItemsEditorProps<TRow>): React.JSX.Element {
  const {
    columns,
    value,
    defaultValue = [],
    onValueChange,
    createRow,
    computeRowTotal,
    showAutoLineAmount = true,
    currency = 'USD',
    locale: explicitLocale,
    taxRate,
    taxLabel,
    adjustments,
    showSummary = true,
    sortable: enableSortable = true,
    addLabel = 'Add line',
    empty,
    minRows = 0,
    maxRows,
    readOnly = false,
    disabled = false,
    invalid,
    name,
    ariaLabel,
    words,
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    className,
    fieldClassName,
    ref,
  } = props;
  const legacyEmptyMessage = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const emptyContent = renderStructuredEmpty(empty, legacyEmptyMessage ?? 'No line items added yet.');
  const locale = resolveLocale(explicitLocale);
  const [internalRows, setInternalRows] = React.useState<TRow[]>(() => [...defaultValue]);
  const rows = React.useMemo<TRow[]>(() => (value !== undefined ? [...value] : internalRows), [value, internalRows]);

  const isInvalid = invalid ?? Boolean(error);
  const isLocked = readOnly || disabled;

  const commitRows = React.useCallback(
    (next: TRow[]) => {
      if (value === undefined) {
        setInternalRows(next);
      }
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  // Detect automatic qty * money pairing when no explicit computed column or custom row total exists
  const autoPair = React.useMemo(() => {
    const hasComputed = columns.some((c) => c.kind === 'computed');
    const hasExplicitSum = columns.some((c) => c.sumInSubtotal);
    if (hasComputed || hasExplicitSum) return null;

    const qtyCol = columns.find((c) => c.kind === 'number' && /^(qty|quantity|count|units|hours)$/i.test(c.key));
    const moneyCols = columns.filter((c) => c.kind === 'money');
    if (qtyCol && moneyCols.length === 1 && moneyCols[0]) {
      return { qtyKey: qtyCol.key, priceKey: moneyCols[0].key };
    }
    return null;
  }, [columns]);

  const showDerivedAmountCol = Boolean(autoPair && showAutoLineAmount && !computeRowTotal);

  const evaluateRowTotal = React.useCallback(
    (row: TRow, rowIndex: number): number => {
      if (computeRowTotal) {
        return computeRowTotal(row, rowIndex);
      }
      const explicitCols = columns.filter((c) => c.sumInSubtotal);
      if (explicitCols.length > 0) {
        return explicitCols.reduce((sum, col) => {
          const val = col.kind === 'computed' ? (col.compute?.(row, rowIndex) ?? 0) : Number(row[col.key] ?? 0);
          return sum + (Number.isFinite(val) ? val : 0);
        }, 0);
      }
      const computedCols = columns.filter((c) => c.kind === 'computed');
      if (computedCols.length > 0) {
        const lastComputed = computedCols[computedCols.length - 1];
        const val = lastComputed?.compute?.(row, rowIndex) ?? 0;
        return Number.isFinite(val) ? val : 0;
      }
      if (autoPair) {
        const q = Number(row[autoPair.qtyKey] ?? 0);
        const p = Number(row[autoPair.priceKey] ?? 0);
        const prod = q * p;
        return Number.isFinite(prod) ? prod : 0;
      }
      const moneyCols = columns.filter((c) => c.kind === 'money');
      if (moneyCols.length > 0) {
        return moneyCols.reduce((sum, col) => {
          const val = Number(row[col.key] ?? 0);
          return sum + (Number.isFinite(val) ? val : 0);
        }, 0);
      }
      const numCols = columns.filter((c) => c.kind === 'number');
      return numCols.reduce((sum, col) => {
        const val = Number(row[col.key] ?? 0);
        return sum + (Number.isFinite(val) ? val : 0);
      }, 0);
    },
    [autoPair, columns, computeRowTotal],
  );

  const subtotal = React.useMemo(() => rows.reduce((acc, row, idx) => acc + evaluateRowTotal(row, idx), 0), [rows, evaluateRowTotal]);

  const taxAmount = React.useMemo(() => (taxRate !== undefined && taxRate > 0 ? subtotal * taxRate : 0), [subtotal, taxRate]);

  const adjustmentsSum = React.useMemo(() => (adjustments ? adjustments.reduce((acc, adj) => acc + adj.amount, 0) : 0), [adjustments]);

  const grandTotal = subtotal + taxAmount + adjustmentsSum;

  const handleCellChange = (rowId: string, key: string, rawVal: string | number) => {
    commitRows(rows.map((r) => (r.id === rowId ? ({ ...r, [key]: rawVal } as TRow) : r)));
  };

  const handleAddRow = () => {
    if (isLocked || (maxRows !== undefined && rows.length >= maxRows)) return;
    if (createRow) {
      commitRows([...rows, createRow()]);
      return;
    }
    const blank: Record<string, string | number | undefined> = {
      id: freshRowId('nx-line', new Set(rows.map((r) => r.id))),
    };
    for (const col of columns) {
      if (col.kind === 'computed') continue;
      if (col.kind === 'number') {
        blank[col.key] = /^(qty|quantity|count|units)$/i.test(col.key) ? 1 : 0;
      } else if (col.kind === 'money') {
        blank[col.key] = 0;
      } else if (col.kind === 'select') {
        blank[col.key] = col.options?.[0]?.value ?? '';
      } else {
        blank[col.key] = '';
      }
    }
    commitRows([...rows, blank as TRow]);
  };

  const handleDeleteRow = (rowId: string) => {
    if (isLocked || rows.length <= minRows) return;
    commitRows(rows.filter((r) => r.id !== rowId));
  };

  const handleReorder = (nextIds: string[]) => {
    if (isLocked) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const reordered = nextIds.map((id) => byId.get(id)).filter((r): r is TRow => r !== undefined);
    if (reordered.length === rows.length) {
      commitRows(reordered);
    }
  };

  const gridTemplate = React.useMemo(() => {
    const parts: string[] = [];
    if (enableSortable && !isLocked) parts.push('28px');
    for (const col of columns) {
      parts.push(defaultColumnTrack(col));
    }
    if (showDerivedAmountCol) {
      parts.push('minmax(108px, 1fr)');
    }
    if (!isLocked) {
      parts.push('34px');
    }
    return parts.join(' ');
  }, [columns, enableSortable, isLocked, showDerivedAmountCol]);

  const rowIds = React.useMemo(() => rows.map((r) => r.id), [rows]);
  const rowById = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const renderRowCells = (row: TRow, rowIndex: number) => (
    <>
      {columns.map((col) => {
        const align = col.align ?? (col.kind === 'number' || col.kind === 'money' || col.kind === 'computed' ? 'end' : 'start');

        if (col.kind === 'computed') {
          const val = col.compute?.(row, rowIndex) ?? 0;
          const colCurrency = col.currency ?? currency;
          return (
            <div key={col.key} data-align={align} className="nx-line-cell nx-line-cell-computed">
              {formatMoneyAmount(val, colCurrency, locale)}
            </div>
          );
        }

        if (col.kind === 'select') {
          const currentVal = String(row[col.key] ?? '');
          return (
            <div key={col.key} data-align={align} className="nx-line-cell">
              <select
                value={currentVal}
                disabled={isLocked}
                aria-label={typeof col.label === 'string' ? col.label : col.key}
                onChange={(e) => handleCellChange(row.id, col.key, e.target.value)}
                className="nx-line-select nx-focusable"
              >
                {col.placeholder ? (
                  <option value="" disabled>
                    {col.placeholder}
                  </option>
                ) : null}
                {(col.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (col.kind === 'money') {
          const colCurrency = col.currency ?? currency;
          const sym = getCurrencySymbol(colCurrency, locale);
          const raw = row[col.key];
          return (
            <div key={col.key} data-align={align} className="nx-line-cell nx-line-cell-money">
              <span className="nx-line-currency-symbol" aria-hidden="true">
                {sym}
              </span>
              <input
                type="number"
                inputMode="decimal"
                step={col.step ?? '0.01'}
                min={col.min}
                max={col.max}
                value={raw === undefined ? '' : raw}
                placeholder={col.placeholder ?? '0.00'}
                readOnly={readOnly}
                disabled={disabled}
                aria-label={typeof col.label === 'string' ? col.label : col.key}
                onChange={(e) => {
                  const v = e.target.value;
                  handleCellChange(row.id, col.key, v === '' ? '' : Number(v));
                }}
                className="nx-line-input nx-line-input-num"
              />
            </div>
          );
        }

        if (col.kind === 'number') {
          const raw = row[col.key];
          return (
            <div key={col.key} data-align={align} className="nx-line-cell">
              <input
                type="number"
                inputMode="decimal"
                step={col.step ?? 1}
                min={col.min}
                max={col.max}
                value={raw === undefined ? '' : raw}
                placeholder={col.placeholder ?? '0'}
                readOnly={readOnly}
                disabled={disabled}
                aria-label={typeof col.label === 'string' ? col.label : col.key}
                onChange={(e) => {
                  const v = e.target.value;
                  handleCellChange(row.id, col.key, v === '' ? '' : Number(v));
                }}
                className="nx-line-input nx-line-input-num"
              />
            </div>
          );
        }

        return (
          <div key={col.key} data-align={align} className="nx-line-cell">
            <input
              type="text"
              value={String(row[col.key] ?? '')}
              placeholder={col.placeholder}
              readOnly={readOnly}
              disabled={disabled}
              aria-label={typeof col.label === 'string' ? col.label : col.key}
              onChange={(e) => handleCellChange(row.id, col.key, e.target.value)}
              className="nx-line-input"
            />
          </div>
        );
      })}

      {showDerivedAmountCol ? (
        <div data-align="end" className="nx-line-cell nx-line-cell-computed">
          {formatMoneyAmount(evaluateRowTotal(row, rowIndex), currency, locale)}
        </div>
      ) : null}

      {!isLocked ? (
        <div className="nx-line-cell nx-line-cell-action">
          <button
            type="button"
            onClick={() => handleDeleteRow(row.id)}
            disabled={rows.length <= minRows}
            aria-label={words?.removeLine ? words.removeLine(rowIndex + 1) : `Remove line ${rowIndex + 1}`}
            title={words?.removeLine ? words.removeLine(rowIndex + 1) : 'Remove line'}
            className="nx-line-delete-btn nx-focusable"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ) : null}
    </>
  );

  const tableFrame = (
    <div
      ref={ref}
      aria-label={ariaLabel}
      data-slot="line-items-editor"
      data-invalid={isInvalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      style={{ '--line-items-grid': gridTemplate } as React.CSSProperties}
      className={cx('nx-line-items', className)}
    >
      {name ? <input type="hidden" name={name} value={JSON.stringify(rows)} /> : null}

      <div className="nx-line-items-scroll">
        <div className="nx-line-items-header">
          {enableSortable && !isLocked ? <span aria-hidden="true" /> : null}
          {columns.map((col) => {
            const align = col.align ?? (col.kind === 'number' || col.kind === 'money' || col.kind === 'computed' ? 'end' : 'start');
            return (
              <span key={col.key} data-align={align} className="nx-line-col-heading">
                {col.label}
              </span>
            );
          })}
          {showDerivedAmountCol ? (
            <span data-align="end" className="nx-line-col-heading">
              {words?.amount ?? 'Amount'}
            </span>
          ) : null}
          {!isLocked ? <span aria-hidden="true" /> : null}
        </div>

        {rows.length === 0 ? (
          <div className="nx-line-items-empty">{emptyContent}</div>
        ) : enableSortable && !isLocked ? (
          <Sortable
            by="handle"
            value={rowIds}
            onValueChange={handleReorder}
            aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Line items')}
            className="nx-line-items-body"
          >
            {(rowId, rowIndex) => {
              const row = rowById.get(rowId);
              if (!row) return null;
              return (
                <SortableItem key={rowId} value={rowId} className="nx-line-items-row">
                  <div className="nx-line-cell nx-line-cell-handle">
                    <SortableHandle
                      aria-label={words?.reorderLine ? words.reorderLine(rowIndex + 1) : `Reorder line ${rowIndex + 1}`}
                      className="nx-line-drag-handle"
                    >
                      <Icon name="dots-six-vertical" size={14} weight="bold" />
                    </SortableHandle>
                  </div>
                  {renderRowCells(row, rowIndex)}
                </SortableItem>
              );
            }}
          </Sortable>
        ) : (
          <div className="nx-line-items-body">
            {rows.map((row, rowIndex) => (
              <div key={row.id} className="nx-line-items-row">
                {renderRowCells(row, rowIndex)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="nx-line-items-footer">
        <div className="nx-line-items-footer-start">
          {!isLocked ? (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" size={13} weight="bold" />}
              disabled={maxRows !== undefined && rows.length >= maxRows}
              onClick={handleAddRow}
            >
              {addLabel}
            </Button>
          ) : null}
        </div>

        {showSummary ? (
          <dl className="nx-line-items-summary">
            <div className="nx-line-summary-row">
              <dt>{words?.subtotal ?? 'Subtotal'}</dt>
              <dd>{formatMoneyAmount(subtotal, currency, locale)}</dd>
            </div>

            {adjustments?.map((adj, idx) => (
              <div key={idx} className="nx-line-summary-row">
                <dt>{adj.label}</dt>
                <dd>{formatMoneyAmount(adj.amount, currency, locale)}</dd>
              </div>
            ))}

            {taxRate !== undefined && taxRate > 0 ? (
              <div className="nx-line-summary-row">
                <dt>{taxLabel ?? `Tax (${+(taxRate * 100).toFixed(2)}%)`}</dt>
                <dd>{formatMoneyAmount(taxAmount, currency, locale)}</dd>
              </div>
            ) : null}

            <div className="nx-line-summary-row nx-line-summary-total">
              <dt>{words?.total ?? 'Total'}</dt>
              <dd>{formatMoneyAmount(grandTotal, currency, locale)}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </div>
  );

  return wrapWithField(tableFrame, {
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

/* ============================================================================
 * 6. KeyValueEditor (Env Vars / HTTP Headers / Metadata + Secret Mask + Paste)
 * ========================================================================== */

/** Single key/value entry managed by `KeyValueEditor`. */
export interface KeyValueItem {
  id: string;
  key: string;
  value: string;
  secret?: boolean;
}

/** Props for the `KeyValueEditor` component. */
export interface KeyValueEditorProps extends FieldFrameProps {
  value?: ReadonlyArray<KeyValueItem>;
  defaultValue?: ReadonlyArray<KeyValueItem>;
  onValueChange?: (items: KeyValueItem[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  keyHeader?: React.ReactNode;
  valueHeader?: React.ReactNode;
  /** Enable per-row secret masking (`Eye`/`EyeSlash`) and secret lock toggle. Defaults to `true`. */
  allowSecrets?: boolean;
  /** Default `secret` state for newly added rows. Defaults to `false`. */
  defaultSecret?: boolean;
  /** Automatically uppercase typed/pasted keys (ideal for `.env` variables). Defaults to `false`. */
  uppercaseKeys?: boolean;
  /** Parse multiline `KEY=VALUE` or `Header: Value` clipboard pastes into structured rows. Defaults to `true`. */
  allowMultilinePaste?: boolean;
  addLabel?: React.ReactNode;
  empty?: EmptyStateSpec | React.ReactNode;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  name?: string;
  ariaLabel?: string;
  /** The editor's own wording, for an App in another language. Each falls back to the English. */
  words?: {
    /** The badge on a key that appears twice, and its tooltip. */
    duplicate?: string;
    duplicateTitle?: string;
    /** The line beside the add button about pasting `KEY=VALUE` blocks. */
    pasteTip?: React.ReactNode;
    /** The count in the header: `3 entries · 1 secret`. */
    count?: (entries: number, secrets: number) => string;
    keyLabel?: (index: number) => string;
    valueLabel?: (key: string, index: number) => string;
    revealSecret?: string;
    hideSecret?: string;
    markSecret?: string;
    unmarkSecret?: string;
    deleteRow?: (key: string, index: number) => string;
  };
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
}

const SECRET_KEY_HINT_RE = /(?:secret|token|password|passwd|pwd|private|api[_-]?key|auth|credential)/i;

function parseKeyValueBlock(
  text: string,
  options: { allowSecrets?: boolean; uppercaseKeys?: boolean; defaultSecret?: boolean } = {},
): Array<Omit<KeyValueItem, 'id'>> {
  const lines = text.split(/\r?\n/);
  const parsed: Array<Omit<KeyValueItem, 'id'>> = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.replace(/^export\s+/, '');
    const eqIdx = withoutExport.indexOf('=');
    const colonIdx = withoutExport.indexOf(':');

    let sepIdx = -1;
    if (eqIdx > 0 && (colonIdx === -1 || eqIdx < colonIdx)) {
      sepIdx = eqIdx;
    } else if (colonIdx > 0) {
      sepIdx = colonIdx;
    }
    if (sepIdx <= 0) continue;

    let rawKey = withoutExport.slice(0, sepIdx).trim();
    let rawVal = withoutExport.slice(sepIdx + 1).trim();

    if (
      (rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2)
    ) {
      rawVal = rawVal.slice(1, -1);
    }

    if (options.uppercaseKeys) {
      rawKey = rawKey.toUpperCase();
    }

    const inferredSecret = options.allowSecrets !== false && (Boolean(options.defaultSecret) || SECRET_KEY_HINT_RE.test(rawKey));

    parsed.push({
      key: rawKey,
      value: rawVal,
      secret: inferredSecret || undefined,
    });
  }

  return parsed;
}

/** Key/value table editor with secret masking, duplicate-key warnings, and multiline `.env` paste parsing. */
export function KeyValueEditor(props: KeyValueEditorProps): React.JSX.Element {
  const {
    value,
    defaultValue = [],
    onValueChange,
    keyPlaceholder = 'KEY_NAME',
    valuePlaceholder = 'Value',
    keyHeader = 'Key',
    valueHeader = 'Value',
    allowSecrets = true,
    defaultSecret = false,
    uppercaseKeys = false,
    allowMultilinePaste = true,
    addLabel = 'Add row',
    empty,
    readOnly = false,
    disabled = false,
    invalid,
    name,
    ariaLabel,
    words,
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    className,
    fieldClassName,
    ref,
  } = props;
  const revealWord = words?.revealSecret ?? 'Reveal secret value';
  const hideWord = words?.hideSecret ?? 'Hide secret value';
  const legacyEmptyMessage = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const emptyContent = renderStructuredEmpty(empty, legacyEmptyMessage ?? 'No entries configured. Add a row or paste KEY=VALUE lines.');
  const [internalItems, setInternalItems] = React.useState<KeyValueItem[]>(() => [...defaultValue]);
  const [revealedIds, setRevealedIds] = React.useState<Set<string>>(() => new Set());

  const items = React.useMemo<KeyValueItem[]>(() => (value !== undefined ? [...value] : internalItems), [value, internalItems]);

  const isInvalid = invalid ?? Boolean(error);
  const isLocked = readOnly || disabled;

  const duplicateKeys = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const k = item.key.trim();
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [k, count] of counts) {
      if (count > 1) dupes.add(k);
    }
    return dupes;
  }, [items]);

  const commitItems = React.useCallback(
    (next: KeyValueItem[]) => {
      if (value === undefined) {
        setInternalItems(next);
      }
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const handleAdd = () => {
    if (isLocked) return;
    commitItems([
      ...items,
      {
        id: freshRowId('nx-kv', new Set(items.map((item) => item.id))),
        key: '',
        value: '',
        secret: defaultSecret || undefined,
      },
    ]);
  };

  const handleRemove = (id: string) => {
    if (isLocked) return;
    commitItems(items.filter((item) => item.id !== id));
    setRevealedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleUpdate = (id: string, patch: Partial<KeyValueItem>) => {
    if (isLocked) return;
    commitItems(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleKeyInputPaste = (rowIndex: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    if (!allowMultilinePaste || isLocked) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;

    const looksStructured = text.includes('\n') || /^[A-Za-z0-9_.-]+\s*=\s*.+/.test(text.trim());
    if (!looksStructured) return;

    const extracted = parseKeyValueBlock(text, {
      allowSecrets,
      uppercaseKeys,
      defaultSecret,
    });
    if (extracted.length === 0) return;

    event.preventDefault();

    const next = [...items];
    const targetRow = next[rowIndex];
    const taken = new Set(items.map((item) => item.id));
    const newEntries: KeyValueItem[] = extracted.map((entry) => ({
      id: freshRowId('nx-kv', taken),
      ...entry,
    }));

    if (targetRow && !targetRow.key.trim() && !targetRow.value.trim()) {
      const first = newEntries[0];
      if (first) {
        next.splice(rowIndex, 1, { ...first, id: targetRow.id }, ...newEntries.slice(1));
      }
    } else {
      next.splice(rowIndex + 1, 0, ...newEntries);
    }

    commitItems(next);
  };

  const secretCount = items.filter((i) => i.secret).length;

  const kvFrame = (
    <div
      ref={ref}
      aria-label={ariaLabel}
      data-slot="key-value-editor"
      data-invalid={isInvalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx('nx-kv-editor', className)}
    >
      {name ? <input type="hidden" name={name} value={JSON.stringify(items)} /> : null}

      <div className="nx-kv-header">
        <span className="nx-kv-col-label">{keyHeader}</span>
        <span className="nx-kv-col-label">{valueHeader}</span>
        <span className="nx-kv-header-meta">
          {items.length === 0
            ? null
            : words?.count
              ? words.count(items.length, secretCount)
              : `${items.length} ${items.length === 1 ? 'entry' : 'entries'}${secretCount > 0 ? ` · ${secretCount} secret` : ''}`}
        </span>
      </div>

      {items.length === 0 ? (
        <div
          className="nx-kv-empty"
          onPaste={(e) => {
            if (!allowMultilinePaste || isLocked) return;
            const text = e.clipboardData.getData('text/plain');
            const extracted = parseKeyValueBlock(text, {
              allowSecrets,
              uppercaseKeys,
              defaultSecret,
            });
            if (extracted.length > 0) {
              e.preventDefault();
              const taken = new Set<string>();
              commitItems(extracted.map((entry) => ({ id: freshRowId('nx-kv', taken), ...entry })));
            }
          }}
          tabIndex={isLocked ? undefined : 0}
        >
          {emptyContent}
        </div>
      ) : (
        <div className="nx-kv-rows">
          {items.map((item, idx) => {
            const isRevealed = revealedIds.has(item.id);
            const isMasked = Boolean(item.secret) && !isRevealed;
            const isDupe = Boolean(item.key.trim()) && duplicateKeys.has(item.key.trim());

            return (
              <div key={item.id} data-secret={item.secret ? '' : undefined} data-duplicate={isDupe ? '' : undefined} className="nx-kv-row">
                <div className="nx-kv-key-cell">
                  <input
                    type="text"
                    value={item.key}
                    placeholder={keyPlaceholder}
                    readOnly={readOnly}
                    disabled={disabled}
                    spellCheck={false}
                    autoCapitalize="off"
                    aria-label={words?.keyLabel?.(idx) ?? `Key ${idx + 1}`}
                    onPaste={(e) => handleKeyInputPaste(idx, e)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      handleUpdate(item.id, {
                        key: uppercaseKeys ? raw.toUpperCase() : raw,
                      });
                    }}
                    className="nx-kv-input nx-kv-key-input"
                  />
                  {isDupe ? (
                    <span className="nx-kv-dupe-badge" title={words?.duplicateTitle ?? 'Duplicate key'}>
                      {words?.duplicate ?? 'DUPE'}
                    </span>
                  ) : null}
                </div>

                <div className="nx-kv-value-cell">
                  <input
                    type={isMasked ? 'password' : 'text'}
                    value={item.value}
                    placeholder={item.secret ? '••••••••••••' : valuePlaceholder}
                    readOnly={readOnly}
                    disabled={disabled}
                    spellCheck={false}
                    autoCapitalize="off"
                    data-agent-secret={item.secret ? '' : undefined}
                    aria-label={words?.valueLabel?.(item.key, idx) ?? `Value for ${item.key || `row ${idx + 1}`}`}
                    onChange={(e) => handleUpdate(item.id, { value: e.target.value })}
                    className="nx-kv-input nx-kv-value-input"
                  />

                  {allowSecrets && item.secret ? (
                    <button
                      type="button"
                      onClick={() => toggleReveal(item.id)}
                      disabled={disabled}
                      aria-label={isRevealed ? hideWord : revealWord}
                      title={isRevealed ? hideWord : revealWord}
                      className="nx-kv-icon-btn nx-focusable"
                    >
                      {isRevealed ? <Icon name="eye-slash" size={14} /> : <Icon name="eye" size={14} />}
                    </button>
                  ) : null}
                </div>

                <div className="nx-kv-actions-cell">
                  {allowSecrets && !isLocked ? (
                    <button
                      type="button"
                      onClick={() => handleUpdate(item.id, { secret: !item.secret })}
                      aria-pressed={Boolean(item.secret)}
                      aria-label={item.secret ? (words?.unmarkSecret ?? 'Unmark as secret') : (words?.markSecret ?? 'Mark value as secret')}
                      title={item.secret ? 'Secret (masked)' : 'Plaintext (click to mask)'}
                      data-active={item.secret ? '' : undefined}
                      className="nx-kv-icon-btn nx-focusable"
                    >
                      {item.secret ? <Icon name="lock" size={14} weight="bold" /> : <Icon name="lock-simple-open" size={14} />}
                    </button>
                  ) : null}

                  {!isLocked ? (
                    <button
                      type="button"
                      onClick={() => handleRemove(item.id)}
                      aria-label={words?.deleteRow?.(item.key, idx) ?? `Delete ${item.key || `row ${idx + 1}`}`}
                      title="Delete row"
                      className="nx-kv-icon-btn nx-kv-delete-btn nx-focusable"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isLocked ? (
        <div className="nx-kv-footer">
          <Button size="sm" variant="secondary" leadingIcon={<Icon name="plus" size={13} weight="bold" />} onClick={handleAdd}>
            {addLabel}
          </Button>
          {allowMultilinePaste ? (
            <span className="nx-kv-paste-hint">
              {words?.pasteTip ?? (
                <>
                  Tip: Paste multiline <code>KEY=VALUE</code> blocks into any key field
                </>
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return wrapWithField(kvFrame, {
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}
