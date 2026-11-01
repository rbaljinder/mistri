/**
 * An App list's filters as controls, not a form: the bar a list draws above
 * its rows unless its view says `filterBar: 'rail'` or `'none'`.
 *
 * The bar was a form — an empty box or Select per filter, then Filter, then
 * Advanced — the heaviest thing above a quiet table, and on a phone more than
 * half the first screen. So the list's name column keeps one search box, a
 * real field with the 3:1 edge; every other filter the view declares is a
 * quiet "+ Status" that opens, in a popover, the picker the rail draws for it
 * (a checklist, Min/Max, date presets; a reference is the typeahead its box
 * was); and what is applied is said in the same row as chips, each in its
 * filter's place: a chip opens its picker again, its × (or Backspace) takes
 * it out, and two or more earn one Clear all. On a phone the pickers are the
 * rail's sheet, behind one Filters button that says how many apply.
 *
 * No picker writes a new kind of question. Each hands a condition tail to
 * withCondition, as the boxes and the rail do, so a chip, the address
 * (publicAddress.ts), a saved view and the crumb read it as they always did.
 * A picker edits a draft and applies it with one button: every navigation
 * redraws the list, and a popover that applied each tick would close under
 * the reader's second one.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Popover } from '@base-ui/react/popover';
import { WHOLE, canonicalize, conditionTail, mentionsColumn, ownedTails, squeeze, stripCondition, withCondition } from '../filterbar.js';
import { formatNumber } from '../locale.js';
import { columnKind, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/internal/anchor.js';
import { RefBox, boxTail, boxText, wrongForNumber, type Box, type BoxEdit } from './FilterBoxes.js';
import { useConditionWords } from './useConditionWords.js';
import { useArrived } from './onDemand.js';
import { SuggestBox } from './suggestPart.js';
import { FacetFor, useDraftCount, type FacetUnit } from './FilterRail.js';
import { clearFacets, facetActive } from './filterRailModel.js';
import { say } from '../copy/filters/components/ListFilterBar.js';
import { popupContainer } from '../shellHost.js';

interface ListFilterBarProps {
  table: TableMeta;
  /** Every filter the view declares, the name column's first. */
  boxes: Box[];
  /** The name column's box, drawn as the search box; every other box is a picker. */
  search?: Box;
  /** The question the controls read, without the table or the plumbing. */
  refinement: string;
  /** The lit tab's own query: a column it speaks for is the tab's to say, not a chip's. */
  tabQuery: string;
  /** The view's standing condition, under every count a picker shows. */
  standing: string;
  unitOf: (column: string) => FacetUnit | undefined;
  /** What is typed in the search box and not yet applied; undefined while untouched. */
  typed: string | undefined;
  onType: (raw: string) => void;
  /** Enter, or the search field's own ×: the list's form folds the typed text in. */
  onSearch: () => void;
  /** Every change goes here, with the column whose control the redrawn list focuses. */
  apply: (text: string, focus?: string) => void;
  /** The text a chip's × edits: the query bar's, while a reader is typing in it. */
  current: () => string;
  /** A leftover clause no tab explains, said in words with its own way out. */
  residue?: { text: string; remove: () => void };
  /** The list's own name, for the search box's words: "Search issues…". */
  listLabel: string;
  phone: boolean;
  /** The phone's pickers: the rail's sheet, over the list. */
  onSheet: () => void;
}

type SlotProps = ListFilterBarProps & { box: Box; chipOnly?: boolean };

