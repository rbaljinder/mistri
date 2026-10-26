/**
 * A dashboard's find box (`find()`): one big field over several resources'
 * records, the hits grouped by resource, each its record's name and one line
 * of its list, opening the record at its own address. A portal's home is the
 * place for it: an employee who wants an article or a laptop types, and
 * does not first have to know which list holds it.
 *
 * The engine is ⌘K's (recordSearch.ts), so what it finds is what this
 * reader may read, asked of the App's search engine where a resource has
 * one. A typed pause asks; an answer to older text is never shown as this
 * text's. The box is a combobox: the arrows walk the hits across the groups
 * and Enter opens the lit one, so the pointer is never needed.
 * Loaded the first time a dashboard holds one (onDemand.tsx).
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { activeApp } from '../appState.js';
import type { Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import { findRecords, findableTables, lineOf, type Found } from '@mistriwork/kit/client/components/recordSearch.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import './DashboardFind.css';
import { say } from '../copy/dashboards/components/DashboardFind.js';
import { shellById } from '@mistriwork/kit/client/shellHost.js';

/** Hits per resource: a box answers with a shortlist, and its list is one click away for the rest. */
const PER_RESOURCE = 5;
/* The pause after a keystroke before the question goes, so a word typed is one request, not one per letter. */
const PAUSE = 200;

export function FindSection({ section }: { section: Section }) {
  const app = activeApp();
  const searched = section.searched;
  const tables = useMemo(() => (app ? findableTables(app, searched ?? []) : []), [app, searched]);
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const [lit, setLit] = useState(0);
  const id = useId();
  const term = text.trim();

  useEffect(() => {
    const timer = setTimeout(() => setAsked(term), PAUSE);
    return () => clearTimeout(timer);
  }, [term]);

  const answer = useQuery({
    queryKey: ['find', tables.map((each) => each.table.id), asked],
    enabled: asked.length >= 2 && tables.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      Promise.all(
        tables.map(async (findable) => ({
          findable,
          hits: await findRecords(findable, asked, PER_RESOURCE, lineOf(findable)),
        })),
      ),
  });
  /* Only an answer to what the box says now is drawn: one for older text would open a record nobody asked for. */
  const current = term.length >= 2 && answer.data && asked === term && !answer.isPlaceholderData ? answer.data : undefined;
  const groups = (current ?? []).filter((group) => group.hits.length);
  const hits: Found[] = groups.flatMap((group) => group.hits);
  const at = hits.length ? Math.min(lit, hits.length - 1) : -1;
  useEffect(() => {
    setLit(0);
  }, [asked]);
  useEffect(() => {
    if (at >= 0) shellById(`${id}-hit-${at}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at, id]);

  const open = Boolean(current);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && hits.length) {
      event.preventDefault();
      setLit((at + 1) % hits.length);
    } else if (event.key === 'ArrowUp' && hits.length) {
      event.preventDefault();
      setLit((at - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter' && at >= 0) {
      event.preventDefault();
      hits[at].open();
    } else if (event.key === 'Escape' && text) {
      event.preventDefault();
      setText('');
    }
  };

  let index = -1;
  return (
    <div className="find">
      <div className="find-box">
        <Icon name="magnifying-glass" size={20} />
        <input
          type="search"
          role="combobox"
          aria-label={section.title ?? section.placeholder ?? say('searchPlaceholder')}
          aria-expanded={open}
          aria-controls={`${id}-hits`}
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? `${id}-hit-${at}` : undefined}
          placeholder={section.placeholder ?? say('searchPlaceholder')}
          value={text}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <p className="visually-hidden" aria-live="polite">
        {current ? say('results', { count: hits.length }) : ''}
      </p>
      {open && !hits.length && <p className="find-empty">{say('nothingMatches', { term })}</p>}
      <div
        id={`${id}-hits`}
        role="listbox"
        className="find-hits"
        hidden={!hits.length}
        aria-label={section.title ?? say('searchPlaceholder')}
      >
        {groups.map(({ findable, hits: found }) => (
          <div key={findable.table.id} role="group" aria-labelledby={`${id}-${findable.table.id}`} className="find-group">
            <p id={`${id}-${findable.table.id}`} className="find-group-title" role="presentation">
              {findable.room.label}
            </p>
            {found.map((hit) => {
              index += 1;
              const mine = index;
              return (
                <div
                  key={JSON.stringify(hit.key)}
                  id={`${id}-hit-${mine}`}
                  role="option"
                  aria-selected={mine === at}
                  className="find-hit"
                  onMouseMove={() => setLit(mine)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={hit.open}
                >
                  <span className="find-hit-name">{hit.label}</span>
                  {hit.line && <span className="find-hit-line">{hit.line}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
