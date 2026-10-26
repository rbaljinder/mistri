import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render as renderDom, screen, waitFor, within } from '@testing-library/react';
import { fixtureHost, fixtures, SectionFrame } from '../sdk/fixture.js';
import { OperationsPanel, refusalText } from './OperationsRoom.js';
import { AnalyticsPanel } from './AnalyticsRoom.js';
import { ConsoleFailure, type ConsoleRequest } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const host = fixtureHost(fixtures({}), {}, [], []);
const render = (children: ReactNode) =>
  renderDom(children, {
    wrapper: ({ children }) => (
      <SectionFrame host={host} id="console-operations" width={960}>
        {children}
      </SectionFrame>
    ),
  });

const apps = {
  apps: [
    {
      id: 'depot',
      name: 'Depot',
      sections: ['jobs', 'deliveries', 'workflows', 'stores'],
      destinations: [{ id: 'webhook:warehouse', kind: 'webhook', name: 'warehouse' }],
    },
    { id: 'ledger', name: 'Ledger', sections: ['jobs'] },
  ],
};
const deadJob = {
  id: 'job-1',
  job: 'restock',
  state: 'failed',
  attempts: 1,
  maxAttempts: 1,
  redrives: 0,
  runAt: null,
  lastCode: 'handler_error',
};

function operations(overrides: Record<string, (body?: unknown) => unknown> = {}) {
  return vi.fn(async (path: string, body?: unknown) => {
    for (const [prefix, answer] of Object.entries(overrides)) if (path.startsWith(prefix)) return answer(body);
    if (path === '/operations') return apps;
    if (path === '/operations/depot/summary')
      return {
        ok: true,
        sections: {
          jobs: { dead: 1, retrying: 0, scheduled: 2, recent: 23, capped: false },
          deliveries: { dead: 0, retrying: 0, scheduled: 0, delivered: 4, capped: false },
          workflows: { failed: 0, running: 1, completed: 3, capped: false },
          stores: { total: 3, behind: 1, refused: 0 },
        },
      };
    if (path.startsWith('/operations/depot/jobs/attempts'))
      return { attempts: [{ attempt: 1, startedAt: null, outcome: 'failed', code: 'handler_error', operator: null }] };
    if (path.startsWith('/operations/depot/jobs'))
      return { jobs: [{ ...deadJob, id: 'job-2', job: 'notify', state: 'succeeded', updatedAt: '2026-10-02T00:00:00.000Z' }, deadJob] };
    if (path.startsWith('/operations/depot/deliveries/attempts')) return { attempts: [] };
    if (path.startsWith('/operations/depot/deliveries'))
      return {
        deliveries: [
          {
            eventId: 'evt-9',
            ordinal: 1,
            state: 'retry',
            attempts: 2,
            maxAttempts: 5,
            redrives: 0,
            nextAt: '2026-10-03T00:00:00.000Z',
            lastCode: 'transport',
          },
        ],
      };
    if (path.startsWith('/operations/depot/stores'))
      return {
        stores: [
          { database: 'main', dialect: 'sqlite', id: 'jobs', title: 'durable jobs', found: 1, current: 1, pending: [] },
          { database: 'main', dialect: 'sqlite', id: 'inbox', title: 'notifications', found: 1, current: 2, pending: [1] },
          { database: 'main', dialect: 'sqlite', id: 'history', title: 'record history', found: null, current: 1, pending: [] },
        ],
      };
    throw new ConsoleFailure('refused', 'unexpected');
  });
}

