/**
 * What `@mistriwork/mistri/ui` gives a free-form page to say a read and a figure with: `useFormat` says money as the
 * display rules do (exact, minor units, whole, compact) and a moment in a named zone, and `<Loaded>` draws a read's
 * states before its drawing as every section does.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { appNow } from '@mistriwork/kit/client/locale.js';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { useFormat } from './hooks.js';
import { Loaded } from './kit.js';

afterEach(cleanup);

test('money is exact past 2^53, and reads minor units, whole figures and a compact glance as a display rule does', () => {
  const format = useFormat();
  expect(format.money('90071992547409931.25', 'USD')).toBe('$90,071,992,547,409,931.25');
  expect(format.money('1999', { currency: 'USD', minor: true })).toBe('$19.99');
  expect(format.money('9007199254740993', { currency: 'USD', minor: true })).toBe('$90,071,992,547,409.93');
  expect(format.money(24495, { currency: 'USD', whole: true })).toBe('$24,495');
  expect(format.money('24495.50', { currency: 'USD', whole: true })).toBe('$24,495.50');
  expect(format.money(27_900, { currency: 'USD', compact: true })).toBe('$27.9K');
  expect(format.money(999, { currency: 'USD', compact: true })).toBe('$999.00');
  expect(format.money(1999, { currency: 'JPY', minor: true })).toBe('¥1,999');
});

test('a moment is said in a named zone with its name, and as the App clock says it without one', () => {
  const format = useFormat();
  expect(format.dateTime('2026-09-04T21:30:00Z', { timezone: 'America/Los_Angeles' })).toBe('Sep 4, 2026, 2:30 PM PDT');
  expect(format.dateTime('2026-09-04T21:30:00Z', { timezone: 'Asia/Tokyo' })).toBe('Sep 5, 2026, 6:30 AM GMT+9');
  expect(format.dateTime('2026-09-04 21:30')).toBe(format.dateTime('2026-09-04 21:30', {}));
});

test('a short moment is the fewest characters, in a named zone as without one', () => {
  const format = useFormat();
  const spaced = (text: string) => text.replace(/[\s\u202f\u00a0]+/g, ' ');
  expect(spaced(format.dateTime('2026-09-04 21:30:15', { style: 'short' }))).toBe('9/4/26, 9:30 PM');
  expect(spaced(format.dateTime('2026-09-04T21:30:00Z', { timezone: 'America/Los_Angeles', style: 'short' }))).toBe('9/4/26, 2:30 PM PDT');
});

test("a page reckons the App's day in the App's zone, and in the reader's own where the App names none", () => {
  installShell({ format: () => ({ locale: 'en-US', timezone: 'America/Denver' }) });
  expect(useFormat().timezone).toBe('America/Denver');
  installShell({ format: () => ({ locale: 'en-US' }) });
  expect(useFormat().timezone).toBeUndefined();
});

test("a page's today follows the clock offset a development server runs as of, and the real clock without one", () => {
  const asOf = Date.UTC(2026, 0, 5, 12);
  installShell({ format: () => ({ locale: 'en-US', timezone: 'UTC', clockOffset: asOf - Date.now() }) });
  expect(Math.abs(appNow().getTime() - asOf)).toBeLessThan(60_000);
  expect(useFormat().relative('2026-01-04')).toBe('yesterday');
  expect(useFormat().relative('2026-01-05')).toBe('today');
  expect(useFormat().relative('2026-01-06')).toBe('tomorrow');
  installShell({ format: () => ({ locale: 'en-US', timezone: 'UTC' }) });
  expect(Math.abs(appNow().getTime() - Date.now())).toBeLessThan(1000);
  expect(useFormat().relative('2026-01-05')).not.toBe('today');
});

const query = <T,>(state: { data?: T; isError?: boolean; error?: Error | null }) => ({
  data: state.data,
  isError: state.isError ?? false,
  error: state.error ?? null,
  refetch: vi.fn(),
});

test('while a read is asked, the platform placeholder holds the size the drawing will take', () => {
  const drawn = vi.fn(() => <p>rows</p>);
  render(
    <Loaded query={query<string[]>({})} height={120}>
      {drawn}
    </Loaded>,
  );
  const holding = screen.getByRole('status');
  expect(holding.classList.contains('sk-bar')).toBe(true);
  expect(holding.style.blockSize).toBe('120px');
  expect(drawn).not.toHaveBeenCalled();
});

test('no rows and no record are the house empty note, or the one the page gives', () => {
  const { rerender } = render(<Loaded query={query<string[]>({ data: [] })}>{() => <p>rows</p>}</Loaded>);
  expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  rerender(
    <Loaded query={query<string | null>({ data: null })} empty={<p>No payments yet</p>}>
      {() => <p>rows</p>}
    </Loaded>,
  );
  expect(screen.getByText('No payments yet')).toBeTruthy();
  expect(screen.queryByText('rows')).toBeNull();
});

test('a read that failed says so with Try again, which asks it again and holds focus when nothing else did', () => {
  const failed = query<string[]>({ isError: true, error: new Error('The ledger could not be read.') });
  render(<Loaded query={failed}>{() => <p>rows</p>}</Loaded>);
  expect(screen.getByRole('alert').textContent).toContain('The ledger could not be read.');
  const retry = screen.getByRole('button', { name: 'Try again' });
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(failed.refetch).toHaveBeenCalled();
});

test('what was read stays drawn when a later refresh fails', () => {
  render(
    <Loaded query={query({ data: ['a', 'b'], isError: true, error: new Error('Offline') })}>{(rows) => <p>{rows.join(' ')}</p>}</Loaded>,
  );
  expect(screen.getByText('a b')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
