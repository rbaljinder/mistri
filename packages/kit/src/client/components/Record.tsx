/**
 * The record view: one row, its fields, and everything that points at it.
 *
 * The row and the reverse-reference counts are two Queries asked together,
 * because they are independent and waiting for the second to show the
 * first would make every record open feel slower than it is. The row runs
 * as a one-row view rather than a plain query: that is what lets a field
 * section hold `customer_id.name`, and it means a record and a list are the
 * same machinery pointed at different questions.
 *
 * The children are tables under the record, one per incoming relationship
 * the layout lists, behind a rail of tabs beside the fields — a menu one
 * row high rather than four tables stacked under the thing you came to
 * read. Empty relationships stay as disabled tabs: "nothing points here
 * through this" is a real answer.
 *
 * The leaves — a value in its dress, a reference chip, an editable field,
 * the pending-changes bar, the Delete and Layout buttons — are still the
 * vanilla client's and are drawn into place; they move when the page view
 * does, since the two share them.
 */
import { tabMatches } from '@mistriwork/engine/shared/addressParams.js';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motionStill } from '../motionStill.js';
import { readRecordSource, shareRecordSource } from '../recordSource.js';
import { equalityFilter, pathEqualityFilter, recordKey } from '../resourceRequests.js';
import {
  api,
  beginNavigation,
  emptyWord,
  findTable,
  go,
  keyOf,
  labelPath,
  loadJson,
  openRecord,
  pageView,
  prefersPages,
  primaryKey,
  quote,
  refsTo,
  rowLabel,
  saveJson,
  setExplain,
  state,
  tableView,
  toast,
} from '../core.js';
import { formatNumber } from '../locale.js';
import { copyPosition, positionOf } from '../handoff.js';
import { pagesFor } from '../page.js';
import { canEditRow, whyNotEditable } from '../write.js';
import { activeDraft, fieldPathsOf, hasSavedTemplate, listSectionsOf, openTemplateBuilder, savedTemplate } from '../template.js';
import { EditLayoutButton } from './EditLayoutButton.js';
import { DEFAULT_LIST_LIMIT } from '@mistriwork/engine/shared/recordview.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { ResourceHttpSuccess } from '@mistriwork/engine/shared/resourceHttp.js';
import { Editable, PendingBar } from './Editable.js';
import { DeleteButton } from './DeleteButton.js';
import { RefJump, Value } from './Value.js';
import { Delayed, RecordSkeleton, RelatedSkeleton } from './Skeleton.js';
import { Grid, type GridData, type Row } from './Grid.js';
import { useWalk } from './walk.js';
import { FOCUS_ALWAYS } from './mount.js';
import { RecordTrailNav } from './RecordTrailNav.js';
import { say } from '../copy/record/components/Record.js';

export interface RowEntry {
  kind: 'row';
  table: string;
  key: Record<string, unknown>;
  label?: string;
  tab?: string;
}

interface FieldSection {
  kind: 'fields';
  title?: string;
  paths: string[];
  off?: boolean;
}
interface ListSection {
  kind: 'list';
  title?: string;
  via: string;
  columns?: string[];
  limit?: number;
  off?: boolean;
}
export interface Template {
  sections: Array<FieldSection | ListSection>;
}

interface Fk {
  name: string;
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
}
type Resolved = ResourceHttpSuccess<'/api/view/run'>['resolved'][number];
/** `count` is absent for a source that reports no totals (an API). */
interface Refs {
  references?: Array<{ constraint: string; count?: number; capped?: boolean }>;
}

interface RecordProps {
  entry: RowEntry;
  table: TableMeta;
  template: Template;
  /** The row's readable name arrived: the crumb and the address want it. */
  onLabel: (label: string) => void;
  /** The reader picked a relationship: the address wants it. */
  onChooseTab: (fkName: string) => void;
}

/** Which relationship was last looked at, per table, for the session. */
const lastTab = new Map<string, string>();

