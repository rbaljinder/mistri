/**
 * A tab coming back to the front re-reads what is older than a minute and
 * the record on screen, not every query on the page: a dashboard used to
 * re-run all its aggregates on every alt-tab.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { focusManager, useQuery } from '@tanstack/react-query';
import { FOCUS_ALWAYS, mount, queryClient, unmountAll } from './mount.js';

afterEach(() => {
  cleanup();
  unmountAll();
  queryClient.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

function Reader({ name, read, always = false }: { name: string; read: () => Promise<number>; always?: boolean }) {
  const found = useQuery({ queryKey: ['focus-test', name], queryFn: read, ...(always ? { meta: FOCUS_ALWAYS } : {}) });
  return createElement('span', null, String(found.data ?? ''));
}

test('focus re-reads the record on screen and data older than a minute, nothing younger', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const tile = vi.fn(async () => 1),
    record = vi.fn(async () => 2);
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    mount(host, [
      createElement(Reader, { key: 't', name: 'tile', read: tile }),
      createElement(Reader, { key: 'r', name: 'record', read: record, always: true }),
    ]);
  });
  await waitFor(() => expect(host.textContent).toBe('12'));
  expect([tile.mock.calls.length, record.mock.calls.length]).toEqual([1, 1]);

  // Ten seconds on: stale by the five-second rule, still too young to re-read.
  vi.setSystemTime(Date.now() + 10_000);
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  expect(tile).toHaveBeenCalledTimes(1);

  // Past a minute, the tile is re-read too.
  vi.setSystemTime(Date.now() + 61_000);
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(tile).toHaveBeenCalledTimes(2));
  host.remove();
});
