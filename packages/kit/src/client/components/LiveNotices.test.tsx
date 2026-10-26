/** Where a change from elsewhere is said: the pill, the line under a record, the notice over a draft, the row's tint. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { LiveEditNotice, LivePill, LiveUpdatedLine, resetChangedBy } from './LiveNotices.js';
import { queryClient } from './mount.js';
import { QueryClientProvider } from '@tanstack/react-query';
import { announcePulse, noteRecentChanges, raiseEditNotice, resetLiveState, useChangedRows } from '../liveState.js';

const api = vi.hoisted(() => vi.fn());
vi.mock('../core.js', async (original) => ({ ...(await original<typeof import('../core.js')>()), api }));

const job = { id: 'job', name: 'Job', columns: [] } as unknown as TableMeta;
const key = { id: 7 };
const draw = (node: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ entries: [{ by: 'Ana Ruiz' }] });
});
afterEach(() => {
  cleanup();
  resetLiveState();
  resetChangedBy();
  queryClient.clear();
  vi.useRealTimers();
});

test('the pill counts what is held and shows it on click', async () => {
  const show = vi.fn();
  render(<LivePill held={3} show={show} />);
  await userEvent.click(screen.getByRole('button', { name: 'Show the updates' }));
  expect(show).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button')).toHaveTextContent('3 updates · Show');
  cleanup();
  render(<LivePill held="many" show={show} />);
  expect(screen.getByRole('button')).toHaveTextContent('Updates · Show');
});

test('a record changed by another person says who, when the history names them', async () => {
  const { liveKeyText } = await import('../liveState.js');
  noteRecentChanges('job', [liveKeyText(key)], false);
  draw(<LiveUpdatedLine table={job} recordKey={key} />);
  expect(await screen.findByText('Updated by Ana Ruiz just now')).toBeInTheDocument();
});

test('with no readable name the line is neutral, and an email is never said', async () => {
  const { liveKeyText } = await import('../liveState.js');
  api.mockResolvedValue({ entries: [{ by: 'ana@example.com' }] });
  noteRecentChanges('job', [liveKeyText(key)], false);
  draw(<LiveUpdatedLine table={job} recordKey={key} />);
  expect(await screen.findByText('Updated just now')).toBeInTheDocument();
  expect(screen.queryByText(/ana@example/)).toBeNull();
});

test('the reader\'s own change in another tab says "you", and the line leaves after ten minutes', async () => {
  vi.useFakeTimers();
  const { liveKeyText } = await import('../liveState.js');
  noteRecentChanges('job', [liveKeyText(key)], true);
  draw(<LiveUpdatedLine table={job} recordKey={key} />);
  expect(screen.getByText('Updated by you just now')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(3 * 60_000));
  expect(screen.getByText('Updated by you 3 minutes ago')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(8 * 60_000));
  expect(screen.queryByText(/Updated/)).toBeNull();
});

test('while the reader has a draft of the record the line is not drawn: the notice over the draft says it', async () => {
  const { liveKeyText } = await import('../liveState.js');
  const { activateDraft, discardStaged, stage } = await import('../write.js');
  noteRecentChanges('job', [liveKeyText(key)], false);
  draw(<LiveUpdatedLine table={job} recordKey={key} />);
  expect(await screen.findByText('Updated by Ana Ruiz just now')).toBeInTheDocument();
  const name = { name: 'name', type: 'TEXT', nullable: true, primaryKey: false } as TableMeta['columns'][number];
  act(() => {
    activateDraft(job, key);
    stage(job, key, name, 'Typed', 'Before');
  });
  expect(screen.queryByText(/Updated/)).toBeNull();
  act(() => discardStaged());
  expect(screen.getByText('Updated by Ana Ruiz just now')).toBeInTheDocument();
});

test('the notice over a draft names the author, offers Review and Keep editing, and Keep editing leaves the draft alone', async () => {
  const { liveKeyText } = await import('../liveState.js');
  raiseEditNotice({ table: 'job', key: liveKeyText(key), kind: 'update', self: false });
  draw(<LiveEditNotice table={job} recordKey={key} />);
  expect(await screen.findByText('Ana Ruiz changed this job')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review changes' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByText(/changed this/)).toBeNull();
});

test('each change under a draft is named by its own author, not the one before it', async () => {
  const { liveKeyText } = await import('../liveState.js');
  raiseEditNotice({ table: 'job', key: liveKeyText(key), kind: 'update', self: false, at: 1_000 });
  draw(<LiveEditNotice table={job} recordKey={key} />);
  expect(await screen.findByText('Ana Ruiz changed this job')).toBeInTheDocument();
  api.mockResolvedValue({ entries: [{ by: 'Bo Chen' }] });
  act(() => raiseEditNotice({ table: 'job', key: liveKeyText(key), kind: 'update', self: false, at: 2_000 }));
  /* Within the second the first was read in, so read when that second is out. */
  expect(await screen.findByText('Bo Chen changed this job', undefined, { timeout: 2_000 })).toBeInTheDocument();
  expect(api).toHaveBeenLastCalledWith('/api/record-history', { table: 'job', key, limit: 1 });
});