/** Whether empty relationships are folded away, per connection. */
const EMPTIES_KEY = 'mistri.related.hideEmpty';
const connection = () => (state as { activeConnection?: string }).activeConnection ?? '';
const hidingEmpty = () => Boolean((loadJson(EMPTIES_KEY, {}) as Record<string, boolean>)[connection()]);
function setHidingEmpty(on: boolean) {
  const all = loadJson(EMPTIES_KEY, {}) as Record<string, boolean>;
  all[connection()] = on;
  saveJson(EMPTIES_KEY, all);
}

/** This record's page, with this record already chosen as its root. */
async function openAsPage(entry: RowEntry): Promise<void> {
  const isCurrent = beginNavigation();
  let pageId = `suggested:${entry.table}`;
  try {
    const [configured] = await pagesFor(entry.table);
    if (configured && !configured.error) pageId = configured.id;
  } catch {
    // A config that cannot be read still leaves the suggested page.
  }
  if (isCurrent()) go(pageView(pageId, entry.table, entry.key, entry.label), 'push');
}

/**
 * The column metadata behind a path: the record's own column, or the
 * compiler's answer for a pulled-in one, labelled by the last segment.
 */
function columnForPath(table: TableMeta, path: string, byPath: Map<string, Resolved>): (ColumnMeta & { label?: string }) | null {
  if (!path.includes('.')) return table.columns.find((c) => c.name === path) ?? null;
  const resolved = byPath.get(path);
  if (!resolved) return null;
  return {
    name: resolved.name,
    label: path.slice(path.lastIndexOf('.') + 1),
    type: resolved.type,
    nullable: resolved.nullable,
    primaryKey: false,
  } as ColumnMeta & { label: string };
}

