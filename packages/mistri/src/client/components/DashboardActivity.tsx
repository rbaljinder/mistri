/**
 * A dashboard's activity feed (`activity()`): the newest changes across the
 * resources the section names, from their record history — each with its
 * resource's mark, what the write did, the record by its name, who made it
 * and when — under a segmented Today / Yesterday / This week and a search.
 *
 * The server answers for this reader (server/recordActivity.ts): a change is
 * said only about a record they can read now, and a field they may not read
 * says that it changed and nothing else, so this module only says what it
 * was handed. The period is the server's to bound, in the App's own day; the
 * search narrows the changes the period read, here, as a reader types.
 * Loaded the first time a dashboard holds a feed (onDemand.tsx).
 */
import { useDeferredValue, useId, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, columnLabel, findTable, openRecord } from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { ACTIVITY_MAX } from '../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { headingOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { resourceOf } from '@mistriwork/kit/client/components/appRooms.js';
import type { Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import { whoWrote, type HistoryEntry, type HistoryField } from '@mistriwork/kit/client/components/PageHistory.js';
import { Empty, Problem } from '@mistriwork/kit/client/components/Notes.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import './DashboardActivity.css';
import { say } from '../copy/dashboards/components/DashboardActivity.js';

interface ActivityEntry extends HistoryEntry {
  table: string;
  key: Record<string, unknown>;
  label: string;
}
type Period = 'today' | 'yesterday' | 'week';
const PERIODS: Array<{ value: Period; label: string; said: string }> = [
  { value: 'today', label: say('common.today'), said: 'today' },
  { value: 'yesterday', label: say('yesterday'), said: 'yesterday' },
  { value: 'week', label: say('thisWeek'), said: 'this week' },
];

/** What a change was, as its title: the action or command by its label, else a new record or an edit of one. */
function titleOf(entry: ActivityEntry, noun: string): string {
  if (entry.action) return entry.action;
  return entry.kind === 'insert' ? say('new', { noun }) : say('edited', { headingOf: headingOf(noun) });
}

/* The fields a line can say whole: ones the reader may read, with a value to say, and not a reference, whose
   stored value is its key — the record's own page says those by name (PageHistory.tsx). */
const sayable = (table: TableMeta | undefined, field: HistoryField) =>
  !field.hidden && !field.redacted && !table?.columns.find((column) => column.name === field.column)?.references;

/** A change's detail: its first field from what to what, in the column's own dress. */
function Changed({ entry, table }: { entry: ActivityEntry; table: TableMeta | undefined }) {
  /* One line: the change's first field it can say, else how many changed. The record's own history says the rest. */
  const said = entry.fields.filter((field) => sayable(table, field)).slice(0, entry.kind === 'insert' ? 0 : 1);
  const rest = entry.kind === 'insert' || said.length ? 0 : entry.fields.length;
  if (!said.length && !rest) return null;
  const col = (name: string) => table?.columns.find((column) => column.name === name) as ColumnMeta | undefined;
  const caption = (field: HistoryField) =>
    (columnLabel(entry.table, field.column) as string | null) ?? field.label ?? humanName(field.column);
  const draw = (field: HistoryField, value: HistoryField['after']): ReactNode => (
    <Value col={col(field.column)} value={value ?? null} tableId={entry.table} compact />
  );
  return (
    <span className="activity-changed">
      {said.map((field) => (
        <span key={field.column} className="activity-field">
          <span className="activity-caption">{caption(field)}</span>{' '}
          {field.before !== undefined && field.before !== null && (
            <>
              <span className="activity-before">{draw(field, field.before)}</span>
              <span className="activity-arrow" aria-label={say('to')}>
                {' '}
                →{' '}
              </span>
            </>
          )}
          <span className="activity-after">{draw(field, field.after)}</span>
        </span>
      ))}
      {rest > 0 && <span className="activity-field activity-more-fields">{say('fieldsChanged', { count: rest })}</span>}
    </span>
  );
}

/** When, as the period says it: a time today or yesterday, a weekday and a time this week. */
function when(at: string, period: Period): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return formatDateTime(
    date,
    period === 'week' ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' },
  );
}

/* The words a search looks through: what the change was, the record, who, and the fields' captions and values. */
const searched = (entry: ActivityEntry, title: string) =>
  [
    title,
    entry.label,
    whoWrote(entry),
    ...entry.fields.flatMap((field) => [field.column, field.label ?? '', String(field.before ?? ''), String(field.after ?? '')]),
  ]
    .join(' ')
    .toLowerCase();

