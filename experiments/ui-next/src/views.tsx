import { BookmarkSimple, CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Popover } from './containers';
import type { ListState } from './listState';
import { words } from './words';

/* ---------- views of a list, kept by name ---------- */

export type SavedView = { id: string; name: string; state: ListState };

const same = (a: ListState, b: ListState): boolean => {
  const said = (state: ListState) =>
    JSON.stringify([
      state.tab,
      state.search.trim(),
      Object.entries(state.filters)
        .filter(([, values]) => values.length > 0)
        .map(([id, values]) => [id, [...values].sort()])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      state.sort,
      state.columns ?? null,
    ]);
  // A page is where a reader is in a view, not part of what the view is.
  return said(a) === said(b);
};

/* The views of one list a reader has named, kept in this browser under `key`. A page that keeps them on a
   server holds them itself and hands `SavedViews` its own. */
export function useSavedViews(key: string): [SavedView[], (views: SavedView[]) => void] {
  const [views, setViews] = useState<SavedView[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(`m-views:${key}`) ?? '[]') as SavedView[];
    } catch {
      return [];
    }
  });
  return [
    views,
    (next) => {
      setViews(next);
      try {
        window.localStorage.setItem(`m-views:${key}`, JSON.stringify(next));
      } catch {
        // Nothing kept: the views last as long as the page.
      }
    },
  ];
}

/* A list as the reader left it, kept under a name and come back to in one press: the tab, the search, the
   filters, the order and the columns. The button says which view the list is in, and says when the list has
   moved on from it, with the two things a reader then wants beside it: keep the change, or go back. Saving is a
   name and Enter; nothing is asked that has an obvious answer. */