export function ListFilterBar(props: ListFilterBarProps) {
  const { boxes, search, refinement, tabQuery, apply, residue, phone, onSheet } = props;
  const pickers = boxes.filter((box) => box !== search);
  const columns = boxes.map((box) => box.column);
  const active = boxes.filter((box) => facetActive(refinement, box.column, tabQuery)).length;
  const narrowed = pickers.filter((box) => facetActive(refinement, box.column, tabQuery)).length;
  /* One way to empty the row once there is more than one thing in it; the
     lit tab's own conditions stay, as the rail's Clear all leaves them. The
     focus goes to the row's first control, not the page. */
  const clearAll =
    active >= 2 ? (
      <button
        type="button"
        className="applist-chips-clear"
        onClick={() => apply(clearFacets(refinement, columns, tabQuery), search?.column ?? pickers[0]?.column)}
      >
        {say('list.clearAll')}
      </button>
    ) : null;
  const residueChip = residue ? (
    <span className="applist-chip">
      <span className="applist-chip-text">{residue.text}</span>
      <button type="button" className="applist-chip-x" aria-label={say('common.remove2', { text: residue.text })} onClick={residue.remove}>
        ×
      </button>
    </span>
  ) : null;
  const searchBox = search ? <SearchBox {...props} box={search} /> : null;
  /* On a desk the row keeps one line: the filters not yet asked for give way
     from the end, into one "+ Filter" that opens every picker in the sheet,
     rather than the last of them standing cut at the window's edge ("+ Orde…").
     A chip never gives way — it says what the rows are. Counted before the
     row is painted, so nothing is seen to jump. */
  const idle = pickers.filter((box) => !facetActive(refinement, box.column, tabQuery));
  const [folded, setFolded] = useState(0);
  /* A new width is measured afresh even where nothing was folded: the fold
     below runs after a render, and unfolding nothing renders nothing. */
  const [, remeasure] = useState(0);
  const mark = useRef<HTMLSpanElement>(null);
  const width = useRef(0);
  useLayoutEffect(() => {
    setFolded(0);
  }, [refinement, tabQuery, boxes.length]);
  useLayoutEffect(() => {
    const row = mark.current?.closest<HTMLElement>('.applist-controls');
    if (!row) return;
    /* The list's tabs give way after the filters (structure.css): told here when the filters have nothing left to give. */
    row.toggleAttribute('data-filters-spent', !phone && folded >= idle.length);
    if (phone) return;
    const over = row.scrollWidth - row.clientWidth;
    if (over < 2 || folded >= idle.length) return;
    /* As many more of the shown pickers, from the end, as the room they stand in (their widths and the gaps before
       them, in layout pixels as scrollWidth is) covers: every one that starts past where the row would have to end,
       and the one before them. Never more than are needed — the "+ Filter" that folding brings takes room of its own —
       so a row still too wide folds again on its next render. One a render, it was a render and a measure of the whole
       row per picker, in every sort, filter and tab (test/built-client-vitals.mjs). */
    const slots = [...row.querySelectorAll<HTMLElement>('.applist-slot[data-column]')];
    const end = (node?: Node | null) => (node ? (node as HTMLElement).offsetLeft + (node as HTMLElement).offsetWidth : 0);
    const limit = end(slots.at(-1)) - over;
    setFolded(folded + 1 + slots.filter((slot) => end(slot.previousSibling) > limit).length);
  });
  useEffect(() => {
    const row = mark.current?.closest<HTMLElement>('.applist-controls');
    if (phone || !row || typeof ResizeObserver === 'undefined') return undefined;
    width.current = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width.current) return;
      width.current = row.clientWidth;
      setFolded(0);
      remeasure((n) => n + 1);
    });
    observer.observe(row);
    /* A look's face arriving after the first measure widens the words in a row whose own width never changed: the
       fold was judged on the fallback's metrics, and the row scrolled 10px on a desk wherever the face was late. */
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    const refit = () => {
      setFolded(0);
      remeasure((n) => n + 1);
    };
    fonts?.addEventListener?.('loadingdone', refit);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener?.('loadingdone', refit);
    };
  }, [phone]);
  const hidden = new Set(folded ? idle.slice(-folded).map((box) => box.column) : []);
  if (phone) {
    /* The search stays in reach; the pickers are one button, and the chips
       wrap under the box rather than pushing it off the row. */
    return (
      <>
        {searchBox}
        {pickers.length > 0 && (
          <button type="button" className="applist-add applist-sheet-open" aria-haspopup="dialog" onClick={onSheet}>
            {narrowed ? say('common.filters', { narrowed }) : say('common.filtersButton')}
          </button>
        )}
        <div className="applist-bar-chips">
          {search && <FilterSlot {...props} box={search} chipOnly />}
          {pickers.map((box) => (
            <FilterSlot key={box.column} {...props} box={box} chipOnly />
          ))}
          {residueChip}
          {clearAll}
        </div>
      </>
    );
  }
  const rest = idle.filter((box) => hidden.has(box.column));
  return (
    <>
      <span ref={mark} hidden />
      {searchBox}
      {search && <FilterSlot {...props} box={search} />}
      {pickers
        .filter((box) => !hidden.has(box.column))
        .map((box) => (
          <FilterSlot key={box.column} {...props} box={box} />
        ))}
      {rest.length > 0 && (
        <span className="applist-slot applist-slot-more">
          <button
            type="button"
            className="applist-add"
            aria-haspopup="dialog"
            aria-label={say('moreFilters', { map: rest.map((box) => box.label).join(', ') })}
            onClick={onSheet}
          >
            <span className="applist-add-mark" aria-hidden="true">
              +
            </span>
            {say('common.filter')}
          </button>
        </span>
      )}
      {residueChip}
      {clearAll}
    </>
  );
}

