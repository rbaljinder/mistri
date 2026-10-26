/**
 * A page's history section: the record's own changes, newest first, one
 * entry per write — who made it, when, the action or command it came from,
 * and each field from what to what, in the App's words.
 *
 * The server answers for this reader (server/recordHistory.ts): a field
 * their grant does not read, or one the App's `audit.redact` names, comes
 * back as "changed" with no values, and a record they cannot read has no
 * history for them at all. This module only says what it was handed.
 *
 * A reference is said by its record's name, read through the reader's own
 * `/api/query` as a picker's chosen value is, so a name they cannot read
 * stays the key it was stored as — never a name the history kept, since it
 * keeps none.
 *
 * The page hands it its reads and its frame (PageSections.tsx) rather than
 * this module importing the page's: a section reaching back into the page
 * would join the page's import cycle, which is only allowed to shrink.
 */
import type { ReactNode } from 'react';
import { historyBody } from '@mistriwork/engine/shared/recordReads.js';
import { DEFAULT_HISTORY_LIMIT } from '@mistriwork/engine/shared/pageModel.js';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { columnLabel, findTable, labelPath, recordLabel, rowLabel } from '../core.js';
import { formatDateTime } from '../locale.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { LABEL_SEGMENT } from '@mistriwork/engine/shared/recordLabel.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageSection } from './pageModel.js';
import { Empty } from './Notes.js';
import { Value } from './Value.js';
import { say } from '../copy/record/components/PageHistory.js';
import { pageBridge } from '../uiBridge.js';
import type { ServedMachine } from '@mistriwork/engine/shared/servedApp.js';

/* The machine of the record's resource, when it has one: its state's words, and its column leads a change. */
const machineOf = (tableId: string): ServedMachine | undefined =>
  (pageBridge.activeApp() as { resources?: Record<string, { machine?: ServedMachine }> } | null)?.resources?.[tableId]?.machine;

type Scalar = string | number | boolean | null;
export interface HistoryField {
  column: string;
  before?: Scalar;
  after?: Scalar;
  hidden?: true;
  redacted?: true;
  cut?: true;
  label?: string;
}
export interface HistoryEntry {
  at: string;
  kind: 'insert' | 'update';
  via: 'app' | 'workbench' | 'agent' | 'api' | 'form' | 'system';
  action?: string;
  /** The writer's name when they wrote; never an email. */ by?: string;
  fields: HistoryField[];
}
interface HistoryPage {
  entries: HistoryEntry[];
  more?: number;
}
/** A read through the page's connection, as `usePageApi` makes one. */
export type HistoryApi = (path: string, body: Record<string, unknown>) => Promise<unknown>;
interface HistoryProps {
  section: PageSection;
  base: TableMeta;
  recordKey: Record<string, unknown>;
  api: HistoryApi;
  /** An authoring preview has no record to read: the section shows its shape. */
  preview?: boolean;
  /** The section's frame: its heading around `body`, or its heading and a problem where the read failed. */
  frame: (body: ReactNode, broken?: string) => ReactNode;
  /** What stands in the section while the first read is out. */
  loading: ReactNode;
}

/** Who made a write, as a person reads it: their name when they wrote, else the door it came through.
    Never an address: the server sends none, and a name that reads as one is not said either. */
export function whoWrote(entry: Pick<HistoryEntry, 'by' | 'via'>): string {
  if (entry.by && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(entry.by)) return entry.by;
  switch (entry.via) {
    case 'agent':
      return say('anAgent');
    case 'form':
      return say('aPublicForm');
    case 'workbench':
      return say('theWorkbench');
    case 'api':
      return say('theApi');
    case 'system':
      return say('theSystem');
    default:
      return say('someone');
  }
}

/** What a write did, in a word: the action or command by its label, else what any write is. */
export const whatWrote = (entry: Pick<HistoryEntry, 'action' | 'kind'>): string =>
  entry.action ?? (entry.kind === 'insert' ? say('created') : say('edited'));

/* The names of the records a page's references point at, read as the
   reader: one query per referenced table, the values it holds. */
function useReferenceNames(api: HistoryApi, base: TableMeta, entries: readonly HistoryEntry[]) {
  const wanted = new Map<string, { target: TableMeta; column: string; values: Set<string> }>();
  for (const entry of entries) {
    for (const field of entry.fields) {
      const col = base.columns.find((c) => c.name === field.column);
      const target = col?.references && (findTable(col.references.table) as TableMeta | undefined);
      if (!col?.references || !target) continue;
      const known = wanted.get(field.column) ?? { target, column: col.references.column, values: new Set<string>() };
      for (const value of [field.before, field.after]) if (value !== null && value !== undefined) known.values.add(String(value));
      wanted.set(field.column, known);
    }
  }
  const asks = [...wanted]
    .map(([column, ask]) => ({ column, table: ask.target.id, valueColumn: ask.column, ids: [...ask.values].sort() }))
    .filter((ask) => ask.ids.length);
  return useQuery({
    queryKey: ['page-history-names', base.id, asks],
    enabled: asks.length > 0,
    queryFn: async () => {
      const names = new Map<string, Map<string, string>>();
      await Promise.all(
        asks.map(async (ask) => {
          const table = findTable(ask.table) as TableMeta;
          const naming = labelPath(table) ?? ask.valueColumn;
          const columns = [...new Set([ask.valueColumn, naming, ...table.columns.filter((c) => c.primaryKey).map((c) => c.name)])];
          try {
            /* A path, or a name the catalog computes (a template's `$label`), is
             read where it is computed: a view. A plain read has no such
             column, and in a tenant App asking it for one was answered as a
             refused context, which ended the session. */
            const data =
              naming.includes('.') || naming === LABEL_SEGMENT
                ? await api('/api/view/run', {
                    view: {
                      id: `history:${table.id}`,
                      name: '',
                      base: table.id,
                      columns: columns.map((path) => ({ path })),
                      filter: { groups: [[{ path: ask.valueColumn, op: 'in', value: ask.ids }]] },
                      limit: ask.ids.length,
                    },
                  })
                : await api('/api/query', {
                    table: table.id,
                    columns,
                    filter: { groups: [[{ column: ask.valueColumn, op: 'in', value: ask.ids }]] },
                    limit: ask.ids.length,
                    offset: 0,
                  });
            const rows = (data as { rows?: Array<Record<string, unknown>> }).rows ?? [];
            names.set(
              ask.column,
              new Map(
                rows.map((row) => [
                  String(row[ask.valueColumn]),
                  recordLabel(table) === undefined ? String(row[naming] ?? row[ask.valueColumn]) : rowLabel(table, row),
                ]),
              ),
            );
          } catch {
            /* A table the reader cannot read keeps its keys: the history is still true without the names. */
          }
        }),
      );
      return names;
    },
    staleTime: 60_000,
  }).data;
}

