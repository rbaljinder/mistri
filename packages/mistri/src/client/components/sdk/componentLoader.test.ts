/**
 * A tenant App lists its components only once a tenant is chosen: a section asking before that waits for the choice
 * rather than refusing, so nothing is logged for an answer that had not arrived (a field report).
 */
import { expect, test, vi } from 'vitest';

let app: { components?: Record<string, { kind: 'section'; href: string }> } | null = null;
vi.mock('@mistriwork/kit/client/uiBridge.js', () => ({ pageBridge: { activeApp: () => app } }));
vi.mock('./host.js', () => ({}));

const { loadComponent } = await import('./componentLoader.js');
const identity = await import('@mistriwork/kit/client/sessionIdentity.js');

test('a part asked for before the tenant is chosen waits for the payload; one the App never serves still refuses', async () => {
  identity.establishSessionIdentity({ signedIn: true, accountId: 'a1', appId: 'ops' });
  identity.requireTenantSelection();
  let settled = '';
  const asking = loadComponent('gauge').then(
    () => (settled = 'loaded'),
    (error: Error) => (settled = error.message),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe('');
  app = { components: { gauge: { kind: 'section', href: 'data:text/javascript,export default () => null' } } };
  identity.establishTenantSelection({
    appId: 'ops',
    accountId: 'a1',
    tenantId: 't1',
    tabId: 'tab',
    context: 'c',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  } as never);
  await asking;
  expect(settled).toBe('loaded');
  await expect(loadComponent('missing')).rejects.toThrow(/serves no component "missing"/);
}, 10_000);
