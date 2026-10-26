import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from './shell.js';

/* The shell itself is the served client, walked by e2e/embed-react.spec.ts; here it is a stand-in that records what each element asked of it. */
const shell = vi.hoisted(() => ({
  attached: [] as Attachment[],
  parked: 0,
  refuse: undefined as string | undefined,
  opening: null as { resource: string; key: Record<string, unknown> } | null,
}));
vi.mock('./loadShell.js', () => ({
  loadShell: async () => ({
    attachShell(next: Attachment) {
      if (shell.refuse) throw new Error(shell.refuse);
      shell.attached.push(next);
      return () => {
        shell.parked++;
      };
    },
    openingRecord: () => shell.opening,
  }),
}));

const { App, Assistant, Dashboard, List, Page, Provider, Record } = await import('./index.js');
const { defineTheme } = await import('../../schema/app.mjs');

/* The server: the boot (one read, with the shell's first answers) and the sign-in exchange, as server/embed/ answers them. */
const server = vi.hoisted(() => ({
  asked: [] as Array<{ url: string; init?: RequestInit }>,
  data: { reads: { 'GET /api/whoami?app=compass\u0000': { body: { signedIn: true } } }, items: {} } as unknown,
}));

beforeEach(() => {
  shell.attached = [];
  shell.parked = 0;
  shell.refuse = undefined;
  shell.opening = null;
  server.asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      server.asked.push({ url: String(url), init });
      const body = String(url).includes('/api/auth/embed/exchange')
        ? { signedIn: true, accountId: 'a1', expiresAt: Date.now() + 3_600_000 }
        : { protocol: 1, version: '1.0', signedIn: true, data: server.data };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const last = () => shell.attached.at(-1)!;

describe('Provider and App', () => {
  it('draws a slot with the host’s fallback, then puts the whole App in it under the host’s prefix', async () => {
    render(
      <Provider endpoint="/api/tw/" mode="dark" density="compact">
        <App app="compass" basePath="/crm" className="pane" fallback={<p>Loading the CRM…</p>} />
      </Provider>,
    );
    expect(screen.getByText('Loading the CRM…')).toBeInTheDocument();
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    const attached = last();
    expect(attached.slot).toHaveAttribute('data-mistri-slot', 'App');
    expect(attached.slot).toHaveClass('pane');
    expect(attached).toMatchObject({
      app: 'compass',
      surface: 'app',
      endpoint: '/api/tw',
      address: { base: '/crm', apps: { compass: '' } },
      preferences: { mode: 'dark', density: 'compact' },
    });
    expect(attached.authorization()).toBeUndefined();
    await waitFor(() => expect(screen.queryByText('Loading the CRM…')).not.toBeInTheDocument());
  });

  it('uses the host router’s navigator when given one, and the window’s otherwise', async () => {
    const navigator = {
      current: vi.fn(() => ({ pathname: '/crm', search: '', state: null })),
      push: vi.fn(),
      replace: vi.fn(),
      listen: vi.fn(() => () => {}),
    };
    render(
      <Provider endpoint="/api/tw" navigator={navigator}>
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last().navigator).toBe(navigator);
  });

  it('passes the shell’s title to the host, and writes none of its own', async () => {
    const onTitle = vi.fn();
    document.title = 'Host';
    render(
      <Provider endpoint="/api/tw" onTitle={onTitle}>
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    last().title('Leads · Compass');
    expect(onTitle).toHaveBeenCalledWith('Leads · Compass');
    expect(document.title).toBe('Host');
  });

  it('survives StrictMode’s double effect: one park, one attachment left standing', async () => {
    render(
      <StrictMode>
        <Provider endpoint="/api/tw">
          <App app="compass" basePath="/crm" />
        </Provider>
      </StrictMode>,
    );
    await waitFor(() => expect(shell.attached.length).toBeGreaterThan(0));
    expect(shell.attached.length - shell.parked).toBe(1);
  });

  it('parks the shell when the element goes', async () => {
    const view = render(
      <Provider endpoint="/api/tw">
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    view.unmount();
    expect(shell.parked).toBe(1);
  });

  it('says why in the slot when the shell refuses (a second element on the page)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shell.refuse = '@mistriwork/mistri/react draws one mistri element at a time on a page.';
    render(
      <Provider endpoint="/api/tw">
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('one mistri element at a time');
  });

  it('must be inside a Provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<App app="compass" basePath="/crm" />)).toThrow('<App> must be inside a <Provider>.');
  });

  it('refuses a basePath that is not a path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Provider endpoint="/api/tw">
        <App app="compass" basePath="crm//x" />
      </Provider>,
    );
    return waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/basePath/));
  });
});

