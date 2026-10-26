import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationList, type ConversationSummary } from './ConversationList.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { configureSessionLifecycle } from '../../../../kit/src/client/sessionLifecycle.js';
import { setAppRequestScope } from '../../../../kit/src/client/requestIdentity.js';
import { state } from '../../../../kit/src/client/core.js';
import { installShell } from '../../../../kit/src/client/shellMode.js';

const now = new Date(2026, 9, 7, 15, 0, 0);
const at = (days: number, hours = 0, minutes = 0) =>
  new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000 - minutes * 60_000).toISOString();
const conversations: ConversationSummary[] = [
  { id: 'a', title: 'Stale deals this quarter', updatedAt: at(0, 0, 2) },
  { id: 'b', title: 'Pipeline by stage', updatedAt: at(0, 3), state: 'awaiting' },
  { id: 'c', title: 'New leads this week', updatedAt: at(1) },
  { id: 'd', title: 'Bronwyn’s accounts', updatedAt: at(4) },
  { id: 'e', title: 'Quarterly forecast', updatedAt: at(40) },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' } });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'compass' });
  setAppRequestScope(true);
  state.activeConnection = 'compass';
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).startsWith('/api/assistant/search'))
      return json({
        conversations: [{ id: 'd', title: 'Bronwyn’s accounts', updatedAt: at(4), snippet: '…owns three accounts in Ohio, all renewing…' }],
      });
    return json({ error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.activeConnection = null;
});

function draw(props: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onNew: vi.fn(), onRename: vi.fn(async () => {}), onDelete: vi.fn(async () => {}) };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConversationList app="compass" conversations={conversations} current="a" now={now} {...handlers} {...props} />
    </QueryClientProvider>,
  );
  return handlers;
}
const headings = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
const titlesUnder = (name: string) =>
  within(screen.getByRole('region', { name }))
    .getAllByRole('button', { name: /./ })
    .filter((button) => button.classList.contains('assistant-conv-open'))
    .map((button) => button.querySelector('.assistant-conv-title')!.textContent);

test('what waits for the person comes first, then the rest by the day it was last touched, each with its day', () => {
  draw();
  expect(headings()).toEqual(['Waiting for you', 'Today', 'Yesterday', 'Earlier this week', 'Older']);
  expect(titlesUnder('Waiting for you')).toEqual(['Pipeline by stage']);
  expect(titlesUnder('Today')).toEqual(['Stale deals this quarter']);
  expect(titlesUnder('Earlier this week')).toEqual(['Bronwyn’s accounts']);
  expect(screen.getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
  // Today, Yesterday, a weekday within the week (Wednesday the 7th, four days on from Saturday), then the date.
  const when = [...document.querySelectorAll('.assistant-conv-when')].map((each) => each.textContent);
  expect(when).toEqual(['Today', 'Today', 'Yesterday', 'Sat', 'Aug 28']);
  // A title too long for its line is there whole on the pointer.
  expect(screen.getByText('Bronwyn’s accounts').closest('.assistant-conv-title')).toHaveAttribute('title', 'Bronwyn’s accounts');
  // The current one is marked as such, and only it.
  expect(screen.getAllByRole('button', { current: true })).toHaveLength(1);
});

test('days are the App’s: its timezone decides what was today and what yesterday, read against the clock now', () => {
  /* 20:00 UTC on the 7th is 09:00 on the 8th in Auckland, so 10:00 UTC on the 7th — the same UTC day — was yesterday there. */
  installShell({ format: () => ({ timezone: 'Pacific/Auckland' }) });
  try {
    const clock = new Date('2026-10-07T20:00:00Z');
    const rows: ConversationSummary[] = [
      { id: 'x', title: 'Late last night', updatedAt: '2026-10-07T10:00:00Z' },
      { id: 'y', title: 'This morning', updatedAt: '2026-10-07T19:30:00Z' },
      { id: 'z', title: 'Last weekend', updatedAt: '2026-10-03T22:00:00Z' },
    ];
    draw({ conversations: rows, now: clock });
    expect(headings()).toEqual(['Today', 'Yesterday', 'Earlier this week']);
    expect(titlesUnder('Today')).toEqual(['This morning']);
    expect(titlesUnder('Yesterday')).toEqual(['Late last night']);
    // Sunday the 4th in Auckland, though it was still Saturday in UTC.
    expect(within(screen.getByRole('region', { name: 'Earlier this week' })).getByText('Sun')).toBeInTheDocument();
  } finally {
    installShell({ format: () => null });
  }
});

test('a list left open is grouped against the clock as it is now, not as it was when it was drawn', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    vi.setSystemTime(new Date(2026, 9, 7, 23, 59, 30));
    const rows: ConversationSummary[] = [{ id: 'a', title: 'Late call', updatedAt: new Date(2026, 9, 7, 23, 0).toISOString() }];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationList
          app="compass"
          conversations={rows}
          current={null}
          onOpen={vi.fn()}
          onNew={vi.fn()}
          onRename={vi.fn(async () => {})}
          onDelete={vi.fn(async () => {})}
        />
      </QueryClientProvider>,
    );
    expect(headings()).toEqual(['Today']);
    act(() => {
      vi.setSystemTime(new Date(2026, 9, 8, 0, 0, 30));
      vi.advanceTimersByTime(60_000);
    });
    expect(headings()).toEqual(['Yesterday']);
  } finally {
    vi.useRealTimers();
  }
});

