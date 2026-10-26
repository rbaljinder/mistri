import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The three routers are the host's and are not installed here: each is a
 * stand-in with the few calls its adapter makes, so what is tested is the
 * adapter's half — what it writes, and when it tells the shell.
 */
const reactRouter = vi.hoisted(() => ({
  location: { pathname: '/crm/leads', search: '', state: null as unknown, key: 'a' },
  navigate: vi.fn(),
}));
vi.mock('react-router', () => ({
  useNavigate: () => reactRouter.navigate,
  useLocation: () => reactRouter.location,
}));

const tanstack = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    history: {
      location: { pathname: '/crm/leads', search: '', state: { key: 'k' } as unknown },
      push: vi.fn(),
      replace: vi.fn(),
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
});
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: tanstack.history }) }));

const next = vi.hoisted(() => ({ pathname: '/crm/leads', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => next.pathname,
  useSearchParams: () => new URLSearchParams(next.search),
}));

const { useReactRouterNavigator } = await import('./react-router.js');
const { useTanStackNavigator } = await import('./tanstack-router.js');
const { useNextNavigator } = await import('./next.js');

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('React Router', () => {
  it('writes with navigate, the walk beside the router’s state, and tells the shell of a move that was not its own', () => {
    const { result, rerender } = renderHook(() => useReactRouterNavigator());
    const heard = vi.fn();
    result.current.listen(heard);

    result.current.push('/crm/leads/127', { step: 1 });
    expect(reactRouter.navigate).toHaveBeenCalledWith('/crm/leads/127', { state: { mistri: { step: 1 } } });
    // Until the router has applied it, the shell reads back the address it wrote.
    expect(result.current.current()).toMatchObject({ pathname: '/crm/leads/127', state: { step: 1 } });

    reactRouter.location = { pathname: '/crm/leads/127', search: '', state: { mistri: { step: 1 } }, key: 'b' };
    rerender();
    expect(heard).not.toHaveBeenCalled();

    reactRouter.location = { pathname: '/crm/accounts', search: '', state: { usr: 1 }, key: 'c' };
    rerender();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(result.current.current()).toEqual({ pathname: '/crm/accounts', search: '', state: null });

    result.current.replace('/crm/accounts?tab=all', { step: 2 });
    expect(reactRouter.navigate).toHaveBeenLastCalledWith('/crm/accounts?tab=all', {
      replace: true,
      state: { usr: 1, mistri: { step: 2 } },
    });
  });
});

describe('TanStack Router', () => {
  it('writes through the router’s history and hears it through its subscription', () => {
    const { result } = renderHook(() => useTanStackNavigator());
    const heard = vi.fn();
    result.current.listen(heard);

    result.current.replace('/crm/leads?tab=new', { step: 1 });
    expect(tanstack.history.replace).toHaveBeenCalledWith('/crm/leads?tab=new', { key: 'k', mistri: { step: 1 } });

    tanstack.history.location = { pathname: '/crm/accounts', search: '', state: { key: 'j' } };
    act(() => {
      for (const fn of tanstack.listeners) fn();
    });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('Next', () => {
  it('writes the window’s history, which the App Router follows, and hears a Link through usePathname', () => {
    const { result, rerender } = renderHook(() => useNextNavigator());
    const heard = vi.fn();
    result.current.listen(heard);

    result.current.push('/crm/leads/127', { step: 1 });
    expect(window.location.pathname).toBe('/crm/leads/127');
    expect(window.history.state).toEqual({ mistri: { step: 1 } });
    next.pathname = '/crm/leads/127';
    rerender();
    expect(heard).not.toHaveBeenCalled();

    window.history.pushState({ __NA: true }, '', '/crm/accounts');
    next.pathname = '/crm/accounts';
    rerender();
    // Its popstate and its pathname may both report one move; the shell hears it once.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