export function RecordView({ entry, table, template, onLabel, onChooseTab }: RecordProps) {
  /* The entry is the walk's and is corrected in place — its label arrives
     after the row — so the heading follows the walk's tick. */
  useWalk();
  const canBeReferenced = (refsTo(entry.table) as Fk[]).length > 0;
  const paths = useMemo(() => fieldPathsOf(template) as string[], [template]);
  /* The row's name is fetched whether or not the layout shows it: the label
     is a property of the row, not of the layout. */
  const namePath = labelPath(table) as string | undefined;
  const fetched = namePath && !paths.includes(namePath) ? [...paths, namePath] : paths;

  const row = useQuery({
    queryKey: ['record', entry.table, entry.key, fetched],
    // Only a post-Undo read replaces an equal cached source. Ordinary late
    // reads retain sharing, so they cannot erase a confirmed-save overlay.
    structuralSharing: shareRecordSource,
    queryFn: () =>
      readRecordSource(() =>
        api('/api/view/run', {
          count: 'none',
          view: {
            id: `record:${entry.table}`,
            name: entry.table,
            base: entry.table,
            columns: fetched.map((path) => ({ path })),
            filter: pathEqualityFilter(recordKey(entry.key)),
            limit: 1,
          },
        }),
      ),
    staleTime: 0,
    meta: FOCUS_ALWAYS,
  });
  const refs = useQuery<Refs | null>({
    queryKey: ['references', entry.table, entry.key],
    queryFn: () => api('/api/references', { table: entry.table, key: entry.key }),
    enabled: canBeReferenced,
    staleTime: 0,
  });

  const data = row.data && 'view' in row.data ? row.data : undefined;
  const record = data?.rows[0];
  useEffect(() => {
    if (!row.data) return;
    setExplain('sql' in row.data ? row.data.sql?.text : undefined);
    if (!record) return;
    /* A row reached by a link knows only its key, so its crumb reads "1002".
       Now that the row is here, the readable label is, too. */
    const readable = rowLabel(table, record);
    if (readable && readable !== entry.label) onLabel(readable);
  }, [row.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = entry.label ?? '';
  const heading = (
    <h1 className="record-heading">
      <span>
        {entry.table} · {label}
      </span>
      <RecordTrailNav entry={entry} />
      <button
        type="button"
        className="ghost record-as-page"
        title={say('everythingAboutThisRecord')}
        onClick={() => void openAsPage(entry)}
      >
        {say('asAPage')}
      </button>
      <button
        type="button"
        className="ghost"
        title={say('theRowsKeyItsShape')}
        onClick={() => void copyPosition(positionOf(state, entry, { record: { key: entry.key, label: entry.label } }), toast)}
      >
        {say('copyForAgent')}
      </button>
      <EditLayoutButton table={table} saved={savedTemplate(entry.table)} onOpen={() => openTemplateBuilder(entry.table)} />
      <DeleteButton table={table} recordKey={entry.key} label={label} />
    </h1>
  );

  const fieldSections = template.sections.filter((s): s is FieldSection => s.kind === 'fields' && !s.off);
  const related = useRelated(entry, template, refs.data ?? null, canBeReferenced && refs.isPending, onChooseTab);
  return (
    <>
      <div className="panel">
        {heading}
        {row.isPending && (
          <Delayed>
            <RecordSkeleton sections={fieldSections.map((s) => ({ title: s.title, count: s.paths.length })).slice(0, 5)} />
          </Delayed>
        )}
        {row.data && !('view' in row.data) ? (
          <p className="note">{row.data.errors[0]?.message ?? say('thatRecordCouldNotBeRead')}</p>
        ) : row.isError || (data && !record) ? (
          <p className="note">{say('thatRowIsNoLonger')}</p>
        ) : record && data ? (
          <Fields table={table} entry={entry} record={record} resolved={data.resolved} sections={fieldSections} />
        ) : null}
        {data && related.panel}
      </div>
      {related.rail}
    </>
  );
}

/* ---------- the fields ---------- */

function Fields({
  table,
  entry,
  record,
  resolved,
  sections,
}: {
  table: TableMeta;
  entry: RowEntry;
  record: Row;
  resolved: Resolved[];
  sections: FieldSection[];
}) {
  const editing = canEditRow(table, entry.key) as boolean;
  const blocked = whyNotEditable(table) as string | null;
  /* Typing must not re-render the fields — that would destroy the input
     mid-keystroke and lose the caret. The pending bar reads the staging
     store and ticks with it, so nothing here has to be told. */
  const refresh = () => {};
  const byPath = useMemo(() => new Map(resolved.map((c) => [c.path, c])), [resolved]);
  return (
    <>
      <PendingBar table={table} recordKey={entry.key} onDone={(opts) => (opts?.inPlace ? refresh() : go({ ...entry }, 'replace'))} />
      <div className="field-groups">
        {sections.map((section, i) => {
          /* A label that occurs once is left alone; one that collides is
             spelled out to the hop that distinguishes it. */
          const metas = section.paths.map((path) => ({ path, meta: columnForPath(table, path, byPath) }));
          const labels = metas.map(({ meta }) => meta?.label ?? meta?.name);
          const collides = new Set(labels.filter((l, k) => l && labels.indexOf(l) !== k));
          const rows = metas
            .filter(({ meta }) => meta)
            .map(({ path, meta }) => {
              const named = meta!.label ?? meta!.name;
              const col = collides.has(named) ? { ...meta!, label: path } : meta!;
              const value = record[byPath.get(path)?.name ?? path];
              /* Only the record's own columns are editable: `customer_id.name`
               lives on another table. */
              return (
                <FieldRow
                  key={path}
                  table={table}
                  entry={entry}
                  col={col}
                  value={value}
                  canEdit={editing && !path.includes('.')}
                  refresh={refresh}
                />
              );
            });
          if (!rows.length) return null;
          if (!section.title)
            return (
              <section key={i} className="field-group field-group-plain">
                <dl className="fields">{rows}</dl>
              </section>
            );
          return (
            <FieldGroup key={i} title={section.title} count={rows.length}>
              {rows}
            </FieldGroup>
          );
        })}
        {blocked && <p className="note">{blocked}</p>}
      </div>
    </>
  );
}

function FieldGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className={`field-group${collapsed ? ' collapsed' : ''}`}>
      <button className="field-group-head" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        <span className="field-group-caret" aria-hidden="true">
          ▾
        </span>
        <span>{title}</span>
        <span className="field-group-count">{count}</span>
      </button>
      <dl className="fields">{children}</dl>
    </section>
  );
}

