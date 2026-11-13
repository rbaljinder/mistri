/**
 * `@mistriwork/mistri/page`'s own blocks: one import path holding the whole of `mistri/ui` and more, a command's and a
 * fixed action's button on one row (hidden, held, named and announced as a person meets it), a `Scope` whose condition
 * the blocks inside it inherit, a `List` drawing a read's rows and its empty and refused states, and the typed
 * parameters `useParam` hands back already checked.
 */
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { state } from '@mistriwork/kit/client/core.js';
import { PAGE_EXPORTS, UI_EXPORTS } from '../../../shared/uiSdk.js';
import { UiPageContext, type UiPageFrame } from './context.js';
import { fixtureHost, SectionFrame } from './fixture.js';
import { fixtures, renderPage } from './testing.js';
import { useCommand, useGranted, useRows } from './hooks.js';
import { ActionButton, CommandButton, definePage, List, Scope } from './page.js';

const BOOKINGS = fixtures({
  booking: [
    { id: 1, guest_name: 'Morgan Lee', class_session_id: 4, status: 'booked', party_size: 2 },
    { id: 2, guest_name: 'Ana Ruiz', class_session_id: 4, status: 'checked_in', party_size: 1 },
    { id: 3, guest_name: 'Sam Ito', class_session_id: 5, status: 'booked', party_size: 3 },
    { id: 4, guest_name: 'Kai Moss', class_session_id: 4, status: 'booked', party_size: 4 },
  ],
});
const SIGNED_IN = { signedIn: true, account: 'a' };

describe('one import path', () => {
  test('the page entry exports exactly its list, and that list holds every name mistri/ui exports', async () => {
    const page = await import('./page.js');
    expect(Object.keys(page).sort()).toEqual([...PAGE_EXPORTS].sort());
    for (const name of UI_EXPORTS) expect(PAGE_EXPORTS).toContain(name);
  });
});