/**
 * One declared filter in its place in the row: its chip when it narrows the
 * list, its "+" when it does not. A flag's "+" is one gesture, as its
 * checkbox was; every other "+" opens the column's picker.
 */
function FilterSlot(props: SlotProps) {
  const { box, search, refinement, tabQuery, apply, current, phone, onSheet, chipOnly } = props;
  /* The lit tab says its own column; a chip would say it twice. */
  const owned = mentionsColumn(tabQuery, box.column);
  const tails = owned ? [] : (ownedTails(refinement, box.column) as string[]);
  /* In the App's words: the label, the rule's word for a value, and a
     reference by the name its box shows, not the id beneath it. */
  const { speaker, sayTails } = useConditionWords(
    props.table,
    tails.map((tail) => `${box.column} ${tail}`),
  );
  const isSearch = box === search;
  /* The search's own condition is in its box; a chip only for what the box cannot say. */
  const chipped = tails.length > 0 && !(isSearch && tails.length === 1 && boxText(box, tails[0]));
  if (chipped) {
    const text = sayTails(speaker, box.column, tails);
    const remove = () => apply(withCondition(current(), box.column, ''), box.column);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      e.preventDefault();
      remove();
    };
    const open = isSearch ? (
      <span className="applist-chip-text">{text}</span>
    ) : phone ? (
      <button type="button" className="applist-chip-text applist-chip-open" aria-haspopup="dialog" onClick={onSheet} onKeyDown={onKeyDown}>
        {text}
      </button>
    ) : (
      <Picker {...props} owned={false} className="applist-chip-text applist-chip-open" onKeyDown={onKeyDown}>
        {text}
      </Picker>
    );
    return (
      <span className="applist-chip" data-column={box.column}>
        {open}
        <button
          type="button"
          className="applist-chip-x"
          aria-label={say('common.remove2', { text })}
          onClick={remove}
          onKeyDown={onKeyDown}
        >
          ×
        </button>
      </span>
    );
  }
  if (chipOnly || isSearch) return null;
  const plus = (
    <>
      <span className="applist-add-mark" aria-hidden="true">
        +
      </span>
      {box.label}
    </>
  );
  if (box.kind === 'flag') {
    return (
      <span className="applist-slot" data-column={box.column}>
        <button
          type="button"
          className="applist-add"
          aria-label={say('common.only', { label: box.label })}
          onClick={() => apply(withCondition(refinement, box.column, box.has?.segment ? WHOLE : '= true'), box.column)}
        >
          {plus}
        </button>
      </span>
    );
  }
  return (
    <span className="applist-slot" data-column={box.column}>
      <Picker {...props} owned={owned} className="applist-add" label={say('common.filter2', { label: box.label })}>
        {plus}
      </Picker>
    </span>
  );
}

/* The list's name column as a search: Enter asks, and the field's own ×
   (a search field's clear button) empties the question as Enter on an empty
   box would. It reads what the question says and keeps what is typed. */
