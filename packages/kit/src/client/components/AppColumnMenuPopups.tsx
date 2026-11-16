/**
 * The App column menu's open half: its entries, and the rail's control
 * Filter… opens (AppColumnMenu.tsx draws the ⌄ that opens it).
 *
 * Every column of an App list's grid draws a ⌄, and a reader opens few of
 * them; so what a menu says and does arrives on demand, the first time one
 * is hovered, focused or opened, and a list's first page carries only the
 * buttons.
 */
import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import { createMenuController, Menu, MenuContent, MenuItem, MenuSeparator } from '@ui-sdk/react/menu';
import { createPopoverController, Popover, PopoverContent } from '@ui-sdk/react/popover';
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
import { popupContainer, portalRoot } from '../shellHost.js';

/* Where the menu and the filter are drawn: out of the table, by name. UI SDK draws a layer where its trigger is
   unless it is told where, and the ⌄ is in a column's head: a form drawn there is a form inside whatever the grid
   stands in, and every key pressed in the layer went up through the table. The dialog the grid is in keeps the
   layer, so it stays inside that dialog's focus. */
const layerHost = (trigger: Element | null): HTMLElement =>
  trigger?.closest<HTMLElement>('dialog, [role="dialog"]') ?? popupContainer() ?? portalRoot();

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
  /* Neither layer has a trigger of its own (the ⌄ is AppColumnMenu's, which holds the open state), so each is
     opened and closed through a controller: a layer that is simply drawn open is given no focus, and these are
     asked for by a press, so the keyboard has to arrive in them. */
  const [menu] = useState(() => createMenuController());
  const [filter] = useState(() => createPopoverController());
  useEffect(() => {
    if (open === 'menu') void menu.open({ anchor: button.current ?? undefined, focus: 'popup' });
    else menu.close();
    if (open === 'filter') void filter.open({ anchor: button.current ?? undefined });
    else filter.close();
  }, [open, menu, filter, button]);
  /* The keyboard goes back to the ⌄, unless what was chosen takes it on (the popover, the rail's facet). Said
     here and not left to the menu: choosing an entry takes this whole part off the page, menu and all. */
  const giveBack = () => {
    if (handBack.current && button.current?.isConnected) button.current.focus();
  };
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
    giveBack();
    if ((key === 'asc' || key === 'desc') && sortPath) h.navigate(nextSort(h.query, sortPath, key), name);
    else if (key === 'clear') h.apply(withCondition(h.refinement, name, ''), name);
    else if (key === 'pin') togglePin(h.table, columns, name, h.listKey);
  };

  return (
    <>
      {/* UI SDK owns the menu's keyboard: focus moves in on open, the arrows
          walk the entries, Escape closes it and hands the focus back to the ⌄. */}
      <Menu
        controller={menu}
        onOpenChange={(next, details) => {
          if (next) return;
          setOpen((was) => (was === 'menu' ? null : was));
          /* Escape is a step back to where the reader was; a press elsewhere has already said where it is going. */
          if (details.reason === 'escape-key') giveBack();
        }}
      >
        <MenuContent
          className="th-menu th-menu-app"
          aria-label={sayCopy('labelColumn', { label })}
          anchor={button.current}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          container={layerHost(button.current)}
          finalFocus={() => (handBack.current && button.current?.isConnected ? button.current : null)}
        >
          {entries.map((entry, i) => (
            <Fragment key={entry.key}>
              {/* The pin is about reading the table, not narrowing it: last, and set apart. */}
              {entry.key === 'pin' && i > 0 ? <MenuSeparator className="th-menu-sep" /> : null}
              <MenuItem
                render={<button type="button" />}
                className={`th-menu-item${entry.key === 'pin' ? ' th-menu-quiet' : ''}`}
                closeOnSelect={false}
                onSelect={() => choose(entry.key)}
                aria-label={entry.detail ? `${entry.label}: ${entry.detail}` : undefined}
              >
                <span className="th-menu-label">{entry.label}</span>
                {entry.detail ? <span className="th-menu-said">{entry.detail}</span> : null}
              </MenuItem>
            </Fragment>
          ))}
        </MenuContent>
      </Menu>
      <Popover
        controller={filter}
        onOpenChange={(next) => {
          if (!next) setOpen((was) => (was === 'filter' ? null : was));
        }}
      >
        {box && (
          <PopoverContent
            ref={popup}
            className="filter-pop"
            aria-label={sayCopy('filterBy', { label })}
            anchor={button.current}
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            container={layerHost(button.current)}
            initialFocus={() =>
              popup.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([aria-hidden="true"])') ?? popup.current
            }
            finalFocus={() => (button.current?.isConnected ? button.current : null)}
          >
            <h.Picker
              box={box}
              table={h.table}
              refinement={h.refinement}
              standing={h.standing}
              unit={h.unitOf(name)}
              owned={mentionsColumn(h.tabQuery, name)}
              /* Closed as it applies, as a sort from the menu is: a refinement keeps the room, and the header with it. */
              apply={(text) => {
                setOpen(null);
                h.apply(text, name);
              }}
              close={() => setOpen(null)}
            />
          </PopoverContent>
        )}
      </Popover>
    </>
  );
}