describe('a command on one row', () => {
  const desk = definePage({
    label: 'Desk',
    reads: ['booking'],
    commands: ['checkIn'],
    actions: ['seat'],
    component: () => (
      <List from="booking" where={{ class_session_id: 4, status: 'booked' }} show={['guest_name']} sort="guest_name">
        {(row) => (
          <>
            <CommandButton command="checkIn" row={row} done={`${row.guest_name} is checked in.`} />
            <ActionButton action="seat" row={row} />
          </>
        )}
      </List>
    ),
  });

  test('is drawn only for a reader granted it, and named with its row', async () => {
    renderPage(desk, { data: BOOKINGS, viewer: SIGNED_IN, commands: { checkIn: { label: 'Check in' } } });
    expect(await screen.findByRole('button', { name: 'Check in Kai Moss' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check in Morgan Lee' })).toBeInTheDocument();
    // `seat` is not served to this reader, so no button stands for it.
    expect(screen.queryByRole('button', { name: /^seat/ })).toBeNull();
    // Signed out, the rows are drawn and no button stands on them.
    renderPage(desk, { data: BOOKINGS, commands: { checkIn: { label: 'Check in' } } });
    await vi.waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  test("is named with its row from a plain read's rows, and a label of its own keeps the row's title", async () => {
    function Arrivals() {
      const rows = useRows('booking', { where: { class_session_id: 4, status: 'booked' }, show: ['guest_name'], sort: 'guest_name' });
      return (
        <ul>
          {rows.data?.map((row) => (
            <li key={String(row.guest_name)}>
              <CommandButton command="checkIn" label="Arrive" row={row} />
            </li>
          ))}
        </ul>
      );
    }
    renderPage(definePage({ label: 'Arrivals', reads: ['booking'], commands: ['checkIn'], component: Arrivals }), {
      data: BOOKINGS,
      viewer: SIGNED_IN,
      commands: { checkIn: { label: 'Check in' } },
    });
    expect(await screen.findByRole('button', { name: 'Arrive Kai Moss' })).toBeInTheDocument();
  });

  test('a command that names no row is a button with none, enabled and named by its label alone', async () => {
    renderPage(
      definePage({ label: 'Desk', reads: ['booking'], commands: ['checkIn'], component: () => <CommandButton command="checkIn" /> }),
      {
        data: BOOKINGS,
        viewer: SIGNED_IN,
        commands: { checkIn: { label: 'Check in' } },
      },
    );
    const button = await screen.findByRole('button', { name: 'Check in' });
    await vi.waitFor(() => expect(button).not.toBeDisabled());
  });

  test("is held where the row's state does not allow it", async () => {
    const available = (key: Readonly<Record<string, unknown>>) => key.id !== 4;
    renderPage(desk, { data: BOOKINGS, viewer: SIGNED_IN, commands: { checkIn: { label: 'Check in', available } } });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Check in Kai Moss' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Check in Morgan Lee' })).not.toBeDisabled();
  });

  test("announces its outcome in `done`'s words, and a refusal in the server's", async () => {
    const announced: { text: string; tone: 'ok' | 'error' }[] = [];
    const drawn = renderPage(desk, { data: BOOKINGS, viewer: SIGNED_IN, commands: { checkIn: { label: 'Check in' } }, announced });
    (await screen.findByRole('button', { name: 'Check in Morgan Lee' })).click();
    expect(await screen.findByText('Morgan Lee is checked in.')).toBeInTheDocument();
    expect(announced).toEqual([{ text: 'Morgan Lee is checked in.', tone: 'ok' }]);
    expect(drawn.commands).toEqual([{ command: 'checkIn', mode: 'run', key: { guest_name: 'Morgan Lee', id: 1 } }]);

    const refused: { text: string; tone: 'ok' | 'error' }[] = [];
    const outcome = { status: 'refused' as const, message: 'This class has ended.' };
    renderPage(desk, { data: BOOKINGS, viewer: SIGNED_IN, commands: { checkIn: { label: 'Check in', outcome } }, announced: refused });
    (await screen.findByRole('button', { name: 'Check in Morgan Lee' })).click();
    await vi.waitFor(() => expect(refused).toEqual([{ text: 'This class has ended.', tone: 'error' }]));
  });

  test("a fixed action's button says its outcome in `done`'s words, or the action's own", async () => {
    const announced: { text: string; tone: 'ok' | 'error' }[] = [];
    const served = { seat: { label: 'Seat' } };
    const drawn = renderPage(desk, { data: BOOKINGS, viewer: SIGNED_IN, commands: served, announced });
    (await screen.findByRole('button', { name: 'Seat Kai Moss' })).click();
    await vi.waitFor(() => expect(announced).toHaveLength(1));
    expect(announced[0].tone).toBe('ok');
    expect(drawn.commands).toEqual([{ command: 'seat', mode: 'run', key: { guest_name: 'Kai Moss', id: 4 } }]);
    // Not granted the command, the reader sees only the action's button.
    expect(screen.queryByRole('button', { name: /^Check in/ })).toBeNull();
  });
});

describe('asking whether a command may be run', () => {
  /* A field report: a New page showed an entry only to a role granted its command, and had to declare every one
     of them in `commands` to ask, though it ran none. */
  function Entries() {
    const mayCheckIn = useGranted('checkIn');
    const maySeat = useGranted('seat');
    return <p>{`checkIn ${mayCheckIn} seat ${maySeat}`}</p>;
  }
  const entries = definePage({ label: 'New', reads: ['booking'], commands: [], component: Entries });

  test('useGranted answers on a page that declares no command, as granted says', async () => {
    renderPage(entries, { data: BOOKINGS, viewer: SIGNED_IN, commands: { checkIn: { label: 'Check in' } } });
    expect(await screen.findByText('checkIn true seat false')).toBeInTheDocument();
    renderPage(entries, { data: BOOKINGS, commands: { checkIn: { label: 'Check in' } } });
    expect(await screen.findByText('checkIn false seat false')).toBeInTheDocument();
  });

  test('running one still needs it declared', () => {
    const Runs = () => <p>{useCommand('checkIn').label}</p>;
    const muted = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        renderPage(definePage({ label: 'New', reads: ['booking'], commands: [], component: Runs }), { viewer: SIGNED_IN }),
      ).toThrow(/checkIn/);
    } finally {
      muted.mockRestore();
    }
  });
});

