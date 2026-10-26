import { expect, test } from 'vitest';
import { parseTenantLink, qualifyTenantLink, tenantRootLink } from './tenantLink.js';

test.each(['/atlas', '/atlas/item', '/atlas/item/~42', '/atlas/@detail!related~42'])(
  'unqualified same-App walk %s stays byte-for-byte intact',
  (pathname) => {
    expect(parseTenantLink(pathname, 'atlas')).toEqual({ pathname, search: '', tenantId: null });
  },
);

test.each(['north', 'North', 'north south', '北区', 'north/south', 'a\\b', 'a&tenant=b', 'a+b', 'a=b', 'a?b#c', '%2F', '😀'])(
  'tenant ID %s round-trips exactly through canonical query encoding',
  (tenantId) => {
    const pathname = '/atlas/item/~same%2Fkey!history';
    const link = qualifyTenantLink(pathname, 'atlas', tenantId);
    expect(link).toBe(`${pathname}?${new URLSearchParams({ tenant: tenantId })}`);
    expect(parseTenantLink(link, 'atlas')).toEqual({ pathname, search: '', tenantId });
  },
);

test('a signed-in tenant normalizes its sign-in door to the root while retaining only a valid selector', () => {
  expect(tenantRootLink('atlas', '?realm=platform')).toBe('/atlas?realm=platform');
  expect(tenantRootLink('atlas', '?tenant=north')).toBe('/atlas?tenant=north');
  for (const search of ['', '?return=/atlas/work', '?realm=platform&tenant=north', '?tenant=north#fragment']) {
    expect(tenantRootLink('atlas', search)).toBe('/atlas');
  }
});

test('the platform realm is its own selector, and no tenant hint names its reserved id', () => {
  expect(qualifyTenantLink('/atlas/item/~42', 'atlas', '@platform')).toBe('/atlas/item/~42?realm=platform');
  expect(parseTenantLink('/atlas/item/~42?realm=platform', 'atlas')).toEqual({
    pathname: '/atlas/item/~42',
    search: '',
    tenantId: '@platform',
  });
  for (const link of [
    '/atlas?tenant=%40platform',
    '/atlas?tenant=@platform',
    '/atlas?realm=tenant',
    '/atlas?realm=',
    '/atlas?realm=platform&tenant=north',
  ])
    expect(() => parseTenantLink(link, 'atlas')).toThrow('Invalid tenant link.');
});

test('an App address keeps its own parameters beside the selector, in any order, as written', () => {
  expect(parseTenantLink('/atlas/items?tab=open&search=a%20b&tenant=north', 'atlas')).toEqual({
    pathname: '/atlas/items',
    search: 'tab=open&search=a%20b',
    tenantId: 'north',
  });
  expect(parseTenantLink('/atlas/items?realm=platform&tenant_id=north&sort=-due', 'atlas')).toEqual({
    pathname: '/atlas/items',
    search: 'tenant_id=north&sort=-due',
    tenantId: '@platform',
  });
  // A link with no selector keeps its parameters; the chooser still comes first.
  expect(parseTenantLink('/atlas/items?tab=open', 'atlas')).toEqual({ pathname: '/atlas/items', search: 'tab=open', tenantId: null });
  expect(qualifyTenantLink('/atlas/items?tab=open&search=a%20b', 'atlas', 'north')).toBe('/atlas/items?tab=open&search=a%20b&tenant=north');
  expect(qualifyTenantLink('/atlas/portfolio?period=last-30-days', 'atlas', '@platform')).toBe(
    '/atlas/portfolio?period=last-30-days&realm=platform',
  );
  // Its parameters never carry a selector of their own.
  for (const address of ['/atlas/items?tenant=south', '/atlas/items?tab=open&realm=platform', '/atlas/items?tab=open&', '/atlas/items?x'])
    expect(() => qualifyTenantLink(address, 'atlas', 'north')).toThrow('Invalid tenant link.');
});

test("a signed-in door keeps a selector but none of the App's parameters", () => {
  expect(tenantRootLink('atlas', '?tab=open&tenant=north')).toBe('/atlas?tenant=north');
});

test('query plus means a space, while encoded plus remains a plus', () => {
  expect(parseTenantLink('/atlas?tenant=north+south', 'atlas').tenantId).toBe('north south');
  expect(parseTenantLink('/atlas?tenant=north%2Bsouth', 'atlas').tenantId).toBe('north+south');
});

test('App segment is decoded exactly once and valid encoded App names are preserved', () => {
  expect(parseTenantLink('/%61tlas/item?tenant=north', 'atlas')).toEqual({ pathname: '/%61tlas/item', search: '', tenantId: 'north' });
  expect(parseTenantLink('/%E5%8C%97%E5%8C%BA/item', '北区').pathname).toBe('/%E5%8C%97%E5%8C%BA/item');
  expect(qualifyTenantLink('/%252F/item', '%2F', 'north')).toBe('/%252F/item?tenant=north');
  expect(() => parseTenantLink('/%2561tlas', 'atlas')).toThrow('Invalid tenant link.');
});

test.each([
  '/atlas/item%20name%20%21%3D%20%22a%2Fb%22!rows/~id%3Da%2Fb%2Cregion%3D%E5%8C%97',
  '/atlas/item/~a%2Fb',
  '/atlas/item/~a%2fb',
  '/atlas/item/~%2F%2Fother.example',
  '/atlas/item/~..%2Fsecret',
  '/atlas/item/~%252F',
  '/atlas/item/~a%3Fb%23c',
  '/atlas/@detail!related~a%2Fb%21x',
  '/atlas/item/~name%3D%22!%22',
])('encoded walk query/key %s is not decoded into routing syntax', (pathname) => {
  expect(parseTenantLink(`${pathname}?tenant=north`, 'atlas')).toEqual({ pathname, search: '', tenantId: 'north' });
  expect(qualifyTenantLink(pathname, 'atlas', 'south')).toBe(`${pathname}?tenant=south`);
});

