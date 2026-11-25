/**
 * `useNavigate().openPage` and an Item's in-App link move through the page host's `follow`. In a tenant's session the
 * shell reads an address with no selector as a link to another tenant and loads the document again (a field report:
 * a marker on `window` was lost and the context ran again), so the address is written with this tenant's selector.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { inward, readMountJson } from '@mistriwork/engine/shared/mount.js';
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

/* A page says its addresses as the browser shows them (`hrefFor`), and the mount decides that spelling: a tenant App
   served at the root says `/forecast`, which named no App to the selector's writer, so the address went out bare and the
   shell took it for another tenant's and loaded the document again. Each spelling is read back inside first. */
describe("a tenant's address is qualified in every mount spelling", () => {
  const followMounted = async (mount: object | null, href: string) => {
    vi.resetModules();
    document.head.querySelector('meta[name="mistri-mount"]')?.remove();
    if (mount) {
      const meta = document.createElement('meta');
      meta.name = 'mistri-mount';
      meta.content = JSON.stringify(mount);
      document.head.append(meta);
    }
    const shellMode = await import('@mistriwork/kit/client/shellMode.js');
    shellMode.installShell({
      tenantLinks: { parse: parseTenantLink, qualify: qualifyTenantLink },
    });
    const context = await import('./context.js');
    await import('./host.js');
    mocks.tenant = { appId: 'desk', tenantId: 't-7' };
    renderHook(() => context.useHostIfAny()).result.current?.follow(href);
    document.head.querySelector('meta[name="mistri-mount"]')?.remove();
    const followed = mocks.navFollow.mock.calls.at(-1)?.[0] as string;
    /* What the shell does with it (tenantNavigation.ts): the address read back inside names this tenant, so it is
       applied in place; one that names none, or cannot be read, is a new document. */
    const within = inward(readMountJson(mount ? JSON.stringify(mount) : null), followed);
    let owner: string | null | undefined;
    try {
      owner = within === undefined ? undefined : parseTenantLink(within, 'desk').tenantId;
    } catch {
      owner = undefined;
    }
    inPlace = owner === 't-7';
    return followed;
  };
  let inPlace = false;

  test('the one App served at the root', async () => {
    expect(await followMounted({ base: '', apps: { desk: '' } }, '/forecast?period=q3')).toBe('/forecast?period=q3&tenant=t-7');
    expect(inPlace).toBe(true);
    expect(await followMounted({ base: '', apps: { desk: '' } }, '/')).toBe('/?tenant=t-7');
    expect(inPlace).toBe(true);
  });

  test('an App mounted at its own segment', async () => {
    expect(await followMounted({ base: '', apps: { desk: 'desk', other: 'other' } }, '/desk/forecast')).toBe('/desk/forecast?tenant=t-7');
    expect(inPlace).toBe(true);
    expect(await followMounted({ base: '', apps: { desk: 'front', other: 'other' } }, '/front/forecast')).toBe(
      '/front/forecast?tenant=t-7',
    );
    expect(inPlace).toBe(true);
  });

  test('a server under a base path, with the App at its root and at a segment', async () => {
    expect(await followMounted({ base: '/tools', apps: { desk: '' } }, '/tools/forecast?period=q3')).toBe(
      '/tools/forecast?period=q3&tenant=t-7',
    );
    expect(inPlace).toBe(true);
    expect(await followMounted({ base: '/tools', apps: { desk: 'desk', other: 'other' } }, '/tools/desk/forecast')).toBe(
      '/tools/desk/forecast?tenant=t-7',
    );
    expect(inPlace).toBe(true);
  });

  test("another App's address is not this tenant's, and goes as given", async () => {
    expect(await followMounted({ base: '', apps: { desk: 'desk', other: 'other' } }, '/other/forecast')).toBe('/other/forecast');
    expect(inPlace).toBe(false);
  });
});
