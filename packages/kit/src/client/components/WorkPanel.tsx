/**
 * Everything you already did, in one card.
 *
 * Three questions in the order they are asked: what am I coming back to
 * (pinned), where was I (a page *and* the record), and what else is there
 * (saved filters, then every page, behind a filter box because a database
 * with forty pages is one where finding a page matters more than seeing
 * them all). A link, not a card, for each: a dim label says which
 * question, the links are the answer, and there is one box on the screen
 * instead of eleven.
 *
 * Absent entirely when nothing is saved — an empty "Saved" heading above a
 * schema diagram is a promise the tool has not kept yet.
 */
import { useState, type ReactNode } from 'react';
import { go, pageView, tableView } from '../core.js';
import { pinnedPages, recentVisits } from '../pagemarks.js';
import { allSavedFilters } from '../views.js';
import { say } from '../copy/workbench/components/WorkPanel.js';

export interface KnownPage {
  id: string;
  name: string;
  base: string;
  source?: string;
}
interface Visit {
  pageId: string;
  name: string;
  base?: string;
  key?: Record<string, unknown>;
  label?: string;
}
interface SavedFilter {
  name: string;
  table: string;
  query: string;
}

function Link({ name, detail, title, onClick }: { name: string; detail?: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className="landing-link" title={title} onClick={onClick}>
      <span className="landing-link-name">{name}</span>
      {detail ? <span className="landing-link-detail">{detail}</span> : null}
    </button>
  );
}

function Line({ label, className = 'landing-links', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <li className="shape-line">
      <span className="shape-label">{label}</span>
      <span className={className}>{children}</span>
    </li>
  );
}

export function WorkPanel({ pages }: { pages: KnownPage[] }) {
  const [needle, setNeedle] = useState('');
  const byId = new Map(pages.map((p) => [p.id, p]));
  const openPage = (pageId: string, base: string | undefined, key?: Record<string, unknown>, label?: string) =>
    go(pageView(pageId, byId.get(pageId)?.base ?? base, key, label), 'reset');

  const pinned = pinnedPages() as Array<{ id: string; name: string; base: string }>;
  /* A position, not a page: the record is what makes it worth going back
     to, and a list of page names would send you to the chooser you already
     got past. */
  const positions = (recentVisits() as Visit[]).filter((v) => v.label);
  const saved = allSavedFilters() as SavedFilter[];
  const shown = pages.filter((p) => `${p.name} ${p.base}`.toLowerCase().includes(needle));

  /* Nothing to resume is not an empty card: on a database nobody has worked
     in yet, the schema below really is the most useful thing on screen. */
  if (!pinned.length && !positions.length && !saved.length && !pages.length) return null;

  return (
    <section className="landing-pages shape">
      <h2 className="landing-heading">{say('yourWork')}</h2>
      <ul className="shape-lines">
        {pinned.length ? (
          <Line label={say('pinned')}>
            {pinned.map((page) => (
              <Link
                key={page.id}
                name={page.name}
                detail={page.base}
                title={say('aPageAboutOne', { base: page.base })}
                onClick={() => openPage(page.id, page.base)}
              />
            ))}
          </Line>
        ) : null}
        {positions.length ? (
          /* One position per row: inline they wrapped into word soup — a
             visit named "1" beside "Q3 Pipeline Accelerator" read as one
             sentence. */
          <Line label={say('common.where')} className="landing-links landing-rows">
            {positions.slice(0, 6).map((visit, i) => (
              <Link
                key={i}
                name={visit.label ?? ''}
                detail={visit.name}
                title={`${visit.name} — ${visit.label}`}
                onClick={() => openPage(visit.pageId, visit.base, visit.key, visit.label)}
              />
            ))}
          </Line>
        ) : null}
        {saved.length ? (
          <Line label={say('common.savedFilters')}>
            {saved.map((view, i) => (
              <Link
                key={i}
                name={view.name}
                detail={view.table}
                title={view.query}
                onClick={() => go(tableView(view.table, view.query), 'reset')}
              />
            ))}
          </Line>
        ) : null}
        {pages.length ? (
          <li className="shape-line landing-all">
            <span className="shape-label">{say('allPages', { pagesCount: pages.length })}</span>
            <div>
              <input
                type="search"
                className="landing-page-filter"
                placeholder={say('filterPages')}
                aria-label={say('filterPagesLabel')}
                value={needle}
                onChange={(e) => setNeedle(e.target.value.trim().toLowerCase())}
              />
              <div className="landing-page-list">
                {shown.length ? (
                  shown.map((page) => (
                    <button key={page.id} type="button" className="landing-page" onClick={() => openPage(page.id, page.base)}>
                      <span className="landing-page-name">{page.name}</span>
                      <span className="landing-page-base">{page.base}</span>
                      <span className="landing-page-source">
                        {say(page.source === 'config' ? 'sourceConfig' : page.source === 'saved' ? 'sourceYours' : 'sourceSuggested')}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="note">{say('noPageOfThatName')}</p>
                )}
              </div>
            </div>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
