/**
 * A member's own API tokens in their tenant: listed with their state, a new
 * one's secret shown once, a revoke that asks the route, and a refusal the
 * route gives said in its own words.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state: { activeConnection: 'lending' },
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
const { TenantApiTokens } = await import('./TenantApiTokens.js');

const token = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  label: 'Nightly export',
  roles: ['dealer_staff'],
  operations: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  expiresAt: '2099-01-01T09:00:00.000Z',
  revokedAt: null,
  mine: true,
  ...over,
});
const choices = { roles: ['dealer_staff'], operations: [], maxDays: 365 };

beforeEach(() => api.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('tokens are listed with their state, and revoking one asks the route by id', async () => {
  let revoked = false;
  api.mockImplementation(async (path: string) => {
    if (path === '/api/tokens/revoke') return ((revoked = true), { revoked: true });
    return {
      tokens: [
        token({ revokedAt: revoked ? '2026-10-09T09:00:00.000Z' : null }),
        token({ id: 't2', label: 'Old', revokedAt: '2026-10-02T00:00:00.000Z', mine: false }),
      ],
      choices,
    };
  });
  render(<TenantApiTokens onClose={() => {}} />);
  const row = (await screen.findByText('Nightly export')).closest('tr')!;
  expect(row).toHaveTextContent('active');
  expect(row).toHaveTextContent('Dealer staff');
  expect(screen.getByText('Old').closest('tr')).toHaveTextContent('revoked');
  expect(screen.getByText('Old').closest('tr')).toHaveTextContent('another member’s');
  // A revoked token offers no Revoke: only the active one does.
  expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(api).toHaveBeenCalledWith('/api/tokens/revoke', { id: 't1' });
  await vi.waitFor(() => expect(screen.getByText('Nightly export').closest('tr')).toHaveTextContent('revoked'));
});

test('a new token is issued with the label, roles and days, and its secret is shown once', async () => {
  let issued = false;
  api.mockImplementation(async (path: string) => {
    if (path === '/api/tokens/issue')
      return ((issued = true), { token: 'twk_secret_value', id: 't9', expiresAt: '2027-01-01T00:00:00.000Z' });
    return { tokens: issued ? [token({ id: 't9', label: 'Reporting' })] : [], choices };
  });
  render(<TenantApiTokens onClose={() => {}} />);
  expect(await screen.findByText('No tokens yet.')).toBeTruthy();
  await userEvent.type(screen.getByRole('textbox', { name: /Label/ }), 'Reporting');
  await userEvent.click(screen.getByRole('button', { name: 'Make token' }));
  expect(api).toHaveBeenCalledWith('/api/tokens/issue', { label: 'Reporting', roles: ['dealer_staff'], days: 90 });
  expect(((await screen.findByDisplayValue('twk_secret_value')) as HTMLInputElement).readOnly).toBe(true);
  expect(screen.getByText('Copy it now: this is the only time it is shown.')).toBeTruthy();
  // The list that follows never carries the secret: only the label and state.
  expect(screen.getByText('Reporting').closest('tr')).not.toHaveTextContent('twk_secret_value');
});

test("a refusal is said in the route's own words, and nothing is listed", async () => {
  api.mockResolvedValue({ error: 'Your role may not hold API tokens here.', code: 'tokens_refused', outcome: 'not_applied' });
  render(<TenantApiTokens onClose={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toBe('Your role may not hold API tokens here.');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Make token' })).toBeNull();
});

test('an administrator makes a service token with its role alone, and it is listed as a service', async () => {
  let issued = false;
  const offered = { ...choices, service: { roles: ['ledger_sync', 'mailer'], label: 'Integrations' } };
  api.mockImplementation(async (path: string) => {
    if (path === '/api/tokens/issue') return ((issued = true), { token: 'twk_service', id: 's1', expiresAt: '2027-01-01T00:00:00.000Z' });
    return {
      tokens: issued ? [token({ id: 's1', label: 'Ledger', roles: ['mailer'], service: 'mailer', mine: false })] : [],
      choices: offered,
    };
  });
  render(<TenantApiTokens onClose={() => {}} />);
  await userEvent.click(await screen.findByRole('radio', { name: 'A service, not a person' }));
  expect(screen.getByText(/its changes are recorded as Integrations/)).toBeTruthy();
  // A member's roles are not asked for: the service role is the whole of what it holds.
  expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Mailer' }));
  await userEvent.type(screen.getByRole('textbox', { name: /Label/ }), 'Ledger');
  await userEvent.click(screen.getByRole('button', { name: 'Make token' }));
  expect(api).toHaveBeenCalledWith('/api/tokens/issue', { label: 'Ledger', service: 'mailer', days: 90 });
  expect(await screen.findByDisplayValue('twk_service')).toBeTruthy();
  const row = screen.getByText('Ledger').closest('tr')!;
  expect(row).toHaveTextContent('service');
  expect(row).toHaveTextContent('Mailer');
  // Another administrator's service token is the tenant's, not "another member's".
  expect(row).not.toHaveTextContent('another member’s');
});

test('a member who is not the administrator is offered no service token, and one who holds no API role but administers starts there', async () => {
  api.mockResolvedValue({ tokens: [], choices });
  render(<TenantApiTokens onClose={() => {}} />);
  await screen.findByText('No tokens yet.');
  expect(screen.queryByRole('radio')).toBeNull();
  cleanup();
  api.mockResolvedValue({ tokens: [], choices: { ...choices, roles: [], service: { roles: ['ledger_sync'], label: 'Integrations' } } });
  render(<TenantApiTokens onClose={() => {}} />);
  expect((await screen.findByRole('radio', { name: 'A service, not a person' })) as HTMLInputElement).toBeChecked();
  expect(screen.queryByRole('radio', { name: 'You, with your roles' })).toBeNull();
  expect(screen.queryByText('You hold no role the App’s API allows, so there is no token to make.')).toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: /Label/ }), 'Sync');
  await userEvent.click(screen.getByRole('button', { name: 'Make token' }));
  expect(api).toHaveBeenCalledWith('/api/tokens/issue', { label: 'Sync', service: 'ledger_sync', days: 90 });
});
