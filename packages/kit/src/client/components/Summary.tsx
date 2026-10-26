/**
 * The schema, in a paragraph you can click.
 *
 * The diagram beneath this shows every table at once, which answers "what
 * is in here" only for someone who already knows. This says it: where the
 * domain centres, which tables are the ones you will actually query, how
 * deep the references go, and what is sitting over there connected to
 * nothing. Everything is a link, because a summary you cannot act on is a
 * paragraph to read and then leave.
 *
 * The analysis is `shared/shape.ts` and is pure; this only decides how to
 * say it.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { go, loadJson, saveJson, state, tableView } from '../core.js';
import type { describeSchema } from '@mistriwork/engine/shared/shape.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { openHelp } from '../help.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/workbench/components/Summary.js';

export type Shape = ReturnType<typeof describeSchema>;

/* Collapsed or not, remembered — per database, because arriving at an
   unfamiliar one is the case the summary exists for. */
const OPEN_KEY = 'mistri.summary.open';
const isOpen = (id: string) => (loadJson(OPEN_KEY, {}) as Record<string, boolean>)[id] !== false;
const setOpen = (id: string, open: boolean) => saveJson(OPEN_KEY, { ...(loadJson(OPEN_KEY, {}) as object), [id]: open });

/** Names shown before a list becomes "and n more". */
const NAMED = 5;

function Link({ table }: { table: TableMeta }) {
  return (
    <button
      type="button"
      className="shape-link"
      title={say('common.columns2', { count: table.columns.length })}
      onClick={() => go(tableView(table.id), 'reset')}
    >
      {table.name}
    </button>
  );
}

/** A list of tables, capped: past a handful the names stop carrying the shape. */
function TableList({ tables }: { tables: TableMeta[] }) {
  const shown = tables.slice(0, NAMED);
  const rest = tables.length - shown.length;
  return (
    <>
      {shown.map((t, i) => (
        <Fragment key={t.id}>
          {i ? (i === shown.length - 1 && !rest ? ' and ' : ', ') : null}
          <Link table={t} />
        </Fragment>
      ))}
      {rest ? say('andMore', { rest: formatNumber(rest) }) : null}
    </>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="shape-line">
      <span className="shape-label">{label}</span>
      <span className="shape-says">{children}</span>
    </li>
  );
}

/**
 * Where to start, in this database rather than in general: hubs first —
 * what the domain is built around — then the tables that record what
 * happened, then simply the biggest. Four, not six: a fifth chip buys a
 * row that gets clipped rather than read.
 */
function startingPoints(shape: Shape): Array<{ table: TableMeta; why: string }> {
  const seen = new Set<string>();
  const picks: Array<{ table: TableMeta; why: string }> = [];
  const add = (table: TableMeta | undefined, why: string) => {
    if (!table || seen.has(table.id) || picks.length >= 4) return;
    seen.add(table.id);
    picks.push({ table, why });
  };
  for (const hub of shape.hubs) add(hub.table as TableMeta, `${say('tablesPoint', { count: hub.incoming })} at it`);
  for (const leaf of shape.leaves) add(leaf as TableMeta, 'records events');
  const tables = ((state as { schema?: { tables?: TableMeta[] } }).schema?.tables ?? []) as Array<TableMeta & { approxRows?: number }>;
  for (const table of [...tables]
    .filter((t) => !t.isView && typeof t.approxRows === 'number')
    .sort((a, b) => (b.approxRows ?? 0) - (a.approxRows ?? 0))) {
    add(table, 'the largest table here');
  }
  return picks;
}

