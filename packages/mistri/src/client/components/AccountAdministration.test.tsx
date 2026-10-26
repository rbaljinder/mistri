import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AccountAdministration } from './AccountAdministration.js';
import { AccountControl } from './AccountControl.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { configureSessionLifecycle } from '../../../../kit/src/client/sessionLifecycle.js';

const ada = {
  id: 'ada',
  name: 'Ada Admin',
  email: 'ada@example.test',
  roles: ['admin'],
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
};
const pat = { id: 'pat', name: 'Pat Lee', email: 'pat@example.test', roles: ['agent'], active: true };
const page = (accounts = [ada, pat]) => ({
  accounts,
  total: accounts.length,
  offset: 0,
  roles: ['agent', 'payroll_manager', 'admin'],
  passwords: true,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' } });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'desk' });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(page()));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  configureSessionLifecycle({ onLock: () => {} });
});

test('the menu offers Manage accounts only where the server said so', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<AccountControl who="Ada" />);
  await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
  expect(screen.queryByRole('menuitem', { name: 'Manage accounts' })).toBeNull();
  unmount();
  render(<AccountControl who="Ada" accountAdministration />);
  await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
  await user.click(screen.getByRole('menuitem', { name: 'Manage accounts' }));
  const dialog = await screen.findByRole('dialog', { name: 'Accounts' });
  await within(dialog).findByText('Pat Lee');
  expect(String(fetcher.mock.calls[0][0])).toBe('/api/accounts?app=desk');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { 'x-mistri-account': 'ada' } });
});

test('the list names each account, its roles and whether it signs in', async () => {
  render(<AccountAdministration onClose={() => {}} />);
  const list = await screen.findByRole('list', { name: 'Accounts 1–2 of 2' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Ada Admin (you)ada@example.testRoles AdministratorStatus Active');
  expect(rows[1]).toHaveTextContent('Pat Leepat@example.testRoles AgentStatus Active');
});

test("an account's roles are set as a change the server makes, and said", async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /^Pat Lee/ }));
  expect(await screen.findByRole('heading', { name: 'Pat Lee' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save roles' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'Payroll manager' }));
  fetcher.mockResolvedValueOnce(json({ account: { ...pat, roles: ['agent', 'payroll_manager'] }, outcome: 'applied' }));
  await user.click(screen.getByRole('button', { name: 'Save roles' }));
  expect(await screen.findByRole('status')).toHaveTextContent('pat@example.test now holds Agent, Payroll manager.');
  const [url, init] = fetcher.mock.calls[1];
  expect(String(url)).toBe('/api/accounts?app=desk');
  expect(JSON.parse(String(init!.body))).toEqual({
    app: 'desk',
    operation: 'setRoles',
    accountId: 'pat',
    roles: ['agent', 'payroll_manager'],
  });
});

test('a refusal is said as the server says it, and an administrator keeps their own admin role', async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /^Ada Admin/ }));
  expect(screen.getByRole('checkbox', { name: /Administrator/ })).toBeDisabled();
  // No Deactivate on your own account.
  expect(screen.queryByRole('button', { name: 'Deactivate account' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '← All accounts' }));
  await user.click(await screen.findByRole('button', { name: /^Pat Lee/ }));
  fetcher.mockResolvedValueOnce(json({ error: 'Only an administrator manages accounts.', outcome: 'not_applied' }, 403));
  await user.click(screen.getByRole('button', { name: 'Deactivate account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Only an administrator manages accounts.');
});

test('a new account needs a name, an email, a role and a password before anything is sent', async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await screen.findByRole('list', { name: /^Accounts/ });
  await user.click(screen.getByRole('button', { name: 'Add account' }));
  expect(await screen.findByRole('heading', { name: 'Add an account' })).toBeInTheDocument();
  fireEvent.submit(screen.getByLabelText(/^Name/).closest('form')!);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(screen.getByLabelText(/^Email/)).toHaveAttribute('aria-invalid', 'true'));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Sam Roe' } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'sam@example.test' } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'sam-password-1' } });
  fetcher.mockResolvedValueOnce(
    json({ account: { id: 'sam', name: 'Sam Roe', email: 'sam@example.test', roles: ['agent'], active: true }, outcome: 'applied' }),
  );
  await user.click(screen.getByRole('button', { name: 'Add account' }));
  expect(await screen.findByRole('status')).toHaveTextContent('sam@example.test can sign in now with the password you gave.');
  expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body))).toEqual({
    app: 'desk',
    operation: 'create',
    name: 'Sam Roe',
    email: 'sam@example.test',
    roles: ['agent'],
    password: 'sam-password-1',
  });
  expect(await screen.findByRole('heading', { name: 'Sam Roe' })).toBeInTheDocument();
});

const entry = (id: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, extra = {}) => ({
  id,
  at: '2026-09-02T09:30:00.000Z',
  action,
  actorId: 'ada',
  actorEmail: 'ada@example.test',
  principal: 'session',
  targetId: 'pat',
  targetEmail: 'pat@example.test',
  before,
  after,
  ...extra,
});
const trail = (entries: unknown[], total = entries.length) => ({ entries, total, offset: 0 });

