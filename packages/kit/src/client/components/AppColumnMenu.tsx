/**
 * An App list's column menu: the header's ⌄ with at most five entries.
 *
 * The Workbench keeps its power menu (ThMenu.tsx). In an App the reader
 * gets the two sorts in the column's own words, one Filter… that opens the
 * control the filter rail draws for the column (FilterRail.tsx's facet,
 * through the list bar's picker, so the three look and behave alike), Clear
 * filter while the column is narrowed, and Pin column, last. Where the list's
 * rail is beside the rows and already shows the column, Filter… goes to that
 * facet rather than opening a second one over it.
 *
 * What an open menu says and does is its own part (AppColumnMenuPopups.tsx),
 * loaded the first time a ⌄ is hovered, focused or opened.
 *
 * The list (AppList.tsx) provides what the menu writes through, as a ref
 * read when the menu is used: a context value that changed with every
 * keystroke in the search box would redraw the whole grid under it.
 */
import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type RefObject } from 'react';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { onDemand } from './onDemand.js';
import type { Box } from './FilterBoxes.js';
import type { FacetUnit } from './FilterRail.js';
import type { FilterPickerProps } from './ListFilterBar.js';
import { say as sayCopy } from '../copy/columnMenu/components/AppColumnMenu.js';

/** What an App list lends its grid's column menus. */
export interface AppColumnMenuHost {
  table: TableMeta;
  /** The whole question on screen, sort and all. */
  query: string;
  /** The reader's part of it, as the list's controls read it. */
  refinement: string;
  tabQuery: string;
  standing: string;
  /** The list's own key: its pins are its own, not its table's. */
  listKey: string;
  boxFor: (column: string) => Box | undefined;
  unitOf: (column: string) => FacetUnit | undefined;
  /** A new refinement, with the header whose menu asked for it taking the focus back. */
  apply: (refinement: string, column: string) => void;
  /** A new whole question (a sort), likewise. */
  navigate: (query: string, column: string) => void;
  /* Lent rather than imported, so the grid, which every surface draws, does
     not carry the list bar's pickers into rooms that have no App list. */
  /** The list bar's picker (ListFilterBar.tsx), which Filter… opens. */
  Picker: ComponentType<FilterPickerProps>;
  /** The rail's facet for the column, where a rail beside the rows shows it. */
  railFacet: (column: string) => HTMLElement | null;
}

/* The ⌄ a choice was made from, to take the focus back once the list has
   redrawn under it: the rows of a new question arrive after the navigation,
   and the header with them. A few seconds, not forever — a question that
   lands on no rows draws no header to come back to. */
let comeBack: { column: string; at: number } | null = null;
/** Say which column's ⌄ takes the focus when the grid next draws. */
export function returnFocusTo(column: string): void {
  comeBack = { column, at: Date.now() };
}

export const AppColumnMenuContext = createContext<RefObject<AppColumnMenuHost | null> | null>(null);
export const useAppColumnMenu = () => useContext(AppColumnMenuContext);

const Popups = onDemand(() => import('./AppColumnMenuPopups.js'), 'AppColumnMenuPopups', { quiet: true });

/** What a column's ⌄ is told of its column. */
export interface ColumnMenuProps {
  name: string;
  /** The column's caption, for the button's name and the popover's. */
  label: string;
  kind: string;
  meta: ColumnMeta | undefined;
  sortable: boolean;
  current: 'asc' | 'desc' | null;
  /** The path a reference is drawn by (`owner_id.name`), where the list names it. */
  drawnBy?: string;
  /** The columns as drawn, for the pin store's order. */
  columns: string[];
}

export function AppColumnMenuButton({ host, ...column }: ColumnMenuProps & { host: RefObject<AppColumnMenuHost | null> }) {
  const { name, label } = column;
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<'menu' | 'filter' | null>(null);
  /* Where the focus goes as the menu closes: back to the ⌄, or on into the
     popover or the rail, which take it themselves. */
  const handBack = useRef(true);
  useEffect(() => {
    if (!comeBack || comeBack.column !== name) return;
    if (Date.now() - comeBack.at < 3000) button.current?.focus();
    comeBack = null;
  });
  if (!host.current) return null;
  const soon = () => {
    void Popups.ready();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="th-filter"
        data-column={name}
        aria-label={sayCopy('columnOptions', { label })}
        title={sayCopy('sortFilterPin', { label })}
        aria-haspopup="menu"
        aria-expanded={open === 'menu'}
        onPointerEnter={soon}
        onFocus={soon}
        onClick={(e) => {
          e.stopPropagation();
          handBack.current = true;
          setOpen(open === 'menu' ? null : 'menu');
        }}
      >
        <span className="th-filter-icon" aria-hidden="true" />
      </button>
      {open && <Popups host={host} button={button} open={open} setOpen={setOpen} handBack={handBack} {...column} />}
    </>
  );
}
