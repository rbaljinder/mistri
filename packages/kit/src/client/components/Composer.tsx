/**
 * The view composer: one row per base table, with any field from any table
 * it points at, summaries of the many side, a filter in the query language
 * over paths, and the result previewed as it is built. The draft, the
 * preview fetch, storage and the URL are `composer.js`'s — a store this
 * reads through `useComposer` and drives through its actions. This is the
 * drawing.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { motionStill } from '../motionStill.js';
import { findTable, hopsFrom, refsTo, state, tableAtPrefix } from '../core.js';
import {
  MAX_DEPTH,
  aggregateLabel,
  composerActions as act,
  composerState,
  composerVersion,
  phraseMany,
  phraseOne,
  plural,
  sameAggregate,
  shortAggregate,
  subscribeComposer,
} from '../composer.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Dropdown } from './Dropdown.js';
import { canUseDatabaseTools } from '../connectionScope.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/workbench/components/Composer.js';

interface Hop {
  name: string;
  target: string;
  optional?: boolean;
  fk: { name: string };
}
interface Fk {
  name: string;
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
}
interface Column {
  path: string;
  alias?: string;
}
interface Aggregate {
  fn: string;
  via: string;
  on?: string;
  column?: string;
  alias?: string;
}
interface Draft {
  id: string;
  name: string;
  base: string;
  columns: Column[];
  aggregates?: Aggregate[];
  query: string;
  orderBy?: Array<{ path: string; direction: string }>;
  limit: number;
  source?: string;
}
interface SavedView {
  id: string;
  name: string;
  base: string;
  columns?: unknown[];
  aggregates?: unknown[];
  source?: string;
  error?: string;
}
interface Resolved {
  name: string;
  path: string;
  type?: string;
  table: string;
  column: string;
  hops?: number;
  aggregate?: string;
}
interface Preview {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  resolved: Resolved[];
  total?: number;
  ms: number;
  joins?: unknown[];
  joinCount?: number;
  more?: boolean;
  text?: string;
  explain?: string;
}
interface ComposerSnapshot {
  draft: Draft;
  opened: Set<string>;
  justAdded: string | null;
  fromConfig: SavedView[];
  savedViews: SavedView[];
  pinned: string[];
  preview: Preview | null;
  previewError: Array<{ message: string }> | null;
  showSql: boolean;
  showText: boolean;
  textEdit: string | null;
  running: boolean;
}
type Completion = { value: string; label: string; detail: string; kind: string; partial?: boolean };

function useComposer(): ComposerSnapshot {
  useSyncExternalStore(
    subscribeComposer as (fn: () => void) => () => void,
    composerVersion as () => number,
    composerVersion as () => number,
  );
  return composerState() as ComposerSnapshot;
}

const tableAt = (base: string, prefix: string) => tableAtPrefix(base, prefix) as TableMeta | null | undefined;
const hopsOut = (id: string) => hopsFrom(id) as Hop[];
const shortTable = (id: string) => (findTable(id) as TableMeta | undefined)?.name ?? id;
const andList = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function Composer() {
  const s = useComposer();
  return (
    <>
      <TopBar s={s} />
      <div className="composer-body">
        {/* Saved views above the relationship list: what you have is shorter than what you could add. */}
        <aside className="composer-side">
          <StartPanel s={s} />
          <SavedPanel s={s} />
          <RelatedPanel s={s} />
        </aside>
        <div className="composer-main">
          <FieldsPanel s={s} />
          <FilterPanel s={s} />
          <SummaryLine s={s} />
          {s.showText ? <TextPanel s={s} /> : null}
          {s.showSql && canUseDatabaseTools() ? (
            <pre className="explain composer-explain">
              {s.preview?.explain ?? (s.previewError ? say('theViewDoesNotCompile') : say('pickAFieldToSee'))}
            </pre>
          ) : null}
          <div className="composer-preview" id="composer-preview">
            <PreviewBody s={s} />
          </div>
        </div>
      </div>
    </>
  );
}

