/**
 * A page that names several loaders (`definePage({ loader, loaders })`): the page's `data` is its `loader`, and
 * `page.useLoader(name)` is each of the others — its own cache entry, its own loading state, read again when the page's
 * place in the address moves and after a command the page runs commits, and held to the page's own list.
 */
import { describe, expect, test, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { UiPageContext, type UiPageFrame } from './context.js';
import { fixtureClient, fixtureHost, SectionFrame } from './fixture.js';
import { fixtures, renderPage } from './testing.js';
import { useLoader } from './hooks.js';
import { definePage } from './page.js';

const NONE = fixtures({});

const board = definePage({
  label: 'Board',
  reads: ['ticket'],
  loader: 'board',
  loaders: ['dueFigure'],
  component: () => {
    const due = board.useLoader('dueFigure');
    return <p>{due.isPending ? 'counting' : `due: ${(due.data as { n: number }).n}, fetching: ${due.isFetching}`}</p>;
  },
});

describe('page.useLoader', () => {
  test('answers the named loader, beside the page’s own data, and is asked again when the server moves', async () => {
    const view = renderPage(board, { data: NONE, loaded: { lines: 2 }, loaders: { dueFigure: { n: 3 } } });
    expect(await screen.findByText('due: 3, fetching: false')).toBeInTheDocument();
    await view.refresh({ loaders: { dueFigure: { n: 4 } } });
    expect(await screen.findByText('due: 4, fetching: false')).toBeInTheDocument();
  });

  test('a named loader notes whether it asked as its page opened, for the next entry to read it ahead; a held one and the page’s own data are not', async () => {
    const { pageLoadHints } = await import('../../pageLoadHints.js');
    const { herePath } = await import('@mistriwork/kit/client/addressMount.js');
    localStorage.clear();
    const page = definePage({
      label: 'Board',
      reads: ['ticket'],
      loader: 'board',
      loaders: ['dueFigure', 'office'],
      component: () => {
        const own = page.useLoader('board');
        const due = page.useLoader('dueFigure');
        const office = page.useLoader('office', { enabled: false });
        return <p>{`noted ${own.isPending} ${due.isPending} ${office.fetchStatus}`}</p>;
      },
    });
    renderPage(page, { data: NONE, loaded: { lines: 2 }, loaders: { dueFigure: { n: 3 }, office: { n: 1 } } });
    expect(await screen.findByText('noted false false idle')).toBeInTheDocument();
    expect(pageLoadHints(herePath())).toEqual({ loaders: ['dueFigure'] });
    localStorage.clear();
  });

  test('the loader the page calls its own answers `loaded`, and the same cache entry serves both', async () => {
    const page = definePage({
      label: 'Board',
      reads: ['ticket'],
      loader: 'board',
      component: ({ data }) => {
        const same = page.useLoader('board');
        return <p>{`data ${JSON.stringify(data)} / hook ${JSON.stringify(same.data)}`}</p>;
      },
    });
    renderPage(page, { data: NONE, loaded: { lines: 2 } });
    expect(await screen.findByText('data {"lines":2} / hook {"lines":2}')).toBeInTheDocument();
  });

  test('a name the page does not list is refused in the page’s words, before the server is asked', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = definePage({
      label: 'Board',
      reads: ['ticket'],
      loaders: ['dueFigure'],
      component: () => <p>{String(page.useLoader('other').data)}</p>,
    });
    expect(() => renderPage(page, { data: NONE })).toThrow(/The page "Board" loads "dueFigure"; "other" is not one of them\./);
    quiet.mockRestore();
  });

  test('each loader has its own state: a slow one never holds another back, and a commit reads both again', async () => {
    const host = fixtureHost(NONE, {}, []);
    const waiting: Array<(value: unknown) => void> = [];
    const asked: string[] = [];
    let figure = 1;
    host.load = (_page, _params, loader) => {
      asked.push(String(loader));
      if (loader === 'slow') return new Promise((resolve) => waiting.push(resolve));
      return Promise.resolve({ n: figure });
    };
    const frame: UiPageFrame = {
      view: 'board',
      label: 'Board',
      reads: [],
      commands: [],
      params: [],
      loaders: ['slow', 'fast'],
      get: () => undefined,
      set: () => {},
    };
    function Both() {
      const slow = useLoader('slow');
      const fast = useLoader('fast');
      return (
        <p>{`slow: ${slow.isPending ? 'reading' : JSON.stringify(slow.data)}; fast: ${fast.isPending ? 'reading' : JSON.stringify(fast.data)}`}</p>
      );
    }
    const client: QueryClient = fixtureClient();
    render(
      <SectionFrame host={host} id="board" width={960} client={client}>
        <UiPageContext.Provider value={frame}>
          <Both />
        </UiPageContext.Provider>
      </SectionFrame>,
    );
    // The fast loader is drawn while the slow one is still reading.
    expect(await screen.findByText('slow: reading; fast: {"n":1}')).toBeInTheDocument();
    await act(async () => waiting.shift()!({ n: 10 }));
    expect(await screen.findByText('slow: {"n":10}; fast: {"n":1}')).toBeInTheDocument();
    // What a committed command does (commands.tsx): every page loader is read again, each under its own entry.
    figure = 2;
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['mistri-page', 'load'] });
    });
    await act(async () => waiting.shift()!({ n: 11 }));
    expect(await screen.findByText('slow: {"n":11}; fast: {"n":2}')).toBeInTheDocument();
    expect(asked.sort()).toEqual(['fast', 'fast', 'slow', 'slow']);
  });

  /* A field report: a page that settles its office after its first reads ran its loader before and again after. */
  test('a loader held with `enabled: false` asks nothing, and runs once with the place the page settles on', async () => {
    const host = fixtureHost(NONE, {}, []);
    const asked: Array<Record<string, string>> = [];
    host.load = (_page, params) => {
      asked.push({ ...params });
      return Promise.resolve({ office: params.office });
    };
    let office: string | undefined;
    const frame = (): UiPageFrame => ({
      view: 'today',
      label: 'Today',
      reads: [],
      commands: [],
      params: ['office'],
      loaders: ['asap'],
      get: () => office,
      set: () => {},
    });
    function Today() {
      const asap = useLoader('asap', { enabled: office !== undefined });
      return <p>{asap.data === undefined ? 'waiting' : JSON.stringify(asap.data)}</p>;
    }
    const client: QueryClient = fixtureClient();
    const drawn = (
      <SectionFrame host={host} id="today" width={960} client={client}>
        <UiPageContext.Provider value={frame()}>
          <Today />
        </UiPageContext.Provider>
      </SectionFrame>
    );
    const view = render(drawn);
    expect(await screen.findByText('waiting')).toBeInTheDocument();
    await act(async () => {});
    expect(asked).toEqual([]);
    office = 'north';
    view.rerender(
      <SectionFrame host={host} id="today" width={960} client={client}>
        <UiPageContext.Provider value={frame()}>
          <Today />
        </UiPageContext.Provider>
      </SectionFrame>,
    );
    expect(await screen.findByText('{"office":"north"}')).toBeInTheDocument();
    expect(asked).toEqual([{ office: 'north' }]);
  });

  /* Every address parameter ran every loader of the page again, whether it read the parameter or not: picking a row
     kept in the address read the whole page's data again (a field report). A loader says the ones it reads. */
  test('a loader that says the params it reads is asked again only when one of those moves, and is sent only those', async () => {
    const host = fixtureHost(NONE, {}, []);
    const asked: Array<[string, Readonly<Record<string, string>>]> = [];
    host.load = (_page, params, loader) => {
      asked.push([String(loader), { ...params }]);
      return Promise.resolve({ at: params });
    };
    const place: Record<string, string | undefined> = { office: 'north', picked: '7' };
    const frame = (): UiPageFrame => ({
      view: 'board',
      label: 'Board',
      reads: [],
      commands: [],
      params: ['office', 'picked', 'day'],
      loaders: ['schedule', 'everything', 'settings'],
      // The server says them with the page (pageLoaderCheck.ts): `everything` declares none, and reads the whole place.
      loaderParams: { schedule: ['office', 'day'], settings: [] },
      get: (name) => place[name],
      set: () => {},
    });
    function Three() {
      const schedule = useLoader('schedule');
      const everything = useLoader('everything');
      const settings = useLoader('settings');
      return <p>{[schedule, everything, settings].map((each) => (each.data ? 'ok' : 'reading')).join(' ')}</p>;
    }
    const client: QueryClient = fixtureClient();
    const drawn = (value: UiPageFrame) => (
      <SectionFrame host={host} id="board" width={960} client={client}>
        <UiPageContext.Provider value={value}>
          <Three />
        </UiPageContext.Provider>
      </SectionFrame>
    );
    const view = render(drawn(frame()));
    expect(await screen.findByText('ok ok ok')).toBeInTheDocument();
    expect(asked.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['everything', { office: 'north', picked: '7' }],
      ['schedule', { office: 'north' }],
      ['settings', {}],
    ]);
    // A parameter only the undeclared loader reads: one loader runs, not three.
    asked.length = 0;
    place.picked = '8';
    view.rerender(drawn(frame()));
    await vi.waitFor(() => expect(asked).toEqual([['everything', { office: 'north', picked: '8' }]]));
    // One the schedule reads: it and the undeclared one, never the loader that reads none.
    asked.length = 0;
    place.day = '2026-11-25';
    view.rerender(drawn(frame()));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['everything', { office: 'north', picked: '8', day: '2026-11-25' }],
      ['schedule', { office: 'north', day: '2026-11-25' }],
    ]);
  });
});
