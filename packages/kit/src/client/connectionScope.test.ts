import { beforeEach, expect, test, vi } from 'vitest';

const activeApp = vi.fn();
vi.mock('./uiBridge.js', () => ({ pageBridge: { activeApp } }));
const { canManageConnections, canUseDatabaseTools, setAppConfigured } = await import('./connectionScope.js');

beforeEach(() => {
  activeApp.mockReturnValue(null);
  setAppConfigured(false);
});

test('connection management belongs only to a verified standalone explorer', () => {
  expect(canManageConnections()).toBe(true);
  activeApp.mockReturnValue({ name: 'Service Atlas' });
  expect(canManageConnections()).toBe(false);
  activeApp.mockReturnValue(null);
  setAppConfigured(true);
  expect(canManageConnections()).toBe(false);
  setAppConfigured(null);
  expect(canManageConnections()).toBe(false);
  setAppConfigured(false);
  expect(canManageConnections()).toBe(true);
});

test('database diagnostics cannot be enabled by leaving App mode for Workbench', () => {
  expect(canUseDatabaseTools()).toBe(true);
  setAppConfigured(true);
  expect(canUseDatabaseTools()).toBe(false);
  activeApp.mockReturnValue(null);
  expect(canUseDatabaseTools()).toBe(false);
  setAppConfigured(null);
  expect(canUseDatabaseTools()).toBe(false);
});
