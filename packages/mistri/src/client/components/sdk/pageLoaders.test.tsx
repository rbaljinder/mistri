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
});