describe('the one boot read', () => {
  const at = (pathname: string, search = '') => ({
    current: () => ({ pathname, search, state: null }),
    push: vi.fn(),
    replace: vi.fn(),
    listen: vi.fn(() => () => {}),
  });

  it('asks the server once, for the App at the address it starts on, and hands the shell its first answers', async () => {
    render(
      <Provider endpoint="/api/tw" navigator={at('/crm/leads', '?tab=working')}>
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(server.asked).toHaveLength(1);
    const url = new URL(server.asked[0].url, 'http://host.test');
    expect(url.pathname).toBe('/api/tw/api/embed/boot');
    expect(Object.fromEntries(url.searchParams)).toEqual({ app: 'compass', path: '/compass/leads', search: '?tab=working' });
    expect(server.asked[0].init).toMatchObject({ credentials: 'same-origin' });
    expect(last().firstPaint).toEqual(server.data);
  });

  it('asks it once under StrictMode’s double effect too', async () => {
    render(
      <StrictMode>
        <Provider endpoint="/api/tw" navigator={at('/crm')}>
          <App app="compass" basePath="/crm" />
        </Provider>
      </StrictMode>,
    );
    await waitFor(() => expect(shell.attached.length - shell.parked).toBe(1));
    expect(server.asked.map(({ url }) => new URL(url, 'http://host.test').pathname)).toEqual(['/api/tw/api/embed/boot']);
    expect(new URL(server.asked[0].url, 'http://host.test').searchParams.get('path')).toBe('/compass');
  });

  it('a surface boots at its own address', async () => {
    render(
      <Provider endpoint="/api/tw">
        <List app="compass" view="leads" tab="working" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    const url = new URL(server.asked[0].url, 'http://host.test');
    expect([url.searchParams.get('path'), url.searchParams.get('search')]).toEqual(['/compass/leads', '?tab=working']);
  });

  it('with the host’s sign-in: the exchange first, then the boot as the person it signed in — two requests, no more', async () => {
    // Under StrictMode too: its rehearsal unmount must not close the session and sign the person in again.
    const assertion = vi.fn(async () => 'signed');
    render(
      <StrictMode>
        <Provider endpoint="/api/tw" auth={{ assertion }} navigator={at('/crm/leads')}>
          <App app="compass" basePath="/crm" />
        </Provider>
      </StrictMode>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(server.asked.map(({ url, init }) => `${init?.method ?? 'GET'} ${new URL(url, 'http://host.test').pathname}`)).toEqual([
      'POST /api/tw/api/auth/embed/exchange',
      'GET /api/tw/api/embed/boot',
    ]);
    expect(assertion).toHaveBeenCalledTimes(1);
  });

  it('a boot with nothing to carry still draws: the shell asks for itself', async () => {
    server.data = undefined;
    render(
      <Provider endpoint="/api/tw">
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last().firstPaint).toBeUndefined();
    server.data = { reads: {}, items: {} };
  });
});

describe('the theme', () => {
  it('a look’s id, or the host’s own defineTheme(...), reaches the shell as it was given', async () => {
    const theme = defineTheme({ id: 'harbor', label: 'Harbor', extends: 'mono', colors: { light: { accent: '#0b6e4f' } } });
    const view = render(
      <Provider endpoint="/api/tw" theme={theme}>
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last().preferences.theme).toBe(theme);
    view.unmount();
    render(
      <Provider endpoint="/api/tw" theme="sage">
        <App app="compass" basePath="/crm" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(2));
    expect(last().preferences.theme).toBe('sage');
  });
});

describe('single surfaces', () => {
  it('the assistant: its own page, or one conversation on it', async () => {
    const view = render(
      <Provider endpoint="/api/tw">
        <Assistant app="compass" placement="page" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last()).toMatchObject({ surface: 'assistant' });
    expect(last().navigator.current().pathname).toBe('/compass/assistant');
    view.unmount();
    render(
      <Provider endpoint="/api/tw">
        <Assistant app="compass" conversation="c42" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(2));
    expect(last().navigator.current().pathname).toBe('/compass/assistant/c42');
  });

  it('the assistant refuses a placement that is the App’s chrome', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <Provider endpoint="/api/tw">
          <Assistant app="compass" placement={'panel' as 'page'} />
        </Provider>,
      ),
    ).toThrow(/<App>/);
  });

  it('a list: its own address in memory, the App’s chrome hidden, the host’s address bar untouched', async () => {
    render(
      <Provider endpoint="/api/tw">
        <List app="compass" view="leads" tab="working" search="stone" filters={{ source: 'web' }} />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    const attached = last();
    expect(attached).toMatchObject({ surface: 'list', address: { base: '', apps: { compass: 'compass' } } });
    expect(attached.navigator.current()).toEqual({
      pathname: '/compass/leads',
      search: '?tab=working&search=stone&source=web',
      state: null,
    });
    attached.navigator.push('/compass/leads?tab=lost', null);
    expect(window.location.pathname).toBe('/');
  });

  it('a list hands an opening record to the host and stays where it was', async () => {
    const onOpenRecord = vi.fn();
    render(
      <Provider endpoint="/api/tw">
        <List app="compass" view="leads" onOpenRecord={onOpenRecord} />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    const { navigator } = last();
    shell.opening = { resource: 'lead', key: { id: 127 } };
    navigator.push('/compass/leads/127', null);
    expect(onOpenRecord).toHaveBeenCalledWith({ resource: 'lead', key: { id: 127 }, href: '/leads/127' });
    expect(navigator.current().pathname).toBe('/compass/leads');

    // A move that is not a record is the list's own.
    shell.opening = null;
    navigator.push('/compass/leads?tab=lost', null);
    expect(navigator.current().search).toBe('?tab=lost');
  });

  it('a list follows its props without starting again', async () => {
    const view = render(
      <Provider endpoint="/api/tw">
        <List app="compass" view="leads" tab="new" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    const { navigator } = last();
    view.rerender(
      <Provider endpoint="/api/tw">
        <List app="compass" view="leads" tab="lost" />
      </Provider>,
    );
    await act(async () => {});
    expect(shell.attached).toHaveLength(1);
    expect(navigator.current().search).toBe('?tab=lost');
  });

  it('a record and a dashboard at their addresses', async () => {
    const first = render(
      <Provider endpoint="/api/tw">
        <Record app="compass" resource="lead" id={127} />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last()).toMatchObject({ surface: 'record' });
    expect(last().navigator.current().pathname).toBe('/compass/lead/~127');
    first.unmount();

    render(
      <Provider endpoint="/api/tw">
        <Dashboard app="compass" view="sales-dashboard" period="last-30-days" />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(2));
    expect(last()).toMatchObject({ surface: 'dashboard' });
    expect(last().navigator.current()).toMatchObject({ pathname: '/compass/sales-dashboard', search: '?period=last-30-days' });
  });

  it('a free-form page at its path, with the parameters it keeps', async () => {
    render(
      <Provider endpoint="/api/tw">
        <Page app="depot" page="pick-walk" params={{ list: '12', line: '' }} />
      </Provider>,
    );
    await waitFor(() => expect(shell.attached).toHaveLength(1));
    expect(last()).toMatchObject({ surface: 'page' });
    expect(last().navigator.current()).toMatchObject({ pathname: '/depot/pick-walk', search: '?list=12' });
  });
});
