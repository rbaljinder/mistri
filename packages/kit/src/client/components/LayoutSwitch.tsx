/**
 * A list read as rows or as a board (listInference.ts inferBoard): a two-icon segmented control at the end of the
 * filter bar, drawn as a phone's Records/Table switch is (PresentationSwitch.tsx) but at every width, the names on
 * the buttons for a screen reader. The reader's choice is kept in their browser per view, as a board's folded lanes are: it is
 * how they like to read the list, not a question about it, so the address does not carry it. The views read as boards
 * are said in a cookie too (boardLanes.ts BOARD_COOKIE), so a page opened on one carries the board's reads, not the
 * list's (firstPaintRooms.ts).
 */
import { useCallback, useState } from 'react';
import { BOARD_COOKIE } from '@mistriwork/engine/shared/boardLanes.js';
import { say } from '../copy/lists/components/LayoutSwitch.js';

type ListLayout = 'list' | 'board';

const KEY = 'mistri.listLayout';

/** The cookie says what the store says: a year, for this site's every path, never sent to another site. */
function sayBoards(all: Record<string, unknown>): void {
  const boards = Object.keys(all).filter((view) => all[view] === 'board');
  document.cookie = boards.length
    ? `${BOARD_COOKIE}=${boards.map(encodeURIComponent).join(',')}; path=/; max-age=31536000; SameSite=Lax`
    : `${BOARD_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

function kept(view: string | undefined): ListLayout {
  if (!view) return 'list';
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    // A choice kept before the cookie said it is said now, so the next page carries it.
    if (all[view] === 'board' && !document.cookie.includes(`${BOARD_COOKIE}=`)) sayBoards(all);
    return all[view] === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

function keep(view: string, layout: ListLayout): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    if (layout === 'list') delete all[view];
    else all[view] = layout;
    localStorage.setItem(KEY, JSON.stringify(all));
    sayBoards(all);
  } catch {
    /* A browser that keeps nothing still switches; it forgets on the next visit. */
  }
}

/** The layout a view is read in, and the way to change it; always the list where the view offers no board. */
export function useListLayout(view: string | undefined, offered: boolean): [ListLayout, (layout: ListLayout) => void] {
  const [layout, setLayout] = useState<ListLayout>(() => (offered ? kept(view) : 'list'));
  const change = useCallback(
    (next: ListLayout) => {
      setLayout(next);
      if (view) keep(view, next);
    },
    [view],
  );
  return [offered ? layout : 'list', change];
}

export function LayoutSwitch({ layout, onChange, label }: { layout: ListLayout; onChange: (layout: ListLayout) => void; label: string }) {
  return (
    <div className="list-layout" role="group" aria-label={label}>
      {(['list', 'board'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="list-layout-seg"
          aria-pressed={layout === mode}
          aria-label={mode === 'list' ? say('asList') : say('asBoard')}
          title={mode === 'list' ? say('asList') : say('asBoard')}
          onClick={() => onChange(mode)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
            {mode === 'list' ? (
              <path d="M2 4h12M2 8h12M2 12h12" />
            ) : (
              <>
                <rect x="2" y="2.5" width="3" height="11" rx="0.5" />
                <rect x="6.5" y="2.5" width="3" height="7" rx="0.5" />
                <rect x="11" y="2.5" width="3" height="9" rx="0.5" />
              </>
            )}
          </svg>
        </button>
      ))}
    </div>
  );
}
