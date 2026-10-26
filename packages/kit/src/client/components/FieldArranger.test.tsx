/** Arranging fields: add, remove, reorder from the keyboard, and send one to another group. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { FieldArranger } from './FieldArranger.js';

afterEach(cleanup);

test('counts, adds from the pool, removes, and Alt+arrows reorder with focus following', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <FieldArranger
      all={['id', 'name', 'email', 'phone']}
      chosen={['id', 'name']}
      typeOf={(n) => (n === 'id' ? 'integer' : 'text')}
      onChange={onChange}
    />,
  );
  expect(screen.getByText('2 of 4 · drag to arrange')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))).toEqual([
    'id — position 1 of 2',
    'name — position 2 of 2',
  ]);
  await user.click(screen.getByRole('button', { name: 'Add email' }));
  expect(onChange).toHaveBeenLastCalledWith(['id', 'name', 'email']);
  await user.click(screen.getByRole('button', { name: 'Remove id' }));
  expect(onChange).toHaveBeenLastCalledWith(['name']);
  fireEvent.keyDown(screen.getAllByRole('listitem')[0], { key: 'ArrowDown', altKey: true });
  expect(onChange).toHaveBeenLastCalledWith(['name', 'id']);
  await user.click(screen.getByRole('button', { name: 'None' }));
  expect(onChange).toHaveBeenLastCalledWith([]);
  await user.click(screen.getByRole('button', { name: 'All' }));
  expect(onChange).toHaveBeenLastCalledWith(['id', 'name', 'email', 'phone']);
});

test('with other groups, → hands a field over: straight to the only one, or via a choice in the row', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const onSend = vi.fn();
  const contact = { title: 'Contact', receive: vi.fn() };
  const billing = { title: 'Billing', receive: vi.fn() };
  const { rerender } = render(
    <FieldArranger all={['id', 'email']} chosen={['id', 'email']} onChange={onChange} others={[contact]} onSend={onSend} />,
  );
  await user.click(screen.getByRole('button', { name: 'Move email to another group' }));
  expect(contact.receive).toHaveBeenCalledWith('email');
  expect(onChange).toHaveBeenLastCalledWith(['id']);
  expect(onSend).toHaveBeenCalledTimes(1);
  rerender(
    <FieldArranger all={['id', 'email']} chosen={['id', 'email']} onChange={onChange} others={[contact, billing]} onSend={onSend} />,
  );
  await user.click(screen.getByRole('button', { name: 'Move id to another group' }));
  await user.click(screen.getByRole('button', { name: 'Billing' }));
  expect(billing.receive).toHaveBeenCalledWith('id');
  expect(onChange).toHaveBeenLastCalledWith(['email']);
});

test('an empty group says so, and a full one has nothing left to add', () => {
  render(<FieldArranger all={['id']} chosen={[]} noun="page" onChange={() => {}} />);
  expect(screen.getByText('No fields in this group yet.')).toBeInTheDocument();
  cleanup();
  render(<FieldArranger all={['id']} chosen={['id']} noun="page" onChange={() => {}} />);
  expect(screen.getByText('Every field is on the page')).toBeInTheDocument();
});
