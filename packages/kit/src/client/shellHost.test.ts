/**
 * Served, every seam in shellHost.ts and transport.ts is exactly the global
 * it stands for: the shell behaves as it did before they existed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addHostListener,
  navFollow,
  navPush,
  navReplace,
  navState,
  onNavigate,
  popupContainer,
  portalRoot,
  removeHostListener,
  setTabTitle,
  shellBody,
  shellById,
  shellQuery,
  shellQueryAll,
  shellRoot,
} from './shellHost.js';
import { fetchServer } from './transport.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the shell host, served', () => {
  it('is the page itself: <html>, <body>, and Base UI left to choose', () => {
    expect(shellRoot()).toBe(document.documentElement);
    expect(shellBody()).toBe(document.body);
    expect(portalRoot()).toBe(document.body);
    expect(popupContainer()).toBeUndefined();
  });

  it('looks ids and selectors up in the document', () => {
    document.body.innerHTML = '<main id="content"><p class="note">a</p><p class="note">b</p></main>';
    expect(shellById('content')).toBe(document.getElementById('content'));
    expect(shellQuery('.note')?.textContent).toBe('a');
    expect([...shellQueryAll('.note')].map((node) => node.textContent)).toEqual(['a', 'b']);
  });

  it('writes the tab title', () => {
    setTabTitle('Leads · Compass');
    expect(document.title).toBe('Leads · Compass');
  });

  it('puts a listener on the target it names, and its remover takes it off', () => {
    const heard = vi.fn();
    const off = addHostListener(document, 'keydown', heard, true);
    document.dispatchEvent(new KeyboardEvent('keydown'));
    off();
    document.dispatchEvent(new KeyboardEvent('keydown'));
    addHostListener(window, 'resize', heard);
    removeHostListener(window, 'resize', heard);
    window.dispatchEvent(new Event('resize'));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps the walk in the history entry it writes', () => {
    const walk = { trail: '/leads/127', labels: ['Leads', 'Ada'] };
    navPush('/leads/127', walk);
    expect(window.location.pathname).toBe('/leads/127');
    expect(navState()).toEqual(walk);
    navReplace('/leads');
    expect(window.location.pathname).toBe('/leads');
    expect(navState()).toBeNull();
  });

  it('follows an address by writing it and telling the navigation listener', () => {
    const painted: string[] = [];
    const off = onNavigate(() => painted.push(window.location.pathname));
    navFollow('/accounts/13');
    off();
    navFollow('/accounts/14');
    expect(painted).toEqual(['/accounts/13']);
  });

  it('sends a request to the server path, with the init it was given', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const init = { credentials: 'same-origin' as const };
    await fetchServer('/api/whoami', init);
    expect(fetch).toHaveBeenCalledWith('/api/whoami', init);
  });
});
