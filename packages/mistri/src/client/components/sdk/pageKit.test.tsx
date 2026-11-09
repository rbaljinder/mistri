/**
 * The page kit's rc.25 additions, each as a page meets it: an `optional` read that a refusal does not fail, `Text`, a
 * resource's own records as a picker's options (`useOptions(resource)`), the App's addresses as strings (`useHref`),
 * a test host that titles a row from the App's catalog, and the board and calendar seams of `ui/testing`.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { fixtureHost, SectionFrame, type FixtureCatalog } from './fixture.js';
import { board, calendar, fixtures, renderPage, renderSection } from './testing.js';
import { definePage, Text } from './page.js';
import { useBreakdown, useHref, useRecord, useRows } from './index.js';
import { useOptions, type UiOptions } from './options.js';

afterEach(cleanup);

const BOOKINGS = fixtures({
  booking: [
    { id: 1, guest_name: 'Morgan Lee', status: 'booked' },
    { id: 2, guest_name: 'Ana Ruiz', status: 'checked_in' },
  ],
});

describe('an optional read', () => {
  const states: Record<string, unknown> = {};
  function Reads() {
    const rows = useRows('booking', { optional: true });
    const record = useRecord('booking', { id: 1 }, undefined, { optional: true });
    const groups = useBreakdown('booking', { by: 'status', optional: true });
    for (const [name, read] of Object.entries({ rows, record, groups })) {
      states[name] = {
        refused: read.refused,
        isError: read.isError,
        error: read.error?.message ?? null,
        data: read.data?.length ?? read.data,
      };
    }
    return null;
  }
  const draw = (refuse: (resource: string) => never | undefined) => {
    const host = fixtureHost(BOOKINGS, {}, []);
    for (const name of ['rows', 'record', 'breakdown'] as const) {
      const read = host[name] as (...args: unknown[]) => Promise<unknown>;
      host[name] = (async (...args: unknown[]) => (refuse('booking'), read(...args))) as never;
    }
    render(
      <SectionFrame host={host} id="optional" width={960}>
        <Reads />
      </SectionFrame>,
    );
  };
  const refusedWith = (status: number) => () => {
    throw Object.assign(new Error(`refused ${status}`), { status });
  };

  test('a 401 or 403 is refused, not an error, with no data', async () => {
    for (const status of [401, 403]) {
      draw(refusedWith(status));
      for (const name of ['rows', 'record', 'groups'])
        await waitFor(() => expect(states[name]).toEqual({ refused: true, isError: false, error: null, data: undefined }));
      cleanup();
    }
  });

  test('a 500 stays an error, and a read that is not optional is never refused', async () => {
    draw(refusedWith(500));
    for (const name of ['rows', 'record', 'groups'])
      // The query client retries a server error before it gives up, so this answer comes late.
      await waitFor(() => expect(states[name]).toEqual({ refused: false, isError: true, error: 'refused 500', data: undefined }), {
        timeout: 15_000,
      });
    cleanup();
    const plain: Record<string, unknown> = {};
    function Plain() {
      const rows = useRows('booking');
      plain.state = { refused: Boolean((rows as { refused?: boolean }).refused), isError: rows.isError };
      return null;
    }
    const host = fixtureHost(BOOKINGS, {}, []);
    host.rows = async () => {
      throw Object.assign(new Error('refused'), { status: 403 });
    };
    render(
      <SectionFrame host={host} id="plain" width={960}>
        <Plain />
      </SectionFrame>,
    );
    await waitFor(() => expect(plain.state).toEqual({ refused: false, isError: true }));
  }, 30_000);

  test('a page draws the refusal in its place, and a fixture refusal is the same refusal', async () => {
    function Desk(): ReactNode {
      const rows = page.useRows('booking', { optional: true });
      return rows.refused ? <Text tone="muted">Not open to your role.</Text> : <p>{rows.data?.length ?? 'loading'} rows</p>;
    }
    const page = definePage({ label: 'Desk', reads: ['booking'], component: Desk });
    const view = renderPage(page, { data: BOOKINGS, refused: { booking: 403 } });
    expect(await screen.findByText('Not open to your role.')).toBeInTheDocument();
    await view.refresh({ refused: {} });
    expect(await screen.findByText('2 rows')).toBeInTheDocument();
  });
});

describe('Text', () => {
  test('is a line of words in the page’s ink, its secondary ink, or the status colour, and a size down on request', () => {
    render(
      <>
        <Text>Plain</Text>
        <Text tone="muted" size="sm">
          Muted
        </Text>
        <Text tone="danger">Danger</Text>
      </>,
    );
    expect(screen.getByText('Plain').className).toBe('kit-text');
    expect(screen.getByText('Muted').className).toBe('kit-text kit-text-muted kit-text-sm');
    expect(screen.getByText('Danger').className).toBe('kit-text kit-text-danger');
  });
});

describe('useOptions on a resource', () => {
  const catalog: FixtureCatalog = {
    tables: [
      {
        name: 'country',
        columns: [
          { name: 'code', type: 'TEXT', primaryKey: true },
          { name: 'display', type: 'TEXT' },
          { name: 'name', type: 'TEXT' },
          { name: 'active', type: 'BOOLEAN' },
        ],
      },
    ],
  };
  const COUNTRIES = fixtures({
    country: [
      { code: 'NZ', name: 'New Zealand', active: true },
      { code: 'AU', name: 'Australia', active: true },
      { code: 'XX', name: 'Atlantis', active: false },
    ],
  });
  const held: { options?: UiOptions } = {};
  const options = () => held.options!;

  test('offers the resource’s records by its catalog’s title column, keyed by its own key, under a condition', async () => {
    function Picker() {
      held.options = useOptions('country', { where: { active: true } });
      return null;
    }
    renderSection(Picker, { component: { id: 'picker' } }, { data: COUNTRIES, catalog });
    await waitFor(() => expect(options().isPending).toBe(false));
    expect(options().pages.flat()).toEqual([
      { key: 'AU', label: 'Australia' },
      { key: 'NZ', label: 'New Zealand' },
    ]);
    act(() => options().setQuery('zeal'));
    await waitFor(() => expect(options().pages.flat()).toEqual([{ key: 'NZ', label: 'New Zealand' }]));
    act(() => options().select('AU'));
    await waitFor(() => expect(options().resolved).toEqual({ key: 'AU', label: 'Australia', available: true }));
  });

  test('a free-form page reads only what it declared; one that did not is the mistake said plainly', () => {
    const page = definePage({
      label: 'Pick',
      reads: ['country'],
      component: () => {
        useOptions('region');
        return null;
      },
    });
    expect(() => renderPage(page, { data: COUNTRIES, catalog })).toThrow('"region" is not one of them');
  });

  test('the reader is offered only what they may read: a refused resource offers nothing and says why', async () => {
    function Picker() {
      held.options = useOptions('country');
      return null;
    }
    renderSection(Picker, { component: { id: 'picker' } }, { data: COUNTRIES, catalog, refused: { country: 403 } });
    await waitFor(() => expect(options().error).toBeTruthy());
    expect(options().pages.flat()).toEqual([]);
  });
});

describe('useHref', () => {
  test('hands back strings in the router’s own words', () => {
    let href!: ReturnType<typeof useHref>;
    function Links() {
      href = useHref();
      return null;
    }
    renderSection(Links, { component: { id: 'links' } });
    expect(href.signIn()).toBe('/sign-in');
    expect(href.view('leads', { tab: 'working', search: 'stone' })).toBe('/leads?tab=working&search=stone');
    expect(href.record('leads', { id: 127 })).toBe('/leads/127');
    expect(href.record('leads', { id: 127 }, { tab: 'map' })).toBe('/leads/127/map');
    expect(href.page('forecast', { period: 'q3' })).toBe('/forecast?period=q3');
  });
});

describe('a test host that titles a row from the catalog', () => {
  const catalog: FixtureCatalog = {
    tables: [
      {
        name: 'warehouse',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'name', type: 'TEXT' },
          { name: 'region', type: 'TEXT' },
        ],
      },
      {
        name: 'pick_list',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'reference', type: 'TEXT' },
          { name: 'ship_to', type: 'TEXT' },
        ],
      },
      {
        name: 'tag',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'display', type: 'TEXT' },
        ],
      },
    ],
  };
  test('the catalog’s name column wins over the guess, and the key stands where a table names nothing', () => {
    const { rowTitle } = fixtureHost(fixtures({}), { catalog }, []);
    expect(rowTitle('warehouse', { id: 1, name: 'Reno', region: 'West' })).toBe('Reno');
    // A table with no name column is titled as the App titles it, by its first text column: never the guess's `id` or a `*name` beside it.
    expect(rowTitle('pick_list', { id: 25160, reference: 'SO-25160', ship_to: 'Front Range' })).toBe('SO-25160');
    expect(rowTitle('tag', { id: 7, display: 'Hot lead' })).toBe('Hot lead');
    // No catalog: a guess, as before.
    expect(fixtureHost(fixtures({}), {}, []).rowTitle('warehouse', { id: 1, name: 'Reno' })).toBe('Reno');
  });
});

describe('board and calendar seams', () => {
  test('page.region scopes queries to one region of the page', () => {
    const page = definePage({
      label: 'Two',
      reads: ['booking'],
      component: () => (
        <>
          <section aria-label="Left">
            <button type="button">Save</button>
          </section>
          <section aria-label="Right">
            <button type="button">Save</button>
          </section>
        </>
      ),
    });
    const view = renderPage(page, { data: BOOKINGS });
    expect(() => view.getByRole('button', { name: 'Save' })).toThrow();
    expect(view.region('Left').getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(() => view.region('Nowhere')).toThrow('Expected one region named "Nowhere"');
  });

  test('board.card, board.lane and board.move find a card and drop it into a lane', () => {
    document.body.innerHTML = `
      <div role="group" aria-label="Board">
        <section><h2>New</h2><button>Broken login</button></section>
        <section><h2>Done</h2></section>
      </div>`;
    expect(board.card('Broken login').textContent).toBe('Broken login');
    expect(board.lane('New')).toContainElement(board.card('Broken login'));
    board.move('Broken login', 'Done');
    expect(() => board.card('Nothing')).toThrow();
  });

  test('calendar.event and calendar.day find an event and the day it falls on', () => {
    document.body.innerHTML = `
      <table><tbody><tr><td data-date="2026-11-18"><button>Quarterly review</button></td></tr></tbody></table>`;
    expect(calendar.day('2026-11-18')).toContainElement(calendar.event('Quarterly review'));
    expect(() => calendar.day('2026-11-19')).toThrow('draws no day 2026-11-19');
  });
});
