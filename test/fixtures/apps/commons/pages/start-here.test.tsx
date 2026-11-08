/**
 * Commons' front door as a visitor and a member see it: what is busy and what has the most to read, each a way into
 * its thread; the boards; a way to join for the one and the boards for the other; and a new forum, said in words.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import page from './start-here.page.tsx';

const visitor = { signedIn: false };
const board = [
  { id: 1, name: 'Electronics', description: 'Circuits, solder and small computers.', position: 1, threads: 2, replies: 9 },
  { id: 2, name: 'Woodshop', description: 'Joinery, finishes and jigs.', position: 2, threads: 1, replies: 1 },
];
const thread = (id: number, title: string, board_id: number, replies: number, last_activity: string) => ({
  id,
  title,
  board_id,
  replies,
  last_activity,
  status: 'open',
  'board_id.name': board.find((one) => one.id === board_id)?.name,
  'author_id.display_name': 'Rosa Diaz',
});
const threads = [
  thread(1, 'A split keyboard in walnut', 2, 1, '2026-11-08T14:00:00Z'),
  thread(2, 'Reflowing with a skillet', 1, 7, '2026-11-06T10:00:00Z'),
  thread(3, 'First PCB order, what went wrong', 1, 2, '2026-11-07T09:00:00Z'),
];
const data = () => fixtures({ board, thread: threads, site_image: [] });
/* By label and text, not by role: role queries over a whole page are slow enough in happy-dom to time a test out. */
const list = (view: ReturnType<typeof renderPage>, label: string) => view.container.querySelector(`ul[aria-label="${label}"]`)!;
const press = async (view: ReturnType<typeof renderPage>, text: string) =>
  fireEvent.click((await view.findByText(text)).closest('button')!);

test('a visitor sees what is busy, what has the most to read, every board, and a way to join', async () => {
  const view = renderPage(page, { viewer: visitor, data: data() });
  await view.findByText('A split keyboard in walnut', { selector: 'ul[aria-label="Busy right now"] strong' });
  const busy = list(view, 'Busy right now').querySelectorAll('li');
  expect([...busy].map((row) => row.querySelector('strong')?.textContent)).toEqual([
    'A split keyboard in walnut',
    'First PCB order, what went wrong',
    'Reflowing with a skillet',
  ]);
  expect(busy[0]).toHaveTextContent('Woodshop · Rosa Diaz · 1 reply');
  await waitFor(() => expect(list(view, 'Most to read').querySelector('li')).toHaveTextContent('Reflowing with a skillet'));
  expect(list(view, 'Most to read').querySelector('li')).toHaveTextContent('7 replies');
  expect((await view.findByText('Electronics', { selector: 'strong' })).closest('button')).toHaveTextContent('2 threads · 9 replies');
  expect(view.getByText('Woodshop', { selector: 'button > strong' }).closest('button')).toHaveTextContent('1 thread · 1 reply');
  expect(view.getByText('Join or sign in')).toHaveAttribute('href', 'sign-in');
  expect(view.getByText('Sign in')).toHaveAttribute('href', 'sign-in');
});

test('a thread and a board open where they live, and the latest threads are one press away', async () => {
  const view = renderPage(page, { viewer: visitor, data: data() });
  await press(view, 'Reflowing with a skillet');
  expect(view.navigations.at(-1)).toMatchObject({ kind: 'record', resource: 'thread', key: { id: 2 } });
  fireEvent.click((await view.findByText('Woodshop', { selector: 'button > strong' })).closest('button')!);
  expect(view.navigations.at(-1)).toMatchObject({ kind: 'record', resource: 'board', key: { id: 2 } });
  await press(view, 'Read the latest threads');
  expect(view.navigations.at(-1)).toMatchObject({ kind: 'view', view: 'latest' });
});

test('a member is offered the boards instead of the sign-in', async () => {
  const view = renderPage(page, { viewer: { signedIn: true, account: 'rosa' }, data: data() });
  expect(await view.findByText('Browse the boards')).toBeInTheDocument();
  expect(view.queryByText(/sign in/i)).toBeNull();
});

test('a forum with nothing in it yet says so', async () => {
  const view = renderPage(page, { viewer: visitor, data: fixtures({ board: [], thread: [], site_image: [] }) });
  await waitFor(() => expect(view.getAllByText('No threads yet')).toHaveLength(2));
  expect(await view.findByText('No boards yet')).toBeInTheDocument();
});