test.each([
  '',
  '/',
  'atlas',
  'atlas/item',
  'https://example.test/atlas',
  'http://example.test/atlas',
  '//atlas/item',
  '///atlas/item',
  '\\atlas\\item',
  '/atlas\\item',
  '/atlas/item\\key',
  '/atlas#fragment',
  '/atlas/item#',
  '/atlas/item?tenant=north#fragment',
  '/other',
  '/Atlas',
  '/atlas-other',
  '/%6Fther/item',
  '/atlas/',
  '/atlas//item',
  '/atlas/item/',
  '/atlas/item//~42',
  '/atlas/./item',
  '/atlas/../atlas',
  '/atlas/%2e/item',
  '/atlas/.%2E/item',
  '/atlas/%2E./item',
  '/atlas/%2e%2e/item',
  '/atlas/item/..',
  '/atlas/item/%2e',
  ' /atlas',
  '/atlas ',
  '/atlas/raw space',
  '/atlas/北区',
  '/atlas/\nitem',
  '/atlas/\titem',
  '/atlas/item\u0000',
  '/atlas/item\u007f',
])('ambiguous, foreign or non-local link %j refuses', (link) => {
  expect(() => parseTenantLink(link, 'atlas')).toThrow('Invalid tenant link.');
});

test.each(['/atlas%2Fother', '/atlas%2fother', '/atlas%5Cother'])(
  'encoded separator in App segment %s is refused even for a matching App argument',
  (pathname) => {
    const appId = decodeURIComponent(pathname.slice(1));
    expect(() => parseTenantLink(pathname, appId)).toThrow('Invalid tenant link.');
    expect(() => qualifyTenantLink(pathname, appId, 'north')).toThrow('Invalid tenant link.');
  },
);

test.each([
  '/atlas?',
  '/atlas?tenant',
  '/atlas?tenant=',
  '/atlas?tenant=north&tenant=south',
  '/atlas?tenant=north&tenant=north',
  '/atlas?tenant=north&%74enant=south',
  '/atlas?app=atlas',
  '/atlas?conn=atlas',
  '/atlas?Tenant=north',
  '/atlas?TENANT=north&tenant=south',
  '/atlas?tab=open&tab=done&tenant=north',
  '/atlas?realm=platform&%72ealm=platform',
  '/atlas?tab&tenant=north',
  '/atlas?tenant=north&',
  '/atlas?&tenant=north',
  '/atlas?&&',
  '/atlas?tenant=+north',
  '/atlas?tenant=north+',
  '/atlas?tenant=%20north',
  '/atlas?tenant=north%20',
  '/atlas?tenant=%09north',
  '/atlas?tenant=north%00south',
  '/atlas?tenant=north%7Fsouth',
  '/atlas?tenant=north%C2%85south',
])('invalid selector envelope %s refuses without dropping fields', (link) => {
  expect(() => parseTenantLink(link, 'atlas')).toThrow('Invalid tenant link.');
});

test.each(['%', '%2', '%GG', '%C0%AF', '%E0%A4', '%ED%A0%80', '%FF'])(
  'malformed percent/UTF-8 escape %s refuses in every parsed component',
  (escape) => {
    for (const link of [`/${escape}`, `/atlas/item/~${escape}`, `/atlas?tenant=${escape}`, `/atlas?${escape}=north`]) {
      expect(() => parseTenantLink(link, 'atlas')).toThrow('Invalid tenant link.');
    }
  },
);

test.each(['', ' north', 'north ', '\t', 'north\nsouth', 'north\u0000south', 'north\u007fsouth', 'north\u0085south', '\ud800', '\udfff'])(
  'qualifying invalid tenant ID %j refuses without coercion',
  (tenantId) => {
    expect(() => qualifyTenantLink('/atlas/item', 'atlas', tenantId)).toThrow('Invalid tenant link.');
  },
);

test('tenant size bound applies to the decoded ID, not percent-encoding expansion', () => {
  for (const tenantId of ['n'.repeat(1024), '北'.repeat(1024)]) {
    const link = qualifyTenantLink('/atlas', 'atlas', tenantId);
    expect(parseTenantLink(link, 'atlas').tenantId).toBe(tenantId);
  }
  const tooLong = 'n'.repeat(1025);
  expect(() => qualifyTenantLink('/atlas', 'atlas', tooLong)).toThrow('Invalid tenant link.');
  expect(() => parseTenantLink(`/atlas?tenant=${tooLong}`, 'atlas')).toThrow('Invalid tenant link.');
});

test.each(['/atlas?tenant=north', '/atlas?', '/atlas#x', '/other/item', '/atlas/../atlas'])(
  'qualify requires an unqualified canonical pathname: %s',
  (pathname) => {
    expect(() => qualifyTenantLink(pathname, 'atlas', 'south')).toThrow('Invalid tenant link.');
  },
);

test('runtime non-string arguments refuse without invoking object conversion', () => {
  let conversions = 0;
  const malformed = {
    toString() {
      conversions++;
      return '/atlas';
    },
  };
  for (const input of [null, undefined, 42, malformed]) {
    expect(() => Reflect.apply(parseTenantLink, undefined, [input, 'atlas'])).toThrow('Invalid tenant link.');
    expect(() => Reflect.apply(parseTenantLink, undefined, ['/atlas', input])).toThrow('Invalid tenant link.');
    expect(() => Reflect.apply(qualifyTenantLink, undefined, ['/atlas', 'atlas', input])).toThrow('Invalid tenant link.');
  }
  expect(conversions).toBe(0);
});
