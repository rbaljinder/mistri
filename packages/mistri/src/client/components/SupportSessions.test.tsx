/**
 * The platform's audit of support sessions: every tenant's visits, each named
 * by its tenant, with the operator's email — the one view that carries it —
 * and a refusal said rather than an empty list.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { replaceTenantNames } from '../tenantNames.js';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state: { activeConnection: 'lending' },
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
const { SupportSessions } = await import('./SupportSessions.js');

const visit = (over: Record<string, unknown> = {}) => ({
  supportId: 's1',
  tenantId: 'north',
  accountId: 'olivia',
  operatorName: 'Olivia Operator',
  operatorEmail: 'olivia@example.test',
  realmLabel: 'Lender',
  dealerRole: 'branch_staff',
  reason: 'Checking a stuck application',
  openedAt: '2026-01-01T09:00:00.000Z',
  endedAt: '2026-01-01T09:20:00.000Z',
  endReason: 'exit',
  state: 'ended',
  reads: 3,
  changes: [],
  ...over,
});

beforeEach(() => {
  api.mockReset();
  replaceTenantNames([['north', 'North Motors']]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('each visit says which tenant it entered and who, by name and email', async () => {
  api.mockResolvedValue({ sessions: [visit(), visit({ supportId: 's2', tenantId: 'south', operatorEmail: null })], more: true });
  render(<SupportSessions onClose={() => {}} />);
  const north = (await screen.findByText('Into North Motors')).closest('li')!;
  expect(api).toHaveBeenCalledWith('/api/tenant/support/sessions');
  expect(north).toHaveTextContent('olivia@example.test');
  expect(north).toHaveTextContent('Olivia Operator');
  expect(north).toHaveTextContent('Checking a stuck application');
  // A tenant with no known name is said by its id; an account that is gone has no email to show.
  expect(screen.getByText('Into south').closest('li')).not.toHaveTextContent('@');
  expect(screen.getByText(/The newest 2 sessions/)).toBeTruthy();
});

test('a role without the audit grant is told the sessions could not be read, and shown none', async () => {
  api.mockRejectedValue(new Error('forbidden'));
  render(<SupportSessions onClose={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toBe('The support sessions could not be read. Check your access and try again.');
  expect(screen.queryByRole('listitem')).toBeNull();
});
