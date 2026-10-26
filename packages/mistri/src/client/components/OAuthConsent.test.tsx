import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { OAuthConsent, loadConsent, type ConsentView } from './OAuthConsent.js';
import { setRoleLabels } from '../../../../kit/src/client/roleLabels.js';

const view = (over: Partial<ConsentView> = {}): ConsentView => ({
  request: '9b2c1d3e-0000-4000-8000-000000000001',
  nonce: 'n'.repeat(43),
  client: { id: 'twc1.9b2c1d3e-0000-4000-8000-000000000002', name: 'Desk agent' },
  redirect: { scheme: 'http', host: '127.0.0.1:9' },
  app: { id: 'shop', name: 'Shop', version: 1 },
  account: 'ada@example.test',
  roles: ['operator', 'auditor'],
  expiresAt: Date.now() + 600_000,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setRoleLabels(undefined);
});

/** The form a press would send, read instead of sent: happy-dom does not navigate. */
function sent(form: HTMLFormElement, submitter: HTMLButtonElement) {
  const data = new FormData(form, submitter);
  return { decision: data.get('decision'), roles: data.getAll('role'), request: data.get('request'), nonce: data.get('nonce') };
}

test('says who asks, as whom and where the answer goes; offers only the roles the server listed, by their labels', () => {
  setRoleLabels({ operator: 'Shop floor' });
  render(<OAuthConsent view={view()} />);
  expect(screen.getByRole('heading', { name: 'Connect Desk agent to Shop' })).toBeInTheDocument();
  expect(screen.getByText(/Desk agent asks to use Shop as you, ada@example\.test/)).toBeInTheDocument();
  expect(screen.getByText(/sends you back to 127\.0\.0\.1:9/)).toBeInTheDocument();
  const boxes = screen.getAllByRole('checkbox');
  expect(boxes.map((box) => (box as HTMLInputElement).value)).toEqual(['operator', 'auditor']);
  expect(screen.getByLabelText('Shop floor')).not.toBeChecked();
  const form = screen.getByRole('button', { name: 'Allow' }).closest('form')!;
  expect(form.getAttribute('method')).toBe('post');
  expect(form.getAttribute('action')).toBe('/api/auth/oauth/consent');
});

test('Allow needs a role chosen; the answer carries the request, its nonce and exactly the roles ticked', async () => {
  const user = userEvent.setup();
  render(<OAuthConsent view={view()} />);
  const allow = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
  const form = allow.closest('form')!;
  // Read, never sent: happy-dom does not navigate.
  const submitted = vi.fn();
  form.addEventListener('submit', (event) => {
    submitted();
    event.preventDefault();
  });
  await user.click(allow);
  expect(submitted).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one role to allow.');
  await user.click(screen.getByLabelText('auditor'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sent(form, allow)).toEqual({ decision: 'allow', roles: ['auditor'], request: view().request, nonce: 'n'.repeat(43) });
  await user.click(allow);
  expect(submitted).toHaveBeenCalledTimes(1);
  // Pressed once: a second press sends nothing more.
  await user.click(allow);
  expect(submitted).toHaveBeenCalledTimes(1);
});

test('one role is chosen for the person; a native application is named by its scheme; Deny is always there', () => {
  render(
    <OAuthConsent
      view={view({ roles: ['operator'], client: { id: 'twc1.x', name: null }, redirect: { scheme: 'com.example.desk', host: '' } })}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Connect An unnamed application to Shop' })).toBeInTheDocument();
  expect(screen.getByLabelText('operator')).toBeChecked();
  expect(screen.getByText(/back to the application on this device \(com\.example\.desk\)/)).toBeInTheDocument();
  const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
  expect(sent(deny.closest('form')!, deny).decision).toBe('deny');
});

test('an account with no role to give can only decline', () => {
  render(<OAuthConsent view={view({ roles: [] })} />);
  expect(screen.getByText('Your account holds no role this App lets you give to an application.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
});

test('loading: an expired request and a malformed answer are sentences, never a half-drawn page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 410 })),
  );
  expect(await loadConsent('r')).toBe('This request has expired. Start again from the application.');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ request: 'r' }), { status: 200 })),
  );
  expect(await loadConsent('r')).toBe('The request could not be loaded. Start again from the application.');
  const good = view();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(good), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadConsent('a b')).toEqual(good);
  expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe('/api/auth/oauth/consent?request=a%20b');
});

test("a tenant App: the person picks a tenant first, and the roles are that membership's, none carried to the next", async () => {
  const user = userEvent.setup();
  render(
    <OAuthConsent
      view={view({
        roles: [],
        tenants: [
          { id: 'north', name: 'North Depot', roles: ['clerk', 'manager'] },
          { id: 'south', name: 'South Depot', roles: ['clerk'] },
        ],
      })}
    />,
  );
  expect(screen.queryAllByRole('checkbox')).toEqual([]);
  const allow = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
  const form = allow.closest('form')!;
  form.addEventListener('submit', (event) => event.preventDefault());
  await user.click(allow);
  expect(screen.getByRole('alert')).toHaveTextContent('Choose where the application may act.');
  await user.click(screen.getByLabelText('North Depot'));
  expect(screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).value)).toEqual(['clerk', 'manager']);
  await user.click(screen.getByLabelText('manager'));
  await user.click(screen.getByLabelText('South Depot'));
  // One role there, chosen for the person; the manager ticked for North is not South's.
  expect(screen.getByLabelText('clerk')).toBeChecked();
  expect(new FormData(form, allow).get('tenant')).toBe('south');
  expect(new FormData(form, allow).getAll('role')).toEqual(['clerk']);
});

test('a tenant App with no active membership can only decline', () => {
  render(<OAuthConsent view={view({ roles: [], tenants: [] })} />);
  expect(screen.getByText(/not an active member anywhere/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
});
