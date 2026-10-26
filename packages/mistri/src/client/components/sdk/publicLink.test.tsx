/* `useNavigate().publicLink`: a tenant's own link to hand out, from the addresses its own lease's App
   payload carries — a list by the public address, a public form by the intake address — and nothing without one. */
import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installShell } from '../../../../../kit/src/client/shellMode.js';
import { useNavigate } from './hooks.js';
import './host.js';

vi.mock('../../publicAddress.js', () => ({
  viewPath: (view: string) => (view === 'plans' ? '/lending/plans' : undefined),
}));

const showing = (app: unknown) => installShell({ app: () => app as never, inApp: () => true });
const link = (view: string) => renderHook(() => useNavigate()).result.current.publicLink(view);
afterEach(() => showing(null));

test("a list is linked by the tenant's public address, a public form by its intake address", () => {
  showing({ id: 'lending', views: { plans: {} }, addresses: { public: 'PublicAddress0000000001', intake: 'IntakeAddress0000000001' } });
  expect(link('plans')).toBe(`${window.location.origin}/lending/plans?via=PublicAddress0000000001`);
  expect(link('apply')).toBe(`${window.location.origin}/lending/form/apply?via=IntakeAddress0000000001`);
});

test('without the address a link needs, or outside an App, there is no link', () => {
  showing({ id: 'lending', views: { plans: {} }, addresses: { intake: 'IntakeAddress0000000001' } });
  expect(link('plans')).toBeUndefined();
  showing({ id: 'lending', views: { plans: {} } });
  expect(link('apply')).toBeUndefined();
  showing(null);
  expect(link('plans')).toBeUndefined();
});
