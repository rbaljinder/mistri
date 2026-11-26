import { afterEach, expect, test } from 'vitest';
import { installShell } from './shellMode.js';
import { establishSessionIdentity, establishTenantSelection, requireTenantSelection } from './sessionIdentity.js';
import { resolveInAppSpaHref } from './inAppLink.js';

const resetShell = () => {
  installShell({
    inApp: () => false,
    app: () => null,
    rooms: {},
  } as never);
  establishSessionIdentity({ signedIn: false, accountId: null, appId: null });
};

afterEach(resetShell);

test('resolves in-App links and skips non-SPA doors, external URLs, and backslash open redirects', () => {
  installShell({
    inApp: () => true,
    app: () => ({ id: 'denassist' }),
    rooms: {},
  } as never);

  expect(resolveInAppSpaHref('/denassist/patients')).toBe('/denassist/patients');
  expect(resolveInAppSpaHref('/denassist/patients/42?tab=notes#top')).toBe('/denassist/patients/42?tab=notes#top');
  expect(resolveInAppSpaHref('/denassist/sign-in')).toBeNull();
  expect(resolveInAppSpaHref('/denassist/form/intake')).toBeNull();
  expect(resolveInAppSpaHref('/denassist/_components/foo.js')).toBeNull();
  expect(resolveInAppSpaHref('/otherapp/patients')).toBeNull();
  expect(resolveInAppSpaHref('/api/query')).toBeNull();
  expect(resolveInAppSpaHref('/_mistri/ui.js')).toBeNull();
  expect(resolveInAppSpaHref('//evil.example/x')).toBeNull();
  expect(resolveInAppSpaHref('/\\evil.example/x')).toBeNull();
  expect(resolveInAppSpaHref('#section')).toBeNull();
  expect(resolveInAppSpaHref('https://example.com/out')).toBeNull();
});

test('qualifies tenant links, normalizes trailing slashes, preserves hashes, and skips cross-tenant selectors', () => {
  installShell({
    inApp: () => true,
    app: () => ({ id: 'denassist' }),
    rooms: {},
    tenantLinks: {
      parse: (link: string) => {
        const url = new URL(link, 'http://t.invalid');
        const tenantId = url.searchParams.get('tenant');
        return { pathname: url.pathname, search: url.search.replace(/^\?/, ''), tenantId };
      },
      qualify: (address: string, _appId: string, tenantId: string) =>
        address.includes('?') ? `${address}&tenant=${tenantId}` : `${address}?tenant=${tenantId}`,
    },
  } as never);
  establishSessionIdentity({ signedIn: true, accountId: 'u1', appId: 'denassist' });
  const pending = requireTenantSelection();
  establishTenantSelection(
    {
      appId: 'denassist',
      accountId: 'u1',
      tenantId: 'clinic-a',
      tabId: 'tab-1',
      context: 'ctx-1',
      revision: 1,
      expiresAt: Date.now() + 60_000,
    },
    pending,
  );

  expect(resolveInAppSpaHref('/denassist/patients/')).toBe('/denassist/patients?tenant=clinic-a');
  expect(resolveInAppSpaHref('/denassist/patients/42#chart')).toBe('/denassist/patients/42?tenant=clinic-a#chart');
  expect(resolveInAppSpaHref('/denassist/patients?tenant=clinic-a')).toBe('/denassist/patients?tenant=clinic-a');
  expect(resolveInAppSpaHref('/denassist/patients?tenant=clinic-b')).toBeNull();
});
