/**
 * The bell and the inbox: the unread count as the trigger's name and badge,
 * the latest notices as a menu whose items open their record and mark it
 * read, and the room's All/Unread lists, Mark read and Mark all read — each
 * a request for the reader's own notices only, naming no one.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const went: unknown[] = [];
let notices: Array<Record<string, unknown>> = [];
/* Undefined: the App emails nothing, and the reply says nothing of email. */
let emailed: boolean | undefined;

vi.mock('../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../kit/src/client/core.js')>()),
  go: (entry: unknown, mode: string) => {
    went.push({ entry, mode });
  },
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/inbox') {
      const shown = body.unread ? notices.filter((notice) => !notice.read) : notices;
      return {
        notices: shown.slice(0, Number(body.limit)),
        unread: notices.filter((notice) => !notice.read).length,
        ...(emailed === undefined ? {} : { email: emailed }),
      };
    }
    if (path === '/api/inbox/email') {
      emailed = body.email as boolean;
      return { email: emailed };
    }
    if (path === '/api/inbox/read') {
      for (const notice of notices) if (body.all || (body.ids as number[]).includes(notice.id as number)) notice.read = true;
      return { unread: notices.filter((notice) => !notice.read).length };
    }
    throw new Error(`unexpected ${path}`);
  },
}));

const { InboxBell } = await import('./InboxBell.js');
const { InboxRoom } = await import('./InboxList.js');
const { unreadWord } = await import('./inboxModel.js');

const draw = (element: ReactElement) =>
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, element));

beforeEach(() => {
  calls.length = 0;
  went.length = 0;
  emailed = undefined;
  notices = [
    {
      id: 2,
      at: '2026-09-20T14:05:00.000Z',
      title: 'Bob replied in Solder fumes',
      resource: 'thread',
      key: { id: 7 },
      by: 'Bob Diaz',
      read: false,
    },
    { id: 1, at: '2026-09-19T09:00:00.000Z', title: 'PO-12 is received', resource: 'purchase_order', key: { id: 12 }, read: true },
  ];
});
afterEach(() => cleanup());

test('the bell says how many are unread in its name and its badge, and nothing when none are', async () => {
  draw(createElement(InboxBell));
  expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
  expect(calls[0]).toEqual({ path: '/api/inbox', body: { limit: 1 } });
  cleanup();
  notices.forEach((notice) => {
    notice.read = true;
  });
  draw(createElement(InboxBell));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy());
  expect(unreadWord(120)).toBe('99+');
});

test('the menu lists the latest, and opening one marks it read and opens its record', async () => {
  draw(createElement(InboxBell));
  await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
  const item = await screen.findByRole('menuitem', { name: /Bob replied in Solder fumes/ }, { timeout: 5000 });
  expect(item.textContent).toMatch(/^Unread: /);
  expect(screen.getByRole('menuitem', { name: /PO-12 is received/ })).toBeTruthy();
  await userEvent.click(item);
  await waitFor(() =>
    expect(calls.some((call) => call.path === '/api/inbox/read' && JSON.stringify(call.body) === '{"ids":[2]}')).toBe(true),
  );
  expect(went[0]).toMatchObject({ entry: { kind: 'row', table: 'thread', key: { id: 7 } }, mode: 'reset' });
}, 15_000);

test('the room shows All or Unread, marks one read and all read, and says so when nothing is there', async () => {
  draw(createElement(InboxRoom));
  expect(await screen.findByRole('heading', { name: 'Notifications', level: 1 })).toBeTruthy();
  expect(await screen.findByText('1 unread')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /^Mark read.*Bob replied in Solder fumes/ }));
  await waitFor(() => expect(notices[0].read).toBe(true));
  await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
  expect(await screen.findByText('Nothing unread.')).toBeTruthy();
  // Never a recipient, an account or anyone's email in what the page asks.
  expect(JSON.stringify(calls)).not.toMatch(/recipient|@|account/);
});

test("the room offers email only where the App emails notices, and turning it off asks for the reader's own alone", async () => {
  draw(createElement(InboxRoom));
  expect(await screen.findByRole('heading', { name: 'Notifications', level: 1 })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: 'Email me these too' })).toBeNull();
  cleanup();
  emailed = true;
  draw(createElement(InboxRoom));
  const box = (await screen.findByRole('checkbox', { name: 'Email me these too' })) as HTMLInputElement;
  expect(box.checked).toBe(true);
  await userEvent.click(box);
  await waitFor(() =>
    expect(calls.some((call) => call.path === '/api/inbox/email' && JSON.stringify(call.body) === '{"email":false}')).toBe(true),
  );
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Email me these too' }) as HTMLInputElement).checked).toBe(false));
});