export function ActivityFeed({ section, dashboard, at }: { section: Section; dashboard: string; at: number }) {
  const [period, setPeriod] = useState<Period>('today');
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const typed = useDeferredValue(search.trim().toLowerCase());
  const searchId = useId();
  const answer = useQuery<{ entries: ActivityEntry[] }>({
    queryKey: ['record-activity', dashboard, at, period],
    queryFn: () => api('/api/record-activity', { view: dashboard, section: at, period }),
    enabled: at >= 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const app = activeApp();
  const limit = section.limit ?? 8;
  const nounOf = (table: string) => {
    const meta = findTable(table) as TableMeta | undefined;
    return section.resources?.[table]?.label ?? recordNoun(resourceOf(app, table)?.noun, meta?.name ?? table);
  };
  const entries = (answer.data?.entries ?? [])
    .map((entry) => ({ entry, title: titleOf(entry, nounOf(entry.table)) }))
    .filter(({ entry, title }) => !typed || searched(entry, title).includes(typed));
  const shown = all ? entries : entries.slice(0, limit);
  const said = PERIODS.find((each) => each.value === period)!.said;
  let body: ReactNode;
  if (answer.isError) body = <Problem text={(answer.error as Error).message} />;
  else if (!answer.data) body = <div className="activity-list" aria-busy="true" />;
  else if (!entries.length) {
    body = <Empty text={typed ? say('noChangesMatch', { said, search: search.trim() }) : say('noChanges', { said })} />;
  } else {
    body = (
      <>
        <p className="activity-count">
          <strong>
            {entries.length}
            {!typed && entries.length >= ACTIVITY_MAX ? '+' : ''}
          </strong>{' '}
          {say(entries.length === 1 ? 'changeNoun' : 'changesNoun')} {said}
        </p>
        <ol className="activity-list">
          {shown.map(({ entry, title }, i) => {
            const table = findTable(entry.table) as TableMeta | undefined;
            const icon = section.resources?.[entry.table]?.icon;
            return (
              <li key={`${entry.table}-${entry.at}-${i}`} className="activity-entry">
                <span className="activity-mark" aria-hidden="true">
                  {icon ? <Icon name={icon} size={16} /> : null}
                </span>
                <span className="activity-text">
                  <span className="activity-head">
                    <span className="activity-what">{title}</span>
                    <time className="activity-when" dateTime={entry.at} title={formatDateTime(new Date(entry.at))}>
                      {when(entry.at, period)}
                    </time>
                  </span>
                  <span className="activity-detail">
                    {/* The kind of record, unless the change's title already says it ("Start a thread"). */}
                    {!title.toLowerCase().includes(nounOf(entry.table).toLowerCase()) && (
                      <>
                        <span className="activity-noun">{headingOf(nounOf(entry.table))}</span>{' '}
                      </>
                    )}
                    <button
                      type="button"
                      className="activity-record"
                      onClick={() => void openRecord(entry.table, entry.key, entry.label, 'push')}
                    >
                      {entry.label}
                    </button>{' '}
                    <Changed entry={entry} table={table} />
                  </span>
                  <span className="activity-by">{whoWrote(entry)}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {entries.length > limit && (
          <button type="button" className="ghost activity-show" onClick={() => setAll(!all)}>
            {all ? say('showFewer') : say('showMore', { entriesCount: entries.length - limit })}
          </button>
        )}
      </>
    );
  }
  return (
    <div className="activity">
      <div className="activity-periods" role="group" aria-label={say('period', { title: section.title ?? say('theActivity') })}>
        {PERIODS.map((each) => (
          <button
            key={each.value}
            type="button"
            className="activity-period"
            aria-pressed={period === each.value}
            onClick={() => {
              setPeriod(each.value);
              setAll(false);
            }}
          >
            {each.label}
          </button>
        ))}
      </div>
      <label className="activity-search" htmlFor={searchId}>
        <Icon name="magnifying-glass" size={16} />
        <span className="visually-hidden">
          {say('navigation.search')} {section.title ?? say('theActivity')}
        </span>
        <input id={searchId} type="search" value={search} placeholder={say('searchActivity')} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {body}
    </div>
  );
}
