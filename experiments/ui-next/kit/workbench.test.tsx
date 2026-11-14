import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import type { ListState } from '../src/listState';
import { Accordion, PictureGallery } from '../src/reveal';
import { FilterRail, type SavedView, SavedViews } from '../src/views';
import { clear, draw, key, labelled } from './testing';

afterEach(clear);

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (one) => (one.getAttribute('aria-label') ?? one.textContent)?.trim() === name,
  ) as HTMLButtonElement;

/* ---------- views kept by name ---------- */

const FIRST: ListState = { tab: 'all', search: '', filters: {}, sort: { column: 'code', descending: false }, page: 1 };
const VACANT: ListState = { ...FIRST, tab: 'vacant' };

function Views({ start, applied }: { start: ListState; applied: ListState[] }) {
  const [views, setViews] = useState<SavedView[]>([{ id: 'v1', name: 'Empty homes', state: VACANT }]);
  const [state, setState] = useState(start);
  return (
    <>
      <SavedViews
        views={views}
        onViewsChange={setViews}
        state={state}
        first={FIRST}
        onApply={(next) => {
          applied.push(next);
          setState(next);
        }}
      />
      <button type="button" onClick={() => setState({ ...state, search: 'alder', page: 3 })}>
        search
      </button>
      <output>{views.map((view) => `${view.name}:${view.state.tab}:${view.state.search}`).join(',')}</output>
    </>
  );
}
const trigger = () => document.querySelector<HTMLElement>('[data-part="views-trigger"]')!;

test('the button names the view the list is in, and says when the list has moved on from it', () => {
  draw(<Views start={VACANT} applied={[]} />);
  expect(trigger().textContent).toBe('Empty homes');
  // A page is where a reader is in a view, not part of it; a search is.
  press(button('search'));
  expect(trigger().textContent).toBe('Empty homeschanged');
});

test('a changed view is updated in one press, and All goes back to the list untouched', () => {
  const applied: ListState[] = [];
  draw(<Views start={VACANT} applied={applied} />);
  press(button('search'));
  press(trigger());
  press(button('Update Empty homes'));
  expect(document.querySelector('output')?.textContent).toBe('Empty homes:vacant:alder');
  expect(trigger().textContent).toBe('Empty homes');
  press(trigger());
  press(button('All'));
  expect(applied).toEqual([FIRST]);
  expect(trigger().textContent).toBe('Views');
});

test('a view is saved under a name with Enter, and chosen again by it', () => {
  const applied: ListState[] = [];
  draw(<Views start={{ ...FIRST, filters: { beds: ['2 bed'] } }} applied={applied} />);
  press(trigger());
  press(button('Save this view'));
  const name = labelled('Name this view') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Two beds');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => name.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(trigger().textContent).toBe('Two beds');
  press(trigger());
  press(button('Empty homes'));
  expect(applied).toEqual([VACANT]);
});

/* ---------- filters down the side ---------- */

function Rail({ heard }: { heard: Record<string, string[]>[] }) {
  const [value, setValue] = useState<Record<string, string[]>>({ building: ['Fern Row'] });
  return (
    <FilterRail
      label="Filters"
      shown={2}
      value={value}
      onValueChange={(next) => {
        heard.push(next);
        setValue(next);
      }}
      facets={[
        {
          id: 'building',
          label: 'Building',
          options: ['Alder Court', 'Birch House', 'Cedar Mews', 'Fern Row'].map((name, at) => ({ value: name, label: name, count: at })),
        },
        { id: 'beds', label: 'Beds', options: [{ value: '1', label: '1 bed' }] },
      ]}
    />
  );
}
const options = () => [...document.querySelectorAll('[data-slot="filter-rail-option"]')].map((option) => option.textContent);

test('a long group shows its first few and what is chosen, and is searched', () => {
  draw(<Rail heard={[]} />);
  expect(options()).toEqual(['Alder Court0', 'Birch House1', 'Fern Row3', '1 bed']);
  press(button('Show all 4'));
  expect(options().length).toBe(5);
  const search = labelled('Search building') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'ced');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(options()).toEqual(['Cedar Mews2', '1 bed']);
});

test('a group clears itself and one press clears them all', () => {
  const heard: Record<string, string[]>[] = [];
  draw(<Rail heard={heard} />);
  press([...document.querySelectorAll<HTMLInputElement>('[data-slot="filter-rail-option"] input')].at(-1)!);
  expect(heard.at(-1)).toEqual({ building: ['Fern Row'], beds: ['1'] });
  press(button('Clear building'));
  expect(heard.at(-1)).toEqual({ building: [], beds: ['1'] });
  press(button('Clear'));
  expect(heard.at(-1)).toEqual({});
});

/* ---------- sections that fold, pictures read large ---------- */

test('any number of sections are open at once unless only one may be', () => {
  const SECTIONS = [
    { value: 'a', title: 'Terms', content: 'Twelve months.' },
    { value: 'b', title: 'Charges', meta: '7', content: 'Seven.' },
  ];
  draw(<Accordion sections={SECTIONS} defaultValue={['a']} />);
  const open = () => [...document.querySelectorAll('[data-slot="accordion-trigger"]')].map((one) => one.getAttribute('aria-expanded'));
  press(document.querySelectorAll('[data-slot="accordion-trigger"]')[1]!);
  expect(open()).toEqual(['true', 'true']);
  clear();
  draw(<Accordion sections={SECTIONS} defaultValue={['a']} single />);
  press(document.querySelectorAll('[data-slot="accordion-trigger"]')[1]!);
  expect(open()).toEqual(['false', 'true']);
});

test('a picture opens large, arrows go from one to the next, and the count says where', () => {
  const PICTURES = ['Front', 'Courtyard', 'Entrance'].map((alt) => ({ src: `data:image/svg+xml,${alt}`, alt }));
  draw(<PictureGallery label="Alder Court" pictures={PICTURES} />);
  press(button('Open Courtyard'));
  const box = document.querySelector<HTMLElement>('[data-kind="lightbox"]')!;
  const where = () =>
    `${box.querySelector('[data-slot="dialog-title"]')?.textContent} ${box.querySelector('[data-slot="lightbox-count"]')?.textContent}`;
  expect(where()).toBe('Courtyard 2 of 3');
  key(box, 'ArrowRight');
  expect(where()).toBe('Entrance 3 of 3');
  expect(button('Next picture').disabled).toBe(true);
  key(box, 'Home');
  expect(where()).toBe('Front 1 of 3');
});
