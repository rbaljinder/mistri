/**
 * Home in an app, drawn and driven: the home card's links, and
 * the resume chips under a dashboard.
 */
import { afterEach, describe, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

const gone: unknown[] = [];
let visits: unknown[] = [];

vi.mock('../../../../kit/src/client/core.js', () => ({
  api: async () => ({ columns: ['n'], rows: [{ n: 5 }] }),
  findTable: (id: string) => (id === 'lead' ? { id, name: 'lead', approxRows: 301, columns: [] } : undefined),
  go: (entry: unknown, mode: string) => gone.push([entry, mode]),
  currentEntry: () => (gone.at(-1) as [unknown, string] | undefined)?.[0],
  state: {},
  pageView: (pageId: string, table: unknown, key: unknown, label: unknown) => ({ kind: 'page', pageId, table, key, label }),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  toast: () => {},
  columnDisplay: () => null,
  labelColumn: () => 'name',
  primaryKey: () => ['id'],
  quote: (v: string) => v,
  refsFrom: () => [],
  openRecord: () => {},
  viewportBox: () => ({ width: 600, height: 100, top: 0, left: 0, right: 600, bottom: 100 }),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../kit/src/client/pagemarks.js', () => ({ recentVisits: () => visits }));
vi.mock('../appState.js', () => ({ activeApp: () => null }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/url.js', () => ({ syncHash: () => {} }));
vi.mock('../../../../kit/src/client/components/TableRoom.js', async () => {
  const { useEffect } = await import('react');
  return {
    TableRoom: ({ onResult }: { onResult?: (d: unknown) => void }) => {
      useEffect(() => {
        onResult?.({ columns: [] });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});
vi.mock('../../../../kit/src/client/components/appListModel.js', () => ({
  appListQuery: (e: { table: string }) => `${e.table} show name`,
  referenceNames: () => ({}),
}));
vi.mock('./SplitDetailPane.js', () => ({ SplitDetailPane: () => null, SplitDetailActions: () => null }));
vi.mock('./sdk/CustomSection.js', async () => {
  const { useAddressState } = await import('./sdk/hooks.js');
  return {
    CustomPageBody: () => {
      const [scope, setScope] = useAddressState('scope'),
        [, setFlag] = useAddressState('flag');
      return (
        <button
          onClick={() => {
            setFlag(undefined);
            setScope('global', { push: true });
          }}
        >
          {scope ?? 'Choose scope'}
        </button>
      );
    },
  };
});

const { AppHomeBody, AppLanding } = await import('./AppLanding.js');

const app = {
  name: 'Compass CRM',
  ui: {},
  views: {
    sales: { label: 'Sales dashboard', sections: [] },
    leads: { label: 'Leads', table: 'lead' },
    tasks: { label: 'Tasks', table: 'task' },
  },
  nav: [
    { view: 'sales', label: 'Sales dashboard' },
    { view: 'leads', label: 'Leads' },
    { view: 'tasks', label: 'Tasks' },
  ],
  resources: {},
};

function draw(tree: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, tree));
}

afterEach(() => {
  cleanup();
  gone.length = 0;
  visits = [];
});

describe('the home card', () => {
  test('nested groups render nested lists without combining their labels', () => {
    draw(
      <AppHomeBody
        app={{
          name: 'Atlas',
          ui: {},
          resources: {},
          views: { teams: { table: 'lead', label: 'Teams' } },
          nav: [
            {
              group: 'directory',
              label: 'Directory',
              children: [{ group: 'organization', label: 'Organization', children: [{ view: 'teams', label: 'Teams' }] }],
            },
          ],
        }}
      />,
    );
    const directory = screen.getByRole('heading', { name: 'Directory' });
    const organization = screen.getByRole('heading', { name: 'Organization' });
    expect(directory.parentElement).toContainElement(organization);
    expect(organization.parentElement).toContainElement(screen.getByRole('button', { name: /^Teams/ }));
  });
  test('names the app and lists the menu as rows of links with counts', async () => {
    const user = userEvent.setup();
    draw(<AppHomeBody app={app} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Compass CRM');
    const leads = screen.getByRole('button', { name: /^Leads/ });
    expect(leads).toHaveTextContent('301');
    expect(screen.getAllByText('Go to')[0]).toHaveClass('shape-label');
    await user.click(leads);
    expect(gone).toEqual([[{ kind: 'table', table: 'lead', query: 'lead show name', view: 'leads' }, 'reset']]);
    await user.click(screen.getByRole('button', { name: 'Sales dashboard' }));
    expect(gone[1]).toEqual([{ kind: 'page', pageId: 'dash-sales', table: undefined, key: undefined, label: 'Sales dashboard' }, 'reset']);
  });

  test('in the top-bar shell the menu rows are left out', () => {
    draw(<AppHomeBody app={{ ...app, ui: { shell: { placement: 'top' } } }} />);
    expect(screen.queryByText('Go to')).toBeNull();
  });
});

describe('the landing with a dashboard', () => {
  test('a free-form page home provides address state before the first navigation and on reload', async () => {
    const user = userEvent.setup();
    const dashboard = {
      id: 'controls',
      label: 'Controls',
      sections: [{ kind: 'custom' as const, component: { id: 'controls', module: './Controls.tsx', kind: 'page' as const } }],
      page: { reads: ['targets'], commands: [], params: ['scope', 'flag'] },
    };
    const route = () => ({ kind: 'page', pageId: 'dash-controls', tab: 'home' });
    const view = draw(<AppLanding app={app} firstDash={dashboard} loadError="" pages={[]} dashboardEntry={route} />);
    // The dashboard loads on demand, so the first paint waits on a cold module load.
    await user.click(await screen.findByRole('button', { name: 'Choose scope' }, { timeout: 5000 }));
    const entry = (gone.at(-1) as [import('../../../../kit/src/client/components/pageModel.js').PageEntry, string])[0];
    expect(entry).toMatchObject({ pageId: 'dash-controls', tab: 'home', rootBody: ';scope=global' });
    view.unmount();
    draw(<AppLanding app={app} firstDash={dashboard} loadError="" pages={[]} dashboardEntry={route} entry={entry} />);
    expect(await screen.findByRole('button', { name: 'global' })).toBeVisible();
  });

  test('a time-window change requests the home presentation', async () => {
    const user = userEvent.setup();
    const route = vi.fn(() => ({ kind: 'page', pageId: 'dash-sales', tab: 'home' }));
    draw(
      <AppLanding
        app={app}
        firstDash={{ id: 'sales', label: 'Sales', sections: [], windows: ['last 30 days'] }}
        loadError=""
        pages={[]}
        dashboardEntry={route}
      />,
    );
    // The dashboard loads on demand, so wait for its controls before choosing a window.
    await user.click(await screen.findByRole('button', { name: 'Last 30 days' }, { timeout: 5000 }));
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ id: 'sales' }), 'last 30 days', {}, true, {});
    expect(gone[0]).toEqual([{ kind: 'page', pageId: 'dash-sales', tab: 'home' }, 'replace']);
  });

  test("is the app's name, the screen, and where you were", async () => {
    const user = userEvent.setup();
    visits = [{ pageId: 'config-lead', name: 'Lead', base: 'lead', key: { id: 127 }, label: 'Margot Fontaine' }];
    draw(
      <AppLanding
        app={app}
        firstDash={{ id: 'sales', label: 'Sales', sections: [] }}
        loadError=""
        pages={[{ id: 'config-lead', base: 'lead' }]}
        dashboardEntry={(d, w, p) => ({ kind: 'page', pageId: d.id, w, p })}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sales');
    expect(screen.getByRole('heading', { name: 'Where you were' })).toBeInTheDocument();
    await user.click(screen.getByTitle('Lead — Margot Fontaine'));
    expect(gone[0]).toEqual([{ kind: 'page', pageId: 'config-lead', table: 'lead', key: { id: 127 }, label: 'Margot Fontaine' }, 'reset']);
  });

  test('puts plain-text dashboard copy below the heading and leaves no prose node when it is absent', () => {
    const { unmount } = draw(
      <AppLanding
        app={app}
        firstDash={{ id: 'sales', label: 'Sales', description: '<strong>Today only</strong>', sections: [] }}
        loadError=""
        pages={[]}
        dashboardEntry={() => ({})}
      />,
    );
    const prose = screen.getByText('<strong>Today only</strong>');
    expect(prose).toHaveClass('note', 'dash-description');
    expect(prose.previousElementSibling).toHaveTextContent('Sales');
    expect(prose.querySelector('strong')).toBeNull();
    unmount();
    const withoutDescription = draw(
      <AppLanding
        app={app}
        firstDash={{ id: 'sales', label: 'Sales', sections: [] }}
        loadError=""
        pages={[]}
        dashboardEntry={() => ({})}
      />,
    );
    expect(withoutDescription.container.querySelector('.dash-description')).toBeNull();
  });

  test('says when it is showing the last good save', () => {
    draw(
      <AppLanding
        app={app}
        firstDash={{ id: 'sales', label: 'Sales', sections: [] }}
        loadError="app.json: unexpected token"
        pages={[]}
        dashboardEntry={() => ({})}
      />,
    );
    expect(screen.getByText(/Still showing the last good save — app.json/)).toHaveClass('app-loaderror');
  });
});
