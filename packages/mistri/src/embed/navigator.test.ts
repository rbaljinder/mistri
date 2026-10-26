import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNavigator, memoryNavigator, routerNavigator, walkOf, type Location } from './navigator.js';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('browserNavigator', () => {
  it('keeps the walk under its own key, beside what the host keeps in the entry', () => {
    const navigator = browserNavigator();
    window.history.replaceState({ usr: 'host' }, '', '/crm/leads');
    navigator.replace('/crm/leads?tab=working', { step: 1 });
    expect(window.history.state).toEqual({ usr: 'host', mistri: { step: 1 } });
    expect(navigator.current()).toEqual({ pathname: '/crm/leads', search: '?tab=working', state: { step: 1 } });

    navigator.push('/crm/leads/127', { step: 2 });
    expect(window.history.state).toEqual({ mistri: { step: 2 } });
    expect(window.location.pathname).toBe('/crm/leads/127');
  });

  it('hears Back and Forward, and stops when told', () => {
    const navigator = browserNavigator();
    const heard = vi.fn();
    const stop = navigator.listen(heard);
    window.dispatchEvent(new PopStateEvent('popstate'));
    stop();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reads no walk from an entry the shell did not write', () => {
    expect(walkOf(null)).toBeNull();
    expect(walkOf({ usr: 1 })).toBeNull();
    expect(walkOf({ mistri: { a: 1 } })).toEqual({ a: 1 });
  });
});

/** A router that applies a write only when told to, as a data router does a moment later. */
function lazyRouter(start: Location) {
  let at = start;
  const pending: Location[] = [];
  const moves = {
    read: () => at,
    push: vi.fn((href: string, entry: Record<string, unknown>) => {
      const url = new URL(href, 'http://x');
      pending.push({ pathname: url.pathname, search: url.search, state: entry });
    }),
    replace: vi.fn(),
  };
  return {
    moves,
    settle: () => (at = pending.shift() ?? at),
    hostGoes: (to: Location) => (at = to),
  };
}

describe('routerNavigator', () => {
  it('says the address it wrote until the router has caught up, and does not hear its own write', () => {
    const router = lazyRouter({ pathname: '/crm/leads', search: '', state: null });
    const navigator = routerNavigator(router.moves);
    const heard = vi.fn();
    navigator.listen(heard);

    navigator.push('/crm/leads/127?x=1', { step: 2 });
    expect(router.moves.push).toHaveBeenCalledWith('/crm/leads/127?x=1', { mistri: { step: 2 } });
    expect(navigator.current()).toEqual({ pathname: '/crm/leads/127', search: '?x=1', state: { step: 2 } });

    router.settle();
    navigator.hostMoved();
    expect(heard).not.toHaveBeenCalled();
  });

  it('hears a move of the host’s once, however many times the router reports it', () => {
    const router = lazyRouter({ pathname: '/crm/leads', search: '', state: null });
    const navigator = routerNavigator(router.moves);
    const heard = vi.fn();
    navigator.listen(heard);

    router.hostGoes({ pathname: '/crm/accounts', search: '', state: null });
    navigator.hostMoved();
    navigator.hostMoved();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(navigator.current().pathname).toBe('/crm/accounts');

    router.hostGoes({ pathname: '/crm/leads', search: '', state: null });
    navigator.hostMoved();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('memoryNavigator', () => {
  it('keeps its own entries and never writes the address bar', () => {
    const navigator = memoryNavigator('/compass/leads?tab=working');
    navigator.push('/compass/leads/127', { step: 1 });
    expect(navigator.current()).toEqual({ pathname: '/compass/leads/127', search: '', state: { step: 1 } });
    navigator.replace('/compass/leads/127?tab=notes', { step: 2 });
    expect(navigator.current().search).toBe('?tab=notes');
    expect(window.location.pathname).toBe('/');
  });

  it('turns a push down and sends the shell back to where it was', async () => {
    const navigator = memoryNavigator('/compass/leads', { refuse: (href) => href.includes('/127') });
    const heard = vi.fn();
    navigator.listen(heard);
    navigator.push('/compass/leads/127', null);
    expect(navigator.current().pathname).toBe('/compass/leads');
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('moves when the surface’s props do', () => {
    const navigator = memoryNavigator('/compass/leads');
    const heard = vi.fn();
    navigator.listen(heard);
    navigator.push('/compass/leads/127', null);
    navigator.reset('/compass/leads?tab=lost');
    expect(navigator.current()).toEqual({ pathname: '/compass/leads', search: '?tab=lost', state: null });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
