/**
 * A breakdown: counts and sums, grouped by something — the answer drawn.
 *
 * Deliberately plain: a header that sorts by editing the line, cells that
 * render through the same value renderer every other surface uses, the
 * keyboard cursor with nowhere to open, and the same paging the table has,
 * over groups instead of rows. A group is a door — "draft · 102" opens
 * `invoice status = draft` — where the grouping is a plain column.
 */
import { useRef, useState } from 'react';
import { api, findTable, go, pageSize, quote, render, state, tableView, toast } from '../core.js';
import { explicitLimit, nextSort, sortDirection } from '../clauses.js';
import { planColumn } from '../columns.js';
import { EXPORT_MAX_ROWS, download, exportFilename, toCsv, toJson } from '../export.js';
import { promptFor } from '../prompt.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { ResourceHttpSuccess } from '@mistriwork/engine/shared/resourceHttp.js';
import { Value } from './Value.js';
import { useGridKeyboard } from './useGridKeyboard.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/dashboards/components/Breakdown.js';

export interface BreakdownEntry {
  kind: 'breakdown';
  table: string;
  query: string;
}

export type BreakdownData = ResourceHttpSuccess<'/api/breakdown'>;

export function BreakdownView({ entry, data }: { entry: BreakdownEntry; data: BreakdownData }) {
  const asked = explicitLimit(entry.query) as number | null;
  const shown = (asked ? 0 : (state as { page: number }).page * (pageSize() as number)) + data.rows.length;
  return (
    <>
      <Head entry={entry} data={data} shown={shown} />
      <BreakdownGrid entry={entry} data={data} />
      <Pager entry={entry} data={data} shown={shown} />
    </>
  );
}

/** "Groups" rather than "rows": 12,006 invoices came back as 4 groups. */
function Head({ entry, data, shown }: { entry: BreakdownEntry; data: BreakdownData; shown: number }) {
  const base = data.breakdown?.base ?? entry.table;
  const total = data.total;
  return (
    <div className="result-head">
      <h1 className="result-title">{(findTable(base) as TableMeta | undefined)?.name ?? base}</h1>
      <span className="stat">
        {total === undefined
          ? say('groups', { count: shown })
          : total > shown
            ? say('shownOfTotal', { shown: formatNumber(shown), total: say('groups', { count: total }) })
            : say('groups', { count: total })}
      </span>
      <span className="stat">{say('ms', { ms: data.ms })}</span>
      {/* The workbench-to-config bridge: this very line, shaped as a dashboard section. */}
      {data.section ? (
        <button
          type="button"
          className="ghost bd-copy-section"
          title={say('thisBreakdownAsADashboard')}
          onClick={async () => {
            const text = JSON.stringify(data.section, null, 2);
            try {
              await navigator.clipboard.writeText(text);
              toast(say('sectionCopiedPasteItInto'), 'ok');
            } catch {
              await promptFor({
                title: say('copyThisIntoADashboards'),
                label: say('section'),
                value: text,
                hint: undefined,
                placeholder: undefined,
              });
            }
          }}
        >
          {say('copyAsAppSection')}
        </button>
      ) : null}
      <ExportGroups entry={entry} data={data} />
    </div>
  );
}

/**
 * Export, for groups: the two scopes, each with its count spelled out. No
 * column chooser — every column is a key or a measure, and dropping one
 * makes the answer a different and wrong one.
 */
