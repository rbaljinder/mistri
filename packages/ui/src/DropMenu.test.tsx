import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { DropGroup, DropItem, DropMenu, DropSeparator } from './DropMenu.js';

afterEach(cleanup);

function Menu({ pick = () => {}, onOpenChange }: { pick?: (what: string) => void; onOpenChange?: (open: boolean) => void }) {
  return (
    <DropMenu className="sort" triggerClassName="sort-btn" label="Sort" popupClassName="sort-menu" onOpenChange={onOpenChange}>
      <DropGroup className="sort-group" labelClassName="sort-label" label="Order">
        <DropItem className="sort-item" onClick={() => pick('newest')}>
          Newest first
        </DropItem>
        <DropItem className="sort-item" disabled onClick={() => pick('oldest')}>
          Oldest first
        </DropItem>
      </DropGroup>
      <DropSeparator className="sort-rule" />
      <DropItem className="sort-item" onClick={() => pick('reset')}>
        Reset
      </DropItem>
    </DropMenu>
  );
}

test('the trigger opens a menu of its items in the classes it was given, with no server behind it', async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  render(<Menu onOpenChange={opened} />);
  const trigger = screen.getByRole('button', { name: 'Sort' });
  expect(trigger).toHaveClass('sort-btn');
  await user.click(trigger);
  expect(opened).toHaveBeenLastCalledWith(true, expect.objectContaining({ reason: 'trigger-press' }));
  const menu = await screen.findByRole('menu');
  expect(menu).toHaveClass('sort-menu');
  expect(screen.getByRole('group', { name: 'Order' })).toHaveClass('sort-group');
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Newest first', 'Oldest first', 'Reset']);
  expect(screen.getByRole('menuitem', { name: 'Oldest first' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('separator')).toHaveClass('sort-rule');
});

test('an item runs and closes the menu; Escape closes it and hands focus back to the trigger', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<Menu pick={pick} />);
  const trigger = screen.getByRole('button', { name: 'Sort' });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Newest first' }));
  expect(pick).toHaveBeenCalledWith('newest');
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await screen.findByRole('menu');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(trigger).toHaveFocus();
});

test('a menu given no classes still draws: the house trigger, surface and items are the defaults', async () => {
  const user = userEvent.setup();
  render(
    <DropMenu label="More">
      <DropItem onClick={() => {}}>Rename</DropItem>
      <DropSeparator />
    </DropMenu>,
  );
  // With no class of the caller's, each is the menu's own part, which the stylesheet dresses.
  expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('data-slot', 'menu-trigger');
  await user.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveAttribute('data-slot', 'menu-item');
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menu')).toHaveAttribute('data-slot', 'menu-content');
  expect(screen.getAllByRole('separator')).toHaveLength(1);
});

test('a caller says where the focus goes on close: an element, the trigger, or nowhere', async () => {
  const user = userEvent.setup();
  let answer: boolean | HTMLElement | null = null;
  render(
    <>
      <button>Elsewhere</button>
      <DropMenu label="Move" finalFocus={() => answer}>
        <DropItem onClick={() => {}}>Up</DropItem>
      </DropMenu>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'Move' });
  const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
  // An element: the row the item moved, say.
  answer = elsewhere;
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Up' }));
  expect(elsewhere).toHaveFocus();
  // `true` is the trigger, as when the caller says nothing.
  answer = true;
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Up' }));
  expect(trigger).toHaveFocus();
  // `false` leaves the focus be: it is not handed to the trigger.
  answer = false;
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Up' }));
  expect(trigger).not.toHaveFocus();
});

test('a menu that opens before its items arrive gives the keyboard the first one when it does', async () => {
  const user = userEvent.setup();
  function Loads() {
    const [items, setItems] = useState<string[]>([]);
    return (
      <DropMenu label="Views" onOpenChange={(open) => open && setTimeout(() => setItems(['Mine', 'All']), 30)}>
        {items.map((item) => (
          <DropItem key={item} onClick={() => {}}>
            {item}
          </DropItem>
        ))}
      </DropMenu>
    );
  }
  render(<Loads />);
  screen.getByRole('button', { name: 'Views' }).focus();
  await user.keyboard('{Enter}');
  const first = await screen.findByRole('menuitem', { name: 'Mine' });
  await waitFor(() => expect(first).toHaveFocus());
});
