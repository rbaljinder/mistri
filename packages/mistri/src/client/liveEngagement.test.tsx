/** A list the reader is working in holds still behind a pill, and is shown its changes when they stop. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryObserver } from '@tanstack/react-query';
import { state } from '../../../kit/src/client/core.js';
import { queryClient } from '../../../kit/src/client/components/mount.js';
import { fileReads } from '../../../kit/src/client/liveReads.js';
import { fileQueryReads } from '../../../kit/src/client/liveReads.js';
import { addChange, emptyBatch, forgetLive, invalidateLive } from './liveInvalidate.js';
import { watchEngagement } from './liveEngagement.js';
import { resetLiveState, setLiveActive, useListHold } from '../../../kit/src/client/liveState.js';

let stop: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

function Probe() {
  const { held, show } = useListHold({ table: 'job', owns: (key) => key[0] === 'count' });
  return (
    <button type="button" onClick={show}>
      {held === 0 ? 'none' : `held ${held}`}
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  state.activeConnection = 'spoke';
  document.body.innerHTML =
    '<div class="content"><table><tbody><tr><td><input type="checkbox" class="row-select"></td></tr></tbody></table></div>';
  setLiveActive(true);
  stop = watchEngagement();
  /* The cache files what an answer says it read, as the page's own client does. */
  queryClient.getQueryCache().config.onSuccess = fileQueryReads;
});
afterEach(() => {
  cleanup();
  unsubscribe?.();
  stop?.();
  forgetLive();
  resetLiveState();
  queryClient.clear();
  vi.useRealTimers();
});

async function counting() {
  const asked = vi.fn();
  const observer = new QueryObserver(queryClient, {
    queryKey: ['count', 'spoke', 'jobs'],
    staleTime: Infinity,
    queryFn: () => {
      asked();
      const answer = { n: asked.mock.calls.length };
      fileReads(answer, 'job');
      return answer;
    },
  });
  unsubscribe = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  return asked;
}
const told = () => {
  const batch = emptyBatch();
  addChange(batch, { tables: { job: { keys: [{ id: 1 }], kinds: ['update'] } } });
  invalidateLive(batch, queryClient);
};
const select = (on: boolean) => {
  document.querySelector<HTMLInputElement>('input.row-select')!.checked = on;
};

test('a list with a row selected is held, says so once, and is shown when the selection ends and two seconds pass', async () => {
  const asked = await counting();
  render(<Probe />);
  select(true);
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_500));
  expect(asked).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button')).toHaveTextContent('held 1');
  select(false);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(asked).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(2_500));
  expect(asked).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button')).toHaveTextContent('none');
});

test('Show refreshes at once', async () => {
  const asked = await counting();
  render(<Probe />);
  select(true);
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(10));
  await act(async () => screen.getByRole('button').click());
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(asked).toHaveBeenCalledTimes(2);
});

test('a pointer over the rows holds the list for three seconds, a pointer elsewhere does not', async () => {
  const asked = await counting();
  render(<Probe />);
  document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_200));
  expect(asked).toHaveBeenCalledTimes(2);
  document.querySelector('tbody tr')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_200));
  expect(asked).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(6_000));
  expect(asked).toHaveBeenCalledTimes(3);
});

test('an open row menu or a list paged past its first page holds the list; a closed menu the shell keeps mounted does not', async () => {
  const asked = await counting();
  render(<Probe />);
  const closed = document.createElement('div');
  closed.setAttribute('role', 'menu');
  closed.setAttribute('data-closed', '');
  document.body.append(closed);
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_200));
  expect(asked).toHaveBeenCalledTimes(2);
  closed.remove();
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_200));
  expect(asked).toHaveBeenCalledTimes(2);
  menu.remove();
  await act(() => vi.advanceTimersByTimeAsync(4_000));
  expect(asked).toHaveBeenCalledTimes(3);
  (state as { page?: number }).page = 2;
  await act(async () => told());
  await act(() => vi.advanceTimersByTimeAsync(1_200));
  expect(asked).toHaveBeenCalledTimes(3);
  (state as { page?: number }).page = 0;
});
