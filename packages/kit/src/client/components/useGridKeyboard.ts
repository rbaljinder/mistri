/**
 * Moving around a result without a mouse.
 *
 * Arrow keys move a cell cursor, Enter opens the row's record — which is
 * the walk, done from the keyboard. Everything else follows from those two
 * and from the grid pattern people already know from a spreadsheet.
 *
 * The position is held as `(row, column)` indices, not elements. Above a
 * few hundred rows the table is virtualised and the `<tr>` under the cursor
 * is destroyed the moment it scrolls out of the window; indices survive
 * that, the element is looked up again on every move, and when the row has
 * not been painted yet the scroller is moved and the lookup retried.
 *
 * The hook version of grid.js: the same contract, with the listeners taken
 * down when the table or its shape changes rather than stacked on the
 * element by every repaint.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { viewportBox } from '../core.js';
import { shellById, shellQuery } from '../shellHost.js';

/** Rows moved by PageUp/PageDown when the viewport cannot be measured. */
const PAGE_FALLBACK = 20;
/** How many frames to wait for the virtualiser to paint a row we scrolled to. */
const PAINT_TRIES = 4;

interface GridKeyboardOptions {
  rowCount: number;
  columnCount: number;
  /** Leading cells before the first data column (an expander). */
  offset: number;
  onOpen?: (index: number) => void;
  /** Space: a glance at the row's record without leaving the list. */
  onPeek?: (index: number) => void;
  /** So a screen reader hears "of 63,010" rather than "of 20". */
  totalRows?: number;
  firstRow: number;
}

