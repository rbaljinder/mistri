/**
 * Which of a list's columns a reader draws: "Columns", at the end of the list's bar, opens them as a checklist, drawn
 * as a filter's picker is (ListFilterBar.tsx). The choice is how they like to read the list, not a question about
 * it: kept in their browser per view, as the layout is (LayoutSwitch.tsx), never in the address, a saved view or the
 * query, so the rows are asked for as they were and another reader sees the list as the App wrote it. The first
 * column is the one a row is known by and always stays.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { popupContainer, portalRoot } from '../shellHost.js';
import { say } from '../copy/lists/components/ListColumns.js';

const KEY = 'mistri.listColumns';

function kept(view: string | undefined): string[] {
  if (!view) return [];
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const hidden = all[view];
    return Array.isArray(hidden) ? hidden.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function keep(view: string, hidden: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    if (hidden.length) all[view] = hidden;
    else delete all[view];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* A browser that keeps nothing still hides the column; it forgets on the next visit. */
  }
}

/** The columns a reader left out of a view, among the ones it offers, and the way to change them. */
export function useListColumns(view: string | undefined, offered: readonly string[]): [string[], (hidden: string[]) => void] {
  const [hidden, setHidden] = useState<string[]>(() => kept(view));
  const change = useCallback(
    (next: string[]) => {
      setHidden(next);
      if (view) keep(view, next);
    },
    [view],
  );
  // A column the view no longer shows, or its first, is not one a reader can have left out.
  const mayHide = offered.slice(1);
  return [hidden.filter((name) => mayHide.includes(name)), change];
}

export function ListColumns({
  columns,
  hidden,
  onChange,
  caption,
}: {
  /** The view's columns in its order, each by the label its head says. */
  columns: ReadonlyArray<{ name: string; label: string }>;
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
  caption: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | null);
  }, []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="applist-columns" data-own="" ref={trigger}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 5h6.5M12.5 5H14M2 11h1.5M7.5 11H14" />
          <circle cx="10.5" cy="5" r="1.75" />
          <circle cx="5.5" cy="11" r="1.75" />
        </svg>
        {say('columns')}
      </PopoverTrigger>
      <PopoverContent
        className="filter-pop"
        aria-label={say('columnsOf', { caption })}
        render={(drawn) => <div {...drawn} aria-labelledby={undefined} />}
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        /* Out of the bar, by name, as a filter's picker is: the bar is a form, and Enter in it asks the list. */
        container={container ?? popupContainer() ?? portalRoot()}
      >
        <fieldset className="facet">
          <legend className="facet-label">{say('columns')}</legend>
          {hidden.length > 0 && (
            <button type="button" className="facet-clear" onClick={() => onChange([])}>
              {say('showAll')}
            </button>
          )}
          <ul className="facet-values">
            {columns.map((column, at) => (
              <li key={column.name}>
                <label className="facet-option">
                  <input
                    type="checkbox"
                    checked={!hidden.includes(column.name)}
                    disabled={at === 0}
                    onChange={(event) =>
                      onChange(event.target.checked ? hidden.filter((name) => name !== column.name) : [...hidden, column.name])
                    }
                  />
                  <span className="facet-option-label">{column.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
