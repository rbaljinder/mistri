import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { AppTarget } from '../../../../engine/src/shared/appLinks.js';
import { AppTargetLink } from './AppTargetLink.js';

const target: AppTarget<string | number> = { app: 'payday', kind: 'home' };
const otherTarget: AppTarget<string | number> = { app: 'payday', kind: 'view', view: 'benefits' };
const label = 'View benefits';
type Result = { href: string } | null;

function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

test('renders only an authorized ordinary anchor with the authored accessible label and inline action styling', async () => {
  const pending = deferred();
  const resolve = vi.fn((_target: AppTarget<string | number>, _signal: AbortSignal) => pending.promise);
  const { container, rerender } = render(
    <AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} className="custom-action" />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(resolve).toHaveBeenCalledWith(target, expect.any(AbortSignal));
  expect(resolve.mock.calls[0][1].aborted).toBe(false);

  await act(async () => {
    pending.resolve({ href: '/apps/payday?tenant=one#benefits' });
  });
  const link = screen.getByRole('link', { name: label });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/apps/payday?tenant=one#benefits');
  expect(link).toHaveClass('dashboard-note-action', 'custom-action');
  expect(screen.queryByRole('button')).toBeNull();

  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
    expect(fireEvent(link, event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  }
  const middleClick = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  expect(fireEvent(link, middleClick)).toBe(true);
  expect(middleClick.defaultPrevented).toBe(false);

  rerender(<AppTargetLink label="Open payroll" target={target} scope="account-1" resolve={resolve} />);
  expect(screen.getByRole('link', { name: 'Open payroll' })).toHaveAttribute('href', '/apps/payday?tenant=one#benefits');
  expect(resolve).toHaveBeenCalledTimes(1);
});

test.each(['deny', 'reject', 'throw'] as const)('%s leaves no link or technical error visible', async (outcome) => {
  const resolve = vi.fn((): Promise<Result> => {
    if (outcome === 'throw') throw new Error('internal tenant lookup failed');
    return outcome === 'deny' ? Promise.resolve(null) : Promise.reject(new Error('internal tenant lookup failed'));
  });
  const { container } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  await act(async () => {});
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(container).toBeEmptyDOMElement();
});

test.each(['scope', 'target'] as const)('clears an existing grant in the %s change render, before passive effects', async (change) => {
  const pending = deferred();
  const resolve = vi.fn().mockResolvedValueOnce({ href: '/old' }).mockReturnValue(pending.promise);
  const observed: boolean[] = [];
  function Surface({ scope, to }: { scope: string; to: AppTarget<string | number> }) {
    useLayoutEffect(() => {
      observed.push(!!screen.queryByRole('link'));
    }, [scope, to]);
    return <AppTargetLink label={label} target={to} scope={scope} resolve={resolve} />;
  }
  const { rerender } = render(<Surface scope="account-1" to={target} />);
  await screen.findByRole('link');
  rerender(<Surface scope={change === 'scope' ? 'account-2' : 'account-1'} to={change === 'target' ? otherTarget : target} />);
  expect(observed).toEqual([false, false]);
  expect(screen.queryByRole('link')).toBeNull();
  expect(resolve.mock.calls[0][1].aborted).toBe(true);
  await act(async () => {
    pending.resolve(null);
  });
  expect(screen.queryByRole('link')).toBeNull();
});

test.each(['scope', 'target'] as const)('ignores late %s responses even after returning to the original identity', async (change) => {
  const first = deferred(),
    second = deferred(),
    third = deferred();
  const resolve = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  const { rerender } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  rerender(
    <AppTargetLink
      label={label}
      target={change === 'target' ? otherTarget : target}
      scope={change === 'scope' ? 'account-2' : 'account-1'}
      resolve={resolve}
    />,
  );
  rerender(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  expect(resolve.mock.calls.map((call) => call[1].aborted)).toEqual([true, true, false]);
  await act(async () => {
    first.resolve({ href: '/stale-first' });
  });
  expect(screen.queryByRole('link')).toBeNull();
  await act(async () => {
    third.resolve({ href: '/current' });
  });
  expect(screen.getByRole('link')).toHaveAttribute('href', '/current');
  await act(async () => {
    second.resolve({ href: '/stale-second' });
  });
  expect(screen.getByRole('link')).toHaveAttribute('href', '/current');
});

test('a late failure cannot clear the newer authorized result', async () => {
  const old = deferred();
  const resolve = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ href: '/current' });
  const { rerender } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  rerender(<AppTargetLink label={label} target={target} scope="account-2" resolve={resolve} />);
  await screen.findByRole('link');
  await act(async () => {
    old.reject(new Error('old request failed'));
  });
  expect(screen.getByRole('link')).toHaveAttribute('href', '/current');
});

test('changing the resolver also invalidates a previous grant', async () => {
  const resolve = vi.fn().mockResolvedValue({ href: '/old' });
  const replacement = vi.fn().mockResolvedValue(null);
  const { rerender } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  await screen.findByRole('link');
  rerender(<AppTargetLink label={label} target={target} scope="account-1" resolve={replacement} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(resolve.mock.calls[0][1].aborted).toBe(true);
  await act(async () => {});
  expect(screen.queryByRole('link')).toBeNull();
});

test.each(['resolve', 'reject'] as const)('unmount aborts and ignores a late %s, with no grant carried into a remount', async (outcome) => {
  const old = deferred(),
    current = deferred();
  const resolve = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const { unmount, container } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  unmount();
  expect(resolve.mock.calls[0][1].aborted).toBe(true);
  render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  await act(async () => {
    if (outcome === 'resolve') old.resolve({ href: '/stale' });
    else old.reject(new Error('unmounted request failed'));
  });
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole('link')).toBeNull();
  await act(async () => {
    current.resolve({ href: '/current' });
  });
  expect(screen.getByRole('link')).toHaveAttribute('href', '/current');
});

test.each([
  '',
  'relative/path',
  'https://example.com/app',
  'http://localhost/app',
  '//example.com/app',
  '///example.com/app',
  'javascript:alert(1)',
  'data:text/html,test',
  '\\example.com',
  '/\\example.com',
  '/path\\next',
  ' /app',
  '\t/app',
  '/path\nnext',
  '/path\rnext',
  '/path\tnext',
  '/path\u0000next',
  '/path\u001fnext',
  '/path\u007fnext',
  '/path\u0085next',
])('rejects unsafe resolver href %j', async (href) => {
  const resolve = vi.fn().mockResolvedValue({ href });
  const { container } = render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test.each(['/', '/apps/payday', '/apps/payday?tenant=one#benefits', '/apps/payday/records/a%20b'])(
  'accepts root-relative href %j',
  async (href) => {
    const resolve = vi.fn().mockResolvedValue({ href });
    render(<AppTargetLink label={label} target={target} scope="account-1" resolve={resolve} />);
    expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', href);
  },
);
