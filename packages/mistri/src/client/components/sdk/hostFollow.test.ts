/**
 * `useNavigate().openPage` and an Item's in-App link move through the page host's `follow`. In a tenant's session the
 * shell reads an address with no selector as a link to another tenant and loads the document again (a field report:
 * a marker on `window` was lost and the context ran again), so the address is written with this tenant's selector.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { qualifyTenantLink, parseTenantLink } from '../../tenantLink.js';

const mocks = vi.hoisted(() => ({
  navFollow: vi.fn(),
  tenant: undefined as { appId: string; tenantId: string } | undefined,
}));
vi.mock('@mistriwork/kit/client/shellHost.js', async (original) => ({
  ...(await original<object>()),
  navFollow: mocks.navFollow,
}));
vi.mock('@mistriwork/kit/client/sessionIdentity.js', async (original) => {
  const real = await original<typeof import('@mistriwork/kit/client/sessionIdentity.js')>();
  return { ...real, sessionIdentity: () => ({ ...real.sessionIdentity(), tenant: mocks.tenant }) };
});

const { useHostIfAny } = await import('./context.js');
await import('./host.js');
// The page host is set when host.tsx loads; no provider is needed to reach it.
const follow = (href: string) => {
  const { result } = renderHook(() => useHostIfAny());
  result.current?.follow(href);
};

afterEach(() => mocks.navFollow.mockReset());

describe('the page host follows an address in place', () => {
  test("a tenant's address carries its selector, so the shell takes it for its own", () => {
    installShell({ tenantLinks: { parse: parseTenantLink, qualify: qualifyTenantLink } });
    mocks.tenant = { appId: 'desk', tenantId: 't-7' };
    follow('/desk/forecast?period=q3');
    expect(mocks.navFollow).toHaveBeenCalledWith('/desk/forecast?period=q3&tenant=t-7');
  });

  test('an address with no tenant session, or one that cannot be read, goes as given', () => {
    mocks.tenant = undefined;
    follow('/desk/forecast');
    mocks.tenant = { appId: 'desk', tenantId: 't-7' };
    follow('/elsewhere/forecast');
    expect(mocks.navFollow.mock.calls).toEqual([['/desk/forecast'], ['/elsewhere/forecast']]);
  });
});
