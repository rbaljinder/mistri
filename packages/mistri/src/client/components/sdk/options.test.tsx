/**
 * A reference input's choices for a picker a component draws itself (`useOptions`): searched and paged where the
 * platform's own picker reads them, the latest text winning, a pick named by its key when it is on no page, and a
 * pick the reader has lost access to said to be not available, never not found.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Typeahead } from '@mistriwork/ui';
import { useOptions, type UiOptions } from './options.js';
import { fixtures } from './fixture.js';
import { renderSection } from './testing.js';

afterEach(cleanup);

const payees = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, name: `Payee ${String(index + 1).padStart(2, '0')}` }));
const served = {
  pay: { label: 'Pay', input: { payee: { type: 'reference' as const, from: 'payee', required: true }, note: { type: 'text' as const } } },
};
const signedIn = { viewer: { signedIn: true, account: 'a' }, commands: served, data: fixtures({ payee: payees }) };

describe('useOptions', () => {
  const held: { options?: UiOptions } = {};
  function Picker() {
    held.options = useOptions('pay', 'payee');
    return null;
  }
  const options = () => held.options!;

  test('offers a page of matches, reads the next one, and searches by what is typed', async () => {
    renderSection(Picker, { component: { id: 'picker' } }, signedIn);
    await waitFor(() => expect(options().isPending).toBe(false));
    expect(options().pages).toHaveLength(1);
    expect(options().pages[0]).toHaveLength(20);
    expect(options().pages[0][0]).toEqual({ key: 1, label: 'Payee 01' });
    expect(options().hasMore).toBe(true);
    act(() => options().more());
    await waitFor(() => expect(options().pages).toHaveLength(2));
    expect(options().pages[1].map((one) => one.key)).toEqual([21, 22, 23, 24, 25]);
    expect(options().hasMore).toBe(false);
    act(() => options().setQuery('payee 1'));
    expect(options().isPending).toBe(true);
    await waitFor(() => expect(options().isPending).toBe(false));
    expect(
      options()
        .pages.flat()
        .map((one) => one.label),
    ).toEqual(['Payee 10', 'Payee 11', 'Payee 12', 'Payee 13', 'Payee 14', 'Payee 15', 'Payee 16', 'Payee 17', 'Payee 18', 'Payee 19']);
  });

  test('the latest text wins: a search typed over is never the one shown', async () => {
    renderSection(Picker, { component: { id: 'picker' } }, signedIn);
    await waitFor(() => expect(options().isPending).toBe(false));
    act(() => options().setQuery('nobody'));
    act(() => options().setQuery('25'));
    await waitFor(() => expect(options().isPending).toBe(false));
    expect(options().query).toBe('25');
    expect(options().pages.flat()).toEqual([{ key: 25, label: 'Payee 25' }]);
  });

  test('a pick on no page is named by its key; one the reader lost access to is not available, never not found', async () => {
    const drawn = renderSection(Picker, { component: { id: 'picker' } }, signedIn);
    act(() => options().setQuery('payee 0'));
    await waitFor(() => expect(options().pages.flat()).toHaveLength(9));
    act(() => options().select(23));
    await waitFor(() => expect(options().resolved).toEqual({ key: 23, label: 'Payee 23', available: true }));
    act(() => options().select(4));
    expect(options().resolved).toEqual({ key: 4, label: 'Payee 04', available: true });
    act(() => options().select(23));
    await drawn.refresh({ refused: { payee: 403 } });
    await waitFor(() => expect(options().resolved).toEqual({ key: 23, label: 'Not available', available: false }));
    expect(options().error).toBeTruthy();
  });

  test('a reader not granted the command is offered nothing; an input that picks no record is a mistake, said plainly', async () => {
    renderSection(Picker, { component: { id: 'picker' } }, { commands: served, data: fixtures({ payee: payees }) });
    expect(options()).toMatchObject({ pages: [], hasMore: false, isPending: false, error: null });
    function Wrong() {
      useOptions('pay', 'note');
      return null;
    }
    expect(() => render(<Wrong />)).toThrow();
    expect(() => renderSection(Wrong, { component: { id: 'wrong' } }, signedIn)).toThrow('pay has no input "note" that picks a record');
  });

  test('drawn with the kit’s Typeahead, the keyboard searches and picks', async () => {
    function Payee() {
      const payee = useOptions('pay', 'payee');
      const [open, setOpen] = useState(false);
      return (
        <>
          <Typeahead
            text={payee.query}
            onText={payee.setQuery}
            items={payee.pages.flat()}
            itemKey={(option) => String(option.key)}
            itemLabel={(option) => option.label}
            itemClassName={() => ''}
            renderItem={(option) => option.label}
            onPick={(option) => {
              payee.select(option.key);
              setOpen(false);
            }}
            open={open}
            onOpenChange={setOpen}
            inputProps={{ 'aria-label': 'Payee' }}
            popupClassName="payee-popup"
            listClassName="payee-list"
          />
          <output>{payee.resolved?.label}</output>
        </>
      );
    }
    renderSection(Payee, { component: { id: 'payee' } }, signedIn);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: 'Payee' }), '25');
    await screen.findByRole('option', { name: 'Payee 25' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    /* The matches arrive after the typing, so the reader arrows onto one, as they would. */
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Payee 25'));
  });
});