function TopBar({ s }: { s: ComposerSnapshot }) {
  return (
    <header className="composer-bar">
      <span className="composer-eyebrow">{say('viewEyebrow')}</span>
      <input
        className="composer-name"
        type="text"
        value={s.draft.name}
        placeholder={say('untitledView')}
        aria-label={say('viewName')}
        onChange={(e) => act.setName(e.currentTarget.value)}
      />
      <span className="composer-on">{say('from', { base: s.draft.base })}</span>
      <div className="composer-bar-actions">
        {/* Text first, then SQL: one is the view in the language you can edit, the other what it compiles to. */}
        <button
          type="button"
          className="ghost"
          aria-pressed={s.showText}
          title={say('theViewWrittenDown')}
          onClick={() => act.toggleText()}
        >
          {say('text')}
        </button>
        {canUseDatabaseTools() && (
          <button
            type="button"
            className="ghost"
            aria-pressed={s.showSql}
            title={say('theStatementThisCompiles')}
            onClick={() => act.toggleSql()}
          >
            SQL
          </button>
        )}
        <button type="button" className="ghost" onClick={() => void act.saveAs()}>
          {say('saveAs')}
        </button>
        <button type="button" onClick={() => void act.saveDraft()}>
          {say('common.save')}
        </button>
        <button
          type="button"
          className="ghost composer-close"
          aria-label={say('closeTheComposer')}
          title={say('closeParenEsc')}
          onClick={() => act.leave()}
        >
          ×
        </button>
      </div>
    </header>
  );
}

function StartPanel({ s }: { s: ComposerSnapshot }) {
  const tables = (state as { schema: { tables: Array<TableMeta & { approxRows?: number }> } }).schema.tables;
  return (
    <section className="panel composer-panel">
      <h3>{say('startFrom')}</h3>
      <div className="composer-pad">
        <Dropdown
          ariaLabel={say('baseTable')}
          value={s.draft.base}
          onChange={(id) => act.setBase(id)}
          items={tables.map((t) => ({
            value: t.id,
            label: t.id,
            detail: `${say('columns', { count: t.columns.length })}${t.approxRows != null ? ` · ${say('rows', { count: t.approxRows })}` : ''}`,
            badge: t.isView ? 'view' : undefined,
          }))}
        />
      </div>
    </section>
  );
}