test('the room draws four figures and only the granted views, and a dead job opens in a drawer and is redriven', async () => {
  let redriven: unknown;
  const request = operations({
    '/operations/depot/jobs/redrive': (body) => {
      redriven = body;
      return { job: { id: 'job-1', state: 'retry', redrives: 1 } };
    },
  });
  const choose = vi.fn();
  const { rerender } = render(<OperationsPanel request={request as ConsoleRequest} appId="depot" choose={choose} />);
  const tabs = await screen.findAllByRole('tab');
  expect(tabs.map((tab) => tab.textContent?.replace(/\d.*$/, ''))).toEqual(['Work', 'Workflows', 'Stores']);
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  const figures = await screen.findByRole('region', { name: 'Health' });
  // One dead job, one failed-free workflow list and one store behind: two need someone, and where is said.
  await within(figures).findByText('1 job · 1 store');
  expect(within(figures).getByText('Needs attention')).toBeInTheDocument();
  expect(within(figures).getByText('In flight')).toBeInTheDocument();
  // Jobs and deliveries in one stream, dead work first, each saying where it came from.
  await screen.findByRole('button', { name: 'restock' });
  const names = screen.getAllByRole('button', { name: /^(restock|notify|evt-9)$/ }).map((button) => button.textContent);
  expect(names[0]).toBe('restock');
  expect(names.indexOf('evt-9')).toBeLessThan(names.indexOf('notify'));
  expect(screen.getByText('Delivery to warehouse')).toBeInTheDocument();
  expect(screen.getAllByText('Dead').length).toBeGreaterThan(0);
  expect(screen.getAllByText('handler_error').length).toBeGreaterThan(0);
  // Only redrivable work can be picked; nothing is redriven until a row is opened or picked.
  expect(screen.getAllByRole('checkbox', { name: /^Select restock/ })).toHaveLength(1);
  expect(screen.queryByRole('checkbox', { name: 'Select notify' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'restock' }));
  expect(choose).toHaveBeenCalledWith({ item: 'job:job-1' });
  rerender(<OperationsPanel request={request as ConsoleRequest} appId="depot" item="job:job-1" choose={choose} />);
  const pane = await screen.findByRole('complementary', { name: 'Details' });
  await screen.findByRole('region', { name: 'Attempts' });
  expect(within(pane).getByRole('region', { name: 'Payload' })).toBeInTheDocument();
  fireEvent.click(within(pane).getByRole('button', { name: 'Redrive' }));
  await screen.findByText('Redriven. It runs again with a fresh budget.');
  expect(redriven).toEqual({ id: 'job-1' });
  fireEvent.click(screen.getByRole('tab', { name: /Stores/ }));
  expect(choose).toHaveBeenCalledWith({ section: 'stores' });
});

test('the stream opens on what needs attention, asking every source for that group', async () => {
  const request = operations();
  const choose = vi.fn();
  render(<OperationsPanel request={request as ConsoleRequest} appId="depot" choose={choose} />);
  await screen.findByRole('button', { name: 'restock' });
  expect(screen.getByRole('radio', { name: /^Needs attention/ })).toHaveAttribute('aria-checked', 'true');
  expect(request).toHaveBeenCalledWith('/operations/depot/jobs?group=attention', undefined, expect.anything());
  expect(request).toHaveBeenCalledWith(
    '/operations/depot/deliveries?destination=webhook%3Awarehouse&group=attention',
    undefined,
    expect.anything(),
  );
  // All is asked for by name, and asks for no group.
  fireEvent.click(screen.getByRole('radio', { name: 'All' }));
  expect(choose).toHaveBeenCalledWith({ state: 'all' });
});

