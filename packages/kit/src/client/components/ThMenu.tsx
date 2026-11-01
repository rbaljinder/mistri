/**
 * The column header's ⌄ menu: pin, sort, and a filter built from what the
 * column holds — sampled values where the column repeats, typed conditions
 * always, ranges where a range means anything. The sampling round trip
 * stays in `thmenu.js`; this is the menu, and the rule for what it offers.
 */
import { Menu } from '@base-ui/react/menu';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/internal/anchor.js';
import { go, quote, refine, render, tableView } from '../core.js';
import { addSort, nextSort, sortCount, sortDirection } from '../clauses.js';
import { SORT_SCAN_BELOW } from '../columns.js';
import { composeFilter } from '../compose.js';
import { promptFor, promptForRange } from '../prompt.js';
import { pinnedFor, togglePin } from '../pins.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { formatNumber } from '../locale.js';
import { say } from '../copy/columnMenu/components/ThMenu.js';
import { popupContainer } from '../shellHost.js';

export type Kind = 'boolean' | 'date' | 'number' | 'text' | string;
type Row = Record<string, unknown>;
export interface Typed {
  label: string;
  build: (value: string) => string;
  placeholder: string;
  type: string;
}
export interface Offer {
  options: Array<[string, string]>;
  typed: Typed[];
  ranges: Array<[string, string, string]>;
  asStamp: (v: string) => string;
}

/** Quote a typed value only when the grammar needs it. Trimmed, then handed to the one quoter. */
const quoteValue = (text: string) => quote(String(text).trim()) as string;

/**
 * What the menu offers a column of this kind, given a sample of its rows.
 * Dates get ranges, not equality; sampled values only where the column
 * repeats; typed conditions always, because on a key the sample is a list
 * of arbitrary values and the thing wanted is to name one.
 */