function ExportGroups({ entry, data }: { entry: BreakdownEntry; data: BreakdownData }) {
  const rows = data.rows ?? [];
  const columns = data.columns ?? [];
  const total = data.total ?? rows.length;
  const capped = Math.min(total, EXPORT_MAX_ROWS as number);
  const base = data.breakdown?.base ?? entry.table;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const write = (kind: string, groups: Array<Record<string, unknown>>) => {
    const name = `${base}-by-${(data.breakdown?.by ?? []).map((k) => k.alias || k.path).join('-') || 'group'}`;
    if (kind === 'csv') download(exportFilename(name, 'csv'), toCsv(columns, groups), 'text/csv');
    else download(exportFilename(name, 'json'), toJson(columns, groups), 'application/json');
    toast(say('exportedGroups', { count: groups.length }));
  };
  const start = async (kind: string, all: boolean) => {
    if (!all) {
      setOpen(false);
      write(kind, rows);
      return;
    }
    /* One bounded re-run rather than pages stitched together: a group is an
       aggregate over rows that may have changed between two requests. */
    setBusy(`${kind}:all`);
    try {
      const fresh = await api('/api/breakdown', { text: entry.query, limit: capped, offset: 0 });
      if ('errors' in fresh) throw new Error(fresh.errors[0]?.message ?? say('thatLineNoLonger'));
      setOpen(false);
      write(kind, fresh.rows);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const pageLabel = say('thisPageGroups', { count: rows.length });
  const allLabel = say('allGroups', { capped: formatNumber(capped) });
  return (
    <DropMenu
      className="export"
      triggerClassName="export-summary"
      triggerTitle={say('downloadTheseGroups')}
      label={say('export')}
      popupClassName="export-menu"
      open={open}
      onOpenChange={setOpen}
    >
      {(['csv', 'json'] as const).map((kind) => (
        <div key={kind} className="export-group">
          <div className="export-heading">{kind.toUpperCase()}</div>
          <DropItem className="export-item" closeOnClick={false} onClick={() => void start(kind, false)}>
            {pageLabel}
          </DropItem>
          {/* The second scope is offered only when it differs. */}
          {capped > rows.length && (
            <DropItem className="export-item" disabled={busy === `${kind}:all`} closeOnClick={false} onClick={() => void start(kind, true)}>
              {busy === `${kind}:all` ? say('fetching') : allLabel}
            </DropItem>
          )}
        </div>
      ))}
    </DropMenu>
  );
}

function BreakdownGrid({ entry, data }: { entry: BreakdownEntry; data: BreakdownData }) {
  const wrap = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const byName = new Map((data.resolved ?? []).map((c) => [c.name, c]));
  const plans = new Map(data.columns.map((name) => [name, planColumn(byName.get(name), name, data.rows) as { align: string }]));
  /* Only plain single-column groupings drill — a bucketed key names a range
     the equality could not honestly write. */
  const keys = (data.breakdown?.by ?? []).filter((k) => !k.bucket);
  const drillable = keys.length === (data.breakdown?.by ?? []).length && keys.length > 0;
  useGridKeyboard(table, wrap, {
    rowCount: data.rows.length,
    columnCount: data.columns.length,
    offset: 0,
    totalRows: data.total,
    firstRow: explicitLimit(entry.query) ? 0 : (state as { page: number }).page * (pageSize() as number),
  });
  if (!data.rows.length) {
    return (
      <div className="table-wrap" ref={wrap}>
        <p className="note">{say('nothingToGroupNoRows')}</p>
      </div>
    );
  }
  const drill = (row: Record<string, unknown>) => {
    const conditions = keys
      .map((k) => {
        const value = row[k.alias || k.path];
        if (value === null || value === undefined) return `${k.path} is empty`;
        return `${k.path} = ${quote(String(value))}`;
      })
      .join(' and ');
    go(tableView(data.breakdown!.base, `${data.breakdown!.base} ${conditions}`), 'push');
  };
  return (
    <div className="table-wrap" ref={wrap}>
      <table ref={table}>
        <thead>
          <tr>
            {data.columns.map((name) => {
              const meta = byName.get(name);
              const direction = sortDirection(entry.query, name) as 'asc' | 'desc' | null;
              return (
                <th
                  key={name}
                  className={`align-${plans.get(name)!.align}${direction ? ' sorted' : ''}`}
                  title={
                    meta?.kind === 'measure'
                      ? say('aMeasure', { measure: `${meta.fn}${meta.path ? `(${meta.path})` : ''}` })
                      : meta?.path
                        ? `${say('grouped', { path: meta.path })}${meta.type ? ` · ${meta.type}` : ''}`
                        : name
                  }
                >
                  <button
                    type="button"
                    className="th-sort"
                    title={say('sort', { name })}
                    onClick={() => go({ ...entry, query: nextSort(entry.query, name) }, 'replace')}
                  >
                    {name}
                    {direction === 'desc' ? ' ↓' : direction === 'asc' ? ' ↑' : ''}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr
              key={i}
              data-row={i}
              className={drillable ? 'clickable' : undefined}
              title={drillable ? say('openTheRowsThisGroup') : undefined}
              onClick={drillable ? () => drill(row) : undefined}
            >
              {data.columns.map((name) => {
                const value = row[name];
                return (
                  <td key={name} className={`align-${plans.get(name)!.align}`}>
                    {value === null || value === undefined ? (
                      <span className="null-value">—</span>
                    ) : (
                      <Value col={{ ...(byName.get(name) ?? {}), name } as never} value={value} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The same paging the table view has, over groups. */
function Pager({ entry, data, shown }: { entry: BreakdownEntry; data: BreakdownData; shown: number }) {
  if (explicitLimit(entry.query)) return <div className="pager" />;
  const page = (state as { page: number }).page;
  const prev = page > 0;
  const next = data.total !== undefined ? data.total > shown : data.rows.length >= (pageSize() as number);
  return (
    <div className="pager">
      {prev && (
        <button
          className="ghost"
          type="button"
          onClick={() => {
            (state as { page: number }).page--;
            render();
          }}
        >
          {say('previous')}
        </button>
      )}
      {next && (
        <button
          className="ghost"
          type="button"
          onClick={() => {
            (state as { page: number }).page++;
            render();
          }}
        >
          {say('common.nextArrow')}
        </button>
      )}
      {(prev || next) && (
        <span className="page-label">
          {say('common.page')} {page + 1}
        </span>
      )}
    </div>
  );
}