function SearchBox({ box, table, standing, refinement, typed, onType, onSearch, listLabel }: SlotProps) {
  const input = useRef<HTMLInputElement>(null);
  const viaEnter = useRef(false);
  const said = boxText(box, squeeze(conditionTail(refinement, box.column)));
  const fuzzy = !box.exact && (box.meta ? columnKind(box.meta.type) === 'text' : false);
  const suggesting = useArrived(SuggestBox, Boolean(box.suggest?.length));
  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;
    /* The search event also comes with Enter, which the form already answers. */
    const cleared = () => {
      if (viaEnter.current) {
        viaEnter.current = false;
        return;
      }
      if (el.value === '' && said) onSearch();
    };
    el.addEventListener('search', cleared);
    return () => el.removeEventListener('search', cleared);
  }, [said, onSearch, suggesting]);
  const wrong = wrongForNumber(box, typed);
  const inputProps = {
    type: 'search',
    className: 'applist-search-input',
    ...(box.meta && columnKind(box.meta.type) === 'number' ? { inputMode: 'decimal' as const } : {}),
    ...(wrong ? { 'aria-invalid': true, title: say('takesANumber', { label: box.label }) } : {}),
    placeholder: fuzzy ? say('search', { listLabel: listLabel.toLowerCase() }) : say('labelEquals', { label: box.label }),
    'aria-label': say('common.filter2', { label: box.label }),
    ...(wrong ? {} : { title: fuzzy ? say('matchesAnywhereInTheAny', { label: box.label.toLowerCase() }) : undefined }),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      viaEnter.current = e.key === 'Enter';
      /* Asked for, not left to implicit submission: a form with two
         fields (this and the query bar's) and no submit button has none. */
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSearch();
      }
    },
  };
  return (
    <span className="applist-search" data-column={box.column}>
      {suggesting && box.suggest ? (
        <SuggestBox
          table={table.id}
          columns={box.suggest}
          standing={standing}
          text={typed ?? said}
          onText={onType}
          onPick={(value) => {
            onType(value);
            onSearch();
          }}
          inputProps={inputProps}
          inputRef={input}
        />
      ) : (
        <input ref={input} {...inputProps} value={typed ?? said} onChange={(e) => onType(e.target.value)} />
      )}
    </span>
  );
}

/**
 * A "+" or a chip, and the popover it opens: anchored on the zoom-aware
 * ruler, drawn inside the enclosing dialog when there is one, the focus on
 * its first field as it opens and back on its button when Escape closes it.
 */
