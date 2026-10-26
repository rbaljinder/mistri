/**
 * Export the result you are looking at, as CSV or JSON.
 *
 * Both scopes are offered with their row count spelled out, because the
 * default page is 20 rows and a file called `invoice-2026-08-22.csv` gives
 * no hint that the other 49,980 rows were left behind. The serialisers and
 * the column memory stay in `export.js`, pure and tested without a browser;
 * this is the control over them, a part that loads on demand: ExportHold.tsx
 * holds its place until it has.
 */
import { useRef, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { api, columnDisplay, findTable, pageSize, state, toast } from '../core.js';
import { minorToMajor, rowCurrency } from '@mistriwork/engine/shared/money.js';
import {
  EXPORT_MAX_ROWS,
  declaredColumns,
  orderColumns,
  rememberColumns,
  sameList,
  saveExport,
  selectionFor,
  streamExport,
  withColumns,
} from '../export.js';
import { copyPosition, positionOf } from '../handoff.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { defaultCurrency, formatNumber } from '../locale.js';
import { pageStepFor, stepList } from './pageStep.js';
import { shell } from '../shellMode.js';
import { say } from '../copy/workbench/components/Export.js';

interface ExportData {
  table: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
}
interface Entry {
  table: string;
  query: string;
}

export function ExportControl({ entry, data }: { entry: Entry; data: ExportData }) {
  const displayed = data.columns ?? [];
  const declared = declaredColumns(data.table) as string[];
  const pageRows = data.rows ?? [];
  const total = data.total ?? pageRows.length;
  const capped = Math.min(total, EXPORT_MAX_ROWS as number);
  /* Last time's selection if there is one, otherwise exactly what is on
     screen. A pick is remembered in the store, so re-reading it after one
     is enough — the tick is only to make this component look again. */
  const [, tick] = useState(0);
  const selected = selectionFor(data.table, displayed, declared) as string[];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  /**
   * Fetch if the file would differ from what is on screen, then write it.
   * The re-fetch is the whole reason the chooser is safe to offer: picking
   * columns out of the rows already in hand would quietly export blanks for
   * any column the query never selected.
   */
  const deliver = async (kind: 'csv' | 'json', all: boolean) => {
    const onScreen = sameList(selected, displayed);
    let rows = pageRows;
    if (all || !onScreen) {
      setBusy(`${kind}:${all}`);
      try {
        /* Where it cannot stream, "all" is one bounded re-run rather than
           pages stitched together by the client. */
        const q = withColumns(entry.query, sameList(selected, declared) ? [] : selected);
        /* Streamed where the server offers it: one bounded read held whole
           was up to 19 MB of objects on the server and a long pause. */
        if (all && (await streamExport(kind, data.table, q, selected))) {
          setOpen(false);
          return;
        }
        /* This page is read the way the list read it: a step by key, where the pager took one (pageStep.ts). */
        const page = (state as { page: number }).page;
        const step = all
          ? undefined
          : pageStepFor(
              stepList((state as { activeConnection?: string }).activeConnection ?? '', entry.table, entry.query, pageSize()),
              page,
            );
        const fresh = await api('/api/run', {
          q,
          limit: all ? capped : (step?.limit ?? pageSize()),
          offset: all ? 0 : page * pageSize(),
          ...step?.body,
        });
        if (!fresh.columns) throw new Error(fresh.errors?.[0]?.message ?? say('thatQueryNoLonger'));
        rows = fresh.rows ?? [];
      } catch (err) {
        toast((err as Error).message, 'error');
        return;
      } finally {
        setBusy(null);
      }
    }
    setOpen(false);
    // `selected` rather than what came back, so the file follows the declared order.
    saveExport(kind, data.table, selected, kind === 'csv' ? sheetAmounts(data.table, selected, rows) : rows);
  };

  /* JSON and the agent hand-off are Workbench tools; an App's list offers the columns and the CSV. */
  const workbench = !shell().inApp();
  const kinds = workbench ? (['csv', 'json'] as const) : (['csv'] as const);
  const pageLabel = say('thisPageRows', { count: pageRows.length });
  const allLabel = say('allMatchingRows', { capped: formatNumber(capped) });
  return (
    <>
      <DropMenu
        className="export"
        triggerClassName="export-summary"
        triggerTitle={say('downloadThisResult')}
        label={
          <>
            <span className="export-word">{say('export')}</span>
            <span className="export-more" aria-hidden="true">
              ⋯
            </span>
          </>
        }
        popupClassName="export-menu"
        open={open}
        onOpenChange={setOpen}
      >
        <div className="export-group">
          <DropItem className="export-item export-columns-item" onClick={() => setChoosing(true)}>
            <span>{say('chooseColumns')}</span>
            <span className="export-count">
              {declared.length ? say('selectedOfDeclared', { selected: selected.length, declared: declared.length }) : `${selected.length}`}
            </span>
          </DropItem>
        </div>
        {kinds.map((kind) => (
          <div key={kind} className="export-group">
            <span className="export-kind">{kind.toUpperCase()}</span>
            <DropItem
              className="export-item"
              disabled={busy === `${kind}:false`}
              closeOnClick={false}
              onClick={() => void deliver(kind, false)}
            >
              {busy === `${kind}:false` ? say('fetching') : pageLabel}
            </DropItem>
            {/* Only worth offering when it would actually differ from the page. */}
            {total > pageRows.length && (
              <DropItem
                className="export-item"
                disabled={busy === `${kind}:true`}
                closeOnClick={false}
                onClick={() => void deliver(kind, true)}
              >
                {busy === `${kind}:true` ? say('fetching') : allLabel}
              </DropItem>
            )}
          </div>
        ))}
        {/* Not a file, but the same question: take this away with you. An agent is the other place a result goes. */}
        {workbench && (
          <div className="export-group">
            <span className="export-kind">{say('agent')}</span>
            <DropItem
              className="export-item"
              title={say('theQueryTheShape')}
              onClick={() => void copyPosition(positionOf(state, entry, { columns: displayed, shown: pageRows.length, total }), toast)}
            >
              {say('copyThisPosition')}
            </DropItem>
          </div>
        )}
        {total > (EXPORT_MAX_ROWS as number) && (
          <p className="export-note">{say('cappedAtRowsTheSame', { max: formatNumber(EXPORT_MAX_ROWS as number) })}</p>
        )}
      </DropMenu>
      {choosing && (
        <ColumnChooser
          tableId={data.table}
          displayed={displayed}
          declared={declared}
          selected={selected}
          onClose={() => setChoosing(false)}
          onDone={(picked) => {
            rememberColumns(data.table, picked);
            tick((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

interface ChooserColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  references?: unknown;
}

/**
 * The column chooser: a checklist rather than a multi-select, so every
 * column is visible at once with its type and its keys — which is the
 * information the choice actually turns on.
 */
function ColumnChooser({
  tableId,
  displayed,
  declared,
  selected,
  onClose,
  onDone,
}: {
  tableId: string;
  displayed: string[];
  declared: string[];
  selected: string[];
  onClose: () => void;
  onDone: (picked: string[]) => void;
}) {
  const table = state.schema ? (findTable(tableId) as TableMeta | undefined) : null;
  /* A view whose columns the catalog does not carry still has the ones on
     screen, so the chooser degrades to those rather than opening empty. */
  const columns: ChooserColumn[] = table?.columns?.length
    ? table.columns
    : declared.concat(displayed.filter((n) => !declared.includes(n))).map((name) => ({ name }));
  const [ticked, setTicked] = useState(() => new Set(selected));
  const dialog = useRef<ModalHandle>(null);
  const setAll = (names: string[]) => setTicked(new Set(names));
  const toggle = (name: string, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const use = () => {
    const picked = columns.map((c) => c.name).filter((n) => ticked.has(n));
    // A file of nothing but row separators is not an export.
    if (!picked.length) {
      toast(say('pickAtLeastOne'), 'error');
      return;
    }
    dialog.current?.close();
    onDone(orderColumns(picked, declared) as string[]);
  };
  return (
    <Modal className="confirm cols" ref={dialog} onClose={onClose}>
      <h2>{say('columnsToExport')}</h2>
      <p>{say('tickedColumnsAreWritten')}</p>
      <div className="col-actions">
        <Button size="compact" onClick={() => setAll(columns.map((c) => c.name))}>
          {say('common.all')}
        </Button>
        <Button size="compact" onClick={() => setAll([])}>
          {say('none')}
        </Button>
        <Button size="compact" onClick={() => setAll(displayed)}>
          {say('asDisplayed')}
        </Button>
        <span className="col-count">
          {say('ofSelected', { filterCount: columns.filter((c) => ticked.has(c.name)).length, columnsCount: columns.length })}
        </span>
      </div>
      <div className="col-list">
        {columns.map((column) => (
          <label key={column.name} className="col-row">
            <input type="checkbox" checked={ticked.has(column.name)} onChange={(e) => toggle(column.name, e.currentTarget.checked)} />
            <span className="col-name">{column.name}</span>
            {/* The same markers the result grid puts on its headers, so the two read as one vocabulary. */}
            {column.primaryKey ? <span className="pk"> {say('common.key')}</span> : null}
            {column.references ? <span className="fk"> →</span> : null}
            <span className="col-type">{column.type ?? ''}</span>
            {displayed.includes(column.name) ? null : <span className="col-extra">{say('notShown')}</span>}
          </label>
        ))}
      </div>
      <p className="confirm-params">{say('rememberedForThisTable')}</p>
      <div className="confirm-actions">
        <Button onClick={() => dialog.current?.close()}>{say('common.cancel')}</Button>
        <Button intent="primary" onClick={use}>
          {say('useTheseColumns')}
        </Button>
      </div>
    </Modal>
  );
}

type MinorRule = { format?: string; minor?: true; currency?: string; currencyColumn?: string };
/**
 * A CSV says money as the figure a sheet reads, as the server's streamed file
 * does (exportRoute.ts csvAmounts), and here where it cannot stream — a tenant
 * lease, a row policy, this page: a column kept in minor units, 1999, is
 * written 19.99 in its row's own currency.
 */
function sheetAmounts(tableId: string, columns: readonly string[], rows: Array<Record<string, unknown>>) {
  const minor = columns.flatMap((column) => {
    const rule = columnDisplay(tableId, column) as MinorRule | null;
    return rule?.format === 'money' && rule.minor ? [[column, rule] as const] : [];
  });
  if (!minor.length) return rows;
  return rows.map((row) => {
    const said = { ...row };
    for (const [column, rule] of minor)
      if (Object.hasOwn(row, column))
        said[column] = minorToMajor(row[column], rowCurrency(rule, row, rule.currency || defaultCurrency())) ?? row[column];
    return said;
  });
}
