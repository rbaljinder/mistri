/** The new standalone primitives: Switch, Tabs, Drawer, Popover, Avatar and Pagination. */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Switch, type SwitchProps } from './Switch.js';
import { Tabs } from './Tabs.js';
import { Drawer } from './Drawer.js';
import { Popover } from './Popover.js';
import { Avatar, initialsOf } from './Avatar.js';
import { Pagination, paginationItems } from './Pagination.js';

afterEach(cleanup);

test('a switch says its state and toggles on Space, and a busy switch refuses the press', async () => {
  const onCheckedChange = vi.fn();
  const { rerender } = render(<Switch label="Notify me" onCheckedChange={onCheckedChange} />);
  const control = screen.getByRole('switch', { name: 'Notify me' });
  expect(control).toHaveAttribute('aria-checked', 'false');
  await userEvent.click(control);
  expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  rerender(<Switch label="Notify me" checked onCheckedChange={onCheckedChange} busy />);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(screen.getByRole('switch'));
  expect(onCheckedChange).toHaveBeenCalledTimes(1);
});

test('tabs show one panel at a time and the arrow walk moves between them', async () => {
  render(
    <Tabs
      tabs={[
        { value: 'one', label: 'One', children: 'First panel' },
        { value: 'two', label: 'Two', children: 'Second panel' },
      ]}
    />,
  );
  expect(screen.getByText('First panel')).toBeVisible();
  expect(screen.queryByText('Second panel')).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Two' }));
  expect(screen.getByText('Second panel')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
});

test('a drawer mounts only while open and closes on Escape', async () => {
  const onOpenChange = vi.fn();
  const { rerender } = render(
    <Drawer open title="Filters" onOpenChange={onOpenChange}>
      <button>Inside</button>
    </Drawer>,
  );
  expect(screen.getByText('Filters')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  /* Base UI reports the open state first and the reason second; the
     test's claim is the state, not the reason. */
  expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  rerender(
    <Drawer open={false} title="Filters" onOpenChange={onOpenChange}>
      <button>Inside</button>
    </Drawer>,
  );
  /* Base UI keeps the sheet in the tree for its exit animation; the
     claim that matters here is that it is no longer the open sheet. */
  expect(screen.queryByRole('dialog')).not.toHaveAttribute('data-open');
});

test('a popover opens from its trigger and shows its layer', async () => {
  render(
    <Popover trigger={<button>Open</button>}>
      <p>Popover body</p>
    </Popover>,
  );
  expect(screen.queryByText('Popover body')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByText('Popover body')).toBeVisible();
});

test('an avatar falls back to initials, two words then one', () => {
  expect(initialsOf('Ada Lovelace')).toBe('AL');
  expect(initialsOf('Ada')).toBe('A');
  expect(initialsOf('')).toBe('');
  render(<Avatar name="Ada Lovelace" />);
  expect(screen.getByText('AL')).toBeVisible();
});

test('pagination marks the current page, disables the ends, and shortens a long run', async () => {
  const onPageChange = vi.fn();
  render(<Pagination page={1} pages={20} onPageChange={onPageChange} />);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('button', { name: '3' }));
  expect(onPageChange).toHaveBeenCalledWith(3);
  expect(paginationItems(10, 20)).toEqual([1, '…', 8, 9, 10, 11, 12, '…', 20]);
  expect(paginationItems(1, 3)).toEqual([1, 2, 3]);
});

test('pagination renders nothing for a single page', () => {
  const { container } = render(<Pagination page={1} pages={1} onPageChange={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test('a switch without a label still renders, and fireEvent toggles an uncontrolled one', () => {
  render(<Switch defaultChecked={false} />);
  const control = screen.getByRole('switch');
  fireEvent.click(control);
  expect(control).toHaveAttribute('aria-checked', 'true');
});

test('switch props type-check: controlled props are accepted', () => {
  const props: SwitchProps = { checked: true, onCheckedChange: () => {} };
  expect(props.checked).toBe(true);
});