test('a record changing several times a second has its author read at most once a second, the first change at once', async () => {
  vi.useFakeTimers();
  const { liveKeyText } = await import('../liveState.js');
  const change = () => act(() => noteRecentChanges('job', [liveKeyText(key)], false, Date.now()));
  await change();
  draw(<LiveUpdatedLine table={job} recordKey={key} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  /* The first change is read at once. */
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Updated by Ana Ruiz just now')).toBeInTheDocument();
  api.mockResolvedValue({ entries: [{ by: 'Bo Chen' }] });
  /* Four changes in the next second: none read until the second is out, then one read, for the newest. */
  for (let n = 0; n < 3; n++) {
    await act(() => vi.advanceTimersByTimeAsync(250));
    await change();
  }
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(api).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(api).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Updated by Bo Chen just now')).toBeInTheDocument();
  /* Ten seconds of a change every 250 ms: one read a second. */
  for (let n = 0; n < 40; n++) {
    await act(() => vi.advanceTimersByTimeAsync(250));
    await change();
  }
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(api.mock.calls.length).toBeGreaterThanOrEqual(11);
  expect(api.mock.calls.length).toBeLessThanOrEqual(13);
  /* Quiet for a while, the next change is read at once again. */
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  const before = api.mock.calls.length;
  await change();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(api).toHaveBeenCalledTimes(before + 1);
});

test('a record whose history the reader may not read (or that keeps none) is changed by "someone"', async () => {
  const { liveKeyText } = await import('../liveState.js');
  api.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
  raiseEditNotice({ table: 'job', key: liveKeyText(key), kind: 'update', self: false });
  draw(<LiveEditNotice table={job} recordKey={key} />);
  expect(await screen.findByText('Someone changed this job')).toBeInTheDocument();
});

test('a deleted record offers no review, only to keep editing', async () => {
  const { liveKeyText } = await import('../liveState.js');
  raiseEditNotice({ table: 'job', key: liveKeyText(key), kind: 'delete', self: false });
  draw(<LiveEditNotice table={job} recordKey={key} />);
  expect(await screen.findByText(/deleted this job/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
});

test('a row an announced change named, and whose answer differs, wears a tint; a page turned to does not', () => {
  const a = { id: 1, status: 'open' };
  const b = { id: 2, status: 'open' };
  const keyOf = (row: { id: number }) => ({ id: row.id });
  const { result, rerender } = renderHook(({ rows }) => useChangedRows('job', rows, keyOf), { initialProps: { rows: [a, b] } });
  expect(result.current.size).toBe(0);
  announcePulse({ id: 1, at: Date.now(), tables: new Map([['job', new Set(['{"id":"2"}'])]]) });
  const a2 = { ...a, status: 'done' };
  const b2 = { ...b, status: 'done' };
  rerender({ rows: [a2, b2] });
  expect([...result.current.keys()]).toEqual([b2]);
  /* Rows a change did not name (a sort, a page) are never tinted, however different they are. */
  rerender({ rows: [{ id: 3, status: 'x' }] });
  expect(result.current.size).toBe(0);
});

test('a list that gathers the same rows into a new array (a board) keeps a fresh tint until the next change', () => {
  const keyOf = (row: { id: number }) => ({ id: row.id });
  const a = { id: 1, status: 'open' };
  const { result, rerender } = renderHook(({ rows }) => useChangedRows('job', rows, keyOf), { initialProps: { rows: [a] } });
  announcePulse({ id: 3, at: Date.now(), tables: new Map([['job', new Set(['{"id":"1"}'])]]) });
  const a2 = { ...a, status: 'done' };
  rerender({ rows: [a2] });
  expect(result.current.get(a2)).toBe(1);
  rerender({ rows: [a2] });
  expect(result.current.get(a2)).toBe(1);
  /* The next change to another row leaves this one as it is: its tint was the last change's. */
  announcePulse({ id: 4, at: Date.now(), tables: new Map([['job', new Set(['{"id":"9"}'])]]) });
  rerender({ rows: [a2] });
  expect(result.current.size).toBe(0);
});

test('the tint is drawn only where motion is welcome, and over --t-changed', () => {
  const css = readFileSync('packages/kit/src/client/style.css', 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  :is(tr.row-changed-1'));
  expect(block.slice(0, block.indexOf('\n}\n'))).toMatch(/animation: row-changed-1 var\(--t-changed\)/);
  expect(css.match(/tr\.row-changed-1/g)).toHaveLength(1);
  /* A grid's cells and every other list's row (a card, a queue's row, a board's card) wear the same fade. */
  expect(block).toMatch(/\.row-changed-1:not\(tr\)/);
  expect(block).toMatch(/color-mix\(in srgb, var\(--changed-hue\) var\(--changed-mix\), var\(--surface\)\)/);
});