test('the history lists every change made here, newest first: when, what, and by whom', async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await screen.findByRole('list', { name: /^Accounts/ });
  fetcher.mockResolvedValueOnce(
    json(
      trail([
        entry('3', 'setPassword', null, { password: 'changed', sessionsEnded: true }, { principal: 'impersonation:root' }),
        entry('2', 'setRoles', { roles: ['agent'] }, { roles: ['agent', 'payroll_manager'] }),
        entry('1', 'create', null, { email: 'pat@example.test', name: 'Pat Lee', roles: ['agent'], active: true }),
        // Made on someone's behalf: by the operator's maintenance step, and by an invitation's claim.
        entry(
          '0b',
          'create',
          null,
          { email: 'kim@example.test', name: 'Kim', roles: ['user'], active: true },
          { actorId: 'kim', actorEmail: 'kim@example.test', principal: 'invitation:inv-1', targetEmail: 'kim@example.test' },
        ),
        entry(
          '0a',
          'create',
          null,
          { email: 'lee@example.test', name: 'Lee', roles: ['user'], active: true },
          { actorId: 'maintenance', actorEmail: '', principal: 'maintenance', targetEmail: 'lee@example.test' },
        ),
        // An identity provider's claims, at a sign-in: named by its label.
        entry(
          '00',
          'setRoles',
          { roles: ['agent'] },
          { roles: ['payroll_manager'] },
          { actorId: 'provider:workforce', actorEmail: 'Contoso', principal: 'sign-in:workforce', targetEmail: 'lee@example.test' },
        ),
      ]),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'History' }));
  expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
  const list = await screen.findByRole('list', { name: 'Changes 1–6 of 6' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent?.replace(/^When .*?Change /, ''))).toEqual([
    'New password; sessions endedpat@example.testBy ada@example.testimpersonated',
    'Roles Agent → Agent, Payroll managerpat@example.testBy ada@example.test',
    'Added with Agentpat@example.testBy ada@example.test',
    'Added with Userkim@example.testBy kim@example.testby invitation',
    'Added with Userlee@example.testBy Maintenance',
    'Roles Agent → Payroll managerlee@example.testBy Contosoat sign-in',
  ]);
  expect(within(rows[0]).getByText((_, element) => element?.tagName === 'TIME')).toHaveAttribute('dateTime', '2026-09-02T09:30:00.000Z');
  expect(String(fetcher.mock.calls[1][0])).toBe('/api/accounts?app=desk&trail=1');
  // Nothing in a row is a target: it is read, not opened.
  expect(within(list).queryAllByRole('button')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '← All accounts' }));
  expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument();
});

test("an account's history is that account's alone, and goes back to it", async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await user.click(await screen.findByRole('button', { name: /^Pat Lee/ }));
  fetcher.mockResolvedValueOnce(json(trail([entry('2', 'deactivate', { active: true }, { active: false })])));
  await user.click(screen.getByRole('button', { name: 'View history' }));
  expect(await screen.findByRole('heading', { name: 'History of Pat Lee' })).toBeInTheDocument();
  const rows = within(await screen.findByRole('list', { name: 'Changes 1–1 of 1' })).getAllByRole('listitem');
  // One account's rows do not repeat whose they are.
  expect(rows[0]).toHaveTextContent('Deactivated');
  expect(rows[0]).not.toHaveTextContent('pat@example.test');
  expect(String(fetcher.mock.calls[1][0])).toBe('/api/accounts?app=desk&trail=1&account=pat');
  await user.click(screen.getByRole('button', { name: '← Pat Lee' }));
  expect(await screen.findByRole('heading', { name: 'Pat Lee' })).toBeInTheDocument();
});

test('an empty history says so, a long one pages, and a refusal is said', async () => {
  const user = userEvent.setup();
  render(<AccountAdministration onClose={() => {}} />);
  await screen.findByRole('list', { name: /^Accounts/ });
  fetcher.mockResolvedValueOnce(json(trail([])));
  await user.click(screen.getByRole('button', { name: 'History' }));
  expect(await screen.findByText('No changes have been made here yet.')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '← All accounts' }));
  const many = Array.from({ length: 25 }, (_, index) => entry(String(60 - index), 'reactivate', { active: false }, { active: true }));
  fetcher.mockResolvedValueOnce(json(trail(many, 60)));
  await user.click(await screen.findByRole('button', { name: 'History' }));
  const pager = await screen.findByRole('navigation', { name: 'History pages' });
  expect(within(pager).getByRole('button', { name: 'Newer' })).toBeDisabled();
  fetcher.mockResolvedValueOnce(json({ entries: many, total: 60, offset: 25 }));
  await user.click(within(pager).getByRole('button', { name: 'Older' }));
  expect(await screen.findByRole('list', { name: 'Changes 26–50 of 60' })).toBeInTheDocument();
  expect(String(fetcher.mock.calls.at(-1)![0])).toBe('/api/accounts?app=desk&trail=1&offset=25');

  fetcher.mockResolvedValueOnce(json({ error: 'Only an administrator manages accounts.', outcome: 'not_applied' }, 403));
  await user.click(within(pager).getByRole('button', { name: 'Newer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Only an administrator manages accounts.');
});
