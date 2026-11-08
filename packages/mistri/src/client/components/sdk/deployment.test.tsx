/* `useDeployment()`: the deployment's presentation of the App, read-only, and nothing else. */
import { renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { installShell } from '../../../../../kit/src/client/shellMode.js';
import { useDeployment } from './deployment.js';
import { fixtureHost, fixtures } from './fixture.js';
import { UiHostContext } from './context.js';
import './host.js';

const showing = (app: unknown) => installShell({ app: () => app as never, inApp: () => true });
afterEach(() => showing(null));

test('it says the name, mark, theme, locale and base path, and exactly those', () => {
  showing({
    id: 'bank',
    name: 'Northside Bank',
    // Secrets that must never reach a page: nothing outside the allowed keys is read.
    token: 'secret',
    connection: 'postgres://user:pw@host/db',
    ui: {
      logo: { src: 'logos/north.svg', href: '/bank/_brand/north-1.svg', markHref: '/bank/_brand/north-mark-1.svg' },
      theme: { preset: 'mono' },
      locale: 'en-AU',
    },
  });
  const seen = renderHook(() => useDeployment()).result.current;
  expect(Object.keys(seen).sort()).toEqual(['basePath', 'locale', 'mark', 'name', 'theme']);
  expect(seen).toEqual({ name: 'Northside Bank', mark: '/bank/_brand/north-mark-1.svg', theme: 'mono', locale: 'en-AU', basePath: '' });
  expect(Object.isFrozen(seen)).toBe(true);
});

test('an App with an icon for a logo and no theme or locale says null, not a guess', () => {
  showing({ id: 'bank', name: 'Bank', ui: { logo: 'wallet' } });
  expect(renderHook(() => useDeployment()).result.current).toEqual({ name: 'Bank', mark: null, theme: null, locale: null, basePath: '' });
});

test('a test fixture host answers with the same five keys', () => {
  const host = fixtureHost(fixtures({}), { look: 'mono', locale: 'de-DE' }, []);
  const seen = renderHook(() => useDeployment(), {
    wrapper: ({ children }) => <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>,
  }).result.current;
  expect(Object.keys(seen).sort()).toEqual(['basePath', 'locale', 'mark', 'name', 'theme']);
  expect(seen).toMatchObject({ theme: 'mono', locale: 'de-DE' });
});
