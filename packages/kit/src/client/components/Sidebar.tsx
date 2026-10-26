/**
 * The sidebar's list: the app's menu or every table, drawn into the `ul`
 * the shell owns.
 *
 * Rows that name a table carry `data-table` (and, in an app, `data-navq`)
 * the way they always have, so the stylesheet, the tests and the keyboard
 * cannot tell the two lists apart. Two states light a row: `aria-current`
 * for the room on screen, `.active` for the keyboard's cursor — one row
 * usually, two while a skim has run ahead of its debounced preview, when
 * the list wears `skimming` so the stale one steps back.
 *
 * An app's rows carry a live count (navCounts.ts), asked for only while
 * the row is on screen; the workbench's carry the catalog's snapshot.
 *
 * The keyboard's moves are exported beside the component rather than
 * bound in it: the shell owns the filter box and the sidebar's key
 * handler, and the roving cursor is a store both read. A move flushes the
 * render synchronously so the row it lands on can be focused and scrolled
 * in the same keystroke.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import { shell } from '../shellMode.js';
import { openFavorite } from './favoriteNav.js';
import { favoriteId, favoritesVersion, subscribeFavorites } from './favorites.js';
import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { go, pageView, tableView, toast, state } from '../core.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appListQuery } from './appListModel.js';
import { useWalk } from './walk.js';
import { useCountsOnFocus, useInView, useNavCount, type NavCountSpec } from './navCounts.js';
import {
  currentDashView,
  currentFormView,
  currentSidebarIndex,
  effectiveCursor,
  railed,
  rowCount,
  setSidebarCursor,
  sidebarView,
  sidebarFilter,
  sidebarItems,
  sidebarVersion,
  stickyTab,
  subscribeSidebar,
  tableRows,
  setSidebarGroupCollapsed,
  type TableItem,
} from './sidebarModel.js';
import { NavGlyph } from './NavGlyph.js';
import { say } from '../copy/shell/components/Sidebar.js';

/* Whether the sidebar is folded: palette.js toggles `sidebar-hidden` on the
   body and announces each fold. In the icon rail the words are hidden, so a
   folded entry says its name on hover (its title) — and only then, since an
   open menu already shows every name. */
const subscribeFold = (notify: () => void) => {
  addHostListener(document, 'mistri:sidebar-fold', notify);
  return () => removeHostListener(document, 'mistri:sidebar-fold', notify);
};
const foldedNow = () => shellBody().classList.contains('sidebar-hidden');
import { dashPageId, formPageId } from './appRooms.js';
import { formatNumber } from '../locale.js';
import { addHostListener, removeHostListener, shellBody, shellQueryAll } from '../shellHost.js';

interface SidebarProps {
  /** The list element the tree is drawn into; it wears the skimming class. */
  host: HTMLElement;
  /** The mobile drawer owns a separate fixed footer. */
  footerHost?: HTMLElement | null;
  /** A destination was chosen, so an enclosing mobile drawer can dismiss. */
  onSelect?: () => void;
  /** Modal navigation uses ordinary Tab order, not the desktop roving cursor. */
  tabNavigation?: boolean;
}

/**
 * The Workbench's table list, drawn as it scrolls once it is long.
 *
 * A catalog of three hundred tables was three hundred rows in the DOM, each a
 * button with a count, before the reader had looked at one: 2,300 nodes on
 * the landing. Past WINDOWED rows the list draws the rows in view and a few
 * either side, with a spacer for the rest, the way the grid windows a long
 * result. An App's menu is never this long and is always drawn whole.
 */
const WINDOWED = 100;
const OVERSCAN_ROWS = 16;

/* The windowed list's way to put a row on screen before a key moves to it:
   moveSidebar asks for the row it lands on, which may not be drawn yet. */
let revealRow: ((index: number) => void) | null = null;

