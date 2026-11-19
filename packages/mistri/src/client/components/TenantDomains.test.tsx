/**
 * A tenant's domains in Settings: an editor sees the two DNS records with a copy for each and asks for a check by
 * host; a member who is not an editor sees the addresses with no records and no controls; the limit closes the form;
 * a refusal is said in the route's own words.
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
const { TenantDomains } = await import('./TenantDomains.js');

const records = {
  cname: { type: 'CNAME', name: 'shop.example.com', value: 'acme.apps.test' },
  txt: { type: 'TXT', name: '_mistri-verify.shop.example.com', value: 'mv-token-1' },
  apex: false,
};
const subdomain = {
  host: 'acme.apps.test',
  kind: 'subdomain',
  status: 'live',
  primary: true,
  claimed: false,
  checkedAt: null,
  failures: 0,
};
const custom = (over: Record<string, unknown> = {}) => ({
  host: 'shop.example.com',
  kind: 'custom',
  status: 'pending',
  primary: false,
  claimed: true,
  checkedAt: null,
  failures: 0,
  expiresAt: Date.now() + 6.5 * 24 * 3_600_000,
  records,
  ...over,
});

beforeEach(() => api.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('an editor sees the records with a copy for each, and Check now asks the route by host', async () => {
  let status = 'pending';
  api.mockImplementation(async (path: string) => {
    if (path === '/api/domains/check') status = 'live';
    const reply = { domains: [subdomain, custom({ status })], limit: 2, editor: true };
    return path === '/api/domains/check' ? { ...reply, outcome: 'ok' } : reply;
  });
  render(<TenantDomains />);
  const row = (await screen.findByText('shop.example.com', { selector: 'bdi' })).closest('li')!;
  expect(row).toHaveTextContent('Waiting for DNS');
  expect(row).toHaveTextContent('Expires in 7 days unless verified.');
  expect(row).toHaveTextContent('_mistri-verify.shop.example.com');
  expect(row).toHaveTextContent('mv-token-1');
  expect(screen.getByRole('button', { name: 'Copy the TXT value' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy the CNAME value' })).toBeInTheDocument();
  // The subdomain is the operator's: no controls of its own.
  const sub = screen.getByText('acme.apps.test', { selector: 'bdi' }).closest('li')!;
  expect(sub).toHaveTextContent('primary');
  expect(sub.querySelector('button')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(api).toHaveBeenCalledWith('/api/domains/check', { host: 'shop.example.com' });
  expect(await screen.findByRole('status')).toHaveTextContent('Both records were found.');
  // Live, the records are no longer drawn and the domain may become the primary.
  expect(screen.queryByText('mv-token-1')).toBeNull();
  expect(screen.getByRole('button', { name: 'Make primary' })).toBeInTheDocument();
  expect(row).not.toHaveTextContent('Expires in');
});

test('a pending claim in its last day says so in the singular', async () => {
  api.mockResolvedValue({ domains: [custom({ expiresAt: Date.now() + 3_600_000 })], limit: 2, editor: true });
  render(<TenantDomains />);
  expect(await screen.findByText('Expires in 1 day unless verified.')).toBeInTheDocument();
});

test('a member who is not an editor sees the addresses without records or controls', async () => {
  const { records: _records, ...bare } = custom();
  api.mockResolvedValue({ domains: [subdomain, bare], limit: 2, editor: false });
  render(<TenantDomains />);
  await screen.findByText('shop.example.com', { selector: 'bdi' });
  expect(screen.queryByText('mv-token-1')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('adding sends the hostname and clears the box; a refusal is said in the route’s words; the limit closes the form', async () => {
  let added = false;
  api.mockImplementation(async (path: string, body: { host?: string }) => {
    if (path === '/api/domains/add') {
      if (body.host === 'acme.apps.test') return { error: 'That address is taken.', code: 'domain_refused' };
      added = true;
    }
    return { domains: added ? [custom(), custom({ host: 'www.example.com' })] : [], limit: 2, editor: true };
  });
  render(<TenantDomains />);
  const box = await screen.findByRole('textbox', { name: /Domain/ });
  await userEvent.type(box, 'acme.apps.test');
  await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That address is taken.');
  await userEvent.clear(box);
  await userEvent.type(box, 'shop.example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
  expect(api).toHaveBeenCalledWith('/api/domains/add', { host: 'shop.example.com' });
  expect(await screen.findByText('This organization has added as many domains as it may (2).')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('removing asks first, then asks the route by host', async () => {
  let removed = false;
  api.mockImplementation(async (path: string) => {
    if (path === '/api/domains/remove') removed = true;
    return { domains: removed ? [subdomain] : [subdomain, custom({ status: 'suspended' })], limit: 2, editor: true };
  });
  render(<TenantDomains />);
  const row = (await screen.findByText('shop.example.com', { selector: 'bdi' })).closest('li')!;
  expect(row).toHaveTextContent('Suspended');
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(api).not.toHaveBeenCalledWith('/api/domains/remove', expect.anything());
  const confirm = screen.getByRole('group', { name: /Remove shop\.example\.com\?/ });
  await userEvent.click(confirm.querySelector('button')!);
  expect(api).toHaveBeenCalledWith('/api/domains/remove', { host: 'shop.example.com' });
  await vi.waitFor(() => expect(screen.queryByText('shop.example.com', { selector: 'bdi' })).toBeNull());
});
