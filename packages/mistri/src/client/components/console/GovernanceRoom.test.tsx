import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render as renderDom, screen, waitFor } from '@testing-library/react';
import { fixtureHost, fixtures, SectionFrame } from '../sdk/fixture.js';
import { GovernancePanel } from './GovernanceRoom.js';
import { ConsoleFailure, type ConsoleRequest } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const host = fixtureHost(fixtures({}), {}, [], []);
const render = (children: ReactNode) =>
  renderDom(children, {
    wrapper: ({ children }) => (
      <SectionFrame host={host} id="console-governance" width={960}>
        {children}
      </SectionFrame>
    ),
  });

const catalog = { apps: [{ id: 'depot', name: 'Depot', views: ['audit', 'authority', 'accounts'] }] };
function governance(answers: Record<string, unknown> = {}) {
  return vi.fn(async (path: string) => {
    for (const [prefix, answer] of Object.entries(answers)) if (path.startsWith(prefix)) return answer;
    if (path === '/governance') return catalog;
    if (path.startsWith('/governance/depot/audit'))
      return {
        rows: [
          {
            kind: 'access',
            id: 'g-1',
            at: '2026-10-04T09:00:00.000Z',
            who: { id: 'operator', email: null },
            subject: { id: 'carol', email: 'carol@example.test' },
            before: [],
            after: ['clerk', 'admin'],
          },
          {
            id: 'r-1',
            at: '2026-10-03T09:00:00.000Z',
            who: { id: 'bob', email: 'bob@example.test' },
            command: 'reopen_item',
            version: 1,
            resource: 'items',
            href: '/tools/depot/items/7',
            fields: ['state'],
            targets: 2,
          },
        ],
        next: '2026-10-03T09:00:00.000Z~r-1',
      };
    if (path === '/governance/depot/authority')
      return {
        startedAt: '2026-10-09T00:00:00.000Z',
        locked: true,
        groups: [{ group: 'role:agent', sentences: [{ text: 'Role `agent` can read `incident`.', by: ['features "triage"'] }] }],
        since: '2026-10-01T00:00:00.000Z',
        changes: [{ change: 'added', group: 'role:agent', text: 'Role `agent` can now update `incident.state`.' }],
      };
    if (path === '/governance/depot/accounts')
      return {
        accounts: [{ id: 'alice', email: 'alice@example.test', roles: ['admin'], revision: 2 }],
        more: false,
        changes: [
          {
            at: '2026-10-02T00:00:00.000Z',
            subject: { id: 'alice', email: 'alice@example.test' },
            actor: { id: 'operator', email: null },
            before: [],
            after: ['admin'],
          },
        ],
        manageHref: '/tools/_mistri/apps#manage=depot',
      };
    throw new Error(`unexpected ${path}`);
  });
}

test('the audit log names who ran which command, links the record and pages older', async () => {
  const request = governance();
  render(<GovernancePanel request={request as unknown as ConsoleRequest} chooseApp={() => {}} />);
  expect(await screen.findByText('bob@example.test')).toBeTruthy();
  expect(screen.getByText('reopen_item')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'items' }).getAttribute('href')).toBe('/tools/depot/items/7');
  expect(screen.getByText(/and 1 more record/)).toBeTruthy();
  // A role change from the suite's grants sits in the same log: who changed it, for whom, from what to what.
  const change = screen.getByText('Roles changed').closest('tr')!;
  expect(change.textContent).toContain('carol@example.test');
  expect(change.textContent).toContain('no roles → clerk, admin');
  fireEvent.click(screen.getByRole('button', { name: 'Older' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('/governance/depot/audit?before=2026-10-03T09%3A00%3A00.000Z%7Er-1', undefined, expect.anything()),
  );
});

test('a search applies the filter only when asked', async () => {
  const chooseFilter = vi.fn();
  render(<GovernancePanel request={governance() as unknown as ConsoleRequest} chooseApp={() => {}} chooseFilter={chooseFilter} />);
  await screen.findByText('bob@example.test');
  fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'bob@example.test' } });
  expect(chooseFilter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(chooseFilter).toHaveBeenCalledWith({ who: 'bob@example.test' });
});

