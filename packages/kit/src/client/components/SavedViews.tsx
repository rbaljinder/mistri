/**
 * Saved filters, as named tabs on a table, beside what is narrowing the
 * result right now — each with a way off. The query bar can write clauses
 * but could not un-write them: having sorted by clicking a header, going
 * back to unsorted meant finding `sort contract_id` in a line of text and
 * deleting exactly it. The store and the naming live in `views.js`.
 */
import { savedViewsFor } from '../views.js';
import { go, tableView } from '../core.js';
import { activeClauses, withoutClause, withoutCondition } from '../clauses.js';
import { say } from '../copy/lists/components/SavedViews.js';

export interface SavedView {
  id: string;
  name: string;
  query: string;
}
interface Entry {
  table: string;
  query: string;
}
interface Clause {
  key: 'sort' | 'filter' | 'show' | 'limit';
  label: string;
  text: string;
  index?: number;
}

/** Drawn into the `div.views` tablist the crossing owns, so the bar's direct-child rules keep holding. */
export function SavedViewsBar({
  entry,
  views,
  onSave,
  onRename,
  onRemove,
}: {
  entry: Entry;
  views: SavedView[];
  onSave: () => void;
  onRename: (view: SavedView) => void;
  onRemove: (view: SavedView) => void;
}) {
  /* "All" is the unfiltered table, and is only meaningful once something else exists to contrast it with. */
  const isPlain = entry.query.trim() === entry.table;
  const alreadySaved = views.some((v) => v.query.trim() === entry.query.trim());
  return (
    <>
      {views.length ? (
        <button type="button" className="view-tab" aria-pressed={isPlain} onClick={() => go(tableView(entry.table), 'replace')}>
          {say('common.all')}
        </button>
      ) : null}
      {views.map((view) => {
        const active = view.query.trim() === entry.query.trim();
        return (
          <span key={view.id} className={`view-tab-wrap${active ? ' active' : ''}`}>
            <button
              type="button"
              className="view-tab"
              aria-pressed={active}
              title={view.query}
              onClick={() => go(tableView(entry.table, view.query), 'replace')}
              onDoubleClick={() => onRename(view)}
            >
              {view.name}
            </button>
            <button
              type="button"
              className="view-remove"
              title={say('common.removeName', { name: view.name })}
              aria-label={say('removeNameLabel', { name: view.name })}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(view);
              }}
            >
              ×
            </button>
          </span>
        );
      })}
      {/* Saving is offered only when there is a filter worth saving. */}
      {!isPlain && !alreadySaved ? (
        <button type="button" className="view-save" onClick={onSave}>
          {say('saveThisFilter')}
        </button>
      ) : null}
      {(activeClauses(entry.query) as Clause[]).map((clause, i) => (
        <span key={`${clause.key}${clause.index ?? ''}${i}`} className={`clause clause-${clause.key}`}>
          <span className="clause-label">{clause.label}</span>
          <span className="clause-text" title={clause.text}>
            {clause.text}
          </span>
          {/* A filter chip removes its own condition; everything else removes the whole clause. */}
          <button
            type="button"
            className="clause-remove"
            title={say('removeLabelText', { label: clause.label, text: clause.text })}
            aria-label={say('removeLabelText', { label: clause.label, text: clause.text })}
            onClick={() =>
              go(
                tableView(
                  entry.table,
                  clause.index === undefined ? withoutClause(entry.query, clause.key) : withoutCondition(entry.query, clause.index),
                ),
                'replace',
              )
            }
          >
            ×
          </button>
        </span>
      ))}
    </>
  );
}

/**
 * The strip over the explorer's table view: the tablist the stylesheet
 * addresses, or nothing at all. The store and the naming are views.js's.
 */
export function SavedViewsSection({ entry }: { entry: Entry }) {
  const bar = savedViewsFor(entry) as {
    views: SavedView[];
    onSave: () => void;
    onRename: (v: SavedView) => void;
    onRemove: (v: SavedView) => void;
  } | null;
  if (!bar) return null;
  return (
    /* A group of switches, not a tablist: beside the saved filters it holds
       their removals, "Save this filter" and the query's own chips, none of
       which is a tab, and a tablist may hold only tabs. */
    <div className="views" role="group" aria-label={say('common.savedFilters')}>
      <SavedViewsBar entry={entry} views={bar.views} onSave={bar.onSave} onRename={bar.onRename} onRemove={bar.onRemove} />
    </div>
  );
}
