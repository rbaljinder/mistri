/**
 * The controls bound to a page's params: the address is their state. Each is drawn on a page that also says the param
 * back (`page.useParam`), so what a control wrote is read where the address would be read; an address that moves by
 * itself (Back, a link) is a button on the page that writes the param as that would.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fixtures, renderPage } from './testing.js';
import type { ReactNode } from 'react';
import { Choose, DateRange, definePage, Search, useAddressState, useFormat } from './page.js';
import { splitRange } from './paramKinds.js';

afterEach(cleanup);

const CLASSES = fixtures({
  class_session: [
    { id: 2, title: 'Fresh pasta by hand', starts_at: '2026-09-15T18:30:00Z' },
    { id: 3, title: 'Knife skills', starts_at: '2026-09-16T18:30:00Z' },
    { id: 4, title: 'Sourdough', starts_at: '2026-09-17T18:30:00Z' },
  ],
});

/* A page whose `address` readout says every param as the address holds it, beside what the test draws. */
function Address({ names }: { names: string[] }) {
  const held = names.map((name) => [name, useAddressState(name)[0] ?? null]);
  return <output aria-label="address">{JSON.stringify(Object.fromEntries(held))}</output>;
}
function pageWith(params: Record<string, unknown>, body: () => ReactNode) {
  return definePage({
    label: 'Page',
    reads: ['class_session'],
    params: params as never,
    component: () => (
      <>
        {body()}
        <Address names={Object.keys(params)} />
      </>
    ),
  });
}

