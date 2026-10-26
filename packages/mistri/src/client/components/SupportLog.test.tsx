/**
 * The dealer's log of support visits: what it draws, and what it refuses to
 * draw. The operator's name appears and their email never does, a change shows
 * only the columns the server sent, and columns it withheld are counted rather
 * than passed over in silence.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { SupportLogReply } from '../../shared/tenantSupportLog.js';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state: { activeConnection: 'lending' },
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
const { SupportLog } = await import('./SupportLog.js');

const visit = (over: Record<string, unknown> = {}) => ({
  supportId: 's1',
  operatorName: 'Olivia Operator',
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
const reply = (sessions: unknown[]): SupportLogReply => ({ tenantId: 'north', sessions }) as unknown as SupportLogReply;

beforeEach(() => {
  api.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draw = async () => {
  render(<SupportLog onClose={() => {}} />);
  await vi.waitFor(() => expect(screen.queryByText('Loading support visits…')).toBeNull());
};

test('a visit names the operator, the lender, the role, the reason and the counts', async () => {
  api.mockResolvedValue(reply([visit()]));
  await draw();
  expect(api).toHaveBeenCalledWith('/api/tenant/support/log');
  const item = screen.getByText('Olivia Operator').closest('li')!;
  expect(item).toHaveTextContent('Lender');
  expect(item).toHaveTextContent('Branch staff');
  expect(item).toHaveTextContent('Checking a stuck application');
  expect(item).toHaveTextContent('3 reads');
  expect(item).toHaveTextContent('0 changes');
  expect(item).toHaveTextContent('left');
});

test('no email is drawn, because the server never sends one', async () => {
  api.mockResolvedValue(reply([visit()]));
  await draw();
  expect(document.body.textContent).not.toMatch(/@/);
});

test('a session still open says so, and one that timed out says that instead', async () => {
  api.mockResolvedValue(
    reply([
      visit({ supportId: 'live', state: 'active', endedAt: null, endReason: null }),
      visit({ supportId: 'gone', endReason: 'expired' }),
    ]),
  );
  await draw();
  expect(screen.getByText(/here now/)).toBeVisible();
  expect(screen.getByText(/timed out/)).toBeVisible();
});

test('a change shows its columns, and withheld ones are counted rather than hidden', async () => {
  api.mockResolvedValue(
    reply([
      visit({
        changes: [
          {
            at: '2026-01-01T09:10:00.000Z',
            resource: 'application',
            operation: 'update',
            key: { id: 'a1' },
            before: { status: 'new' },
            after: { status: 'open' },
            withheld: ['ssn', 'bank_account'],
          },
        ],
      }),
    ]),
  );
  await draw();
  expect(screen.getByText('status')).toBeVisible();
  expect(screen.getByText('new')).toBeVisible();
  expect(screen.getByText('open')).toBeVisible();
  // The dealer is told something else changed, without being shown it.
  expect(screen.getByText(/2 more columns were changed/)).toBeVisible();
  expect(document.body.textContent).not.toContain('bank_account');
  expect(screen.getByText(/1 change/)).toBeVisible();
});

test('a redacted column is shown as the hash the trail stored, never as a value', async () => {
  api.mockResolvedValue(
    reply([
      visit({
        changes: [
          {
            at: '2026-01-01T09:10:00.000Z',
            resource: 'application',
            operation: 'update',
            key: { id: 'a1' },
            before: { ssn: 'redacted:abcd1234' },
            after: { ssn: 'redacted:efgh5678' },
            withheld: [],
          },
        ],
      }),
    ]),
  );
  await draw();
  expect(screen.getByText('redacted:efgh5678')).toBeVisible();
});

test('an empty log says nobody came, which is not the same as a failure', async () => {
  api.mockResolvedValue(reply([]));
  await draw();
  expect(screen.getByRole('status')).toHaveTextContent('No one has entered this tenant under support.');
});

test('a refused read is said plainly, and draws no visits', async () => {
  api.mockRejectedValue(new Error('refused'));
  await draw();
  expect(screen.getByRole('alert')).toHaveTextContent('The support log could not be read.');
  expect(screen.queryByText('Olivia Operator')).toBeNull();
});

test('closing is offered and reported once', async () => {
  api.mockResolvedValue(reply([]));
  const onClose = vi.fn();
  render(<SupportLog onClose={onClose} />);
  await vi.waitFor(() => expect(screen.queryByText('Loading support visits…')).toBeNull());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Close support visits' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a log cut to its newest visits says so, and a whole one says nothing', async () => {
  api.mockResolvedValue({ ...reply([visit()]), more: true });
  await draw();
  expect(screen.getByText(/newest 1 visits/)).toBeVisible();
  cleanup();
  api.mockResolvedValue({ ...reply([visit()]), more: false });
  await draw();
  expect(screen.queryByText(/newest/)).toBeNull();
});