describe('Scope and List', () => {
  test("a List inside a Scope reads the Scope's resource under its condition and its own", async () => {
    const page = definePage({
      label: 'Class',
      reads: ['booking'],
      component: () => (
        <Scope from="booking" where={{ class_session_id: 4 }}>
          <List where={{ status: 'booked' }} show={['guest_name']} sort="guest_name" label="Expected">
            {(row) => <span>{`${row.guest_name}`}</span>}
          </List>
          <Scope from="booking" where={{ party_size: { gt: 2 } }}>
            <List show={['guest_name']} label="Large parties">
              {(row) => <span>{`${row.guest_name}`}</span>}
            </List>
          </Scope>
        </Scope>
      ),
    });
    renderPage(page, { data: BOOKINGS });
    const expected = await screen.findByRole('list', { name: 'Expected' });
    expect([...expected.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Kai Moss', 'Morgan Lee']);
    // The inner Scope narrows the outer one: session 4 and more than two guests.
    const large = await screen.findByRole('list', { name: 'Large parties' });
    expect([...large.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Kai Moss']);
  });

  test('a List with no rows says its empty state; one the reader may not read says so, not "nothing here"', async () => {
    const page = definePage({
      label: 'Empty',
      reads: ['booking'],
      component: () => (
        <List from="booking" where={{ status: 'cancelled' }} empty="No cancellations.">
          {(row) => <span>{`${row.guest_name}`}</span>}
        </List>
      ),
    });
    renderPage(page, { data: BOOKINGS });
    expect(await screen.findByText('No cancellations.')).toBeInTheDocument();

    const said = { 401: 'This list is for signed-in members.', 403: 'This list is not available to your role.' };
    for (const status of [401, 403] as const) {
      const host = fixtureHost(BOOKINGS, {}, []);
      host.rows = async () => {
        throw Object.assign(new Error('refused'), { status });
      };
      const view = render(
        <SectionFrame host={host} id="refused" width={960}>
          <List from="booking">{(row) => <span>{`${row.guest_name}`}</span>}</List>
        </SectionFrame>,
      );
      expect(await view.findByText(said[status])).toBeInTheDocument();
      expect(view.container.querySelector('ul')).toBeNull();
      view.unmount();
    }
  });
});

describe('a read past its limit, and one that changes under the page', () => {
  test('a List cut at its limit says it shows the first rows; one that holds them all says nothing', async () => {
    const page = definePage({
      label: 'Bookings',
      reads: ['booking'],
      component: () => (
        <>
          <List from="booking" show={['guest_name']} sort="id" limit={2} label="First">
            {(row) => <span>{`${row.guest_name}`}</span>}
          </List>
          <List from="booking" show={['guest_name']} sort="id" limit={4} label="All">
            {(row) => <span>{`${row.guest_name}`}</span>}
          </List>
        </>
      ),
    });
    renderPage(page, { data: BOOKINGS });
    const first = await screen.findByRole('list', { name: 'First' });
    expect(first.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Showing the first 2.')).toBeInTheDocument();
    expect((await screen.findByRole('list', { name: 'All' })).querySelectorAll('li')).toHaveLength(4);
    expect(screen.queryByText('Showing the first 4.')).toBeNull();
  });

  test('useRows reads the next page on more(), and the page says when there is no more', async () => {
    const page = definePage({
      label: 'Paged',
      reads: ['booking'],
      component: () => {
        const rows = page.useRows('booking', { show: ['guest_name'], sort: 'id', limit: 3 });
        return (
          <>
            <p>{(rows.data ?? []).map((row) => row.guest_name).join(', ')}</p>
            <p>{`more: ${rows.page.hasMore}, limit: ${rows.page.limit}, total: ${rows.page.total ?? 'none'}`}</p>
            <button type="button" onClick={rows.more}>
              More
            </button>
          </>
        );
      },
    });
    renderPage(page, { data: BOOKINGS });
    expect(await screen.findByText('Morgan Lee, Ana Ruiz, Sam Ito')).toBeInTheDocument();
    // No total unless the server counted one: a page knows only whether there is more.
    expect(screen.getByText('more: true, limit: 3, total: none')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByText('Morgan Lee, Ana Ruiz, Sam Ito, Kai Moss')).toBeInTheDocument();
    expect(screen.getByText('more: false, limit: 3, total: none')).toBeInTheDocument();
  });

  const watched = definePage({
    label: 'Watched',
    reads: ['booking'],
    component: () => {
      const rows = watched.useRows('booking', { show: ['guest_name'], sort: 'id' });
      return (
        <p>
          {rows.isPending
            ? 'reading'
            : `${(rows.data ?? []).length} rows, stale: ${rows.isStale}, failed: ${rows.refreshError ? (rows.refreshError as { status?: number }).status : 'no'}`}
        </p>
      );
    },
  });

  test('a refresh reads the server as it is now', async () => {
    const view = renderPage(watched, { data: BOOKINGS });
    expect(await screen.findByText('4 rows, stale: false, failed: no')).toBeInTheDocument();
    await view.refresh({ data: { booking: BOOKINGS.tables.booking!.slice(0, 1) } });
    expect(await screen.findByText('1 rows, stale: false, failed: no')).toBeInTheDocument();
    // The test's own fixtures are not the drawing's server: the next drawing reads them whole.
    expect(BOOKINGS.tables.booking).toHaveLength(4);
  });

  test('a refresh that fails keeps the last good rows and says they are stale, until one answers again', async () => {
    const view = renderPage(watched, { data: BOOKINGS });
    expect(await screen.findByText('4 rows, stale: false, failed: no')).toBeInTheDocument();
    await view.refresh({ refused: { booking: 403 } });
    expect(await screen.findByText('4 rows, stale: true, failed: 403')).toBeInTheDocument();
    await view.refresh({ refused: {} });
    expect(await screen.findByText('4 rows, stale: false, failed: no')).toBeInTheDocument();
  });

  test('a read refused from the start draws the refused state, never an empty list', async () => {
    const page = definePage({
      label: 'Refused',
      reads: ['booking'],
      component: () => (
        <List from="booking" empty="Nothing here.">
          {(row) => <span>{`${row.guest_name}`}</span>}
        </List>
      ),
    });
    renderPage(page, { data: BOOKINGS, refused: { booking: 403 } });
    expect(await screen.findByText('This list is not available to your role.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).toBeNull();
  });
});

describe("a record's tab", () => {
  const tab = definePage({
    label: 'Pipeline',
    reads: ['account', 'opportunity'],
    component: () => <p>{JSON.stringify(tab.useRecordKey('account'))}</p>,
  });
  const unread = definePage({
    label: 'Unread',
    reads: ['opportunity'],
    component: () => <p>{JSON.stringify(unread.useRecordKey('account'))}</p>,
  });
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  test('useRecordKey hands back the key of the record the tab is drawn on', async () => {
    renderPage(tab, { record: { id: 13 } });
    expect(await screen.findByText('{"id":13}')).toBeInTheDocument();
  });

  test('outside a record, and for a resource the page does not read, it says what to do', () => {
    const muted = quiet();
    try {
      expect(() => renderPage(tab)).toThrow(/"Pipeline" is not a record's tab: place it at pages\/<list view>\/\[id\]\/<tab>\.page\.tsx/);
      expect(() => renderPage(unread, { record: { id: 13 } })).toThrow(
        /A record's tab reads its record's resource: add "account" to its reads/,
      );
    } finally {
      muted.mockRestore();
    }
  });

  test("on a tab of another resource's record, it names the record's own", () => {
    const frame: UiPageFrame = {
      view: 'dash-accounts-pipeline',
      label: 'Pipeline',
      reads: ['account', 'opportunity'],
      commands: [],
      params: [],
      get: () => undefined,
      set: () => {},
      record: { table: 'opportunity', key: { id: 4 } },
    };
    const Probe = () => <p>{JSON.stringify(tab.useRecordKey('account'))}</p>;
    const muted = quiet();
    try {
      expect(() =>
        render(
          <UiPageContext.Provider value={frame}>
            <Probe />
          </UiPageContext.Provider>,
        ),
      ).toThrow('useRecordKey("account") on a tab of a "opportunity" record: name the record\'s own resource, "opportunity".');
    } finally {
      muted.mockRestore();
    }
  });
});

describe('typed params', () => {
  const kinds = definePage({
    label: 'Params',
    reads: [],
    params: { class: 'id', day: 'date', view: ['list', 'board'], q: 'text' },
    component: () => {
      const [id] = kinds.useParam('class');
      const [day] = kinds.useParam('day');
      const [view] = kinds.useParam('view');
      const [q] = kinds.useParam('q');
      return <p>{JSON.stringify({ id, day, view, q })}</p>;
    },
  });

  test('an id is a number, past 2^53 its digits; a day is checked against the calendar; a literal is one of its list', async () => {
    renderPage(kinds, { address: { class: '42', day: '2026-11-08', view: 'board', q: 'stone' } });
    expect(await screen.findByText('{"id":42,"day":"2026-11-08","view":"board","q":"stone"}')).toBeInTheDocument();
    renderPage(kinds, { address: { class: '9007199254740993' } });
    expect(await screen.findByText('{"id":"9007199254740993"}')).toBeInTheDocument();
  });

  test('a value not of its kind is no value, as a param the address lacks is', async () => {
    renderPage(kinds, { address: { class: '4x', day: '2026-02-30', view: 'grid', q: '' } });
    expect(await screen.findByText('{"q":""}')).toBeInTheDocument();
    renderPage(kinds, { address: { class: '-1', day: '11/08/2026' } });
    expect(await screen.findByText('{}')).toBeInTheDocument();
  });

  test("an id named for a resource the page reads follows that resource's key: text for a text key, a number for an integer one", async () => {
    const before = state.schema;
    state.schema = {
      tables: [
        { name: 'vehicle', id: 'vehicle', columns: [{ name: 'id', type: 'text', nullable: false, primaryKey: true }] },
        { name: 'bay', id: 'bay', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }] },
      ],
    } as unknown as typeof state.schema;
    try {
      const keyed = definePage({
        label: 'Keyed',
        reads: ['vehicle', 'bay'],
        params: { vehicle: 'id', bay: 'id', other: 'id' },
        component: () => {
          const [vehicle] = keyed.useParam('vehicle');
          const [bay] = keyed.useParam('bay');
          const [other] = keyed.useParam('other');
          return <p>{JSON.stringify({ vehicle, bay, other })}</p>;
        },
      });
      renderPage(keyed, { address: { vehicle: 'ten_4fK-9.x', bay: '7', other: '12' } });
      expect(await screen.findByText('{"vehicle":"ten_4fK-9.x","bay":7,"other":12}')).toBeInTheDocument();
      // Text that is not URL-safe is no id; an integer key stays integer; a param naming no table keeps today's reading.
      renderPage(keyed, { address: { vehicle: 'a b', bay: 'north', other: 'north' } });
      expect(await screen.findByText('{}')).toBeInTheDocument();
    } finally {
      state.schema = before;
    }
  });

  test('the list form still means text', async () => {
    const listed = definePage({
      label: 'Listed',
      reads: [],
      params: ['class'],
      component: () => <p>{JSON.stringify(listed.useParam('class')[0])}</p>,
    });
    renderPage(listed, { address: { class: '42' } });
    expect(await screen.findByText('"42"')).toBeInTheDocument();
  });
});

describe('a form the page declares', () => {
  const steps = [
    { id: 'you', label: 'You' },
    { id: 'plan', label: 'Plan' },
  ];
  const home = definePage({
    label: 'Home',
    reads: [],
    forms: ['apply'],
    component: () => {
      const apply = home.useForm('apply');
      if (apply.isPending) return null;
      return (
        <>
          <p>
            {JSON.stringify({ granted: apply.granted, step: apply.step, saved: apply.saved, dirty: apply.dirty, pending: apply.pending })}
          </p>
          <p>{apply.outcome ? `ended ${apply.outcome.status}` : 'not opened'}</p>
          <button onClick={() => void apply.open({ plan: 'team' })}>{apply.dirty ? 'Continue your application' : 'Apply'}</button>
          <button onClick={() => void apply.goTo('you')}>Edit your details</button>
          <button onClick={() => void apply.startOver().then((gone) => gone || setNote('kept'))}>Start over</button>
        </>
      );
    },
  });
  let setNote = (_: string) => {};

  test('a resumed draft reads as the form resumes it, and the page continues it', async () => {
    const draft = { saved: ['you'], step: 'plan', expiresAt: '2026-11-15T00:00:00.000Z' };
    const drawn = renderPage(home, { viewer: SIGNED_IN, forms: { apply: { steps, draft } } });
    expect(await screen.findByText('{"granted":true,"step":"plan","saved":["you"],"dirty":true,"pending":false}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue your application' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit your details' }));
    expect(drawn.navigations).toEqual([
      { kind: 'form', view: 'apply', prefill: { plan: 'team' } },
      { kind: 'form', view: 'apply', prefill: {}, at: 'you' },
    ]);
  });

  test('how the form ended is held, and the draft is read again', async () => {
    const forms = { apply: { steps, outcome: { status: 'received' as const, reference: 'APP-0001' } } };
    renderPage(home, { viewer: SIGNED_IN, forms });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('ended received')).toBeInTheDocument();
  });

  test('Start over is refused while a submit was sent and its result is not known', async () => {
    const notes: string[] = [];
    setNote = (note) => notes.push(note);
    const draft = { saved: ['you'], step: 'plan', expiresAt: null };
    renderPage(home, { viewer: SIGNED_IN, forms: { apply: { steps, draft, pending: true } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }));
    await vi.waitFor(() => expect(notes).toEqual(['kept']));
    expect(screen.getByText(/"pending":true/)).toBeInTheDocument();
  });

  test('Start over discards the draft, and the page reads it gone', async () => {
    const draft = { saved: ['you'], step: 'plan', expiresAt: null };
    renderPage(home, { viewer: SIGNED_IN, forms: { apply: { steps, draft } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }));
    expect(await screen.findByText('{"granted":true,"step":null,"saved":[],"dirty":false,"pending":false}')).toBeInTheDocument();
  });

  test('a form not served, or a signed-out reader, is not granted', async () => {
    renderPage(home, { forms: { apply: { steps } } });
    expect(await screen.findByText(/"granted":false/)).toBeInTheDocument();
  });
});
