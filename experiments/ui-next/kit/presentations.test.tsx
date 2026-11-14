import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Cards, ListDetail, Queue, Tree } from '../src/presentations';
import { all, clear, draw, focus, key } from './testing';

afterEach(() => {
  clear();
  window.localStorage.clear();
});

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
const active = () => document.activeElement as HTMLElement;

/* ---------- cards ---------- */

test("a card is one link, and a card set to have a picture and without one keeps the picture's place", () => {
  const opened: string[] = [];
  draw(
    <Cards
      label="Homes"
      onOpen={(card) => opened.push(card.id)}
      cards={[
        {
          id: 'a',
          title: 'Alder Court AC-105',
          figure: '$1,795',
          picture: 'data:image/svg+xml,a',
          badge: { label: 'Listed', tone: 'good' },
        },
        { id: 'b', title: 'Birch House BH-302', picture: null, facts: [{ label: 'Beds', value: 1 }] },
      ]}
    />,
  );
  const cards = [...document.querySelectorAll('[data-slot="card"]')];
  expect(cards.map((card) => card.querySelectorAll('a, button').length)).toEqual([1, 1]);
  expect(cards.map((card) => (card.querySelector('[data-slot="card-picture"] img') ? 'picture' : 'placeholder'))).toEqual([
    'picture',
    'placeholder',
  ]);
  press(cards[1]!.querySelector('a')!);
  expect(opened).toEqual(['b']);
});

test('cards with nothing in them say so', () => {
  draw(<Cards label="Homes" cards={[]} empty="No home matches that." />);
  expect(document.querySelector('[data-slot="cards-empty"]')?.textContent).toBe('No home matches that.');
});

/* ---------- tree ---------- */

const NODES = [
  {
    id: 'alder',
    label: 'Alder Court',
    meta: '$31,650',
    children: [
      { id: 'alder/1', label: 'Floor 1', children: [{ id: 'AC-101', label: 'AC-101' }] },
      { id: 'alder/2', label: 'Floor 2', children: [] },
    ],
  },
  { id: 'birch', label: 'Birch House', children: [{ id: 'birch/1', label: 'Floor 1', children: [] }] },
];
const rows = () => all('treeitem').map((row) => row.getAttribute('data-value') ?? row.textContent);

test('a tree opens to the depth asked, by the keyboard after that, and keeps what is open', () => {
  const opened: string[] = [];
  draw(<Tree label="Homes" nodes={NODES} open={1} remember="test" onOpen={(id) => opened.push(id)} />);
  expect(all('treeitem').length).toBe(5);
  const first = all('treeitem')[0]!;
  focus(first);
  key(active(), 'ArrowDown');
  key(active(), 'ArrowRight');
  expect(all('treeitem').length).toBe(6);
  key(active(), 'ArrowRight');
  key(active(), 'Enter');
  expect(opened).toEqual(['AC-101']);
  expect(JSON.parse(window.localStorage.getItem('m-tree:test') ?? '[]')).toEqual(['alder', 'birch', 'alder/1']);
  // Drawn again, it is as it was left.
  clear();
  draw(<Tree label="Homes" nodes={NODES} open={0} remember="test" />);
  expect(rows().length).toBe(6);
});

/* ---------- a list with its detail ---------- */

const PEOPLE = [
  { id: 'a', name: 'Andre Okoye' },
  { id: 'b', name: 'Bea Lindqvist' },
  { id: 'c', name: 'Chidi Eze' },
];
function People({ heard }: { heard?: (string | null)[] }) {
  return (
    <ListDetail
      label="Residents"
      items={PEOPLE}
      keyOf={(person) => person.id}
      titleOf={(person) => person.name}
      row={(person) => person.name}
      detail={(person) => <h2>{person.name}</h2>}
      onPickChange={(pick) => heard?.push(pick)}
    />
  );
}
const pane = () => document.querySelector<HTMLElement>('[data-slot="list-detail-pane"]')!;

test('walking a list picks as it goes, with one stop for the keyboard', () => {
  const heard: (string | null)[] = [];
  draw(<People heard={heard} />);
  expect(pane().textContent).toBe('Pick one to read it here.');
  expect(all('option').filter((row) => row.tabIndex === 0).length).toBe(1);
  focus(all('option')[0]!);
  key(active(), 'ArrowDown');
  expect([active().textContent, pane().getAttribute('aria-label')]).toEqual(['Bea Lindqvist', 'Bea Lindqvist']);
  key(active(), 'End');
  expect(all('option').map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  expect(heard).toEqual(['b', 'c']);
});

test('Enter goes into the detail and Escape comes back to its row', () => {
  draw(<People />);
  focus(all('option')[0]!);
  key(active(), 'ArrowDown');
  key(active(), 'Enter');
  expect(active()).toBe(pane());
  key(active(), 'Escape');
  expect(active().textContent).toBe('Bea Lindqvist');
});

/* ---------- a queue ---------- */

function Review({ heard, fail }: { heard: string[]; fail?: string }) {
  return (
    <Queue
      label="Applications"
      items={PEOPLE}
      keyOf={(person) => person.id}
      titleOf={(person) => person.name}
      verbs={[
        { value: 'approve', label: 'Approve', shortcut: 'a' },
        { value: 'decline', label: 'Decline' },
      ]}
      onVerb={async (person, verb) => {
        if (person.id === fail) throw new Error('Not this one.');
        heard.push(`${verb} ${person.id}`);
      }}
    >
      {(person) => <p>{person.id}</p>}
    </Queue>
  );
}
const button = (name: string) => [...document.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))!;
const where = () =>
  `${document.querySelector('[data-slot="queue-count"]')?.textContent}: ${document.querySelector('[data-slot="queue"] h2')?.textContent}`;

test('a queue does a verb, brings the next one and puts the keyboard on its name', async () => {
  const heard: string[] = [];
  draw(<Review heard={heard} />);
  expect(where()).toBe('1 of 3: Andre Okoye');
  press(button('Approve'));
  await settle();
  expect([heard, where()]).toEqual([['approve a'], '2 of 3: Bea Lindqvist']);
  expect(active().textContent).toBe('Bea Lindqvist');
  expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
});

test('a verb that fails leaves the one in hand where it is and says why', async () => {
  const heard: string[] = [];
  draw(<Review heard={heard} fail="a" />);
  press(button('Approve'));
  await settle();
  expect([heard, where()]).toEqual([[], '1 of 3: Andre Okoye']);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Not this one.');
});

test('a skipped one comes round again, and the queue ends when nothing is left', async () => {
  const heard: string[] = [];
  draw(<Review heard={heard} />);
  press(button('Skip'));
  expect(where()).toBe('1 of 3: Bea Lindqvist');
  press(button('Decline'));
  await settle();
  press(button('Decline'));
  await settle();
  // Past the last, what was skipped is what is left.
  expect(where()).toBe('3 of 3: Andre Okoye');
  expect(button('Skip')).toBeUndefined();
  press(button('Approve'));
  await settle();
  expect(heard).toEqual(['decline b', 'decline c', 'approve a']);
  expect(document.querySelector('[data-slot="queue"]')?.textContent).toBe('All doneYou went through 3.');
});