function SavedPanel({ s }: { s: ComposerSnapshot }) {
  const all = [...s.savedViews, ...s.fromConfig];
  /* Pinned first, and stably. */
  const ordered = [...all].sort((a, b) => Number(s.pinned.includes(b.id)) - Number(s.pinned.includes(a.id)));
  return (
    <section className="panel composer-panel">
      <h3>{say('savedViews')}</h3>
      {!all.length ? (
        <p className="note">{say('nothingSavedYetBuild')}</p>
      ) : (
        <ul className="composer-saved">
          {ordered.map((view) => {
            const pinned = s.pinned.includes(view.id);
            return (
              <li key={view.id} className={`composer-saved-item${view.id === s.draft.id ? ' active' : ''}`}>
                <button
                  type="button"
                  className={`composer-pin${pinned ? ' on' : ''}`}
                  aria-pressed={pinned}
                  title={pinned ? say('unpin', { name: view.name }) : say('pinToTheTop', { name: view.name })}
                  aria-label={pinned ? say('unpinName', { name: view.name }) : say('pin', { name: view.name })}
                  onClick={() => act.togglePin(view.id)}
                >
                  {pinned ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  className="composer-saved-open"
                  disabled={Boolean(view.error)}
                  title={
                    view.error
                      ? view.error
                      : `${view.base} · ${say('countFields', { count: (view.columns ?? []).length })}${(view.aggregates ?? []).length ? ` · ${say('countSummaries', { count: view.aggregates!.length })}` : ''}`
                  }
                  onClick={() => act.openSaved(view)}
                >
                  <span className="composer-saved-name">{view.name}</span>
                  <span className="composer-saved-base">{view.base}</span>
                </button>
                {view.source === 'config' ? (
                  <span className="composer-saved-tag" title={say('definedInTablewalkJson')}>
                    {say('config')}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="view-remove"
                    title={say('removeQuotedNameQuoted', { name: view.name })}
                    aria-label={say('remove', { name: view.name })}
                    onClick={() => void act.removeSaved(view)}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The forward hops out of a table, grouped per target, recursing into the ones that are open. */
function Outgoing({ s, tableId, prefix, depth }: { s: ComposerSnapshot; tableId: string; prefix: string; depth: number }) {
  const table = findTable(tableId) as TableMeta | undefined;
  if (!table) return null;
  const groups = new Map<string, Hop[]>();
  for (const hop of hopsOut(tableId)) groups.set(hop.target, [...(groups.get(hop.target) ?? []), hop]);
  const pathOf = (hop: Hop) => (prefix ? `${prefix}.${hop.name}` : hop.name);
  return (
    <>
      {[...groups.entries()].map(([targetId, hops]) => {
        const target = findTable(targetId) as (TableMeta & { approxRows?: number }) | undefined;
        const rows = target && target.approxRows != null ? ` · ${say('rows', { count: target.approxRows })}` : '';
        if (hops.length === 1) {
          return (
            <HopRow
              key={targetId}
              s={s}
              table={table}
              hop={hops[0]}
              prefix={prefix}
              depth={depth}
              phrase={phraseOne(table, hops[0]) as string}
              detail={say('viaNameRows', { name: hops[0].name, rows })}
              sub={s.opened.has(pathOf(hops[0])) ? <Outgoing s={s} tableId={targetId} prefix={pathOf(hops[0])} depth={depth + 1} /> : null}
            />
          );
        }
        /* The header states the relationship once; each way is a row under it. */
        const anyOptional = hops.some((h) => h.optional);
        const self = targetId === table.id;
        return (
          <li key={targetId} className="composer-rel-group-wrap" style={{ display: 'contents' }}>
            <li className="composer-rel-group" style={depth ? { paddingLeft: `${10 + depth * 14}px` } : undefined}>
              <span className="composer-phrase">
                {say('eachRelation', {
                  table: table.name,
                  verb: anyOptional ? say('mayHaveOne') : say('hasOne'),
                  related: self ? say('relatedPrefix') : '',
                  target: target ? target.name : targetId,
                })}
              </span>
              <span className="composer-ways">{say('hopWays', { count: hops.length, rows })}</span>
            </li>
            {hops.map((hop) => (
              <HopRow
                key={hop.name}
                s={s}
                table={table}
                hop={hop}
                prefix={prefix}
                depth={depth}
                detail={`${say('viaHop', { hop: hop.name })}${hop.optional ? say('mayBeEmpty') : ''}`}
                inGroup
                sub={s.opened.has(pathOf(hop)) ? <Outgoing s={s} tableId={targetId} prefix={pathOf(hop)} depth={depth + 1} /> : null}
              />
            ))}
          </li>
        );
      })}
    </>
  );
}

function HopRow({
  s,
  hop,
  prefix,
  depth,
  phrase,
  detail,
  inGroup,
  sub,
}: {
  s: ComposerSnapshot;
  table: TableMeta;
  hop: Hop;
  prefix: string;
  depth: number;
  phrase?: string;
  detail: string;
  inGroup?: boolean;
  sub: React.ReactNode;
}) {
  const path = prefix ? `${prefix}.${hop.name}` : hop.name;
  const isOpen = s.opened.has(path);
  const tooDeep = depth >= (MAX_DEPTH as number);
  const indent = 10 + depth * 14 + (inGroup ? 12 : 0);
  return (
    <>
      <li
        className={`composer-rel-item${isOpen ? ' open' : ''}${inGroup ? ' in-group' : ''}`}
        style={indent === 10 ? undefined : { paddingLeft: `${indent}px` }}
      >
        {phrase ? <span className="composer-phrase">{phrase}</span> : null}
        <span className="composer-via">{detail}</span>
        {tooDeep && !isOpen ? (
          <span className="composer-cap" title={say('aPathMayFollow', { max: MAX_DEPTH })}>
            {say('tooDeep')}
          </span>
        ) : (
          <button
            type="button"
            className={`composer-add${isOpen ? ' on' : ''}`}
            aria-pressed={isOpen}
            title={isOpen ? say('removeAndEveryField', { path }) : say('addItsFieldsJoin', { path })}
            onClick={() => (isOpen ? act.removeJoin(path) : act.addJoin(path))}
          >
            {isOpen ? say('common.added') : say('common.add')}
          </button>
        )}
      </li>
      {sub}
    </>
  );
}

function RelatedPanel({ s }: { s: ComposerSnapshot }) {
  const base = findTable(s.draft.base) as TableMeta | undefined;
  const incoming = refsTo(s.draft.base) as Fk[];
  const aggregates = s.draft.aggregates ?? [];
  return (
    <section className="panel composer-panel composer-related">
      <h3>{say('relatedTables')}</h3>
      <ul className="composer-rel">
        <Outgoing s={s} tableId={s.draft.base} prefix="" depth={0} />
        {/* The other direction, and the honest treatment of it: joining the many side would repeat rows, so it is counted or summarised instead. */}
        {incoming.length && base ? <li className="composer-rel-head">{say('pointingBack')}</li> : null}
        {base
          ? incoming.map((fk) => {
              const child = findTable(fk.from.table) as TableMeta | undefined;
              if (!child) return null;
              const countSpec = { fn: 'count', via: `${fk.from.table}.${fk.from.columns.join('+')}` };
              const counted = aggregates.some((a) => sameAggregate(a, countSpec, s.draft.base));
              return (
                <li key={fk.name} className="composer-rel-item many">
                  <span className="composer-phrase">{phraseMany(base, fk) as string}</span>
                  <span className="composer-via">
                    {say('viaJoiningItWould', { columns: fk.from.columns.join(', '), base: base.name, child: child.name })}
                  </span>
                  <span className="composer-many-actions">
                    <button
                      type="button"
                      className={`composer-add${counted ? ' on' : ''}`}
                      aria-pressed={counted}
                      title={
                        counted
                          ? say('removeTheCount', { name: child.name })
                          : say('addAColumnCounting', { name: base.name, names: plural(child.name) })
                      }
                      onClick={() => (counted ? act.removeAggregate(countSpec) : act.addAggregate(countSpec))}
                    >
                      {counted ? say('counted') : say('addCount')}
                    </button>
                    <SummariseMenu fk={fk} child={child} />
                    <button
                      type="button"
                      className="composer-add"
                      title={say('startAViewFromShowing', { child: child.name, base: base.name })}
                      onClick={() => act.startFromChild(fk)}
                    >
                      {say('startHere')}
                    </button>
                  </span>
                </li>
              );
            })
          : null}
      </ul>
    </section>
  );
}

function summaryLabel(fn: string, column: string, isDate: boolean) {
  switch (fn) {
    case 'sum':
      return say('total', { column });
    case 'avg':
      return say('average', { column });
    case 'min':
      return isDate ? say('earliest', { column }) : say('smallest', { column });
    case 'max':
      return isDate ? say('latest', { column }) : say('largest', { column });
    default:
      return `${fn} ${column}`;
  }
}

function SummariseMenu({ fk, child }: { fk: Fk; child: TableMeta }) {
  const items = [{ value: '', label: say('summarise'), detail: say('aTotalAnAverage') }];
  for (const column of child.columns) {
    if (column.primaryKey || column.references) continue;
    const type = column.type.toLowerCase();
    const numeric = /int|numeric|decimal|real|double|float|money|serial/.test(type);
    const dateish = /date|time/.test(type);
    if (!numeric && !dateish) continue;
    /* A flag is numeric in SQLite and averaging it is meaningless. */
    if (numeric && /^(is|has|can|should)_|^(active|enabled|urgent|billable)/.test(column.name)) continue;
    for (const fn of numeric ? ['sum', 'avg', 'min', 'max'] : ['min', 'max']) {
      items.push({ value: `${fn}:${column.name}`, label: summaryLabel(fn, column.name, dateish), detail: `${fn}(${column.name})` });
    }
  }
  if (items.length === 1) return null;
  return (
    <span className="composer-menu">
      <Dropdown
        items={items}
        value=""
        ariaLabel={say('summariseName', { name: child.name })}
        onChange={(value) => {
          if (!value) return;
          const [fn, column] = value.split(':');
          act.addAggregate({ fn, via: `${fk.from.table}.${fk.from.columns.join('+')}`, column });
        }}
      />
    </span>
  );
}

function FieldsPanel({ s }: { s: ComposerSnapshot }) {
  const { draft, opened, justAdded } = s;
  const groups: Array<{ prefix: string; tableId: string }> = [{ prefix: '', tableId: draft.base }];
  for (const prefix of [...opened].sort()) {
    const table = tableAt(draft.base, prefix);
    if (table) groups.push({ prefix, tableId: table.id });
  }
  const isSelected = (path: string) => draft.columns.some((c) => c.path === path);
  const aggregates = draft.aggregates ?? [];
  const fresh = useRef<HTMLDivElement>(null);
  /* Bring a freshly added table's fields into sight, once. */
  useEffect(() => {
    if (!justAdded) return;
    fresh.current?.scrollIntoView?.({ block: 'nearest', behavior: motionStill() ? 'auto' : 'smooth' });
    act.consumeJustAdded();
  }, [justAdded]);
  return (
    <section className="panel composer-panel composer-fields">
      <h3>
        {say('fieldsHeading')}
        <span className="composer-count">{say('shown', { columnsCount: draft.columns.length })}</span>
      </h3>
      {groups.length === 1 ? (
        <p className="composer-empty">
          <strong>{say('aViewIsOne', { name: (findTable(draft.base) as TableMeta | undefined)?.name ?? draft.base })}</strong>
          {say('withAnyFieldFromAny')}
        </p>
      ) : null}
      {groups.map((group) => {
        const table = findTable(group.tableId) as TableMeta | undefined;
        if (!table) return null;
        const isFresh = Boolean(group.prefix) && group.prefix === justAdded;
        return (
          <div
            key={group.prefix || '·'}
            ref={isFresh ? fresh : undefined}
            className={`composer-group${isFresh ? ' fresh' : ''}`}
            data-prefix={group.prefix || undefined}
          >
            <div className="composer-group-head">
              <span className="composer-group-name">{table.name}</span>
              <span className="composer-group-path">
                {group.prefix ? say('viaPrefix', { prefix: group.prefix }) : say('baseTableGroup')}
              </span>
              {isFresh ? <span className="composer-group-new">{say('justAdded')}</span> : null}
            </div>
            <div className="composer-checks">
              {table.columns.map((column: ColumnMeta) => {
                const path = group.prefix ? `${group.prefix}.${column.name}` : column.name;
                if (path.split('.').length > (MAX_DEPTH as number) + 1) return null;
                const on = isSelected(path);
                return (
                  <label key={path} className={`composer-check${on ? ' on' : ''}`} title={path}>
                    <input type="checkbox" checked={on} onChange={() => act.toggleField(path)} />
                    <span className="composer-field-name">{column.name}</span>
                    <span className="composer-field-type">{column.type.toLowerCase()}</span>
                    {column.primaryKey ? <span className="composer-mark pk">{say('common.key')}</span> : null}
                    {column.references ? (
                      <span className="composer-mark fk" title={`→ ${column.references.table}`}>
                        →
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {aggregates.length ? (
        /* Summaries live in the checklist rather than only where they were added, so unticking one is the same gesture as any other field. */
        <div className="composer-group">
          <div className="composer-group-head">
            <span className="composer-group-name">{say('summaries')}</span>
            <span className="composer-group-path">{say('oneValuePerRow')}</span>
          </div>
          <div className="composer-checks">
            {aggregates.map((spec, i) => (
              <label key={i} className="composer-check on" title={aggregateLabel(spec) as string}>
                <input type="checkbox" checked onChange={() => act.removeAggregate(spec)} />
                <span className="composer-field-name">{shortAggregate(spec) as string}</span>
                <span className="composer-field-type">{spec.fn}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The filter box with its path-aware completions: after `customer_id.` the
 * useful suggestion is the next table's columns, which needs the key graph
 * walked. Same keyboard contract as the query bar's completer.
 */
function FilterPanel({ s }: { s: ComposerSnapshot }) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Completion[]>([]);
  const [index, setIndex] = useState(-1);
  const [openList, setOpenList] = useState(false);
  const shut = () => {
    setOpenList(false);
    setItems([]);
    setIndex(-1);
  };
  const show = () => {
    const node = input.current!;
    const caret = node.selectionStart ?? node.value.length;
    const next = (act.completionsFor(node.value, caret) as Completion[]).slice(0, 40);
    if (!next.length) {
      shut();
      return;
    }
    setItems(next);
    setIndex(-1);
    setOpenList(true);
  };
  const accept = (item: Completion) => {
    const node = input.current!;
    const caret = node.selectionStart ?? node.value.length;
    const before = node.value.slice(0, caret);
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf(',')) + 1;
    const after = node.value.slice(caret);
    /* A hop keeps the caret against the dot; a finished token gets a space. */
    const insert = item.partial ? item.value : item.value + (after.startsWith(' ') ? '' : ' ');
    const value = node.value.slice(0, start) + insert + after;
    act.setQuery(value);
    const at = start + insert.length;
    requestAnimationFrame(() => {
      node.setSelectionRange(at, at);
      show();
    });
    shut();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!openList) {
      if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const step = (n: number) => setIndex(((n % items.length) + items.length) % items.length);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(index + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(index - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      shut();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      accept(items[index >= 0 ? index : 0]);
    } else if (e.key === 'Enter') {
      if (index >= 0) {
        e.preventDefault();
        accept(items[index]);
      } else shut();
    }
  };
  return (
    <section className="composer-filter">
      <div className="composer-filter-row">
        <span className="composer-filter-label">{say('where')}</span>
        <span className="composer-query-wrap">
          <input
            ref={input}
            className="composer-query"
            type="text"
            spellCheck={false}
            value={s.draft.query}
            aria-label={say('common.filter')}
            placeholder="customer_id.country_code.name = Australia and total > 500"
            onChange={(e) => {
              act.setQuery(e.currentTarget.value);
              show();
            }}
            onClick={show}
            onBlur={() => setTimeout(shut, 120)}
            onKeyDown={onKey}
          />
          <div className="ac composer-ac" hidden={!openList} role="listbox">
            {items.map((item, i) => (
              /* mousedown, not click: blur fires first on a click and would close the list before the selection landed. */
              <div
                key={item.value}
                className={`ac-item kind-${item.kind}${i === index ? ' active' : ''}`}
                role="option"
                aria-selected={i === index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                <span className="ac-label">{item.label}</span>
                <span className="ac-detail">{item.detail}</span>
              </div>
            ))}
          </div>
        </span>
        <span className="composer-filter-label">{say('common.rows')}</span>
        <input
          className="composer-limit"
          type="number"
          min={1}
          max={1000}
          defaultValue={String(s.draft.limit)}
          aria-label={say('rowLimit')}
          onChange={(e) => act.setLimit(Number(e.currentTarget.value))}
        />
      </div>
      <p className="composer-hint">{say('sameLanguageAsTheBar')}</p>
    </section>
  );
}

function SummaryLine({ s }: { s: ComposerSnapshot }) {
  const base = findTable(s.draft.base) as TableMeta | undefined;
  const name = base ? base.name : s.draft.base;
  const sources = [...s.opened].sort().map((prefix) => ({ prefix, name: tableAt(s.draft.base, prefix)?.name ?? prefix }));
  /* Two hops onto the same table are two different things. */
  const counts = new Map<string, number>();
  for (const src of sources) counts.set(src.name, (counts.get(src.name) ?? 0) + 1);
  const labels = sources.map((src) => ((counts.get(src.name) ?? 0) > 1 ? `${src.name} (${src.prefix})` : src.name));
  const rolled = (s.draft.aggregates ?? []).map((a) => aggregateLabel(a) as string);
  const parts = [say('oneRowPer', { name })];
  if (labels.length) parts.push(say('withColumns', { andList: andList(labels) }));
  if (rolled.length) parts.push(`${labels.length ? say('and') : say('with')} ${andList(rolled)}`);
  parts.push('.');
  return (
    <p className="composer-summary">
      <strong>{parts.join('')}</strong>
      {labels.length ? say('everyAppearsExactlyOnce', { name }) : null}
    </p>
  );
}

function TextPanel({ s }: { s: ComposerSnapshot }) {
  const value = s.textEdit ?? s.preview?.text ?? '';
  const same = value.trim() === (s.preview?.text ?? '').trim();
  return (
    <section className="composer-textpanel">
      <textarea
        className="composer-text"
        spellCheck={false}
        rows={Math.min(10, Math.max(3, value.split('\n').length + 1))}
        aria-label={say('theViewAsText')}
        placeholder={'invoice\n  show id, customer_id.name as customer\n  where total > 500'}
        value={value}
        onChange={(e) => act.setTextEdit(e.currentTarget.value)}
        /* Applied on demand rather than on every keystroke: a half-typed clause is an error, not a view. */
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void act.applyText(e.currentTarget.value);
          }
        }}
      />
      <div className="composer-text-actions">
        <span className="composer-hint">{say('editAndApplyOrPaste')}</span>
        <button
          type="button"
          className="ghost composer-text-apply"
          disabled={s.textEdit === null || same}
          onClick={() => void act.applyText(value)}
        >
          {say('common.apply')}
        </button>
      </div>
    </section>
  );
}

function PreviewBody({ s }: { s: ComposerSnapshot }) {
  const { draft, preview, previewError, running } = s;
  if (previewError)
    return (
      <div className="errors composer-errors" role="alert">
        {previewError.map((e, i) => (
          <p key={i}>{e.message}</p>
        ))}
      </div>
    );
  if (!draft.columns.length && !(draft.aggregates ?? []).length) return <p className="note">{say('tickAFieldToSee')}</p>;
  if (!preview) return <p className="loading">{running ? say('running') : say('building')}</p>;
  const total = preview.total ?? preview.rows.length;
  const byName = new Map(preview.resolved.map((c) => [c.name, c]));
  return (
    <>
      <div className="result-head">
        <h2 className="result-title">{draft.name || draft.base}</h2>
        <span className="stat">
          {preview.total !== undefined && preview.total > preview.rows.length
            ? say('rowsOfTotal', { shown: formatNumber(preview.rows.length), total: say('rows', { count: preview.total }) })
            : say('rows', { count: total })}
        </span>
        <span className="stat">{say('msMs', { ms: preview.ms })}</span>
        <span className="stat">{say('joins', { count: preview.joinCount ?? preview.joins?.length ?? 0 })}</span>
        {running ? <span className="stat">…</span> : null}
      </div>
      <div className="table-wrap">
        {!preview.rows.length ? (
          <p className="note">{say('noRowsMatch')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                {preview.columns.map((name) => {
                  const meta = byName.get(name);
                  const sorted = (draft.orderBy ?? []).find((o) => o.path === (meta ? meta.path : name));
                  const summary = meta?.aggregate;
                  const shown =
                    meta && meta.name !== meta.path
                      ? meta.name
                      : summary
                        ? meta!.column === '*'
                          ? ''
                          : meta!.column
                        : meta
                          ? meta.column
                          : name;
                  return (
                    <th
                      key={name}
                      title={
                        summary
                          ? say('overOneValuePer', { aggregate: meta!.aggregate ?? '', shortTable: shortTable(meta!.table) })
                          : meta
                            ? `${meta.path} · ${meta.type}`
                            : name
                      }
                      className={`${sorted ? `sorted-${sorted.direction}` : ''}${summary ? ' is-summary' : ''}`.trim() || undefined}
                      /* A summary is a subquery; sorting by one would need it repeated in ORDER BY. Left unsortable rather than sortable-but-broken. */
                      onClick={summary ? undefined : () => act.sortByPath(meta ? meta.path : name)}
                    >
                      {/* The table qualifier, then the column: thirty fields from five tables is unreadable if every header is just "name". */}
                      {meta && (meta.hops || summary) ? (
                        <span className="composer-th-table">{`${summary ? `${meta.aggregate} ` : ''}${shortTable(meta.table)} `}</span>
                      ) : null}
                      {shown}
                      {sorted ? <span className="composer-th-sort">{sorted.direction === 'desc' ? ' ↓' : ' ↑'}</span> : null}
                      <button
                        className="composer-th-rename"
                        type="button"
                        title={say('renameThisColumn')}
                        aria-label={say('rename', { name })}
                        onClick={(e) => {
                          e.stopPropagation();
                          void act.renameColumn(meta, name);
                        }}
                      >
                        ✎
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i}>
                  {preview.columns.map((name) => {
                    const value = row[name];
                    return value === null || value === undefined ? (
                      <td key={name} className="null">
                        null
                      </td>
                    ) : (
                      <td key={name} className="mono" title={String(value).length > 40 ? String(value) : undefined}>
                        {String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview.rows.length && preview.more ? <p className="note">{say('moreRowsMatchThan')}</p> : null}
      </div>
    </>
  );
}
