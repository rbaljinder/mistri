/**
 * A new App's first steps: which stage the home is at, read off one row per
 * step's table, and each step a link to its list — with the New form open
 * where the reader may add, the list alone where they may only read.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Section } from '../../../../kit/src/client/components/dashboardModel.js';

const mocks = vi.hoisted(() => ({
  rows: {} as Record<string, number>,
  failing: new Set<string>(),
  writable: new Set<string>(),
  links: [] as unknown[][],
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  // The steps are asked together (breakdownBatch.ts): each item answered as its own read would be.
  api: async (path: string, body: { q: string; items?: Array<{ run: { q: string } }> }) => {
    const read = (q: string) => ({ rows: Array.from({ length: mocks.rows[q] ?? 0 }, (_, id) => ({ id })) });
    if (path === '/api/breakdowns') {
      return {
        results: body.items!.map(({ run }) =>
          mocks.failing.has(run.q) ? { status: 400, body: { error: 'refused' } } : { status: 200, body: read(run.q) },
        ),
      };
    }
    if (mocks.failing.has(body.q)) throw new Error('refused');
    return read(body.q);
  },
  findTable: (id: string) => ({ id, name: id, columns: [] }),
  state: { activeConnection: 'crm' },
}));
vi.mock('../../../../kit/src/client/insert.js', () => ({ canInsert: (table: { id: string }) => mocks.writable.has(table.id) }));
vi.mock('../../../../kit/src/client/components/viewLink.js', () => ({
  viewLink: (view: string, mode: string, adding: boolean) => {
    mocks.links.push([view, mode, adding]);
    return { href: `/crm/${view}${adding ? '!new' : ''}` };
  },
}));

const { FirstRun, useFirstRun } = await import('./FirstRun.js');

const section: Section = {
  kind: 'firstRun',
  title: 'Welcome to Compass',
  text: 'Two steps and the pipeline fills itself.',
  steps: [
    { label: 'Add your first account', view: 'accounts', table: 'account', detail: 'The companies you sell to.' },
    { label: 'Log a lead', view: 'leads', table: 'lead' },
  ],
};

function Home() {
  const run = useFirstRun(section);
  if (run.stage === 'unknown') return <p>reading</p>;
  if (run.stage === 'done') return <p>dashboard</p>;
  return <FirstRun section={section} done={run.done} fresh={run.stage === 'fresh'} />;
}
function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.rows = {};
  mocks.failing = new Set();
  mocks.writable = new Set(['account', 'lead']);
  mocks.links = [];
});
afterEach(cleanup);

test('an empty App is fresh: the welcome, the first step primary, each opening its New form', async () => {
  draw();
  expect(await screen.findByRole('heading', { name: 'Welcome to Compass' })).toBeInTheDocument();
  expect(document.querySelector('.dash-first-run')).toHaveClass('is-fresh');
  expect(screen.getByText('The companies you sell to.')).toBeInTheDocument();
  const [first, second] = screen.getAllByRole('link', { name: 'Add' });
  expect(first).toHaveAttribute('href', '/crm/accounts!new');
  expect(first).toHaveClass('btn-primary');
  expect(second).toHaveClass('btn-secondary');
});

test('a step with a row is done, quiet, and opens its list; the rest still ask', async () => {
  mocks.rows = { account: 1 };
  draw();
  await screen.findByRole('heading', { name: 'Welcome to Compass' });
  expect(document.querySelector('.dash-first-run')).not.toHaveClass('is-fresh');
  expect(screen.getByText('(done)')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/crm/accounts');
  // The next step not taken is the primary one.
  expect(screen.getByRole('link', { name: 'Add' })).toHaveClass('btn-primary');
});

test('every step done, the dashboard is itself again', async () => {
  mocks.rows = { account: 3, lead: 1 };
  draw();
  expect(await screen.findByText('dashboard')).toBeInTheDocument();
});

test('a reader who may only read is sent to the list, and a step that cannot be read does not hide the dashboard', async () => {
  mocks.writable = new Set();
  draw();
  await screen.findByRole('heading', { name: 'Welcome to Compass' });
  expect(screen.getAllByRole('link', { name: 'Open' }).map((link) => link.getAttribute('href'))).toEqual(['/crm/accounts', '/crm/leads']);
  cleanup();
  mocks.failing = new Set(['account', 'lead']);
  draw();
  await waitFor(() => expect(screen.getByText('dashboard')).toBeInTheDocument());
});