test('a running turn is said where its time would be, in words', () => {
  draw({ working: 'a' });
  const row = screen.getByRole('button', { current: true });
  expect(within(row).getByText('Working')).toBeInTheDocument();
});

test('typing filters the titles at once; a moment later the conversations’ words are searched, the line they were found in shown', async () => {
  const user = userEvent.setup();
  draw();
  const search = screen.getByRole('searchbox', { name: 'Filter conversations' });
  await user.type(search, 'ohio');
  // No title holds it: nothing yet, then the server's answer with its line.
  const results = await screen.findByRole('list', { name: 'Conversations that match' });
  expect(within(results).getByText('Bronwyn’s accounts')).toBeInTheDocument();
  expect(within(results).getByText('Ohio', { selector: 'mark' })).toBeInTheDocument();
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['/api/assistant/search?app=compass&q=ohio']);

  await user.clear(search);
  await user.type(search, 'pipe');
  expect(
    within(screen.getByRole('list', { name: 'Conversations that match' })).getByText('Pipe', { selector: 'mark' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Stale deals this quarter')).toBeNull();

  // Escape empties the box, and the groups come back.
  await user.keyboard('{Escape}');
  expect(search).toHaveValue('');
  expect(headings()[0]).toBe('Waiting for you');
});

test('a search nothing matches says so', async () => {
  fetcher.mockImplementation(async () => json({ conversations: [] }));
  const user = userEvent.setup();
  draw();
  await user.type(screen.getByRole('searchbox', { name: 'Filter conversations' }), 'zebra');
  expect(await screen.findByText('No conversations match')).toBeInTheDocument();
});

test('Rename edits the title where it is: Enter keeps it, Escape leaves it', async () => {
  const user = userEvent.setup();
  const { onRename } = draw();
  await user.click(screen.getByRole('button', { name: 'Actions for “Quarterly forecast”' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const field = screen.getByRole('textbox', { name: 'Rename “Quarterly forecast”' });
  expect(field).toHaveFocus();
  await user.clear(field);
  await user.type(field, 'Q4 forecast{Enter}');
  expect(onRename).toHaveBeenCalledWith('e', 'Q4 forecast');

  await user.click(screen.getByRole('button', { name: 'Actions for “Pipeline by stage”' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  await user.type(screen.getByRole('textbox', { name: 'Rename “Pipeline by stage”' }), ' again{Escape}');
  expect(onRename).toHaveBeenCalledTimes(1);
});

test('Delete asks first, and only Delete deletes', async () => {
  const user = userEvent.setup();
  const { onDelete } = draw();
  await user.click(screen.getByRole('button', { name: 'Actions for “New leads this week”' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete “New leads this week”' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onDelete).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Actions for “New leads this week”' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
  expect(onDelete).toHaveBeenCalledWith('c');
});