export function useGridKeyboard(
  tableRef: RefObject<HTMLTableElement | null>,
  wrapRef: RefObject<HTMLElement | null>,
  opts: GridKeyboardOptions,
): void {
  /* The cursor survives repaints: a sort that redraws the rows should not
     send the reader back to the top-left corner. */
  const cursor = useRef({ row: -1, col: 0 });
  const { rowCount, columnCount, offset, onOpen, onPeek, totalRows, firstRow } = opts;

  useEffect(() => {
    const table = tableRef.current;
    const wrap = wrapRef.current;
    if (!table || !wrap || !rowCount || !columnCount) return;
    const tbody = table.tBodies[0];
    if (!tbody) return;

    table.setAttribute('role', 'grid');
    table.setAttribute('aria-colcount', String(columnCount + offset));
    if (typeof totalRows === 'number') {
      table.setAttribute('aria-rowcount', String(totalRows));
      table.querySelector('thead tr')?.setAttribute('aria-rowindex', '1');
      for (const tr of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-row]')) {
        tr.setAttribute('aria-rowindex', String(firstRow + Number(tr.dataset.row) + 2));
      }
    } else {
      table.removeAttribute('aria-rowcount');
    }

    const scrollerOf = () => (wrap.closest('.content') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement | null);
    const rowAt = (i: number) => tbody.querySelector<HTMLTableRowElement>(`tr[data-row="${i}"]`);
    const cellAt = (i: number, c: number) => (rowAt(i)?.children[c + offset] as HTMLElement | undefined) ?? null;

    const pageSize = () => {
      const sample = tbody.querySelector('tr[data-row]');
      const height = sample ? viewportBox(sample).height : 0;
      const view = scrollerOf()?.clientHeight;
      if (!height || !view) return PAGE_FALLBACK;
      return Math.max(1, Math.floor(view / height) - 1);
    };

    const focusCell = (tries = PAINT_TRIES) => {
      const { row, col } = cursor.current;
      const cell = cellAt(row, col);
      if (!cell) {
        if (tries <= 0) return;
        const sample = tbody.querySelector('tr[data-row]');
        const height = sample ? viewportBox(sample).height : 0;
        const scroller = scrollerOf();
        if (scroller && height) scroller.scrollTop = Math.max(0, row * height - scroller.clientHeight / 2);
        requestAnimationFrame(() => focusCell(tries - 1));
        return;
      }
      for (const stale of tbody.querySelectorAll<HTMLElement>('.cell-cursor')) {
        stale.classList.remove('cell-cursor');
        stale.removeAttribute('tabindex');
      }
      cell.classList.add('cell-cursor');
      cell.tabIndex = 0;
      /* The grid's tab stop moves to the cell, so tabbing in returns to
         where the cursor was left, and the table and the cell are never
         both stops. */
      table.tabIndex = -1;
      cell.focus({ preventScroll: true });
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };

    const moveTo = (nextRow: number, nextCol: number) => {
      cursor.current = {
        row: Math.max(0, Math.min(rowCount - 1, nextRow)),
        col: Math.max(0, Math.min(columnCount - 1, nextCol)),
      };
      focusCell();
    };

    /* One stop for the whole grid, not one per cell. */
    table.tabIndex = 0;
    const onFocus = (e: FocusEvent) => {
      if (e.target !== table) return;
      const { row, col } = cursor.current;
      moveTo(row < 0 ? 0 : row, col);
    };
    // A click is also a way of saying where the cursor is.
    const onMouseDown = (e: MouseEvent) => {
      const cell = (e.target as Element).closest('td');
      const tr = cell?.closest<HTMLTableRowElement>('tr[data-row]');
      if (!cell || !tr) return;
      cursor.current = { row: Number(tr.dataset.row), col: Math.max(0, [...tr.children].indexOf(cell) - offset) };
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest('input, textarea, select, [contenteditable]')) return;
      if (e.altKey) return;
      /* A control inside the grid — a header's sort, a row's expander, what a
         decoration puts in a row — answers its own Enter. The cursor's Enter
         opens a row from a cell; taken from a button it opened whichever row
         was last clicked instead of pressing the button, and a header that
         keeps its focus across a sort is exactly where a second Enter lands. */
      if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).closest('button, a')) return;
      const jump = e.metaKey || e.ctrlKey;
      const { row, col } = cursor.current;
      switch (e.key) {
        case 'ArrowDown':
          moveTo(jump ? rowCount - 1 : row + 1, col);
          break;
        case 'ArrowUp':
          moveTo(jump ? 0 : row - 1, col);
          break;
        case 'ArrowRight':
          moveTo(row, jump ? columnCount - 1 : col + 1);
          break;
        case 'ArrowLeft':
          moveTo(row, jump ? 0 : col - 1);
          break;
        case 'Home':
          moveTo(jump ? 0 : row, 0);
          break;
        case 'End':
          moveTo(jump ? rowCount - 1 : row, columnCount - 1);
          break;
        case 'PageDown':
          moveTo(row + pageSize(), col);
          break;
        case 'PageUp':
          moveTo(row - pageSize(), col);
          break;
        case 'Enter': {
          /* A cell holding more than its line — a JSON document — opens
             that, and a cell the list edits in place opens its editor; the
             row is a cell away. */
          const opener = cellAt(row, col)?.querySelector<HTMLElement>('[data-cell-opens]');
          if (opener) opener.click();
          else if (row >= 0 && onOpen) onOpen(row);
          break;
        }
        case 'F2': {
          /* A spreadsheet's edit key: a cell the list edits in place opens its
             editor (GridCellEditor.tsx), which Enter also does from the cell. */
          const editor = cellAt(row, col)?.querySelector<HTMLElement>('[data-cell-edits]');
          if (!editor) return;
          editor.click();
          break;
        }
        case ' ':
          /* A glance, as a file list's Space: the record over the list, J and
             K through its neighbors, Escape back to this cell. */
          if (row < 0 || !onPeek) return;
          onPeek(row);
          break;
        case 'Escape': {
          /* Back to the filter you would type into rather than nowhere. App
             mode hides the query bar, so there the landing is the list's own
             filter row. */
          table.blur();
          const query = shellById('query') as HTMLElement | null;
          if (query && query.offsetParent) query.focus();
          else (shellQuery('.applist-fields input, .applist-fields button') as HTMLElement | null)?.focus();
          break;
        }
        case 'c':
          if (!jump) return;
          void copyCell(cellAt(row, col));
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    table.addEventListener('focus', onFocus);
    tbody.addEventListener('mousedown', onMouseDown);
    table.addEventListener('keydown', onKey);
    return () => {
      table.removeEventListener('focus', onFocus);
      tbody.removeEventListener('mousedown', onMouseDown);
      table.removeEventListener('keydown', onKey);
    };
  }, [tableRef, wrapRef, rowCount, columnCount, offset, onOpen, onPeek, totalRows, firstRow]);
}

/** Copy one cell: `title` before `textContent`, because a shortened value
    keeps the whole thing in its tooltip. */
async function copyCell(cell: HTMLElement | null): Promise<void> {
  if (!cell) return;
  const text = cell.getAttribute('title') ?? cell.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    cell.classList.add('cell-copied');
    setTimeout(() => cell.classList.remove('cell-copied'), 400);
  } catch {
    /* Clipboard access can be refused; the value is on screen. */
  }
}