/** The record's own change history, newest first, with "Show earlier changes" while the store holds more. */
export function RecordHistory({ section, base, recordKey, api, preview, frame, loading }: HistoryProps) {
  const limit = section.limit ?? DEFAULT_HISTORY_LIMIT;
  const history = useInfiniteQuery({
    queryKey: ['page-history', base.id, recordKey, limit],
    initialPageParam: undefined as number | undefined,
    /* Its first page as the server asks it for the page's compose (shared/recordReads.ts). */
    queryFn: async ({ pageParam }) =>
      (await api('/api/record-history', {
        ...historyBody(base, recordKey, limit),
        ...(pageParam === undefined ? {} : { before: pageParam }),
      })) as HistoryPage,
    getNextPageParam: (last: HistoryPage) => last.more,
    enabled: !preview,
    staleTime: 0,
  });
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const names = useReferenceNames(api, base, entries);
  if (preview) return frame(<Empty text={say('changesToThisRecord')} />);
  if (history.isPending) return loading;
  if (history.isError) return frame(null, (history.error as Error).message);
  if (!entries.length) return frame(<Empty text={say('noChangesRecordedYet')} detail={say('eachChangeToThisRecord')} />);
  return frame(
    <>
      <ol className="history">
        {entries.map((entry, i) => (
          <HistoryItem key={`${entry.at}-${i}`} entry={entry} base={base} names={names} />
        ))}
      </ol>
      {history.hasNextPage && (
        <div className="history-more">
          <button type="button" className="ghost" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {history.isFetchingNextPage ? say('common.loading') : say('showEarlierChanges')}
          </button>
        </div>
      )}
    </>,
  );
}

function HistoryItem({ entry, base, names }: { entry: HistoryEntry; base: TableMeta; names?: Map<string, Map<string, string>> }) {
  const when = new Date(entry.at);
  const said = Number.isNaN(when.getTime()) ? entry.at : formatDateTime(when);
  return (
    <li className="history-entry">
      <div className="history-head">
        <span className="history-by">{whoWrote(entry)}</span>
        <span className="history-what">{whatWrote(entry)}</span>
        <time className="history-when" dateTime={entry.at} title={entry.at}>
          {said}
        </time>
      </div>
      {entry.fields.length > 0 && (
        <dl className="history-fields">
          {/* A move of the record's state reads first: "Submitted → Approved", by whom above. */}
          {[...entry.fields]
            .sort((a, b) => Number(b.column === machineOf(base.id)?.column) - Number(a.column === machineOf(base.id)?.column))
            .map((field) => (
              <HistoryFieldRow key={field.column} field={field} kind={entry.kind} base={base} names={names?.get(field.column)} />
            ))}
        </dl>
      )}
    </li>
  );
}

function HistoryFieldRow({
  field,
  kind,
  base,
  names,
}: {
  field: HistoryField;
  kind: HistoryEntry['kind'];
  base: TableMeta;
  names?: Map<string, string>;
}) {
  const col = base.columns.find((c) => c.name === field.column) as ColumnMeta | undefined;
  const caption = (columnLabel(base.id, field.column) as string | null) ?? field.label ?? humanName(field.column);
  const machine = machineOf(base.id);
  const draw = (value: Scalar | undefined): ReactNode => {
    const name = value !== null && value !== undefined ? names?.get(String(value)) : undefined;
    if (name !== undefined) return <span title={String(value)}>{name}</span>;
    const state = machine?.column === field.column ? machine.states.find((entry) => entry.value === String(value)) : undefined;
    if (state) return <span title={state.value}>{state.label}</span>;
    return <Value col={col} value={value ?? null} tableId={base.id} compact />;
  };
  let change: ReactNode;
  if (field.hidden || field.redacted) change = <span className="history-changed">{say('changed')}</span>;
  else if (kind === 'insert' || !Object.hasOwn(field, 'before')) change = <span className="history-after">{draw(field.after)}</span>;
  else {
    change = (
      <>
        <span className="history-before">{draw(field.before)}</span>
        <span className="history-arrow" aria-label={say('to')}>
          →
        </span>
        <span className="history-after">{draw(field.after)}</span>
      </>
    );
  }
  return (
    <div className="history-field">
      <dt>{caption}</dt>
      <dd>
        {change}
        {field.cut && (
          <span className="history-cut" title={say('keptShortenedInTheHistory')}>
            {' '}
            {say('shortened')}
          </span>
        )}
      </dd>
    </div>
  );
}
