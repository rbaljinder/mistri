import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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
  expect(opened).toHaveBeenLastCalledWith(true);
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