function useRowWindow(host: HTMLElement, count: number, on: boolean): { start: number; end: number; pitch: number } {
  /* Rows are one height (a table's name and its count, one line), read from
     two drawn rows: offsetTop and scrollTop are both layout pixels, the ruler
     a spacer's height is set in. */
  const [pitch, setPitch] = useState(26);
  const read = useCallback((): [number, number] => {
    const top = host.scrollTop,
      view = host.clientHeight || 800;
    return [Math.max(0, Math.floor(top / pitch) - OVERSCAN_ROWS), Math.min(count, Math.ceil((top + view) / pitch) + OVERSCAN_ROWS)];
  }, [host, count, pitch]);
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(count, 60)]);
  useLayoutEffect(() => {
    if (!on) return undefined;
    const update = () =>
      setRange((was) => {
        const next = read();
        return was[0] === next[0] && was[1] === next[1] ? was : next;
      });
    update();
    host.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(host);
    const reveal = (index: number) => {
      const top = index * pitch;
      if (top < host.scrollTop) host.scrollTop = top;
      else if (top + pitch > host.scrollTop + host.clientHeight) host.scrollTop = top + pitch - host.clientHeight;
      flushSync(update);
    };
    revealRow = reveal;
    return () => {
      host.removeEventListener('scroll', update);
      observer?.disconnect();
      if (revealRow === reveal) revealRow = null;
    };
  }, [on, host, read, pitch]);
  useLayoutEffect(() => {
    if (!on) return;
    const rows = host.querySelectorAll<HTMLElement>(':scope > li:not(.sidebar-spacer)');
    if (rows.length < 2) return;
    const measured = rows[1].offsetTop - rows[0].offsetTop;
    if (measured > 0 && Math.abs(measured - pitch) >= 0.5) setPitch(measured);
  });
  return on ? { start: Math.min(range[0], count), end: Math.min(range[1], count), pitch } : { start: 0, end: count, pitch };
}

/** A workspace's mark says its name's words, not its first two letters: "Payday demo workspace" is PD, not "Pa". */
export function identityInitials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

/* Where the shell follows no targets of the nav. */
const followNothing = () => {};

