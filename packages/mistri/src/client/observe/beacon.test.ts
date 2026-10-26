/*
 * The beacon sends the page's web vitals to the dev observer as `vital`
 * reports, with the web-vitals library's semantics: LCP final at the first
 * input or when the page is hidden, CLS as the worst session window of shifts
 * without recent input, INP as the slowest interaction.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Entry = Record<string, unknown>;
const observers = new Map<string, (entries: Entry[]) => void>();

beforeEach(() => {
  observers.clear();
  document.head.innerHTML = '<meta name="mistri-observe" content="/_mistri/observe/">';
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(private readonly callback: (list: { getEntries(): Entry[] }) => void) {}
      observe(options: { type: string }) {
        observers.set(options.type, (entries) => this.callback({ getEntries: () => entries }));
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const reports = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

test('LCP, CLS and INP are reported as vitals when the page is hidden, each once', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const { startBeacon } = await import('./beacon.js');
  startBeacon();
  const hero = document.createElement('h1');
  hero.className = 'page-title';
  document.body.append(hero);
  observers.get('largest-contentful-paint')!([{ startTime: 480, element: hero }]);
  // Two shifts in one window (0.05 + 0.04), a third alone after a gap: CLS is the worse window.
  observers.get('layout-shift')!([
    { startTime: 100, value: 0.05, hadRecentInput: false },
    { startTime: 400, value: 0.04, hadRecentInput: false },
    { startTime: 3000, value: 0.06, hadRecentInput: false },
    { startTime: 3100, value: 0.5, hadRecentInput: true },
  ]);
  const button = document.createElement('button');
  observers.get('event')!([
    { interactionId: 7, name: 'pointerdown', duration: 64, target: button },
    { interactionId: 7, name: 'click', duration: 120, target: button },
    { interactionId: 8, name: 'keydown', duration: 48, target: button },
    { name: 'mousemove', duration: 300 },
  ]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('visibilitychange'));
  const vitals = reports(fetch).filter((report) => report.kind === 'vital');
  expect(vitals.map((report) => [report.name, report.value])).toEqual([
    ['LCP', 480],
    ['CLS', 0.09],
    ['INP', 120],
  ]);
  expect(vitals[0].sources).toEqual([{ node: 'h1.page-title' }]);
  expect(vitals[2].sources).toEqual([{ node: 'click on button' }]);
  Reflect.deleteProperty(document, 'visibilityState');
});
