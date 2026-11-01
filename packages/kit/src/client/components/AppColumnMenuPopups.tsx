/**
 * The App column menu's open half: its entries, and the rail's control
 * Filter… opens (AppColumnMenu.tsx draws the ⌄ that opens it).
 *
 * Every column of an App list's grid draws a ⌄, and a reader opens few of
 * them; so what a menu says and does arrives on demand, the first time one
 * is hovered, focused or opened, and a list's first page carries only the
 * buttons.
 */
import { Fragment, useRef, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/internal/anchor.js';
import { columnDisplay, findTable, labelColumn } from '../core.js';
import { nextSort, sortDirection } from '../clauses.js';
import { mentionsColumn, ownedTails, withCondition } from '../filterbar.js';
import { pinnedFor, togglePin } from '../pins.js';
import { vocabularyWord } from '@mistriwork/engine/shared/model.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { wordFor, type DisplayRule } from './valueModel.js';
import { appMenuEntries, sortWords, type AppMenuKey } from './appColumnMenuModel.js';
import { facetActive } from './filterRailModel.js';
import { useConditionWords } from './useConditionWords.js';
import type { AppColumnMenuHost, ColumnMenuProps } from './AppColumnMenu.js';
import { say as sayCopy } from '../copy/columnMenu/components/AppColumnMenuPopups.js';
import { popupContainer } from '../shellHost.js';

/* How a flag's two values read where no display rule words them. */
const FLAG_WORDS: Record<string, string> = { true: sayCopy('common.yes'), false: sayCopy('common.no') };

interface PopupsProps extends ColumnMenuProps {
  host: RefObject<AppColumnMenuHost | null>;
  button: RefObject<HTMLButtonElement | null>;
  open: 'menu' | 'filter' | null;
  setOpen: (next: 'menu' | 'filter' | null | ((was: 'menu' | 'filter' | null) => 'menu' | 'filter' | null)) => void;
  /** Where the focus goes as the menu closes: back to the ⌄, or on into the popover or the rail. */
  handBack: RefObject<boolean>;
}

export function AppColumnMenuPopups({
  host,
  button,
  open,
  setOpen,
  handBack,
  name,
  label,
  kind,
  meta,
  sortable,
  current,
  columns,
  drawnBy,
}: PopupsProps) {
  const popup = useRef<HTMLDivElement>(null);
  /* The column's own conditions, said as its chip says them, beside Clear filter. */
  const tails = host.current ? (ownedTails(host.current.refinement, name) as string[]) : [];
  const { speaker, sayTails } = useConditionWords(
    host.current?.table,
    tails.map((tail) => `${name} ${tail}`),
  );
  const h = host.current;
  if (!h) return null;
  const box = h.boxFor(name);
  const column = (box?.meta ?? meta) as (ColumnMeta & { allowed?: string[] }) | undefined;
  const rule = columnDisplay(h.table.id, name) as DisplayRule | null;
  const say = (value: string) => wordFor(rule, value) ?? (column?.allowed?.length ? vocabularyWord(value) : (FLAG_WORDS[value] ?? value));
  /* A reference sorts by the name it is drawn by, not the id under it: an
     order by `owner_id` is an order nobody reading the list can see. */
  const target = column?.references ? (findTable(column.references.table) as TableMeta | undefined) : undefined;
  const byName = drawnBy ?? (target && labelColumn(target) ? `${name}.${labelColumn(target)}` : undefined);
  const sortPath = column?.references ? byName : name;
  const order = sortPath && sortPath !== name ? (sortDirection(h.query, sortPath) as 'asc' | 'desc' | null) : current;
  const filterable = Boolean(box?.meta) && (!h.table.filterable || h.table.filterable.includes(name));
  const pinned = pinnedFor(h.table, columns, h.listKey).includes(name);
  const entries = appMenuEntries({
    words: sortPath === name ? sortWords(kind, column, say) : sortWords('text', undefined),
    sortable: sortable && Boolean(sortPath),
    current: order,
    filterable,
    filtered: facetActive(h.refinement, name, h.tabQuery),
    cleared: speaker && tails.length ? sayTails(speaker, name, tails) : undefined,
    pinned,
  });

  const choose = (key: AppMenuKey) => {
    if (key === 'filter') {
      handBack.current = false;
      const facet = h.railFacet(name);
      /* The value already chosen, else the facet's first field: its Clear comes first in the markup, not in the reading. */
      const control =
        facet?.querySelector<HTMLElement>('input:checked') ??
        facet?.querySelector<HTMLElement>('input:not([type="hidden"])') ??
        facet?.querySelector<HTMLElement>('button');
      if (!facet || !control) {
        setOpen('filter');
        return;
      }
      setOpen(null);
      /* Once the menu has gone: while it is open the page outside it is inert, and takes no focus. */
      setTimeout(() => {
        facet.scrollIntoView?.({ block: 'nearest' });
        control.focus();
      }, 0);
      return;
    }
    setOpen(null);
    if ((key === 'asc' || key === 'desc') && sortPath) h.navigate(nextSort(h.query, sortPath, key), name);
    else if (key === 'clear') h.apply(withCondition(h.refinement, name, ''), name);
    else if (key === 'pin') togglePin(h.table, columns, name, h.listKey);
  };

  return (
    <>
      {/* Base UI owns the menu's keyboard: focus moves in on open, the arrows
          walk the entries, Escape closes it and hands the focus back to the ⌄. */}
      <Menu.Root
        open={open === 'menu'}
        onOpenChange={(next) => {
          if (!next) setOpen((was) => (was === 'menu' ? null : was));
        }}
      >
        <Menu.Portal container={popupContainer()}>
          <Menu.Positioner
            anchor={() => (button.current ? zoomAnchor(button.current) : null)}
            positionMethod="fixed"
            side="bottom"
            align="start"
            sideOffset={4}
            collisionBoundary={layoutViewport()}
            collisionPadding={12}
            style={{ zIndex: 40 }}
          >
            <Menu.Popup
              className="th-menu th-menu-app"
              aria-label={sayCopy('labelColumn', { label })}
              finalFocus={() => (handBack.current && button.current?.isConnected ? button.current : false)}
            >
              {entries.map((entry, i) => (
                <Fragment key={entry.key}>
                  {/* The pin is about reading the table, not narrowing it: last, and set apart. */}
                  {entry.key === 'pin' && i > 0 ? <Menu.Separator className="th-menu-sep" /> : null}
                  <Menu.Item
                    render={<button type="button" className={`th-menu-item${entry.key === 'pin' ? ' th-menu-quiet' : ''}`} />}
                    nativeButton
                    closeOnClick={false}
                    onClick={() => choose(entry.key)}
                    aria-label={entry.detail ? `${entry.label}: ${entry.detail}` : undefined}
                  >
                    <span className="th-menu-label">{entry.label}</span>
                    {entry.detail ? <span className="th-menu-said">{entry.detail}</span> : null}
                  </Menu.Item>
                </Fragment>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {box && open === 'filter' && (
        <Popover.Root
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
        >
          <Popover.Portal container={popupContainer()}>
            <Popover.Positioner
              anchor={() => (button.current ? zoomAnchor(button.current) : null)}
              positionMethod="fixed"
              side="bottom"
              align="start"
              sideOffset={6}
              collisionBoundary={layoutViewport()}
              collisionPadding={8}
              style={{ zIndex: 40 }}
            >
              <Popover.Popup
                ref={popup}
                className="filter-pop"
                aria-label={sayCopy('filterBy', { label })}
                initialFocus={() =>
                  popup.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([aria-hidden="true"])') ?? popup.current ?? true
                }
                finalFocus={() => (button.current?.isConnected ? button.current : false)}
              >
                <h.Picker
                  box={box}
                  table={h.table}
                  refinement={h.refinement}
                  standing={h.standing}
                  unit={h.unitOf(name)}
                  owned={mentionsColumn(h.tabQuery, name)}
                  apply={(text) => h.apply(text, name)}
                  close={() => setOpen(null)}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}
