import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createAnalyticsBeacon } from '../../analyticsBeacon.js';
import { renderSection } from './testing.js';
import { useAnalytics } from './hooks.js';

afterEach(cleanup);

function Compare() {
  const analytics = useAnalytics();
  return <button onClick={() => analytics.emit('compare-opened', { vehicleId: 'v-9' })}>Compare</button>;
}

test('a component emits a declared event from a handler, and nothing is emitted by rendering', () => {
  const emitted: { name: string; fields?: Readonly<Record<string, string | number | boolean>> }[] = [];
  renderSection(Compare, { component: { id: 'compare' } }, { analytics: emitted });
  expect(emitted).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(emitted).toEqual([{ name: 'compare-opened', fields: { vehicleId: 'v-9' } }]);
});

test('the beacon batches events, sends how long ago each happened and never an identity', () => {
  vi.useFakeTimers();
  try {
    let clock = 1000;
    const sent: string[] = [];
    const beacon = createAnalyticsBeacon({
      send: (body) => {
        sent.push(body);
      },
      now: () => clock,
      delayMs: 1500,
    });
    beacon.emit('compare-opened', { vehicleId: 'v-9' });
    clock += 400;
    beacon.view('vehicles', '/vehicles/:id');
    expect(sent).toEqual([]);
    clock += 1100;
    vi.advanceTimersByTime(1500);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      events: [
        { kind: 'event', name: 'compare-opened', fields: { vehicleId: 'v-9' }, age: 1500 },
        { kind: 'view', name: 'vehicles', route: '/vehicles/:id', age: 1100 },
      ],
    });
    expect(() => beacon.emit('')).toThrow();
    beacon.emit('x');
    beacon.flush();
    beacon.flush();
    expect(sent).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