function Picker({
  className,
  label,
  onKeyDown,
  owned,
  children,
  ...props
}: SlotProps & {
  owned: boolean;
  className: string;
  label?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  children: ReactNode;
}) {
  const { box, refinement } = props;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | null);
  }, []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<button type="button" className={className} aria-label={label} ref={trigger} onKeyDown={onKeyDown} />}>
        {children}
      </Popover.Trigger>
      <Popover.Portal container={container ?? popupContainer()}>
        <Popover.Positioner
          anchor={() => (trigger.current ? zoomAnchor(trigger.current) : null)}
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
            aria-label={say('common.filter2', { label: box.label })}
            data-column={box.column}
            initialFocus={() => popup.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([aria-hidden="true"])') ?? true}
          >
            <FilterPicker
              box={box}
              table={props.table}
              refinement={refinement}
              standing={props.standing}
              unit={props.unitOf(box.column)}
              owned={owned}
              apply={props.apply}
              close={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What a column's picker needs: the bar's "+ Status" and an App column menu's Filter… open the same one. */
export interface FilterPickerProps {
  box: Box;
  table: TableMeta;
  refinement: string;
  standing: string;
  unit?: FacetUnit;
  /** The lit tab speaks for this column: the picker starts blank, and a choice replaces the tab's condition. */
  owned: boolean;
  apply: (text: string, focus?: string) => void;
  close: () => void;
}

/** One column's picker: a reference's typeahead, or the rail's facet over a draft. */
export function FilterPicker(props: FilterPickerProps) {
  const { box, refinement, owned, apply } = props;
  return box.kind === 'ref' ? (
    <ReferencePicker box={box} tail={owned ? '' : squeeze(conditionTail(refinement, box.column))} refinement={refinement} apply={apply} />
  ) : (
    <FacetPicker {...props} />
  );
}

/**
 * The rail's facet for one column, editing a draft that one button applies,
 * saying what it will show as the sheet's does — and, to a screen reader, as
 * the draft changes. Where the lit tab speaks for the column the picker
 * starts blank — the tab says it — and a tick replaces the tab's condition,
 * as the box's choice did.
 */
function FacetPicker({ box, refinement, table, standing, unit, apply, owned, close }: FilterPickerProps) {
  const [draft, setDraft] = useState(refinement);
  /* Read when the draft is applied, which can be in the event that set it (Enter in a box). */
  const now = useRef(refinement);
  const set = (tail: string) => {
    now.current = withCondition(now.current, box.column, tail);
    setDraft(now.current);
  };
  const unchanged = canonicalize(draft) === canonicalize(refinement);
  const go = () => {
    if (canonicalize(now.current) === canonicalize(refinement)) close();
    else apply(now.current, box.column);
  };
  const n = useDraftCount(table, standing, draft);
  const form = useRef<HTMLFormElement>(null);
  /* A facet whose shape is still being counted has no field yet as the
     popover opens, which then holds the focus itself: the first field to
     arrive takes it, unless the reader has already moved it. */
  useEffect(() => {
    const home = form.current;
    const pop = home?.closest<HTMLElement>('.filter-pop');
    if (!home || !pop || typeof MutationObserver === 'undefined') return undefined;
    const field = () => home.querySelector<HTMLElement>('input:not([type="hidden"]):not([aria-hidden="true"])');
    if (field()) return undefined;
    const observer = new MutationObserver(() => {
      const first = field();
      if (!first) return;
      observer.disconnect();
      /* After the popover's own focus management has settled on its frame. */
      setTimeout(() => {
        if (document.activeElement === pop || document.activeElement === document.body) first.focus();
      }, 0);
    });
    observer.observe(home, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <form
      ref={form}
      className="filter-pop-form"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        go();
      }}
    >
      <FacetFor
        box={box}
        table={table}
        refinement={owned && unchanged ? stripCondition(draft, box.column) : draft}
        standing={standing}
        unit={unit}
        set={set}
        onEnter={go}
        picking
      />
      <p className="visually-hidden" role="status">
        {typeof n === 'number' ? say('match', { n: formatNumber(n) }) : ''}
      </p>
      <div className="filter-pop-foot">
        <Button intent="primary" size="compact" type="submit">
          {typeof n === 'number' ? say('showN', { n: formatNumber(n) }) : say('common.showResults')}
        </Button>
      </div>
    </form>
  );
}

/* A reference is the typeahead its box was: type a name, pick a row, and the
   question says its id. A pick is the decision, so it applies at once; Enter
   on typed text asks for it as written. The list is up as the picker opens. */
function ReferencePicker({
  box,
  tail,
  refinement,
  apply,
}: {
  box: Box;
  tail: string;
  refinement: string;
  apply: ListFilterBarProps['apply'];
}) {
  const [edit, setEdit] = useState<BoxEdit | undefined>(undefined);
  const now = useRef<BoxEdit | undefined>(undefined);
  const onEdit = (next: BoxEdit) => {
    now.current = next;
    setEdit(next);
  };
  const submit = () => {
    if (now.current) apply(withCondition(refinement, box.column, boxTail(box, now.current, tail)), box.column);
  };
  return (
    <form
      className="filter-pop-form"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }}
    >
      <div className="facet" data-column={box.column}>
        <span className="facet-label" aria-hidden="true">
          {box.label}
        </span>
        {tail && (
          <button
            type="button"
            className="facet-clear"
            aria-label={say('common.clear2', { label: box.label })}
            onClick={() => apply(withCondition(refinement, box.column, ''), box.column)}
          >
            {say('common.clear')}
          </button>
        )}
        <RefBox box={box} tail={tail} edit={edit} onEdit={onEdit} onSubmit={submit} startOpen portal="body" />
      </div>
    </form>
  );
}
