import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AccountProfile } from './AccountProfile.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { configureSessionLifecycle } from '../../../../kit/src/client/sessionLifecycle.js';

const profile = (connectedClients: boolean) => ({
  accountId: 'ada',
  appId: 'crm',
  name: 'Ada',
  email: 'ada@example.test',
  providers: ['email'],
  ...(connectedClients ? { connectedClients: true } : {}),
});
const grant = (grantId: string, client: string | null) => ({
  grantId,
  client,
  clientId: `twc1.${grantId}`,
  roles: ['operator'],
  createdAt: 0,
  expiresAt: Date.parse('2026-11-08T12:00:00Z'),
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' } });

let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let grants: ReturnType<typeof grant>[];
beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'crm' });
  grants = [grant('a1', 'Desk agent'), grant('b2', null)];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function serve(connected: boolean, revoke: (grantId: string) => Response | undefined = () => undefined) {
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.startsWith('/api/auth/profile')) return json({ profile: profile(connected) });
    if (path === '/api/auth/oauth/grants') return json({ grants });
    if (path === '/api/auth/oauth/grants/revoke') {
      const { grantId } = JSON.parse(String(init?.body));
      const refused = revoke(grantId);
      if (refused) return refused;
      grants = grants.filter((g) => g.grantId !== grantId);
      return json({ grants });
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetcher);
}

test('a profile without an authorization server asks nothing about connected applications', async () => {
  serve(false);
  render(<AccountProfile onClose={() => {}} />);
  await vi.waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ada'));
  expect(screen.queryByRole('heading', { name: 'Connected applications' })).toBeNull();
  expect(fetcher.mock.calls.map((call) => String(call[0]))).not.toContain('/api/auth/oauth/grants');
});

test('lists each connected application with its roles, and disconnects one', async () => {
  const user = userEvent.setup();
  serve(true);
  render(<AccountProfile onClose={() => {}} />);
  const section = await screen.findByRole('region', { name: 'Connected applications' });
  await vi.waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(2));
  expect(within(section).getByText('Desk agent')).toBeInTheDocument();
  expect(within(section).getByText('An unnamed application')).toBeInTheDocument();
  expect(within(section).getAllByText(/^operator · until /)).toHaveLength(2);
  await user.click(within(section).getByRole('button', { name: 'Disconnect Desk agent' }));
  await vi.waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(1));
  expect(within(section).getByRole('status')).toHaveTextContent('Desk agent is disconnected.');
  const revoke = fetcher.mock.calls.find((call) => String(call[0]) === '/api/auth/oauth/grants/revoke')!;
  expect(revoke[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ grantId: 'a1' }) });
});

test('a refused disconnect keeps the row and says so', async () => {
  const user = userEvent.setup();
  serve(true, () => json({ error: 'not_found' }, 404));
  render(<AccountProfile onClose={() => {}} />);
  const section = await screen.findByRole('region', { name: 'Connected applications' });
  await vi.waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(2));
  await user.click(within(section).getByRole('button', { name: 'Disconnect Desk agent' }));
  await vi.waitFor(() => expect(within(section).getByRole('alert')).toHaveTextContent('Desk agent could not be disconnected. Try again.'));
  expect(within(section).getAllByRole('listitem')).toHaveLength(2);
});
