import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { SupportSessionView } from '../../shared/tenantSupport.js';
import { SupportBanner, SupportScreen } from './SupportBanner.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const session = (patch: Partial<SupportSessionView> = {}): SupportSessionView => ({
  supportId: 'support-1',
  version: '1',
  tenantId: 'north',
  dealerRole: 'branch_staff',
  operatorName: 'Olivia Operator',
  reason: 'Checking a stuck application',
  openedAt: '2026-09-15T12:00:00.000Z',
  validUntil: 0,
  remainingMs: 1_800_000,
  state: 'active',
  ...patch,
});

test('the banner names the dealer, the role and the end, with Exit; a busy Exit refuses a second press', async () => {
  const onExit = vi.fn(),
    user = userEvent.setup(),
    deadline = Date.now() + 1_800_000;
  const tree = render(<SupportBanner session={session()} deadline={deadline} onExit={onExit} />);
  const banner = screen.getByRole('region', { name: 'Support session' });
  expect(banner).toHaveTextContent('Support session');
  expect(banner).toHaveTextContent('north as Branch staff');
  // Inside a dealer's brand, the banner says the provider is the one looking.
  expect(banner).toHaveTextContent('viewing as the provider');
  expect(banner.querySelector('time')).toHaveAttribute('dateTime', new Date(deadline).toISOString());
  // The live region is on the page before it has anything to say.
  expect(screen.getByRole('status')).toHaveTextContent('');
  await user.click(screen.getByRole('button', { name: 'Exit' }));
  expect(onExit).toHaveBeenCalledOnce();
  tree.rerender(<SupportBanner session={session()} deadline={deadline} onExit={onExit} busy />);
  await user.click(screen.getByRole('button', { name: 'Exit' }));
  expect(onExit).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Exit' })).toHaveAttribute('aria-disabled', 'true');
});

test('two minutes before the end the banner says so, once, in its polite live region', () => {
  vi.useFakeTimers({ now: 1_000_000 });
  render(<SupportBanner session={session()} deadline={Date.now() + 180_000} onExit={() => {}} />);
  expect(screen.getByRole('status')).toHaveTextContent('');
  act(() => {
    vi.advanceTimersByTime(59_000);
  });
  expect(screen.getByRole('status')).toHaveTextContent('');
  act(() => {
    vi.advanceTimersByTime(1_100);
  });
  expect(screen.getByRole('status')).toHaveTextContent('Ends in two minutes.');
  expect(screen.getByRole('region', { name: 'Support session' })).toHaveAttribute('data-warning', 'true');
});

test('under support nothing of the dealer is shown: the notice says support access is not available yet', () => {
  render(
    <SupportScreen session={session()} deadline={Date.now() + 600_000} platformLabel="Lender" onExit={() => {}} onReturn={() => {}} />,
  );
  expect(screen.getByRole('heading', { level: 1, name: 'Support access is not available yet' })).toBeVisible();
  expect(screen.getByText(/recorded with your name/)).toHaveTextContent('Olivia Operator');
  expect(screen.getByText(/recorded with your name/)).toHaveTextContent('Checking a stuck application');
  expect(screen.getByText('Exit to return to Lender.')).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('at the end the cover takes the page and only returns to the platform', async () => {
  vi.useFakeTimers({ now: 5_000_000, shouldAdvanceTime: true });
  const onReturn = vi.fn();
  render(<SupportScreen session={session()} deadline={Date.now() + 1_000} platformLabel="Lender" onExit={() => {}} onReturn={onReturn} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1_100);
  });
  const cover = screen.getByRole('dialog', { name: 'Support session ended' });
  expect(cover).toHaveTextContent('Nothing more is recorded under it.');
  const back = screen.getByRole('button', { name: 'Return to Lender' });
  await act(async () => {
    back.click();
  });
  expect(onReturn).toHaveBeenCalledOnce();
});

test('a session the server says has ended is covered at once, whatever the clock says', () => {
  render(
    <SupportScreen
      session={session()}
      deadline={Date.now() + 600_000}
      platformLabel="Lender"
      ended
      onExit={() => {}}
      onReturn={() => {}}
    />,
  );
  expect(screen.getByRole('dialog', { name: 'Support session ended' })).toHaveTextContent('north has ended');
});

test('the dealer is said by its name where the server gave one', () => {
  render(
    <SupportScreen
      session={session()}
      tenantName="North Motors"
      deadline={Date.now() + 600_000}
      platformLabel="Lender"
      onExit={() => {}}
      onReturn={() => {}}
    />,
  );
  expect(screen.getByRole('region', { name: 'Support session' })).toHaveTextContent('North Motors as Branch staff');
  expect(document.body.textContent).not.toContain('north');
});
