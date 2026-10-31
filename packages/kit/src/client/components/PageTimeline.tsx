/**
 * A page's timeline section: the record's activity as one stream, its
 * streams read together and merged newest-first, and, where the App lets
 * this record add to its first stream, the composer that does it through
 * the same related-create plan and form a related list uses.
 */
import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { findTable, labelPath, state } from '../core.js';
import { shell } from '../shellMode.js';
import { resourceOf } from './appRooms.js';
import { headingOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { dayOf, formatDateTime, formatDayHeading, formatTimeOfDay } from '../locale.js';
import { hueOf, initialsOf } from './valueModel.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { relatedCreatePlan } from '@mistriwork/engine/shared/relatedCreate.js';
import { timelineReads } from '@mistriwork/engine/shared/recordReads.js';
import { type TimelineTone } from '@mistriwork/engine/shared/pageModel.js';
import { canInsert, openRelatedRecord } from '../insert.js';
import { PageRenderContext, usePageApi, type SlotProps } from './pageContext.js';
import { Loading, SectionBox } from './PageSectionBox.js';
import { onDemand, useArrived } from './onDemand.js';
import { Empty } from './Notes.js';
import { Value } from './Value.js';
import { listColumn } from './listColumn.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/record/components/PageTimeline.js';

/**
 * What a merged row says it is: its resource's noun ("Call", "Note"), the word
 * a New button and a page already use, and the table's name as a person says
 * it where the resource names none — never a source's qualified name
 * (`sales.deal_estimate`). The Workbench shows the table as it is.
 */
function streamSource(tableId: string, table: TableMeta | undefined): string {
  if (!shell().inApp()) return table?.name ?? tableId;
  const name = table?.name ?? tableId;
  return headingOf(recordNoun(resourceOf(shell().app(), table?.id ?? tableId)?.noun, name.slice(name.lastIndexOf('.') + 1)));
}

/** One row of the merged stream: what it says, who, when, and how the section's rules dress it. */
interface TimelineRow {
  when: string;
  text: unknown;
  textColumn?: ColumnMeta;
  detail: unknown;
  detailColumn?: ColumnMeta;
  table: string;
  by: string | null;
  source: string;
  tone?: TimelineTone;
  compact?: boolean;
  /** The other party's, as the section's `side` says: drawn against the far edge. */
  other?: boolean;
}

/** A row no person wrote, as the section's `compact` rule says: a row without an author is not one (a customer's
    message may have none where the author is the agent). */
const isEvent = (r: TimelineRow) => Boolean(r.compact);

/** The rows by calendar day, each day's runs of two or more events folded into one item. */
function byDay(rows: TimelineRow[]) {
  const days: Array<{ day: string; items: Array<TimelineRow | TimelineRow[]> }> = [];
  for (const r of rows) {
    const day = dayOf(r.when) ?? '';
    let last = days.at(-1);
    if (!last || last.day !== day) days.push((last = { day, items: [] }));
    const prev = last.items.at(-1);
    if (isEvent(r) && prev && (Array.isArray(prev) || isEvent(prev))) last.items[last.items.length - 1] = [prev, r].flat();
    else last.items.push(r);
  }
  return days;
}

/** The time of day a row was written; the day is its group's heading, the whole moment its title. */
function When({ at }: { at: string }) {
  const time = formatTimeOfDay(at);
  return time ? (
    <time className="timeline-when" dateTime={at} title={formatDateTime(at)}>
      {time}
    </time>
  ) : null;
}

/** Whether a message goes on its author's run: the same person, on the same side, in the same dress, right after. */
const runsOn = (r: TimelineRow, prev: TimelineRow | TimelineRow[] | undefined) =>
  Boolean(prev && !Array.isArray(prev) && !isEvent(prev) && r.by && prev.by === r.by && prev.other === r.other && prev.tone === r.tone);

/** One row: an event is one quiet line; a message is who, what kind and when over its words, its author said once a run
    where the section has sides. */
function Row({
  r,
  multi,
  conversation,
  continued = false,
}: {
  r: TimelineRow;
  multi: boolean;
  conversation: boolean;
  continued?: boolean;
}) {
  const words =
    r.text == null || r.text === '' ? (
      ''
    ) : (
      <Value tableId={r.table} col={r.textColumn} value={r.text} compact links wholeText={conversation} />
    );
  const tone = r.tone ? { 'data-tone': r.tone } : {};
  if (isEvent(r))
    return (
      <li className="timeline-row is-compact" data-timeline-row {...tone}>
        <span className="timeline-text">{words}</span>
        <When at={r.when} />
      </li>
    );
  return (
    <li
      className={`timeline-row${r.tone ? ' is-tinted' : ''}${r.other ? ' is-other' : ''}${continued ? ' is-continued' : ''}`}
      data-timeline-row
      {...tone}
    >
      {r.by && !continued ? (
        <span className={`timeline-avatar avatar avatar-c${hueOf(r.by)}`} aria-hidden="true">
          {initialsOf(r.by)}
        </span>
      ) : (
        <span className="timeline-avatar" aria-hidden="true" />
      )}
      <span className="timeline-head">
        {r.by && (continued ? <span className="visually-hidden">{r.by}</span> : <span className="timeline-by">{r.by}</span>)}
        {r.detail != null && (
          <span className="timeline-kind">
            <Value tableId={r.table} col={r.detailColumn} value={r.detail} compact />
          </span>
        )}
        {multi && <span className="timeline-source">{r.source}</span>}
        <When at={r.when} />
      </span>
      <div className="timeline-text prose">{words}</div>
    </li>
  );
}

/** Two or more events in a row, said as their count and opened in place. */
function Fold({ rows, multi, conversation }: { rows: TimelineRow[]; multi: boolean; conversation: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="timeline-fold">
      <button type="button" className="timeline-fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {say('updates', { count: rows.length })}
      </button>
      <ol className="timeline-rows" id={id} hidden={!open}>
        {rows.map((r, i) => (
          <Row key={i} r={r} multi={multi} conversation={conversation} />
        ))}
      </ol>
    </li>
  );
}

/** The record's activity as one stream, merged newest-first (or, as a conversation, oldest-first) across its streams. */
/* The other side's stylesheet, a part of its own: only a section with a `side` (its own or a stream's) asks for it. */
const Sides = onDemand(() => import('./TimelineSides.js'), 'TimelineSides', { quiet: true });

export function TimelineSection({ section, plan, base, recordKey }: SlotProps) {
  /* Rows with sides wait for their dress, under the section's one skeleton, so nothing moves when it comes. */
  const sided = Boolean(section.side || section.streams?.some((stream) => stream.side));
  const sidesHere = useArrived(Sides, sided);
  const api = usePageApi();
  const { preview, isCurrent, openRelated } = useContext(PageRenderContext);
  const queries = useQueryClient();
  const [added, setAdded] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const streams = plan.streams ?? [];
  const conversation = section.newest === 'last';
  /* The conversation's box, as a state: a sided conversation draws its placeholder until its sides arrive, and the box
     drawn then is a new one the first scroll never saw. */
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /* Whether the reader is at the foot: the box keeps them there while it settles, and leaves them where they scrolled. */
  const atFoot = useRef(true);
  /* A row's line and detail are values of their stream's table, dressed by its display rules and drawn by its
     value components as a grid cell is; `table` is whose rules they are. */
  const data = useQuery<TimelineRow[]>({
    queryKey: ['page-timeline', plan.streams, section.limit, section.tone, section.compact, section.streams],
    queryFn: async () => {
      const answers = await Promise.all(
        streams.map(async (stream, s) => {
          /* The stream as authored: its own tone and compact stand over the section's rules. */
          const own = section.streams?.[s];
          if (stream.error) throw new Error(stream.error);
          if (stream.empty) return [];
          if (!stream.view) throw new Error(say('thisActivityStreamHasNoView'));
          const table = findTable(stream.from) as TableMeta | undefined;
          /* An author that is a reference (`author: 'owner_id'`) says the person's name, as a list column of the same
             reference does: read through the reference to the record's label, where this reader reads that table.
             The other party's rows are the same read narrowed by the section's `side`, asked beside it: their keys.
             Both as the page's planned reads ask them (shared recordReads.ts `timelineReads`), so a composed page's
             answers are these very reads. */
          if (stream.side?.error) throw new Error(stream.side.error);
          const asked = timelineReads(
            { table: (id) => findTable(id) as TableMeta | undefined, namePath: (target) => labelPath(target) },
            stream,
          )!;
          const view = asked.view;
          const named = asked.view !== stream.view ? asked.view.columns?.at(-1)?.path : undefined;
          const byPath = named ?? stream.by;
          const others = asked.side ? api('/api/view/run', { view: asked.side, offset: 0 }) : undefined;
          const [got, otherRows] = await Promise.all([api('/api/view/run', { view, offset: 0 }), others]);
          if (!('view' in got)) throw new Error(got.errors[0]?.message ?? say('thisActivityStreamCould'));
          if (otherRows && !('view' in otherRows)) throw new Error(otherRows.errors[0]?.message ?? say('thisActivityStreamCould'));
          const keyOf = (row: Record<string, unknown>, names: string[], cols: string[]) =>
            JSON.stringify(stream.key!.map((column) => row[cols[names.indexOf(column)] ?? column] ?? null));
          const otherKeys =
            otherRows &&
            new Set(otherRows.rows.map((row: Record<string, unknown>) => keyOf(row, stream.key!, otherRows.columns ?? stream.key!)));
          const names = (view.columns ?? []).map((c) => c.path);
          const cols: string[] = got.columns ?? names;
          const atCol = cols[names.indexOf(stream.at)] ?? stream.at;
          const showCol = cols[names.indexOf(stream.show)] ?? stream.show;
          const detailCol = stream.detail ? (cols[names.indexOf(stream.detail)] ?? stream.detail) : null;
          const byCol = byPath ? (cols[names.indexOf(byPath)] ?? byPath) : null;
          const markCol = (name: string) => cols[names.indexOf(name)] ?? name;
          const shown = table && listColumn(table, stream.show);
          const detailed = table && stream.detail ? listColumn(table, stream.detail) : undefined;
          return got.rows.map((row): TimelineRow => ({
            when: row[atCol] == null ? '' : String(row[atCol]),
            text: row[showCol] ?? null,
            ...(shown ? { textColumn: { ...shown, name: stream.show } } : {}),
            detail: detailCol && row[detailCol] != null && row[detailCol] !== '' ? row[detailCol] : null,
            ...(detailed ? { detailColumn: { ...detailed, name: stream.detail! } } : {}),
            table: table?.id ?? stream.from,
            by: byCol && row[byCol] != null ? String(row[byCol]) : null,
            source: streamSource(stream.from, table),
            /* A column's value picks the tone, and a one-line row: the section's rules read each row's own columns,
               where the stream says neither for all its rows. */
            ...(() => {
              const said = (column: string) => (row[markCol(column)] == null ? undefined : String(row[markCol(column)]));
              const tone =
                own?.tone ??
                Object.entries(section.tone ?? {})
                  .map(([column, tones]) => tones[said(column) ?? ''])
                  .find(Boolean);
              const small =
                own?.compact === true ||
                (own?.compact === undefined &&
                  Object.entries(section.compact ?? {}).some(([column, values]) => values.includes(said(column) ?? '')));
              const other = !small && otherKeys?.has(keyOf(row, names, cols));
              return { ...(tone ? { tone } : {}), ...(small ? { compact: true } : {}), ...(other ? { other: true } : {}) };
            })(),
          }));
        }),
      );
      return answers
        .flat()
        .filter((r) => r.when)
        .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
        .slice(0, section.limit ?? 20);
    },
    staleTime: 0,
  });
  /* A conversation reads to its newest line, at the foot: scrolled there when it arrives and when a message is added,
     and kept there while what is above it settles — a face's metrics, an avatar, a message's prose drawn a moment
     later. Scrolled there once, it was left a few pixels short at a desk and most of a message short on a phone as
     the rows grew under it, the top line cut, neither at the first message nor at the newest (G184). Once the reader
     scrolls away from the foot, the box stays where they put it. */
  useLayoutEffect(() => {
    if (!conversation || !scroller) return;
    const box = scroller;
    /* At the foot the box's top edge falls wherever the height runs out, mostly inside a message: so the box stands a
       little shorter than its most, by less than one message, for that edge to fall where a message (or a day) starts.
       Only while the reader is at the foot; their own scroll is theirs. */
    const foot = () => {
      if (!atFoot.current) return;
      box.style.maxHeight = '';
      const room = box.clientHeight,
        whole = box.scrollHeight;
      if (whole > room + 1) {
        const origin = box.getBoundingClientRect().top - box.scrollTop;
        const over = whole - room;
        /* The box's height and its scroll are whole pixels and a face's lines are not (Barlow's start at fractions):
           floored, the edge fell up to a pixel inside the line it was meant to start. Rounded, it falls within half a
           pixel of that line's start, on either side, so a line is taken only where rounding lands no lower. */
        const edge = [...box.querySelectorAll<HTMLElement>('.timeline-day-label, [data-timeline-row], .timeline-fold')]
          .filter((line) => line.offsetHeight > 0)
          .map((line) => line.getBoundingClientRect().top - origin)
          .filter((top) => top >= over - 0.5)
          .sort((a, b) => a - b)[0];
        const height = edge === undefined ? room : Math.round(whole - edge);
        if (height < room) box.style.maxHeight = `${height}px`;
      }
      box.scrollTop = box.scrollHeight;
    };
    atFoot.current = true;
    foot();
    const read = () => {
      atFoot.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    };
    box.addEventListener('scroll', read, { passive: true });
    const settle = new ResizeObserver(foot);
    settle.observe(box);
    for (const child of box.children) settle.observe(child);
    return () => {
      box.removeEventListener('scroll', read);
      settle.disconnect();
    };
  }, [conversation, scroller]);
  // A message added (the reader's own, or one that arrived) takes the reader to the foot, where it is.
  useLayoutEffect(() => {
    if (!conversation || !scroller) return;
    atFoot.current = true;
    scroller.scrollTop = scroller.scrollHeight;
  }, [conversation, scroller, data.data]);
  if (data.isPending || (sided && !sidesHere)) return <Loading section={section} />;
  if (data.isError) return <SectionBox section={section} body={null} foldable={false} broken={(data.error as Error).message} />;
  const rows = conversation ? [...(data.data ?? [])].reverse() : (data.data ?? []);
  /* A message names its stream only where the messages come from more than one: a conversation whose second stream
     is all quiet lines (time logged) said "Activity" over every message, a word that told the reader nothing. */
  const multi = new Set(rows.filter((r) => !isEvent(r)).map((r) => r.source)).size > 1;
  /* The composer adds a row of the first stream, bound to this record the way
     a related list's create is: the same plan, the same form, no new write
     path. A stream narrowed by a query could hide the row it just added. */
  const first = section.streams?.[0];
  const table = first ? (findTable(first.from) as TableMeta | undefined) : undefined;
  const creation =
    section.create && first && !first.filter && table && state.schema
      ? relatedCreatePlan(state.schema, base.id, table.id, first.path, section.create)
      : undefined;
  const defaults = creation?.bindings && Object.fromEntries(creation.bindings.map((b) => [b.column, recordKey[b.parent]]));
  const canCreate =
    !preview &&
    shell().inApp() &&
    table &&
    canInsert(table) &&
    defaults &&
    Object.values(defaults).every((v) => typeof v === 'string' || typeof v === 'number');
  const composeButton = !section.composer && canCreate && (
    <div className="page-related-create timeline-compose">
      {added && <span role="status">{say('common.added')}</span>}
      <button
        type="button"
        className="ghost"
        ref={createButton}
        onClick={() => {
          if (isCurrent && !isCurrent()) return;
          setAdded(false);
          (openRelated ?? openRelatedRecord)(
            table,
            { show: creation!.show, defaults: { ...(creation!.defaults ?? {}), ...defaults } },
            () => {
              if (isCurrent && !isCurrent()) return;
              setAdded(true);
              void queries.invalidateQueries({
                predicate: (query) => ['page-list', 'page-timeline', 'page-metric', 'page-breakdown'].includes(String(query.queryKey[0])),
              });
              createButton.current?.focus();
            },
          );
        }}
      >
        + {section.create!.label}
      </button>
    </div>
  );
  /* The composer sends through the App's commands (TimelineComposer.tsx), drawn through the shell's slot. */
  const { TimelineComposer } = shell().slots;
  return (
    <SectionBox
      section={section}
      foldable={false}
      body={
        <>
          {composeButton}
          {rows.length ? (
            <div
              className={conversation ? 'timeline-scroll' : undefined}
              {...(conversation ? { 'data-scrolls': '' } : {})}
              ref={setScroller}
            >
              <ol className="timeline">
                {byDay(rows).map(({ day, items }, d) => (
                  <li key={day || d} className="timeline-day">
                    {day && (
                      <time className="timeline-day-label" dateTime={day}>
                        {formatDayHeading(day)}
                      </time>
                    )}
                    <ol className="timeline-rows">
                      {items.map((item, i) =>
                        Array.isArray(item) ? (
                          <Fold key={`${item[0]!.when} ${item[0]!.table}`} rows={item} multi={multi} conversation={conversation} />
                        ) : (
                          <Row
                            key={`${item.when} ${item.table}`}
                            r={item}
                            multi={multi}
                            conversation={conversation}
                            continued={sided && runsOn(item, items[i - 1])}
                          />
                        ),
                      )}
                    </ol>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <Empty text={say('nothingDatedYetForThisRecord')} />
          )}
          {section.composer && !preview && shell().inApp() && TimelineComposer && (
            <TimelineComposer
              composer={section.composer}
              recordKey={recordKey as Record<string, string | number>}
              table={base?.id}
              onSent={() =>
                void queries.invalidateQueries({
                  predicate: (query) => ['page-list', 'page-timeline', 'page-metric', 'page-breakdown'].includes(String(query.queryKey[0])),
                })
              }
            />
          )}
        </>
      }
    />
  );
}