function StartingPoints({ shape }: { shape: Shape }) {
  const picks = startingPoints(shape);
  if (!picks.length) return null;
  return (
    <section className="landing-starts">
      <div className="landing-starts-head">
        <h2 className="shape-label">{say('startHere')}</h2>
        <button type="button" className="ghost help-more" onClick={() => openHelp()}>
          {say('queryLanguageParenQuestion')}
        </button>
      </div>
      <div className="landing-chips">
        {picks.map(({ table, why }) => {
          const rows = (table as TableMeta & { approxRows?: number }).approxRows;
          return (
            <button
              key={table.id}
              type="button"
              className="landing-chip start-chip"
              title={say('open', { id: table.id })}
              onClick={() => go(tableView(table.id), 'reset')}
            >
              <span className="landing-chip-name">{table.name}</span>
              <span className="landing-chip-table">
                {typeof rows === 'number' ? <span className="start-rows">{say('common.rows2', { count: rows })}</span> : null}
                <span>{why}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Whether there is anything to say: the crossing asks before mounting. */
export function summaryLines(shape: Shape): number {
  return [shape.hubs.length, shape.leaves.length, shape.joins.length, shape.chain.length > 2, shape.islands.length].filter(Boolean).length;
}

/**
 * The card itself is the `section.shape`: the landing addresses its cards
 * as direct children of its grid, and the collapsed state is the card's
 * own class.
 */
export function SchemaSummary({ shape, label, id }: { shape: Shape; label: string; id: string }) {
  const { counts } = shape;
  const [open, setOpenState] = useState(() => isOpen(id));
  const toggle = () => {
    setOpenState(!open);
    setOpen(id, !open);
  };
  const start = shape.start as TableMeta | null | undefined;
  return (
    <section className={open ? 'shape' : 'shape shape-closed'}>
      <div className="shape-head">
        <button type="button" className="shape-toggle" aria-expanded={open} title={say('showOrHideTheSummary')} onClick={toggle}>
          {label}
        </button>
        {/* How many tables is a size, and a view is a different kind of thing; a count of foreign keys is neither. */}
        <span className="shape-counts">
          {say('common.tables', { count: counts.tables }) + (counts.views ? `, ${say('views', { count: counts.views })}` : '')}
        </span>
        {/* The one line that survives collapsing. */}
        {shape.hubs.length ? <span className="shape-gist">{say('centres', { name: (shape.hubs[0].table as TableMeta).name })}</span> : null}
        {start ? (
          <button
            type="button"
            className="ghost shape-start"
            title={say('theTableThatConnects')}
            onClick={() => go(tableView(start.id), 'reset')}
          >
            {say('start', { name: start.name })}
          </button>
        ) : null}
      </div>
      <div className="shape-body">
        <ul className="shape-lines">
          {shape.hubs.length ? (
            /* First, because it is the answer to "what is this database about". */
            <Line label={say('centresOnLabel')}>
              <Link table={shape.hubs[0].table as TableMeta} />
              {say('referencedByOtherTables', { incoming: shape.hubs[0].incoming })}
              {shape.hubs.length > 1 ? (
                <>
                  {'. Then '}
                  <TableList tables={shape.hubs.slice(1).map((h) => h.table as TableMeta)} />
                </>
              ) : null}
            </Line>
          ) : null}
          {shape.leaves.length ? (
            <Line label={say('recordsEvents')}>
              <TableList tables={shape.leaves as TableMeta[]} />
            </Line>
          ) : null}
          {shape.joins.length ? (
            <Line label={say('connectedThrough')}>
              <TableList tables={shape.joins.map((j) => j.table as TableMeta)} />
              {shape.joins.length === 1 ? say('aJoinTable') : say('whichAreJoinTables')}
            </Line>
          ) : null}
          {shape.chain.length > 2 ? (
            <Line label={say('deepestWalk')}>
              {(shape.chain as TableMeta[]).map((t, i) => (
                <Fragment key={t.id}>
                  {i ? <span className="shape-arrow"> → </span> : null}
                  <Link table={t} />
                </Fragment>
              ))}
            </Line>
          ) : null}
          {shape.islands.length ? (
            /* A table connected to nothing is either configuration or something whose relationships were never declared. */
            <Line label={say('standingAlone')}>
              <TableList tables={shape.islands as TableMeta[]} />
              {shape.islands.length === 1 ? say('noForeignKeys') : say('noForeignKeysAtAll')}
            </Line>
          ) : null}
        </ul>
        <StartingPoints shape={shape} />
      </div>
    </section>
  );
}