export function Sidebar({ host, footerHost: suppliedFooterHost, onSelect, tabNavigation = false }: SidebarProps) {
  useMessageLanguage();
  useWalk();
  useSyncExternalStore(subscribeSidebar, sidebarVersion, sidebarVersion);
  useSyncExternalStore(subscribeFavorites, favoritesVersion, favoritesVersion);
  useCountsOnFocus();
  const app = shell().inApp() ? shell().app() : null;
  const schema = state.schema as DatabaseSchema | null;
  /* The nav's targets into the suite's other Apps are the shell's to follow (shellMode.ts `navTargets`). */
  const targets = shell().slots.navTargets;
  const useFollowTargets = targets?.useFollow ?? followNothing;
  useFollowTargets(app, schema);
  useLayoutEffect(() => {
    const refresh = () => {
      if (app) targets?.refresh(app, schema);
    };
    // A drawer can mount while the desktop sidebar already holds this projection.
    if (tabNavigation) refresh();
    addHostListener(document, 'mistri:sidebar-fold', refresh);
    return () => removeHostListener(document, 'mistri:sidebar-fold', refresh);
  }, [app, schema, tabNavigation]);
  const items = sidebarItems(sidebarFilter());
  const current = currentSidebarIndex(items);
  const cursor = effectiveCursor(current);
  const dashView = currentDashView();
  const formView = currentFormView();
  /* Whether the cursor has run ahead of the table on screen. The preview
     behind the arrow keys is debounced, so for a beat the row being read
     and the row being pointed at are different rows. */
  const skimming = cursor >= 0 && cursor !== current;
  useLayoutEffect(() => {
    host.classList.toggle('skimming', skimming);
  }, [host, skimming]);
  const rail = !tabNavigation && railed();
  const folded = useSyncExternalStore(subscribeFold, foldedNow, () => false);
  const hover = (label: string) => (rail && folded ? label : undefined);
  const sidebar = shell().inApp() ? shell().app()?.ui?.shell?.sidebar : undefined;
  const footerHost = suppliedFooterHost ?? host.parentElement?.querySelector<HTMLElement>('#sidebar-app-footer');
  const pinned = Boolean(sidebar && footerHost);
  useLayoutEffect(() => {
    const parent = host.closest<HTMLElement>('.sidebar');
    if (!parent) return;
    if (sidebar) parent.dataset.density = sidebar.density ?? 'compact';
    else delete parent.dataset.density;
    return () => {
      delete parent.dataset.density;
    };
  }, [host, sidebar]);

  /* The menu's rows are not Tab stops: its filter is, and the arrows move
     from there. An App that hides the filter (`ui.shell.search`, a short
     menu) left the menu with no stop at all, unreachable from the keyboard
     and a scrolling list axe could not enter. Then the current row, or the
     first, is the one stop, and the arrows move from it as before. */
  useLayoutEffect(() => {
    if (tabNavigation) return;
    // The rows the cursor moves over, and the one this effect made a stop last time.
    const rows = [...host.querySelectorAll<HTMLElement>(':scope > li > :is(button, a[href]):is([tabindex="-1"], [data-roving])')];
    for (const row of rows) {
      row.tabIndex = -1;
      delete row.dataset.roving;
    }
    const filter = host.ownerDocument.getElementById('table-filter');
    if (filter && filter.offsetParent !== null) return;
    const stop =
      rows.find((row) => row === document.activeElement) ?? rows.find((row) => row.getAttribute('aria-current') === 'true') ?? rows[0];
    if (stop) {
      stop.tabIndex = 0;
      stop.dataset.roving = '';
    }
  });

  /* Each table row's place among the table rows, which is what the keyboard's
     cursor counts in; worked out over the whole list so a windowed slice of
     it numbers its rows as the whole list would. */
  const tableIndexes: number[] = [];
  let tables = -1;
  for (const item of items) tableIndexes.push(item.kind === 'table' ? (tables += 1) : -1);
  const windowed = !shell().inApp() && !tabNavigation && items.length > WINDOWED;
  const { start, end, pitch } = useRowWindow(host, items.length, windowed);
  const spacer = (key: string, rows: number) =>
    rows > 0 ? <li key={key} className="sidebar-spacer" aria-hidden="true" style={{ height: `${rows * pitch}px`, margin: 0 }} /> : null;
  return (
    <>
      {windowed && spacer('above', start)}
      {items.slice(start, end).map((item, at) => {
        const i = start + at;
        /* The depth is the button's own inset (features.css reads it), not the
           row's: as padding on the <li> it moved the current fill in with the
           words, so a nested room's fill began 13px right of a top-level one's. */
        const order = item.footOrder ? { order: item.footOrder } : undefined;
        const indent =
          item.depth && !(rail && folded) ? ({ '--nav-indent': `${Math.min(item.depth, 4) * 12}px`, ...order } as CSSProperties) : order;
        switch (item.kind) {
          case 'target':
            return (
              <li key={`target:${i}:${item.href}`} style={indent}>
                <a
                  className="app-nav-target"
                  href={item.href}
                  tabIndex={tabNavigation ? 0 : -1}
                  title={hover(item.label)}
                  onClick={(event) => {
                    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) onSelect?.();
                  }}
                >
                  <NavGlyph label={item.label} railed={rail} color={item.color} />
                  <span className="nav-label">{item.label}</span>
                </a>
              </li>
            );
          case 'gap':
            return <li key="foot-gap" className="nav-foot-gap" aria-hidden="true" />;
          case 'group':
            return (
              <li
                key={item.groupId ?? `g${i}`}
                className="nav-group"
                /* The nested heading's inset over the look's own (style.css, a look's nav recipe): an inline padding
                   set the plain look's 8px, so in Lumen (12px) a nested heading stood out of line with its parent's. */
                style={
                  item.depth && !(rail && folded)
                    ? ({ '--nav-group-inset': `${Math.max(0, Math.min(item.depth, 4) - 1) * 12}px`, ...order } as CSSProperties)
                    : order
                }
              >
                <span role="heading" aria-level={Math.min((item.depth ?? 0) + 2, 6)}>
                  {item.groupId && !(rail && folded) ? (
                    <button
                      type="button"
                      className="nav-group-fold"
                      aria-expanded={item.expanded}
                      aria-disabled={item.reveal || undefined}
                      title={item.reveal ? say('keptOpenForTheCurrent') : undefined}
                      onClick={() => {
                        if (!item.reveal) setSidebarGroupCollapsed(item.groupId!, Boolean(item.expanded), Boolean(item.folded));
                      }}
                    >
                      <span>{item.label}</span>
                      <svg
                        aria-hidden="true"
                        className="nav-group-chevron"
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        {/* Where its rows are: below a heading, above one anchored at the foot. */}
                        <path d={item.expanded ? (item.anchored ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4') : 'M6 4l4 4-4 4'} />
                      </svg>
                    </button>
                  ) : (
                    item.label
                  )}
                </span>
              </li>
            );
          case 'favorite':
            return (
              <li key={`s${favoriteId(item.favorite)}`} className="nav-favorite">
                <button
                  type="button"
                  tabIndex={tabNavigation ? 0 : -1}
                  title={hover(item.label)}
                  onClick={() => {
                    const app = shell().app();
                    if (app) {
                      openFavorite(app, item.favorite);
                      onSelect?.();
                    }
                  }}
                >
                  <NavGlyph label={item.label} railed={rail} rail="star" />
                  <span className="nav-label">{item.label}</span>
                </button>
              </li>
            );
          case 'note':
            return (
              <li key={`n${i}`}>
                <p className="note">{item.text}</p>
              </li>
            );
          case 'missing':
            return (
              <li key={`m${i}`} style={indent}>
                <button type="button" className="nav-missing" title={hover(item.label)} onClick={() => toast(item.error, 'error')}>
                  <NavGlyph icon={item.icon} label={item.label} railed={rail} color={item.navColor} />
                  <span className="nav-label">{item.label}</span>
                  <span className="view-tag">{say('missing')}</span>
                </button>
              </li>
            );
          case 'dash':
            return (
              <li key={`d${item.view}`} style={indent}>
                <button
                  type="button"
                  className={item.error ? 'nav-missing' : undefined}
                  data-dash={dashPageId(item.view)}
                  aria-current={Boolean(dashView) && item.view === dashView ? 'true' : 'false'}
                  tabIndex={tabNavigation ? 0 : -1}
                  title={hover(item.label)}
                  onClick={
                    item.error
                      ? () => toast(item.error ?? '', 'error')
                      : () => {
                          go(pageView(dashPageId(item.view), undefined, undefined, item.label), 'reset');
                          onSelect?.();
                        }
                  }
                >
                  <NavGlyph icon={item.icon} label={item.label} railed={rail} color={item.navColor} />
                  <span className="nav-label">{item.label}</span>
                  {item.error ? <span className="view-tag">{say('missing')}</span> : null}
                </button>
              </li>
            );
          case 'form':
            return (
              <li key={`f${item.view}`} style={indent}>
                <button
                  type="button"
                  className={item.error ? 'nav-missing' : undefined}
                  data-form={item.page ?? formPageId(item.view)}
                  aria-current={(item.page ?? item.view) === formView ? 'true' : 'false'}
                  tabIndex={tabNavigation ? 0 : -1}
                  title={hover(item.label)}
                  onClick={
                    item.error
                      ? () => toast(item.error ?? '', 'error')
                      : () => {
                          go(pageView(item.page ?? formPageId(item.view), undefined, undefined, item.label), 'reset');
                          onSelect?.();
                        }
                  }
                >
                  <NavGlyph icon={item.icon} label={item.label} railed={rail} color={item.navColor} />
                  <span className="nav-label">{item.label}</span>
                  {item.error ? <span className="view-tag">{say('missing')}</span> : null}
                </button>
              </li>
            );
          case 'table': {
            const index = tableIndexes[i];
            return (
              <li key={`r${item.table}|${item.navq ?? '-'}|${i}`} style={indent}>
                <TableRow
                  item={item}
                  index={index}
                  current={index === current}
                  active={cursor >= 0 && index === cursor}
                  rail={rail}
                  quiet={rail && folded}
                  title={hover(item.label)}
                  onSelect={onSelect}
                  tabNavigation={tabNavigation}
                />
              </li>
            );
          }
        }
      })}
      {windowed && spacer('below', items.length - end)}
      {pinned && footerHost
        ? createPortal(
            <>
              {sidebar?.footer ? (
                <div className="sidebar-identity" title={sidebar.footer.title}>
                  <span className="sidebar-identity-mark" aria-hidden="true">
                    {identityInitials(sidebar.footer.title)}
                  </span>
                  <span className="sidebar-identity-copy">
                    <strong>{sidebar.footer.title}</strong>
                    {sidebar.footer.description ? <span>{sidebar.footer.description}</span> : null}
                  </span>
                </div>
              ) : null}
            </>,
            footerHost,
          )
        : null}
    </>
  );
}

/* `quiet`: folded into the rail, where a row shows its icon and no number, so it asks for no count. */
function TableRow({
  item,
  index,
  current,
  active,
  rail,
  quiet,
  title,
  onSelect,
  tabNavigation = false,
}: {
  item: TableItem;
  index: number;
  current: boolean;
  active: boolean;
  rail: boolean;
  quiet: boolean;
  title?: string;
  onSelect?: () => void;
  tabNavigation?: boolean;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const snapshot = rowCount(item, undefined);
  /* Named by its label alone and the count said as its description: named
     with the number, a row was "Website 1", which a screen reader reads as
     its name and a test or a voice command has to guess at. */
  const labelId = useId(),
    countId = useId();
  return (
    /* Out of the tab order, in the arrow order: sixty-six tables in the
       tab sequence means Tab is useless for what Tab is for. The list is
       one stop, moved within by the arrows. */
    <button
      ref={row}
      type="button"
      data-table={item.table}
      data-navq={item.navq}
      data-table-index={index}
      tabIndex={tabNavigation ? 0 : -1}
      aria-current={current ? 'true' : 'false'}
      aria-labelledby={labelId}
      aria-describedby={countId}
      className={active ? 'active' : undefined}
      title={title}
      onClick={
        item.entry
          ? /* A list opens on its first tab — the app decided what matters
           most — not on the bare unfiltered table. */
            () => {
              go({ ...tableView(item.table, appListQuery(item.entry!)), view: item.entry!.id }, 'reset');
              onSelect?.();
            }
          : /* Stays on the tab you were reading: comparing two tables'
           diagrams should not mean landing back on Rows. */
            () => {
              go(tableView(item.table, undefined, stickyTab()), 'reset');
              onSelect?.();
            }
      }
    >
      <NavGlyph icon={item.icon} label={item.label} railed={rail} color={item.navColor} />
      <span className="nav-label" id={labelId}>
        {item.label}
      </span>
      {item.tag === 'view' ? (
        <span className="view-tag" id={countId}>
          {say('view')}
        </span>
      ) : item.counted ? (
        <LiveCount item={item} spec={item.counted} row={row} quiet={quiet} id={countId} />
      ) : snapshot != null ? (
        <span className="rows" id={countId}>
          {snapshot}
        </span>
      ) : null}
    </button>
  );
}

/** Its own component, so only a counted row holds a query. */
function LiveCount({
  item,
  spec,
  row,
  quiet,
  id,
}: {
  item: TableItem;
  spec: NavCountSpec;
  row: RefObject<HTMLButtonElement | null>;
  quiet: boolean;
  id: string;
}) {
  const visible = useInView(row);
  // A folded menu asks nothing, rail or not: a rail row is on screen but shows no number.
  const live = useNavCount(spec, visible && !quiet);
  const text = rowCount(item, live);
  if (text == null) return null;
  return (
    <span
      className={item.late && live && live.count > 0 ? 'rows is-overdue' : 'rows'}
      id={id}
      title={
        live?.capped
          ? say('moreThanTheMenu', { count: formatNumber(live.count) })
          : live?.exact === false
            ? say('roughlyFromTheDatabases')
            : undefined
      }
    >
      {text}
    </span>
  );
}

/** Pending preview, so holding an arrow key does not fire a query per row. */
let previewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Move the highlight, and show what it lands on.
 *
 * Highlight moves immediately; the query follows a beat later, so holding
 * the key down skims the list without firing sixty-six queries on the way
 * past. Navigation is a replace, not a push: skimming should not fill the
 * browser's history with every table you scrolled past.
 *
 * Focus moves with the highlight — except out of the filter field: if you
 * are typing there, the highlight is a cursor into the list rather than a
 * place your hands are.
 */
export function moveSidebar(delta: number, host: HTMLElement, filterInput: Element | null): void {
  // An App with external targets skims controls by focus, never by loading a foreign room.
  if (host.querySelector('a.app-nav-target')) {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    const controls = [...host.querySelectorAll<HTMLElement>(':scope > li > :is(button, a[href])')];
    if (!controls.length) return;
    const from = controls.indexOf(document.activeElement as HTMLElement);
    const next = controls[(from + delta + controls.length) % controls.length];
    for (const control of controls) {
      control.tabIndex = control === next ? 0 : -1;
      delete control.dataset.roving;
    }
    next.dataset.roving = '';
    next.focus({ preventScroll: true });
    next.scrollIntoView?.({ block: 'nearest' });
    const index = next.dataset.tableIndex;
    if (index !== undefined) {
      const items = sidebarItems(sidebarFilter());
      const row = tableRows(items)[Number(index)];
      if (row) {
        flushSync(() => setSidebarCursor(Number(index)));
        previewTimer = setTimeout(() => {
          go(sidebarView(row, stickyTab()), 'replace');
        }, 110);
      }
    }
    return;
  }
  const items = sidebarItems(sidebarFilter());
  const rows = tableRows(items);
  if (!rows.length) return;
  const from = effectiveCursor(currentSidebarIndex(items));
  // Wraps, so holding one arrow key cycles rather than sticking at the end.
  const next = (from + delta + rows.length) % rows.length;
  flushSync(() => setSidebarCursor(next));
  const find = () => host.querySelector<HTMLButtonElement>(`button[data-table-index="${next}"]`);
  /* A windowed list may not have drawn the row yet: scroll it into the window first. */
  if (!find()) revealRow?.(items.findIndex((item) => item === rows[next]));
  const button = find();
  if (!button) return;
  if (document.activeElement !== filterInput) button.focus({ preventScroll: true });
  button.scrollIntoView?.({ block: 'nearest' });
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const row = rows[next];
    go(sidebarView(row, stickyTab()), 'replace');
  }, 110);
}

/**
 * Enter in the filter box commits the obvious row — the highlighted one,
 * else the first — as a push, so the table you chose is a place you can
 * come back to, unlike the ones you skimmed past. Dressed the way the click
 * dresses it, in app mode. False when there is nothing to open.
 */
export function openSidebarChoice(): boolean {
  const items = sidebarItems(sidebarFilter());
  const rows = tableRows(items);
  const from = effectiveCursor(currentSidebarIndex(items));
  const first = items.find((item) => item.kind !== 'group' && item.kind !== 'note');
  if (from < 0 && first?.kind === 'target') {
    const anchor = [...shellQueryAll<HTMLAnchorElement>('#table-list a.app-nav-target')].find(
      (link) => link.getAttribute('href') === first.href && link.querySelector('.nav-label')?.textContent === first.label,
    );
    if (!anchor) return false;
    anchor.click();
    return true;
  }
  const row = rows[from >= 0 ? from : 0];
  if (!row) return false;
  go(sidebarView(row, stickyTab()), 'reset');
  return true;
}