describe('Choose over the next words', () => {
  test('a few short words are a row of segments; the arrows move the choice and the address follows', async () => {
    const page = pageWith({ view: ['list', 'board', 'map'] }, () => <Choose param="view" />);
    renderPage(page, { address: { view: 'board' } });
    const group = await screen.findByRole('radiogroup', { name: 'View' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'board' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'list' })).toHaveAttribute('aria-checked', 'false');
    screen.getByRole('radio', { name: 'board' }).focus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'board' }), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('{"view":"map"}'));
    expect(screen.getByRole('radio', { name: 'map' })).toHaveAttribute('aria-checked', 'true');
  });

  test('an address with no choice leaves every segment unchosen, and the first is still the way in', async () => {
    const page = pageWith({ view: ['list', 'board'] }, () => <Choose param="view" />);
    renderPage(page);
    await screen.findByRole('radiogroup');
    expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'list' })).toHaveAttribute('tabindex', '0');
  });

  test('more than five options, or more words than a phone holds, is the listbox', async () => {
    const six = ['one', 'two', 'three', 'four', 'five', 'six'];
    renderPage(
      pageWith({ n: six }, () => <Choose param="n" />),
      { address: { n: 'two' } },
    );
    expect(await screen.findByRole('button', { name: /^N\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    cleanup();
    renderPage(
      pageWith({ k: ['an option that is long', 'another option that is long', 'a third option, long too'] }, () => <Choose param="k" />),
    );
    expect(await screen.findByRole('button', { name: /^K\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    cleanup();
    renderPage(pageWith({ k: ['a', 'b', 'c', 'd', 'e'] }, () => <Choose param="k" />));
    expect(await screen.findByRole('radiogroup')).toBeInTheDocument();
  });

  test('`all` is a first choice that clears the param, and `name` names the control', async () => {
    const page = pageWith({ view: ['list', 'board'] }, () => <Choose param="view" all="Any view" name="Layout" />);
    renderPage(page, { address: { view: 'list' } });
    expect(await screen.findByRole('radiogroup', { name: 'Layout' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Any view' }));
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('{"view":null}'));
    expect(screen.getByRole('radio', { name: 'Any view' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a param with no words and no `from` says what is missing, where the page can see it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = pageWith({ q: 'text' }, () => <Choose param="q" />);
    // Thrown to the page's boundary, as a List with no resource is, not drawn as an empty control.
    expect(() => renderPage(page)).toThrow(/<Choose param="q"> has no options/);
    quiet.mockRestore();
  });
});

describe('Choose over a read', () => {
  test('long labels are a listbox of the rows, and the chosen id reaches the address', async () => {
    const page = pageWith({ class: 'id' }, () => <Classes />);
    function Classes() {
      const format = useFormat();
      return (
        <Choose
          param="class"
          from="class_session"
          sort="starts_at"
          label={(row) => `${String(row.title)} · ${format.dateTime(String(row.starts_at))}`}
          name="Class"
        />
      );
    }
    const user = userEvent.setup();
    renderPage(page, { data: CLASSES });
    const trigger = await screen.findByRole('button', { name: /^Class\b/ });
    // A field box, like the search box a page sets beside it, never the grid's small bare listbox.
    expect(trigger).toHaveClass('field-control', 'field-select');
    await user.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('Fresh pasta by hand');
    console.log('before click');
    await user.click(options[1]);
    console.log('after click');
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('{"class":"3"}'));
    expect(screen.getByRole('button', { name: /^Class\b/ })).toHaveTextContent('Knife skills');
  });

  test('short labels from a column path are segments; a pasted address opens with the choice made', async () => {
    const page = pageWith({ class: 'id' }, () => <Choose param="class" from="class_session" label="title" sort="id desc" limit={2} />);
    renderPage(page, {
      address: { class: '4' },
      data: fixtures({
        class_session: [
          { id: 4, title: 'Bread' },
          { id: 3, title: 'Soup' },
        ],
      }),
    });
    expect(await screen.findByRole('radio', { name: 'Bread' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Soup' })).toHaveAttribute('aria-checked', 'false');
  });

  test('a label path through a reference reads the path the server shows, by its name', async () => {
    const page = pageWith({ class: 'id' }, () => <Choose param="class" from="class_session" label="teacher_id.name" />);
    renderPage(page, {
      data: fixtures({
        class_session: [
          { id: 4, teacher_id: 2, 'teacher_id.name': 'Rosa' },
          { id: 3, teacher_id: 5, 'teacher_id.name': 'Imani' },
        ],
      }),
    });
    expect(await screen.findByRole('radio', { name: 'Rosa' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Imani' })).toBeInTheDocument();
  });

  test('the room it takes is held while it reads, and a read with no rows says `empty`', async () => {
    const page = pageWith({ class: 'id' }, () => (
      <Choose param="class" from="class_session" label="title" empty={<p>No classes coming up</p>} />
    ));
    renderPage(page, { data: fixtures({ class_session: [] }) });
    expect(document.querySelector('.kit-param')).not.toBeNull();
    expect(await screen.findByText('No classes coming up')).toBeInTheDocument();
  });
});

describe('Search', () => {
  test('what is typed reaches the address after a pause, and an address that moves by itself puts the box as it says', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const Moves = () => {
        const [, set] = useAddressState('q');
        return <button onClick={() => set('from Back')}>Back</button>;
      };
      const page = pageWith({ q: 'text' }, () => (
        <>
          <Search param="q" />
          <Moves />
        </>
      ));
      renderPage(page, { address: { q: 'stone' } });
      const box = await screen.findByRole('textbox', { name: 'Q' });
      expect(box).toHaveValue('stone');
      fireEvent.change(box, { target: { value: 'granite' } });
      expect(screen.getByLabelText('address')).toHaveTextContent('{"q":"stone"}');
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(screen.getByLabelText('address')).toHaveTextContent('{"q":"granite"}');
      // Cleared, the param is gone from the address rather than empty in it.
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.blur(box);
      expect(screen.getByLabelText('address')).toHaveTextContent('{"q":null}');
      // The address moved by itself (Back, a link): the box says what it now says.
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Q' })).toHaveValue('from Back'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DateRange', () => {
  test('a run of days reads from the address, a whole day writes it, half a date waits', async () => {
    const page = pageWith({ period: 'date-range' }, () => <DateRange param="period" name="Period" />);
    renderPage(page, { address: { period: '2026-11-01..2026-11-08' } });
    const from = await screen.findByLabelText('Period, From');
    const to = screen.getByLabelText('Period, To');
    expect(screen.getByRole('group', { name: 'Period' })).toBeInTheDocument();
    expect(from).toHaveValue('11/01/2026');
    expect(to).toHaveValue('11/08/2026');
    fireEvent.change(to, { target: { value: '11/1' } });
    expect(screen.getByLabelText('address')).toHaveTextContent('{"period":"2026-11-01..2026-11-08"}');
    fireEvent.change(to, { target: { value: '11/15/2026' } });
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('{"period":"2026-11-01..2026-11-15"}'));
    fireEvent.change(from, { target: { value: '' } });
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('{"period":"..2026-11-15"}'));
  });

  test('the kind: a run is two days on the calendar, either open, never both', () => {
    expect(splitRange('2026-11-01..2026-11-08')).toEqual(['2026-11-01', '2026-11-08']);
    expect(splitRange('..2026-11-08')).toEqual(['', '2026-11-08']);
    expect(splitRange('2026-11-01..')).toEqual(['2026-11-01', '']);
    for (const bad of ['..', '2026-11-01', '2026-02-30..', 'soon..2026-11-08', undefined]) expect(splitRange(bad)).toBeUndefined();
  });

  test('useParam reads a range already checked', async () => {
    const page = definePage({
      label: 'Range',
      reads: [],
      params: { period: 'date-range' },
      component: () => <p>{JSON.stringify(page.useParam('period')[0] ?? null)}</p>,
    });
    renderPage(page, { address: { period: '2026-11-01..2026-11-08' } });
    expect(await screen.findByText('"2026-11-01..2026-11-08"')).toBeInTheDocument();
    renderPage(page, { address: { period: '2026-11-01' } });
    expect(await screen.findByText('null')).toBeInTheDocument();
  });
});
