import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { failStartup, finishStartup, rememberStartupAppearance, whenStartupReady } from './startup.js';

beforeEach(() => {
  sessionStorage.clear();
  document.documentElement.setAttribute('data-starting', '');
  document.body.innerHTML = '<div id="startup-status" role="status"><p>Loading...</p><a hidden>Reload</a></div>';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-starting');
});

test('startup callbacks run only after reveal and can be canceled on unmount', async () => {
  const ready = vi.fn(() => expect(document.documentElement.hasAttribute('data-starting')).toBe(false));
  const canceled = vi.fn();
  whenStartupReady(ready);
  whenStartupReady(canceled)();
  expect(ready).not.toHaveBeenCalled();
  await finishStartup();
  expect(ready).toHaveBeenCalledTimes(1);
  expect(canceled).not.toHaveBeenCalled();
  await finishStartup();
  expect(ready).toHaveBeenCalledTimes(1);
  whenStartupReady(ready);
  expect(ready).toHaveBeenCalledTimes(2);
});

test('appearance caching cannot delay a successful boot when storage is blocked', async () => {
  vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  await finishStartup();
  expect(document.documentElement.hasAttribute('data-starting')).toBe(false);
});

test('the temporary startup palette is never cached as the resolved appearance', () => {
  rememberStartupAppearance();
  expect(sessionStorage.getItem('mistri.startup.v1')).toBeNull();
});

test('unexpected failures stay visible with a reload action and literal error text', () => {
  failStartup(new Error('<strong>Unavailable</strong>'));
  expect(document.querySelector('#startup-status')?.getAttribute('role')).toBe('alert');
  expect(document.querySelector('#startup-status .unavail-line')?.textContent).toContain('<strong>Unavailable</strong>');
  expect(document.querySelector('#startup-status strong')).toBeNull();
  expect(document.querySelector('#startup-status a')?.hasAttribute('hidden')).toBe(false);
  expect(document.documentElement.hasAttribute('data-starting')).toBe(true);
});
