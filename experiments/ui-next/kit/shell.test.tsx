import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { AppShell, InboxBell, SignIn } from '../src/shell';
import { clear, draw, labelled } from './testing';

afterEach(() => {
  clear();
  window.localStorage.clear();
});

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
const NAV = [
  { items: [{ id: 'today', label: 'Today', href: '#today' }] },
  {
    label: 'Leasing',
    items: [
      { id: 'rent-roll', label: 'Rent roll', href: '#rent-roll', count: 54 },
      { id: 'occupancy', label: 'Occupancy', href: '#', idle: true },
    ],
  },
];
const shell = (current: string) => (
  <AppShell brand={{ name: 'Lintel', href: '#today' }} nav={NAV} current={current} remember="test">
    <h1>{current}</h1>
  </AppShell>
);
const links = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="shell-nav"] a')];

test('the first stop is a way past the menu, and the room being read is marked', () => {
  draw(shell('rent-roll'));
  const first = document.querySelector('[data-slot="shell"] a')!;
  expect(first.textContent).toBe('Skip to the page');
  press(first);
  expect(document.activeElement).toBe(document.querySelector('main'));
  expect(links().map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  expect(links()[2]!.getAttribute('aria-disabled')).toBe('true');
});

test('the menu folds to its icons, each still named, and stays folded on the next visit', () => {
  draw(shell('today'));
  press(labelled('Fold the menu'));
  expect(document.querySelector('[data-slot="shell"]')?.hasAttribute('data-folded')).toBe(true);
  expect(links().map((link) => link.getAttribute('aria-label'))).toEqual(['Today', 'Rent roll, 54', 'Occupancy']);
  clear();
  draw(shell('today'));
  expect(labelled('Open the menu').getAttribute('aria-expanded')).toBe('false');
});

/* The shell as a router would hold it: one shell, the room changing under it. */
let go: (room: string) => void = () => {};
function Rooms() {
  const [room, setRoom] = useState('today');
  go = setRoom;
  return shell(room);
}

test('choosing a room from the menu puts the keyboard on the page that arrives', () => {
  draw(<Rooms />);
  act(() => links()[1]!.focus());
  act(() => go('rent-roll'));
  expect(document.activeElement).toBe(document.querySelector('main'));
  // A room that changes while the reader is in the page (a link in it, Back) leaves the keyboard where it is.
  const heading = document.querySelector('h1')!;
  heading.tabIndex = -1;
  act(() => heading.focus());
  act(() => go('today'));
  expect(document.activeElement).toBe(document.querySelector('h1'));
});

test('the bell says how many are new in words, and marks them read', () => {
  const read: string[] = [];
  draw(
    <InboxBell
      notices={[
        { id: 'a', title: 'Boiler loses pressure', unread: true },
        { id: 'b', title: 'Payment received' },
      ]}
      onOpen={(notice) => read.push(notice.id)}
      onReadAll={() => read.push('all')}
    />,
  );
  const bell = labelled('Notices, 1 new');
  press(bell);
  const rows = [...document.querySelectorAll('[data-part="inbox"] li')];
  expect(rows.map((row) => row.querySelector('b')?.textContent)).toEqual(['New: Boiler loses pressure', 'Payment received']);
  press([...document.querySelectorAll('button')].find((button) => button.textContent === 'Mark all read')!);
  press(rows[0]!.querySelector('a')!);
  expect(read).toEqual(['all', 'a']);
});

test('signing in says what is missing, and a refusal keeps what was typed', async () => {
  const tried: string[] = [];
  draw(
    <SignIn
      name="Lintel"
      onSubmit={({ email, password }) => {
        tried.push(`${email} ${password}`);
        throw new Error('No such account.');
      }}
    />,
  );
  const form = document.querySelector('form')!;
  const send = () => act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  send();
  expect([...document.querySelectorAll('[data-slot="field-error"]')].map((line) => line.textContent)).toEqual([
    'Enter your email address.',
    'Enter your password.',
  ]);
  expect(tried).toEqual([]);
  const fill = (name: string, value: string) =>
    act(() => {
      const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  fill('email', 'maya@lintel.example');
  fill('password', 'wrong');
  send();
  await settle();
  expect(tried).toEqual(['maya@lintel.example wrong']);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('No such account.');
  expect(form.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe('wrong');
});

test('the bar says where the reader is: the room, under its group', () => {
  draw(shell('rent-roll'));
  const trail = document.querySelector('[data-slot="shell-trail"]')!;
  expect([trail.getAttribute('aria-label'), trail.textContent]).toEqual(['You are here', 'LeasingRent roll']);
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe('Rent roll');
});

test('along the top, a room with no group is a link and a group is a menu, marked when the room is in it', () => {
  draw(
    <AppShell brand={{ name: 'Lintel', href: '#today' }} nav={NAV} current="rent-roll" layout="top">
      <h1>Rent roll</h1>
    </AppShell>,
  );
  expect(document.querySelector('[data-slot="shell-rail"]')).toBeNull();
  const along = document.querySelector('[data-slot="shell-topnav"]')!;
  expect([...along.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Today']);
  expect(along.querySelector('[data-slot="shell-topnav-group"]')?.hasAttribute('data-current')).toBe(true);
});
