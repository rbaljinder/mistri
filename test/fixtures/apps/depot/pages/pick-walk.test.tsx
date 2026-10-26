/**
 * The pick walk, walked as its stories draw it: a list chosen, each line in
 * bin order confirmed with "Picked ✓", the place kept in the page's address,
 * and the walk ending in the Pick command, run through the platform.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderExample } from '@mistriwork/mistri/ui/testing';
import walk, { Done, Line, Lists } from './pick-walk.examples.tsx';

test('offers the lists waiting, then walks the chosen one line by line, in bin order', async () => {
  const view = renderExample(walk, Lists);
  fireEvent.click(await view.findByRole('button', { name: /^SO-25189/ }));
  expect(await view.findByText('Line 1 of 3')).toBeInTheDocument();
  expect(view.getByText('CMH-A-03-1')).toHaveClass('c-page-pick-walk-bin');
  fireEvent.click(view.getByRole('button', { name: 'Picked ✓' }));
  expect(await view.findByText('Line 2 of 3')).toBeInTheDocument();
  expect(view.getByText('CMH-A-10-2')).toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'Back a line' }));
  expect(await view.findByText('Line 1 of 3')).toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'All pick lists' }));
  expect(await view.findByRole('button', { name: /^SO-25184/ })).toBeInTheDocument();
});

test('a link to a line opens on it', async () => {
  const view = renderExample(walk, Line);
  expect(await view.findByText('Line 2 of 3')).toBeInTheDocument();
});

test('ends in Pick, run through the platform with nothing more to ask', async () => {
  const view = renderExample(walk, Done);
  const pick = await view.findByRole('button', { name: 'Pick' });
  await expect.poll(() => pick.hasAttribute('disabled')).toBe(false);
  fireEvent.click(pick);
  expect(view.commands).toEqual([{ command: 'pickList', mode: 'run', key: { id: 25189 }, input: {} }]);
  expect(await view.findByText('SO-25189 is picked. It waits in To pack.')).toBeInTheDocument();
});

test("the lists waiting are the loader's, first to ship first, a rush said as one", async () => {
  const view = renderExample(walk, Lists);
  const lists = await view.findAllByRole('button', { name: /^SO-/ });
  expect(lists.map((list) => list.textContent)).toEqual([
    expect.stringMatching(/^SO-25189North Woods.*Columbus · ships .* · rush$/),
    expect.stringMatching(/^SO-25184Cascade.*Reno · ships /),
  ]);
});

test('with nothing waiting, it says so', async () => {
  const view = renderExample(walk, Lists, { loaded: { lists: [] } });
  expect(await view.findByText('Nothing to pick')).toBeInTheDocument();
});

test('a reader who may not pick (a purchaser) walks the list and is offered no Pick', async () => {
  const view = renderExample(walk, Done, { commands: {} });
  expect(await view.findByText('All 3 lines picked')).toBeInTheDocument();
  expect(view.queryByRole('button', { name: 'Pick' })).toBeNull();
  expect(view.getAllByRole('button', { name: 'Back a line' })).toHaveLength(1);
});
