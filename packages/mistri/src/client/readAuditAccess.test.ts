/* The read audit as /api/reads tells it: only the route's own filters are sent, nothing is asked outside a tenant App or
   on a support visit, and the route's refusal reaches the page as the error it is. */
import { beforeEach, expect, test, vi } from 'vitest';

const owner = { mode: 'authenticated', accountId: 'eve', appId: 'desk', epoch: 1, tenant: { tenantId: 'north' } };
const identity = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@mistriwork/kit/client/sessionIdentity.js', () => ({ captureAccountIdentity: () => identity.current }));
const core = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@mistriwork/kit/client/core.js', () => core);
const { createReadAuditAccess } = await import('./readAuditAccess.js');

beforeEach(() => {
  identity.current = owner;
  core.api.mockReset();
});

test('it sends only the filters the route reads, and returns its page', async () => {
  const page = {
    reads: [{ id: 3, at: 'x', actor: 'eve', resource: 'patient', route: 'page', kind: 'opened', record: '7' }],
    next: 3,
    resources: ['patient'],
  };
  core.api.mockResolvedValue(page);
  const filters = { resource: 'patient', record: '7', actor: '', before: 9, tenant: 'south' } as never;
  expect(await createReadAuditAccess().read(filters)).toBe(page);
  expect(core.api).toHaveBeenCalledWith('/api/reads', { resource: 'patient', record: '7', before: 9 });
});

test('outside a tenant App, signed out, or on a support visit nothing is asked', async () => {
  for (const current of [
    { ...owner, tenant: undefined },
    { mode: 'anonymous' },
    { ...owner, tenant: { tenantId: 'north', realm: 'support' } },
  ]) {
    identity.current = current;
    expect(await createReadAuditAccess().read({})).toEqual({ reads: [], resources: [] });
  }
  expect(core.api).not.toHaveBeenCalled();
});

test("the route's refusal is the error, and a reply without lines is one too", async () => {
  const refused = Object.assign(new Error('Only admins.'), { status: 403, code: 'forbidden' });
  core.api.mockRejectedValueOnce(refused);
  await expect(createReadAuditAccess().read({})).rejects.toBe(refused);
  core.api.mockResolvedValueOnce({ error: 'Only admins.', code: 'forbidden' });
  await expect(createReadAuditAccess().read({})).rejects.toMatchObject({ message: 'Only admins.', code: 'forbidden' });
  core.api.mockResolvedValueOnce({});
  await expect(createReadAuditAccess().read({})).rejects.toThrow('The read audit could not be read.');
});