/** One field: its name, its type, and whatever the value is best shown as. */
function FieldRow({
  table,
  entry,
  col,
  value,
  canEdit,
  refresh,
}: {
  table: TableMeta;
  entry: RowEntry;
  col: ColumnMeta & { label?: string };
  value: unknown;
  canEdit: boolean;
  refresh: () => void;
}) {
  const isNull = value === null || value === undefined;
  // The key identifies the row being edited and cannot be changed from under it.
  const editable$ = canEdit && !col.primaryKey && col.writable !== false;
  const row = { [col.name]: value };
  let dd: ReactNode;
  if (editable$ && prefersPages()) {
    dd = (
      <dd>
        <Editable
          app
          table={table}
          row={row}
          column={col}
          recordKey={entry.key}
          onSaved={refresh}
          display={(next, label) =>
            col.references && next !== null && next !== undefined && String(next) !== '' ? (
              <RefJump
                references={col.references}
                value={next}
                label={label}
                table={table}
                column={col.name}
                row={{ ...row, [col.name]: next }}
              />
            ) : (
              <Value col={col} value={next} tableId={table.id} compact />
            )
          }
        />
      </dd>
    );
  } else if (editable$ && (isNull || !col.references)) {
    dd = (
      <dd>
        <Editable table={table} row={row} column={col} recordKey={entry.key} onSaved={refresh} />
      </dd>
    );
  } else if (isNull) {
    dd = (
      <dd className="null" title="null">
        {emptyWord()}
      </dd>
    );
  } else if (col.references && String(value) !== '') {
    /* A foreign key is the forward walk: jump to the row it points at. */
    dd = (
      <dd>
        <RefJump references={col.references} value={value} table={table} column={col.name} row={row} />
      </dd>
    );
  } else {
    dd = (
      <dd>
        <Value col={col} value={value} tableId={table.id} row={row} />
      </dd>
    );
  }
  return (
    <div className={`field${col.references ? ' field-ref' : ''}`}>
      <dt>
        {col.label ?? col.name}
        <span className="type">{col.type.toLowerCase()}</span>
        {col.primaryKey && <span className="pk">{say('common.key')}</span>}
        {/* NOT NULL is only shown while editing: it becomes actionable the
            moment you can empty the field. */}
        {!col.nullable && editable$ && (
          <span className="req" title="NOT NULL">
            {say('required')}
          </span>
        )}
      </dt>
      {dd}
    </div>
  );
}

/* ---------- the children ---------- */

interface Relation {
  fk: Fk;
  child: TableMeta;
  section: ListSection;
  limit: number;
  columns: string[];
  values: Record<string, unknown>;
  fetched?: string[];
}

async function fetchChildren(rel: Relation, offset: number): Promise<GridData> {
  const data = await api('/api/query', {
    table: rel.child.id,
    filter: equalityFilter(rel.values),
    columns: rel.fetched,
    limit: rel.limit,
    offset,
  });
  /* Ordered by the layout, not by the query: the key is fetched and hidden,
     so the returned column list is not the chosen one. */
  return rel.columns.length ? { ...data, columns: rel.columns.filter((name) => data.columns.includes(name)) } : data;
}