test('authority reads as sentences, with what changed since the start before', async () => {
  render(<GovernancePanel request={governance() as unknown as ConsoleRequest} view="authority" chooseApp={() => {}} />);
  expect((await screen.findAllByText('Role agent')).length).toBe(2);
  expect(document.querySelector('.console-diff .console-up')?.textContent).toBe('Role agent can now update incident.state.');
  expect(document.querySelector('.console-sentences code')?.textContent).toBe('agent');
  expect(screen.getByText('Granted by features "triage"')).toBeTruthy();
  expect(screen.getByText(/checked against authority.lock/)).toBeTruthy();
});

test('accounts list the holders and changes, link to the access page, and say why tokens and support are absent', async () => {
  render(<GovernancePanel request={governance() as unknown as ConsoleRequest} view="accounts" chooseApp={() => {}} />);
  expect((await screen.findAllByText('alice@example.test')).length).toBe(2);
  expect(screen.getByRole('link', { name: 'Change roles' }).getAttribute('href')).toBe('/tools/_mistri/apps#manage=depot');
  expect(screen.getByText(/API tokens are not issued/)).toBeTruthy();
  expect(screen.getByText(/Support sessions belong to tenant Apps/)).toBeTruthy();
});

test('an App that no longer grants admin says so', async () => {
  const request = governance();
  request.mockImplementation(async (path: string) => {
    if (path === '/governance') return catalog;
    throw new ConsoleFailure('not_granted', 'refused');
  });
  render(<GovernancePanel request={request as unknown as ConsoleRequest} view="authority" chooseApp={() => {}} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe("You no longer hold this App's admin role.");
});

test('no administered App is an empty room', async () => {
  render(<GovernancePanel request={governance({ '/governance': { apps: [] } }) as unknown as ConsoleRequest} chooseApp={() => {}} />);
  expect(await screen.findByText('You administer no App here.')).toBeTruthy();
});

test("a tenant App's accounts are its tenants and one tenant's members, with the way into the App's own screens", async () => {
  const request = governance({
    '/governance/dealers/accounts?tenant=north': {
      tenants: [{ id: 'north', name: 'North Motors', status: 'active', members: true }],
      chosen: {
        id: 'north',
        members: [
          { id: 'bob', email: 'bob@example.test', status: 'active', roles: ['dealer_staff'], validUntil: '2027-01-01T00:00:00.000Z' },
        ],
      },
      href: '/dealers/',
      supportSessions: true,
      apiTokens: true,
    },
    '/governance/dealers/accounts': {
      tenants: [
        { id: 'north', name: 'North Motors', status: 'active', members: true },
        { id: 'south', status: null, members: false },
      ],
      href: '/dealers/',
      supportSessions: true,
      apiTokens: false,
    },
    '/governance': { apps: [{ id: 'dealers', name: 'Dealers', views: ['accounts'] }] },
  });
  render(<GovernancePanel request={request as unknown as ConsoleRequest} view="accounts" chooseApp={() => {}} />);
  expect(await screen.findByText('North Motors')).toBeTruthy();
  expect(screen.getByText('not created yet')).toBeTruthy();
  // A tenant the grant reaches only for its assistant offers no members to show.
  expect(screen.getAllByRole('button', { name: 'Show members' })).toHaveLength(1);
  expect(screen.getByText(/Support sessions are read in the App on its platform context/)).toBeTruthy();
  expect(screen.queryByText(/API tokens are made and ended in the App/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Dealers' }).getAttribute('href')).toBe('/dealers/');
  fireEvent.click(screen.getByRole('button', { name: 'Show members' }));
  expect(await screen.findByText('Members of North Motors')).toBeTruthy();
  expect(screen.getByText('bob@example.test')).toBeTruthy();
  expect(request.mock.calls.map(([path]) => path)).toContain('/governance/dealers/accounts?tenant=north');
});

test('a tenant App whose administration grant was withdrawn says so, and lists no tenant', async () => {
  const request = governance();
  request.mockImplementation(async (path: string) => {
    if (path === '/governance') return { apps: [{ id: 'dealers', name: 'Dealers', views: ['accounts'] }] };
    throw new ConsoleFailure('not_granted', 'refused');
  });
  render(<GovernancePanel request={request as unknown as ConsoleRequest} view="accounts" chooseApp={() => {}} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Tenants')).toBeNull();
});
