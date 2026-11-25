/**
 * A tenant's reads in Settings: each row says when, who (named, or the kind of reader) and what was seen, an opened
 * record linked to its address and followed in place; clicking a person filters by them; the filters and "Show older"
 * ask the route with the filters and the keyset; a refusal is said in the route's own words.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const { api, navFollow } = vi.hoisted(() => ({ api: vi.fn(), navFollow: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state: { activeConnection: 'clinic' },
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
vi.mock('../../../../kit/src/client/shellHost.js', async (original) => ({ ...(await original<object>()), navFollow }));
vi.mock('../publicAddress.js', () => ({
  recordHref: (table: string, key: string) => (table === 'patients' ? `/clinic/patients/${key}` : undefined),
}));
const { TenantReads } = await import('./TenantReads.js');

const opened = {
  id: 9,
  at: '2026-11-18T10:00:00.000Z',
  actor: 'acct-1',
  person: 'Dana Ruiz',
  resource: 'patients',
  route: 'page',
  kind: 'opened',
  record: '42',
};
const listed = { id: 8, at: '2026-11-18T09:00:00.000Z', actor: 'public', resource: 'patients', route: 'api', kind: 'listed', count: 3 };
const helper = {
  id: 7,
  at: '2026-11-18T08:00:00.000Z',
  actor: 'assistant:acct-1',
  person: 'Dana Ruiz',
  resource: 'notes',
  route: 'assistant',
  kind: 'opened',
  record: '5',
};

beforeEach(() => {
  api.mockReset();
  navFollow.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('rows say who saw what, and an opened record is a link followed in place', async () => {
  api.mockResolvedValue({ reads: [opened, listed, helper], resources: ['patients', 'notes'] });
  render(<TenantReads />);
  const first = (await screen.findByRole('button', { name: 'Dana Ruiz' })).closest('li')!;
  expect(first.textContent).toContain('Opened patients');
  const link = within(first).getByRole('link', { name: '42' });
  expect(link.getAttribute('href')).toBe('/clinic/patients/42');
  await userEvent.click(link);
  expect(navFollow).toHaveBeenCalledWith('/clinic/patients/42');
  expect(screen.getByText('A signed-out visitor')).toBeTruthy();
  expect(screen.getByText('Listed patients, 3 rows', { exact: false })).toBeTruthy();
  expect(screen.getByText('The assistant, for Dana Ruiz')).toBeTruthy();
  /* A resource with no address shows its id, unlinked. */
  expect(screen.getByText('5').closest('a')).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/reads', {});
});

test('clicking a person filters by them; Show older pages by the keyset with the same filters', async () => {
  api.mockImplementation(async (_path: string, body: Record<string, unknown>) =>
    body.before === 9
      ? { reads: [{ ...opened, id: 3, record: '7' }], resources: ['patients'] }
      : { reads: [opened], next: 9, resources: ['patients'] },
  );
  render(<TenantReads />);
  await userEvent.click(await screen.findByRole('button', { name: 'Dana Ruiz' }));
  expect(api).toHaveBeenLastCalledWith('/api/reads', { actor: 'acct-1' });
  expect(await screen.findByText('Reads by Dana Ruiz')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
  expect(api).toHaveBeenLastCalledWith('/api/reads', { actor: 'acct-1', before: 9 });
  expect(await screen.findByRole('link', { name: '7' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '42' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Show reads by everyone' }));
  expect(api).toHaveBeenLastCalledWith('/api/reads', {});
});

test('a record and a day range are asked as the key and a whole-day window', async () => {
  api.mockResolvedValue({ reads: [], resources: ['patients'] });
  render(<TenantReads />);
  expect(await screen.findByText('No reads match.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Record', { exact: false }), ' 42 ');
  const from = screen.getByLabelText('From') as HTMLInputElement;
  const to = screen.getByLabelText('To') as HTMLInputElement;
  await userEvent.type(from, '2026-11-01');
  await userEvent.type(to, '2026-11-02');
  await userEvent.click(screen.getByRole('button', { name: 'Show' }));
  expect(api).toHaveBeenLastCalledWith('/api/reads', {
    record: '42',
    since: new Date(2026, 10, 1).toISOString(),
    until: new Date(2026, 10, 3).toISOString(),
  });
});

test("a refusal is said in the route's words", async () => {
  api.mockResolvedValue({ error: "Only this organization's admins may read who saw its records.", code: 'forbidden' });
  render(<TenantReads />);
  expect((await screen.findByRole('alert')).textContent).toBe("Only this organization's admins may read who saw its records.");
});