function useRelations(entry: RowEntry, template: Template): Relation[] {
  return useMemo(() => {
    const out: Relation[] = [];
    for (const section of listSectionsOf(template) as ListSection[]) {
      const fk = (state.schema.foreignKeys as Fk[]).find((f) => f.name === section.via);
      if (!fk) continue;
      const child = findTable(fk.from.table) as TableMeta | undefined;
      if (!child) continue;
      /* Every column of the key has to match, which is what makes this
         correct for a composite key. */
      const values = Object.fromEntries(
        fk.to.columns.map((parentColumn, i) => [fk.from.columns[i] ?? fk.from.columns[0], entry.key[parentColumn]]),
      );
      if (Object.values(values).some((value) => value === undefined || value === null)) continue;
      const columns = (section.columns ?? []).filter((name) => child.columns.some((c) => c.name === name));
      const key = primaryKey(child) as string[];
      /* The key is fetched whether or not it is shown: it is what a row click
         navigates by. */
      const fetched = columns.length ? [...new Set([...key, ...columns])] : undefined;
      out.push({ fk, child, section, limit: section.limit ?? DEFAULT_LIST_LIMIT, columns, values, fetched });
    }
    return out;
  }, [entry.table, entry.key, template]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Page one of every relationship, asked together, so the rail can be ranked and lit. */
function useFirstPages(entry: RowEntry, relations: Relation[]) {
  return useQuery({
    queryKey: ['record-children', entry.table, entry.key, relations.map((r) => r.fk.name)],
    queryFn: async () => {
      const results = await Promise.allSettled(relations.map((rel) => fetchChildren(rel, 0)));
      return relations
        .map((rel, i) => ({ rel, data: results[i].status === 'fulfilled' ? results[i].value : null }))
        .filter((r): r is { rel: Relation; data: GridData } => Boolean(r.data));
    },
    enabled: relations.length > 0,
    staleTime: 0,
  });
}

/**
 * The children: the panel of the chosen relationship, drawn under the
 * fields, and the rail of all of them, drawn beside — two places, one
 * state, so this is a hook that hands both back.
 */
function useRelated(
  entry: RowEntry,
  template: Template,
  counts: Refs | null,
  countsPending: boolean,
  onChooseTab: (fk: string) => void,
): { panel: ReactNode; rail: ReactNode } {
  const relations = useRelations(entry, template);
  const canBeReferenced = (refsTo(entry.table) as Fk[]).length > 0;
  const first = useFirstPages(entry, relations);
  // Counted references only: one from a source that reports no totals (an API) weighs by the rows read.
  const countOf = useMemo(
    () =>
      new Map((counts?.references ?? []).flatMap((r): Array<[string, number]> => (r.count === undefined ? [] : [[r.constraint, r.count]]))),
    [counts],
  );
  /* A count that stopped at its bound (10,000): the rail says "10,000+", and
     the panel pages by whether a full page came back, as it does unasked. */
  const cappedRefs = useMemo(() => new Set((counts?.references ?? []).filter((r) => r.capped).map((r) => r.constraint)), [counts]);
  const [chosen, setChosen] = useState<string | undefined>(entry.tab ?? lastTab.get(entry.table));
  const [pages, setPages] = useState<Map<string, number>>(new Map());
  const [hideEmpty, setHideEmpty] = useState(hidingEmpty);
  const [scrollTo, setScrollTo] = useState(false);

  if (!canBeReferenced) return { panel: null, rail: null };
  if (!relations.length) {
    return {
      panel: null,
      rail: <RelatedNote message={(refsTo(entry.table) as Fk[]).length ? say('thisLayoutHasNoRelated') : say('nothingPointsAtThisRow')} />,
    };
  }
  if (first.isPending || countsPending) {
    return {
      panel: null,
      rail: (
        <div className="panel related-panel">
          <h2 className="related-title">{say('related')}</h2>
          <Delayed>
            <RelatedSkeleton count={relations.length} />
          </Delayed>
        </div>
      ),
    };
  }
  const rendered = [...(first.data ?? [])];
  if (!rendered.length) return { panel: null, rail: <RelatedNote message={say('nothingPointsAtThisRow')} /> };

  /* Ranked by how much there is to read — only when nobody has arranged them. */
  if (!activeDraft(entry.table) && !hasSavedTemplate(entry.table)) {
    const weight = (r: { rel: Relation; data: GridData }) => countOf.get(r.rel.fk.name) ?? r.data.rows.length;
    rendered.sort((a, b) => weight(b) - weight(a));
  }
  const hasRows = (r: { data: GridData }) => r.data.rows.length > 0;
  // A tab from an address is its word (appAddress.ts); one chosen here is the constraint's name.
  let active = rendered.findIndex((r) => chosen !== undefined && tabMatches(r.rel.fk.name, chosen) && hasRows(r));
  if (active < 0) active = rendered.findIndex(hasRows);
  if (active < 0) active = 0;
  const current = rendered[active];

  const repeated = new Set(rendered.map((r) => r.rel.child.id).filter((id, i, all) => all.indexOf(id) !== i));
  const emptyCount = rendered.filter((r) => !hasRows(r)).length;
  const offerToggle = emptyCount > 0 && emptyCount < rendered.length;

  const choose = (i: number) => {
    if (!hasRows(rendered[i])) return;
    const name = rendered[i].rel.fk.name;
    lastTab.set(entry.table, name);
    setChosen(name);
    /* Into the address bar when someone *picked* this table, not when the
       view opened on it by default. */
    onChooseTab(name);
    setScrollTo(true);
  };

  return {
    panel: (
      <div className="record-children">
        <ChildPanel
          entry={entry}
          rel={current.rel}
          firstPage={current.data}
          total={countOf.get(current.rel.fk.name)}
          capped={cappedRefs.has(current.rel.fk.name)}
          offset={pages.get(current.rel.fk.name) ?? 0}
          onPage={(offset) => {
            setPages((m) => new Map(m).set(current.rel.fk.name, offset));
            setScrollTo(true);
          }}
          scrollTo={scrollTo}
          onScrolled={() => setScrollTo(false)}
        />
      </div>
    ),
    rail: (
      <RelatedRail
        rendered={rendered}
        active={active}
        countOf={countOf}
        capped={cappedRefs}
        repeated={repeated}
        emptyCount={emptyCount}
        hideEmpty={offerToggle && hideEmpty}
        onToggleEmpty={
          offerToggle
            ? () => {
                setHidingEmpty(!hideEmpty);
                setHideEmpty(!hideEmpty);
              }
            : undefined
        }
        onChoose={choose}
      />
    ),
  };
}

function RelatedNote({ message }: { message: string }) {
  return (
    <div className="panel related-panel">
      <h2 className="related-title">{say('related')}</h2>
      <p className="note">{message}</p>
    </div>
  );
}

/* The rail: the record grid's second column, beside the fields panel. */
function RelatedRail({
  rendered,
  active,
  countOf,
  capped,
  repeated,
  emptyCount,
  hideEmpty,
  onToggleEmpty,
  onChoose,
}: {
  rendered: Array<{ rel: Relation; data: GridData }>;
  active: number;
  countOf: Map<string, number>;
  capped: Set<string>;
  repeated: Set<string>;
  emptyCount: number;
  hideEmpty: boolean;
  onToggleEmpty?: () => void;
  onChoose: (i: number) => void;
}) {
  return (
    <div className="panel related-panel">
      <div className="related-head">
        <h2 className="related-title">{say('related')}</h2>
        {onToggleEmpty && (
          <button
            type="button"
            className="ghost related-empties"
            title={say('relationshipsWithNoRows')}
            aria-pressed={hideEmpty}
            onClick={onToggleEmpty}
          >
            {hideEmpty ? `show ${emptyCount} empty` : say('hideEmpty', { emptyCount })}
          </button>
        )}
      </div>
      <div className={`related-list${hideEmpty ? ' hide-empty' : ''}`} role="tablist" aria-orientation="vertical">
        {rendered.map(({ rel, data }, i) => {
          const total = countOf.get(rel.fk.name) ?? data.rows.length;
          const label =
            rel.section.title ?? (repeated.has(rel.child.id) ? `${rel.child.name} · ${rel.fk.from.columns.join(', ')}` : rel.child.name);
          const empty = data.rows.length === 0;
          return (
            <button
              key={rel.fk.name}
              type="button"
              className={`related-item${empty ? ' empty' : ''}`}
              role="tab"
              disabled={empty}
              aria-selected={i === active}
              title={say('nameViaColumns', { name: rel.child.name, columns: rel.fk.from.columns.join(', ') })}
              onClick={() => onChoose(i)}
            >
              <span className="related-count">
                {formatNumber(total)}
                {capped.has(rel.fk.name) ? '+' : ''}
              </span>
              <span className="related-names">
                <span className="related-table">{label}</span>
                <span className="related-via">{say('viaColumns', { columns: rel.fk.from.columns.join(', ') })}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChildPanel({
  entry,
  rel,
  firstPage,
  total,
  capped = false,
  offset,
  onPage,
  scrollTo,
  onScrolled,
}: {
  entry: RowEntry;
  rel: Relation;
  firstPage: GridData;
  total: number | undefined;
  capped?: boolean;
  offset: number;
  onPage: (offset: number) => void;
  scrollTo: boolean;
  onScrolled: () => void;
}) {
  /* Page one is already in hand from the initial load; later pages are fetched. */
  const later = useQuery<GridData>({
    queryKey: ['record-children-page', entry.table, entry.key, rel.fk.name, offset],
    queryFn: () => fetchChildren(rel, offset),
    enabled: offset > 0,
    staleTime: 0,
  });
  const data = offset === 0 ? firstPage : later.data;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollTo || !host.current) return;
    host.current.scrollIntoView({ behavior: motionStill() ? 'auto' : 'smooth', block: 'start' });
    onScrolled();
  }, [scrollTo, rel.fk.name, offset]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="child-panel" ref={host} />;
  const { fk, child, limit } = rel;
  // "At least `total`" cannot say where the pages end; a full page can.
  const more = total === undefined || capped ? data.rows.length === limit : offset + limit < total;
  const paged = offset > 0 || more;
  const said = total === undefined ? '' : `${formatNumber(total)}${capped ? '+' : ''}`;
  const openAll = () => {
    const conditions = fk.from.columns.map((col, i) => `${col} = ${quote(entry.key[fk.to.columns[i]])}`).join(' and ');
    go(tableView(child.id, `${child.id} ${conditions}`));
  };
  return (
    <div className="child-panel" ref={host}>
      <div className="record-child-head">
        <h2 className="record-child-title">{child.name}</h2>
        <span className="record-child-via">{say('viaColumns', { columns: fk.from.columns.join(', ') })}</span>
        {(total ?? data.rows.length) > data.rows.length && (
          <button type="button" className="ghost" onClick={openAll}>
            {say('seeAllCount', { count: total ? said : '' }).replace('  ', ' ')}
          </button>
        )}
      </div>
      <Grid
        table={child}
        data={data}
        interactive={false}
        virtual={false}
        onRowClick={(row) => {
          const key = keyOf(child, row) as Record<string, unknown> | null;
          if (key) void openRecord(child.id, key, rowLabel(child, row));
        }}
      />
      {paged && (
        <div className="child-pager">
          <span className="child-range">
            {total
              ? say('rowsRangeOf', {
                  first: formatNumber(offset + 1),
                  last: formatNumber(capped ? offset + data.rows.length : Math.min(offset + data.rows.length, total)),
                  total: said,
                })
              : `${formatNumber(offset + 1)}–${formatNumber(offset + data.rows.length)}`}
          </span>
          <button type="button" className="ghost" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
            {say('prev')}
          </button>
          <button type="button" className="ghost" disabled={!more} onClick={() => onPage(offset + limit)}>
            {say('common.nextArrow')}
          </button>
        </div>
      )}
    </div>
  );
}