export function offersFor(name: string, kind: Kind, dateish: boolean, rows: Row[], metaType?: string): Offer {
  const options: Array<[string, string]> = [];
  if (kind === 'boolean') {
    options.push(['is true', `${name} = true`], ['is false', `${name} = false`]);
  } else if (kind === 'date' || dateish) {
    for (const phrase of ['today', 'last 7 days', 'last 30 days', 'this month', 'last month', 'this year'])
      options.push([phrase, `${name} = ${phrase}`]);
  } else if (kind === 'number') {
    const values = rows.map((r) => Number(r[name])).filter((n) => Number.isFinite(n));
    if (values.length) {
      const mid = Math.round((Math.min(...values) + Math.max(...values)) / 2);
      options.push(
        [say('greaterThan', { mid: formatNumber(mid) }), `${name} > ${mid}`],
        [say('lessThan', { mid: formatNumber(mid) }), `${name} < ${mid}`],
      );
    }
  }
  const counts = new Map<unknown, number>();
  for (const row of rows) {
    const value = row[name];
    if (value === null || value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (distinct.length && distinct.length <= Math.max(3, rows.length / 2)) {
    /* The counts are honest about their sample: bare numbers read as table totals. */
    const sampled = rows.length >= 400 ? say('ofTheFirst', { rowsCount: rows.length }) : say('ofHere', { rowsCount: rows.length });
    for (const [value, count] of distinct.slice(0, 8)) {
      const text = String(value);
      const quoted = /^[\w.-]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
      options.push([`${text}  ·  ${count} ${sampled}`, `${name} = ${quoted}`]);
    }
  }
  options.push(['is empty', `${name} is empty`], ['is not empty', `${name} is not empty`]);

  /* A timestamp gets a time in its picker and a date does not, read off the declared type so the answer is the same before the table has rows. */
  const hasTime = /time|timestamp/i.test(metaType ?? '');
  const dateInput = hasTime ? 'datetime-local' : 'date';
  /* `2026-01-01T09:30` is what the control hands back and not what any of these databases write. */
  const asStamp = (v: string) => String(v).replace('T', ' ');
  const typed: Typed[] =
    kind === 'number'
      ? [
          { label: say('equalsAValue'), build: (v) => `${name} = ${v}`, placeholder: say('value'), type: 'text' },
          { label: say('greaterThanMore'), build: (v) => `${name} > ${v}`, placeholder: say('minimum'), type: 'text' },
          { label: say('lessThanMore'), build: (v) => `${name} < ${v}`, placeholder: say('maximum'), type: 'text' },
        ]
      : kind === 'date'
        ? [
            { label: say('onOrAfter'), build: (v) => `${name} >= ${quoteValue(asStamp(v))}`, placeholder: say('date'), type: dateInput },
            { label: say('before'), build: (v) => `${name} < ${quoteValue(asStamp(v))}`, placeholder: say('date'), type: dateInput },
          ]
        : [
            { label: say('equalsAValue'), build: (v) => `${name} = ${quoteValue(v)}`, placeholder: say('value'), type: 'text' },
            { label: say('contains'), build: (v) => `${name} contains ${quoteValue(v)}`, placeholder: say('textToLook'), type: 'text' },
            { label: say('starts'), build: (v) => `${name} startswith ${quoteValue(v)}`, placeholder: say('prefix'), type: 'text' },
            /* The escape hatch from the three above, which all escape `%`. Here the wildcards are the question. */
            {
              label: say('matchesAPattern'),
              build: (v) => `${name} like ${quoteValue(v)}`,
              placeholder: say('common.patternEGWh'),
              type: 'text',
            },
          ];
  const ranges: Array<[string, string, string]> =
    kind === 'date' ? [[say('between'), dateInput, say('date')]] : kind === 'number' ? [[say('between'), 'text', say('value')]] : [];
  return { options, typed, ranges, asStamp };
}

interface FilterMenuProps {
  anchor: HTMLElement;
  name: string;
  kind: Kind;
  metaType?: string;
  dateish: boolean;
  rows: Row[];
  table: TableMeta | undefined;
  /** The columns as drawn, for the pin store's order. */
  columns: string[];
  entry: { table: string; query: string } | null;
  onClose: () => void;
}

export function FilterMenu({ anchor, name, kind, metaType, dateish, rows, table, columns, entry, onClose }: FilterMenuProps) {
  const offer = offersFor(name, kind, dateish, rows, metaType);
  const pinned = table ? (pinnedFor(table, columns) as string[]) : [];
  /* Sort and filter from a header refine the room on screen rather than
     starting it over (core.js `refine`): the grid is re-asked in place. */
  const apply = (condition: string) => {
    if (entry) refine(() => go(tableView(entry.table, composeFilter(entry.query, entry.table, name, condition)), 'replace'));
  };
  const add = (condition: string) => {
    apply(condition);
    onClose();
  };
  /* Sorting always offered, whatever the index says, and the cost stated rather than the action withheld. */
  const indexLeads = !table?.indexed || table.indexed.includes(name);
  const bigTable =
    (table as { approxRows?: number } | undefined)?.approxRows != null &&
    (table as { approxRows: number }).approxRows >= (SORT_SCAN_BELOW as number);
  const sortsAlready = Boolean(entry) && (sortCount(entry!.query) as number) > 0 && sortDirection(entry!.query, name) === null;
  const sortItem = (label: string, direction: 'asc' | 'desc', append = false) =>
    entry ? (
      <Item
        key={label}
        onClick={() => {
          refine(() => go(tableView(entry.table, (append ? addSort : nextSort)(entry.query, name, direction)), 'replace'));
          onClose();
        }}
      >
        <span className="th-menu-label">{label}</span>
        <span className="th-menu-cond">{indexLeads || !bigTable ? `sort ${name}` : say('noIndexAFull')}</span>
      </Item>
    ) : null;

  const ask = async (typed: Typed) => {
    onClose();
    const value = await promptFor({
      title: say('filter', { name }),
      label: typed.label,
      placeholder: typed.placeholder,
      type: typed.type,
      confirmLabel: say('common.apply'),
      hint: say('addsAConditionToTheQuery'),
    });
    if (value) apply(typed.build(value));
  };
  const askRange = async ([, inputType, fieldLabel]: [string, string, string]) => {
    onClose();
    const range = await promptForRange({
      title: say('filter', { name }),
      fromLabel: say('fieldFrom', { fieldLabel }),
      toLabel: say('fieldTo', { fieldLabel }),
      type: inputType,
      hint: say('bothEndsAreIncluded'),
      placeholder: undefined,
    });
    if (range) apply(`${name} between ${quoteValue(offer.asStamp(range.from))} and ${quoteValue(offer.asStamp(range.to))}`);
  };
  /* Base UI owns the menu's keyboard and its dismissal: focus moves in on
     open, arrows walk the items, Escape and a click outside close only this
     layer, and focus goes back to the ⌄ that opened it. Placed under the
     header on the zoom-aware ruler, flipped or shifted when it would run
     off an edge — which happens constantly on a wide table scrolled to the end. */
  return (
    <Menu.Root
      open
      onOpenChange={(next) => {
        if (next) return;
        /* Dismissed rather than used: the keyboard goes back to the ⌄. */
        if (anchor.isConnected) anchor.focus();
        onClose();
      }}
    >
      <Menu.Portal container={popupContainer()}>
        <Menu.Positioner
          anchor={() => zoomAnchor(anchor)}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionBoundary={layoutViewport()}
          collisionPadding={12}
          style={{ zIndex: 40 }}
        >
          <Menu.Popup className="th-menu" finalFocus={() => (anchor.isConnected ? anchor : false)}>
            {/* First, because it is the one item about *reading* the table rather than narrowing it. */}
            {table ? (
              <Item
                onClick={() => {
                  togglePin(table, columns, name);
                  onClose();
                  render();
                }}
              >
                <span className="th-menu-label">{pinned.includes(name) ? say('unpinThisColumn') : say('pinThisColumn')}</span>
                <span className="th-menu-cond">{pinned.includes(name) ? say('letItScrollAway') : say('keepItInView')}</span>
              </Item>
            ) : null}
            {sortItem(say('sortAscending'), 'asc')}
            {sortItem(say('sortDescending'), 'desc')}
            {/* "Then by" appears only once there is something to be *after*. */}
            {sortsAlready ? sortItem(say('thenByAscending'), 'asc', true) : null}
            {sortsAlready ? sortItem(say('thenByDescending'), 'desc', true) : null}
            {table ? <Menu.Separator className="th-menu-sep" /> : null}
            {offer.typed.map((typed) => (
              <Item key={typed.label} className="th-menu-item th-menu-typed" onClick={() => void ask(typed)}>
                <span className="th-menu-label">{typed.label}</span>
              </Item>
            ))}
            {offer.ranges.map((range) => (
              <Item key={range[0]} className="th-menu-item th-menu-typed" onClick={() => void askRange(range)}>
                <span className="th-menu-label">{range[0]}</span>
              </Item>
            ))}
            {offer.typed.length ? <Menu.Separator className="th-menu-sep" /> : null}
            {offer.options.map(([label, condition]) => (
              <Item key={condition + label} onClick={() => add(condition)}>
                <span className="th-menu-label">{label}</span>
                <span className="th-menu-cond">{condition}</span>
              </Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** One row of the menu, drawn as the button it always was. */
function Item({ className = 'th-menu-item', onClick, children }: { className?: string; onClick: () => void; children: React.ReactNode }) {
  /* The handlers close the menu themselves (onClose unmounts it), so the
     item does not also ask Base UI to — that told the caller twice. */
  return (
    <Menu.Item render={<button type="button" className={className} />} nativeButton closeOnClick={false} onClick={onClick}>
      {children}
    </Menu.Item>
  );
}
