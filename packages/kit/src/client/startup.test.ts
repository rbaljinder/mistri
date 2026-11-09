import { readFileSync } from 'node:fs';
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

test('a reveal the page has moved past leaves the veil to whoever holds it now', async () => {
  let entering = false;
  const pending = finishStartup(() => !entering);
  entering = true;
  await pending;
  expect(document.documentElement.hasAttribute('data-starting')).toBe(true);
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

/* The page's first script (index.html), which reads the cache before any module: run as the page runs it. */
const veil = (() => {
  const page = readFileSync('packages/kit/src/client/index.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(([, body]) => body!.includes('mistri.startup.v1'));
  return new Function(script![1]!);
})();

test("the veil's cached colors are a look's own: switching the Workbench's look, a host's included, never paints the last one", () => {
  vi.useFakeTimers();
  /* A plain session store: happy-dom binds Storage's methods on access, so a spy an earlier test left is not ours. */
  const kept = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  });
  try {
    document.documentElement.removeAttribute('data-starting');
    document.body.style.backgroundColor = 'rgb(10, 37, 80)';
    document.body.style.color = 'rgb(246, 249, 254)';
    localStorage.setItem('mistri.workbench-visual-theme', 'blueprint');
    rememberStartupAppearance();
    const ground = () => document.documentElement.style.getPropertyValue('--startup-ground');
    document.documentElement.removeAttribute('style');
    veil();
    expect(ground()).toBe('rgb(10, 37, 80)');
    // Another look, a built-in or the host's: the page starts on the plain ground, not the cached look's.
    for (const look of ['console', 'sage']) {
      localStorage.setItem('mistri.workbench-visual-theme', look);
      document.documentElement.removeAttribute('style');
      veil();
      expect(ground()).not.toBe('rgb(10, 37, 80)');
    }
  } finally {
    localStorage.removeItem('mistri.workbench-visual-theme');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test('unexpected failures stay visible with a reload action and literal error text', () => {
  failStartup(new Error('<strong>Unavailable</strong>'));
  expect(document.querySelector('#startup-status')?.getAttribute('role')).toBe('alert');
  expect(document.querySelector('#startup-status .unavail-line')?.textContent).toContain('<strong>Unavailable</strong>');
  expect(document.querySelector('#startup-status strong')).toBeNull();
  expect(document.querySelector('#startup-status a')?.hasAttribute('hidden')).toBe(false);
  expect(document.documentElement.hasAttribute('data-starting')).toBe(true);
});
