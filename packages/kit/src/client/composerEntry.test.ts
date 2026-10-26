/** A cold link restores its walk after the schema; readiness has no timer deadline. */
import { afterEach, expect, test, vi } from 'vitest';

const model = vi.hoisted(() => ({
  state: { schema: {} },
  entry: undefined as undefined | { kind: string; table: string; tab: string },
  listeners: new Set<() => void>(),
  loaded: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('./core.js', () => ({
  state: model.state,
  currentEntry: () => model.entry,
  subscribeWalk: (listener: () => void) => {
    model.listeners.add(listener);
    return () => model.listeners.delete(listener);
  },
}));
vi.mock('./menu.js', () => ({ addMenuItem: vi.fn() }));
vi.mock('./components/onDemand.js', () => ({ sayUnavailable: vi.fn() }));
vi.mock('./composer.js', () => {
  model.loaded();
  return { sync: model.sync };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a restored composer walk opens after schema readiness without a click or polling deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  await import('./composerEntry.js');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(model.loaded).not.toHaveBeenCalled();

  model.entry = { kind: 'table', table: 'invoice', tab: 'view' };
  for (const listener of model.listeners) listener();
  expect(model.sync).not.toHaveBeenCalled(); // never mount inside core's synchronous paint
  await vi.runAllTimersAsync();
  await vi.dynamicImportSettled();
  expect(model.loaded).toHaveBeenCalledTimes(1);
  expect(model.sync).toHaveBeenCalledTimes(1);

  model.entry = { kind: 'table', table: 'invoice', tab: 'rows' };
  for (const listener of model.listeners) listener();
  await vi.runAllTimersAsync();
  expect(model.sync).toHaveBeenCalledTimes(2);
  expect(model.loaded).toHaveBeenCalledTimes(1);
});