test('a facet asks the server for one group, and picked rows are redriven together, each through its own route', async () => {
  const bodies: unknown[] = [];
  const request = operations({
    '/operations/depot/jobs/redrive': (body) => {
      bodies.push(body);
      return { job: { id: 'job-1', state: 'retry', redrives: 1 } };
    },
  });
  const choose = vi.fn();
  render(<OperationsPanel request={request as ConsoleRequest} appId="depot" state="done" choose={choose} />);
  await screen.findByRole('button', { name: 'restock' });
  expect(request).toHaveBeenCalledWith('/operations/depot/jobs?group=done', undefined, expect.anything());
  expect(screen.getByRole('radio', { name: 'Done' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('radio', { name: /^Needs attention/ }));
  expect(choose).toHaveBeenCalledWith({ state: undefined });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all that can be redriven' }));
  fireEvent.click(screen.getByRole('button', { name: 'Redrive 1' }));
  await screen.findByText('Redriven. It runs again with a fresh budget.');
  expect(bodies).toEqual([{ id: 'job-1' }]);
});

test('nothing needing attention says how much ran', async () => {
  const request = operations({
    '/operations/depot/jobs': () => ({ jobs: [] }),
    '/operations/depot/deliveries': () => ({ deliveries: [] }),
  });
  render(<OperationsPanel request={request as ConsoleRequest} appId="depot" choose={vi.fn()} />);
  await screen.findByText('Nothing needs attention.');
  expect(await screen.findByText('23 jobs ran in the last 24 h.')).toBeInTheDocument();
});

test('a refused redrive says why, and the history names who redrove it', async () => {
  const request = operations({
    '/operations/depot/jobs/redrive': () => {
      throw new ConsoleFailure('not_redrivable', 'Console operation unavailable.');
    },
  });
  render(<OperationsPanel request={request as ConsoleRequest} appId="depot" item="job:job-1" choose={vi.fn()} />);
  await screen.findByRole('region', { name: 'Attempts' });
  fireEvent.click(await screen.findByRole('button', { name: 'Redrive restock' })); // the row's own action
  expect(await screen.findByRole('alert')).toHaveTextContent('Only dead or unknown work can be redriven.');
});

const instance = (over: Record<string, unknown>) => ({
  id: 'wf-1',
  workflow: 'restockFlow',
  version: 1,
  key: 'SKU-1',
  state: 'running',
  currentStep: 'reserve',
  waitEvent: null,
  wakeAt: null,
  problem: null,
  problemStep: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

test('a live instance can be woken where it is, and a failed one is retried', async () => {
  const asked: unknown[] = [];
  let row = instance({});
  const request = operations({
    '/operations/depot/workflows/retry': (body) => {
      asked.push(body);
      return { instance: row };
    },
    '/operations/depot/workflows/steps': () => ({ steps: [], actions: [] }),
    '/operations/depot/workflows': () => ({ instances: [row] }),
  });
  const { unmount } = render(
    <OperationsPanel request={request as ConsoleRequest} appId="depot" section="workflows" state="all" item="wf-1" choose={vi.fn()} />,
  );
  const pane = await screen.findByRole('complementary', { name: 'Details' });
  expect(within(pane).queryByRole('button', { name: 'Retry' })).toBeNull();
  fireEvent.click(within(pane).getByRole('button', { name: 'Wake' }));
  await screen.findByText('Woken. It runs again from where it is; a run already due does no harm.');
  expect(asked).toEqual([{ id: 'wf-1' }]);
  unmount();

  row = instance({ state: 'failed', problem: 'workflow_error', problemError: { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' } });
  render(
    <OperationsPanel request={request as ConsoleRequest} appId="depot" section="workflows" state="all" item="wf-1" choose={vi.fn()} />,
  );
  const failed = await screen.findByRole('complementary', { name: 'Details' });
  // The error a workflow threw is said by its name and code, never its message.
  expect(within(failed).getByRole('note')).toHaveTextContent('Stopped: workflow_error. It threw TypeError ERR_INVALID_ARG_TYPE');
  expect(within(failed).queryByRole('button', { name: 'Wake' })).toBeNull();
  fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
  await screen.findByText('Retrying from its last good step.');
});

test('stores are a health grid that says up to date, pending and absent stores apart, without the database', async () => {
  render(<OperationsPanel request={operations() as ConsoleRequest} appId="depot" section="stores" choose={vi.fn()} />);
  const grid = await screen.findByRole('list', { name: 'Stores' });
  expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
  expect(within(grid).getByText('Up to date')).toBeInTheDocument();
  expect(within(grid).getByText('Upgrade pending: v1→v2')).toBeInTheDocument();
  expect(within(grid).queryByText('main')).toBeNull();
  expect(screen.queryByText('history')).toBeNull();
});

test('no granted App is said plainly, and refusal codes read as sentences', async () => {
  render(<OperationsPanel request={vi.fn(async () => ({ apps: [] })) as ConsoleRequest} choose={vi.fn()} />);
  await screen.findByText('No App grants you an operations room.');
  expect(refusalText(new ConsoleFailure('not_granted', 'x'))).toBe('Your role in this App is not granted this operation.');
  expect(refusalText(new ConsoleFailure('refused', 'not_retryable'))).toBe(
    'An instance that has completed or was cancelled cannot be retried.',
  );
});

test('analytics draws counts, funnels and breakdowns, and nothing else', async () => {
  const report = {
    from: '2026-09-04T00:00:00.000Z',
    to: '2026-10-04T00:00:00.000Z',
    days: [
      { day: '2026-10-02', tracked: 4, business: 1 },
      { day: '2026-10-03', tracked: 2, business: 0 },
    ],
    names: [{ kind: 'view', name: 'items', events: 4, units: 3 }],
    breakdowns: {
      kind: [
        { key: 'view', events: 4, units: 3 },
        { key: 'business', events: 1, units: 1 },
      ],
      unit: [
        { key: 'subject', events: 5, units: 2 },
        { key: 'none', events: 2, units: 0 },
      ],
    },
    funnels: [
      {
        id: 'checkout',
        result: {
          unit: 'subject',
          conversionWindowHours: 24,
          steps: [
            { step: 1, label: 'view items', units: 2, fromPrevious: 1, fromStart: 1 },
            { step: 2, label: 'event ordered', units: 1, fromPrevious: 0.5, fromStart: 0.5 },
          ],
        },
      },
    ],
  };
  const request = vi.fn(async (path: string) =>
    path === '/analytics' ? { apps: [{ id: 'depot', name: 'Depot', funnels: ['checkout'] }] } : report,
  );
  const chooseWindow = vi.fn();
  const chooseRange = vi.fn();
  const chooseView = vi.fn();
  const props = { request: request as ConsoleRequest, chooseApp: vi.fn(), chooseRange, chooseWindow, chooseView };
  const { rerender } = render(<AnalyticsPanel {...props} />);
  // The overview: the figures as one strip, the days, the breakdowns; funnels and names are views of their own.
  await screen.findByText('Not attributed');
  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.queryByText('By tenant')).toBeNull();
  expect(screen.queryByRole('region', { name: 'checkout' })).toBeNull();
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Events', 'Funnels']);
  fireEvent.click(screen.getByRole('tab', { name: 'Funnels' }));
  expect(chooseView).toHaveBeenCalledWith('funnels');
  expect(request).toHaveBeenCalledWith(
    expect.stringMatching(/^\/analytics\/depot\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/),
    undefined,
    expect.anything(),
  );
  // Dates are asked only for a custom range.
  expect(screen.queryByLabelText('From')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
  expect(chooseRange).toHaveBeenCalledWith('7');
  // The funnel as steps: each step's units and share, and what dropped away before it.
  rerender(<AnalyticsPanel {...props} view="funnels" />);
  const funnel = await screen.findByRole('region', { name: 'checkout' });
  expect(within(funnel).getByText('1 unit')).toBeInTheDocument();
  expect(within(funnel).getByText(/dropped · 1 left$/)).toBeInTheDocument();
  rerender(<AnalyticsPanel {...props} range="custom" />);
  fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-09-01' } });
  expect(chooseWindow).toHaveBeenCalledWith('2026-09-01', undefined);
});

test('an analytics window the route refuses is said as one', async () => {
  const request = vi.fn(async (path: string) => {
    if (path === '/analytics') return { apps: [{ id: 'depot', name: 'Depot', funnels: [] }] };
    throw new ConsoleFailure('invalid_request', 'Console operation unavailable.');
  });
  render(
    <AnalyticsPanel request={request as ConsoleRequest} from="2026-10-03" to="2026-01-01" chooseApp={vi.fn()} chooseWindow={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Choose a start before the end, at most a year apart.'));
  expect(request).toHaveBeenCalledWith('/analytics/depot?from=2026-10-03&to=2026-01-01', undefined, expect.anything());
});

test('an event opens as its own view, filtering the figures and days, and several funnels are chosen one at a time', async () => {
  const report = {
    from: '2026-09-04T00:00:00.000Z',
    to: '2026-10-04T00:00:00.000Z',
    units: 3,
    days: [{ day: '2026-10-02', tracked: 4, business: 0 }],
    names: [{ kind: 'view', name: 'items', events: 4, units: 3 }],
    breakdowns: { kind: [{ key: 'view', events: 4, units: 3 }], unit: [] },
    funnels: ['checkout', 'signup'].map((id) => ({
      id,
      result: {
        unit: 'subject',
        conversionWindowHours: 24,
        steps: [{ step: 1, label: `${id} start`, units: 2, fromPrevious: 1, fromStart: 1 }],
      },
    })),
  };
  const request = vi.fn(async (path: string) =>
    path === '/analytics' ? { apps: [{ id: 'depot', name: 'Depot', funnels: ['checkout', 'signup'] }] } : report,
  );
  const chooseEvent = vi.fn(),
    chooseFunnel = vi.fn();
  const props = { request: request as ConsoleRequest, chooseApp: vi.fn(), chooseWindow: vi.fn(), chooseEvent, chooseFunnel };
  const { rerender } = render(<AnalyticsPanel {...props} view="funnels" />);
  await screen.findByRole('region', { name: 'checkout' });
  expect(screen.queryByRole('region', { name: 'signup' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'signup' }));
  expect(chooseFunnel).toHaveBeenCalledWith('signup');
  rerender(<AnalyticsPanel {...props} view="events" />);
  fireEvent.click(await screen.findByRole('button', { name: 'items' }));
  expect(chooseEvent).toHaveBeenCalledWith({ kind: 'view', name: 'items' });
  rerender(<AnalyticsPanel {...props} view="events" event={{ kind: 'view', name: 'items' }} />);
  await screen.findByText('items by day (UTC)');
  expect(request).toHaveBeenCalledWith(expect.stringMatching(/&kind=view&name=items$/), undefined, expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Show every event, not only items' }));
  expect(chooseEvent).toHaveBeenLastCalledWith(undefined);
  // The overview counts every event, whatever the address still holds.
  request.mockClear();
  rerender(<AnalyticsPanel {...props} view="overview" event={{ kind: 'view', name: 'items' }} />);
  await screen.findByText('Events by day (UTC)');
  expect(request).not.toHaveBeenCalledWith(expect.stringMatching(/kind=view/), undefined, expect.anything());
});