export function SavedViews({
  views,
  onViewsChange,
  state,
  onApply,
  first,
}: {
  views: SavedView[];
  onViewsChange: (views: SavedView[]) => void;
  /* The list as it stands. */
  state: ListState;
  /* Asked to put the list in a view's state. */
  onApply: (state: ListState) => void;
  /* The list as it is before anything is changed: what "All" goes back to. */
  first: ListState;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const [inId, setInId] = useState<string | null>(null);
  const exact = views.find((view) => same(view.state, state));
  const current = exact ?? views.find((view) => view.id === inId);
  const changed = current !== undefined && !exact;
  const untouched = same(first, state);

  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);
  // A list that arrives already in a view (from its address, after a reload) is in that view when it moves on.
  const exactId = exact?.id;
  useEffect(() => {
    if (exactId) setInId(exactId);
  }, [exactId]);

  const apply = (view: SavedView | null) => {
    setInId(view?.id ?? null);
    onApply(view ? { ...view.state, page: 1 } : first);
    setOpen(false);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const said = name.trim();
    if (!said) return;
    const view = { id: `v${Date.now().toString(36)}`, name: said, state: { ...state, page: 1 } };
    onViewsChange([...views.filter((other) => other.name !== said), view]);
    setInId(view.id);
    setName('');
    setNaming(false);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setNaming(false);
      }}
      align="start"
      title={words.savedViews}
      trigger={
        <Button data-part="views-trigger" data-changed={changed ? '' : undefined}>
          <BookmarkSimple aria-hidden="true" weight={current ? 'fill' : 'regular'} />
          <span>{current ? current.name : words.savedViews}</span>
          {changed && <span data-slot="views-changed">{words.changed}</span>}
          <CaretDown aria-hidden="true" />
        </Button>
      }
    >
      <div data-slot="views">
        <ul>
          <li>
            <button type="button" aria-current={!current && untouched ? 'true' : undefined} onClick={() => apply(null)}>
              <Check aria-hidden="true" />
              {words.allRows}
            </button>
          </li>
          {views.map((view) => (
            <li key={view.id}>
              <button type="button" aria-current={view.id === current?.id ? 'true' : undefined} onClick={() => apply(view)}>
                <Check aria-hidden="true" />
                {view.name}
              </button>
              <button
                type="button"
                data-slot="views-remove"
                aria-label={words.removeView(view.name)}
                onClick={() => {
                  onViewsChange(views.filter((other) => other.id !== view.id));
                  if (inId === view.id) setInId(null);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div data-slot="views-foot">
          {changed && current && (
            <Button
              size="sm"
              block
              onClick={() => {
                onViewsChange(views.map((view) => (view.id === current.id ? { ...view, state: { ...state, page: 1 } } : view)));
                setOpen(false);
              }}
            >
              {words.updateView(current.name)}
            </Button>
          )}
          {naming ? (
            <form onSubmit={save}>
              <input
                ref={input}
                data-slot="input"
                aria-label={words.viewName}
                placeholder={words.viewName}
                value={name}
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
              />
              <Button size="sm" intent="primary" type="submit" disabled={!name.trim()}>
                {words.saveWord}
              </Button>
            </form>
          ) : (
            <Button size="sm" intent="quiet" block disabled={untouched || Boolean(exact)} onClick={() => setNaming(true)}>
              {words.saveView}
            </Button>
          )}
        </div>
      </div>
    </Popover>
  );
}

/* ---------- filters down the side ---------- */

export type FacetOption = { value: string; label: string; count?: number };
export type Facet = { id: string; label: string; options: FacetOption[] };

/* A list's filters as a rail down its side: every group open at once with how many rows each choice holds, so a
   reader sees what there is to narrow by before narrowing, and a choice that would leave nothing says so by its
   count. A long group is searched and shows its first few; what is chosen is always shown, wherever it sits in
   the group. Each group clears itself and one press clears them all. */
export function FilterRail({
  label,
  facets,
  value,
  onValueChange,
  shown = 6,
}: {
  label: string;
  facets: Facet[];
  value: Record<string, string[]>;
  onValueChange: (value: Record<string, string[]>) => void;
  /* How many choices a group shows before the rest are folded and a search is offered. */
  shown?: number;
}) {
  const [open, setOpen] = useState<string[]>([]);
  const [search, setSearch] = useState<Record<string, string>>({});
  const chosen = Object.values(value).reduce((total, values) => total + values.length, 0);
  const toggle = (id: string, option: string) => {
    const now = value[id] ?? [];
    onValueChange({ ...value, [id]: now.includes(option) ? now.filter((other) => other !== option) : [...now, option] });
  };
  return (
    <aside data-slot="filter-rail" aria-label={label}>
      <header>
        <b>{label}</b>
        {chosen > 0 && (
          <Button size="sm" intent="quiet" onClick={() => onValueChange({})}>
            {words.clearChosen(chosen)}
          </Button>
        )}
      </header>
      {facets.map((facet) => {
        const picked = value[facet.id] ?? [];
        const long = facet.options.length > shown;
        const asked = (search[facet.id] ?? '').trim().toLowerCase();
        const matching = asked ? facet.options.filter((option) => option.label.toLowerCase().includes(asked)) : facet.options;
        const all = open.includes(facet.id) || asked !== '';
        const drawn = all ? matching : matching.filter((option, at) => at < shown || picked.includes(option.value));
        return (
          <fieldset key={facet.id}>
            <legend>
              <span>{facet.label}</span>
              {picked.length > 0 && (
                <button
                  type="button"
                  onClick={() => onValueChange({ ...value, [facet.id]: [] })}
                  aria-label={words.clearGroup(facet.label)}
                >
                  {words.clearWord}
                </button>
              )}
            </legend>
            {long && (
              <label data-slot="filter-rail-search">
                <MagnifyingGlass aria-hidden="true" />
                <input
                  type="search"
                  aria-label={words.searchIn(facet.label)}
                  placeholder={words.searchIn(facet.label)}
                  value={search[facet.id] ?? ''}
                  onChange={(event) => setSearch({ ...search, [facet.id]: event.target.value })}
                />
              </label>
            )}
            {drawn.map((option) => (
              <label key={option.value} data-slot="filter-rail-option" data-none={option.count === 0 ? '' : undefined}>
                <input type="checkbox" checked={picked.includes(option.value)} onChange={() => toggle(facet.id, option.value)} />
                <span>{option.label}</span>
                {option.count !== undefined && <span data-slot="filter-rail-count">{option.count}</span>}
              </label>
            ))}
            {drawn.length === 0 && <p data-slot="filter-rail-none">{words.nothingMatchesOption}</p>}
            {long && !asked && (
              <button
                type="button"
                data-slot="filter-rail-more"
                aria-expanded={all}
                onClick={() => setOpen(all ? open.filter((id) => id !== facet.id) : [...open, facet.id])}
              >
                {all ? words.showFewer : words.showAll(facet.options.length)}
              </button>
            )}
          </fieldset>
        );
      })}
    </aside>
  );
}
