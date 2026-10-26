/**
 * A call to action's link is the view as the address bar says it once
 * followed: a list by its key, a dashboard by its own, a key naming nothing
 * no link at all.
 */
import { expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { installShell } from '../shellMode.js';

const board = { id: 'board', table: 'issue', label: 'Board', query: 'cycle_id = 1' };
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ id: 'thread', views: {} }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('./appRooms.js', () => ({
  viewRoom: (_app: unknown, key: string) =>
    key === 'board'
      ? board
      : key === 'home'
        ? { id: 'home', sections: [] }
        : key === 'write'
          ? { id: 'write', command: 'addResponse' }
          : undefined,
  isListRoom: (room: object) => !('sections' in room) && !('command' in room),
  dashPageId: (key: string) => `dash-${key}`,
  roomPageId: (room: { id: string; sections?: unknown; command?: unknown }) =>
    room.sections ? `dash-${room.id}` : room.command ? `form-${room.id}` : undefined,
}));
vi.mock('../core.js', () => ({
  go: vi.fn(),
  pageView: (pageId: string) => ({ kind: 'page', pageId }),
  state: { activeConnection: 'thread' },
  tableView: (table: string, query: string) => ({ kind: 'table', table, query, tab: 'rows' }),
}));
vi.mock('./appListModel.js', () => ({
  appListQuery: (spec: { table: string; query?: string }) => `${spec.table} ${spec.query ?? ''}`.trim(),
}));
/* The list as it opens: its key alone (publicAddress.test says why); a
   dashboard is its key in the App's book (app-address.test says how). The
   App's addresses are the shell's answer (shellMode.ts), as appnav.js gives it. */
const asked = vi.hoisted(() => ({ search: '' }));
beforeEach(() =>
  installShell({
    addresses: {
      viewEntry: (key: string, search: string) => {
        asked.search = search;
        return { kind: 'table', view: key, table: 'issue', query: `asked ${search}` };
      },
      listParams: (entry: { view?: string }) => (entry.view === 'board' ? '' : undefined),
      address: (connection: string, [entry]: readonly object[]) =>
        (entry as { kind: string }).kind === 'page' ? `/${connection}/home` : undefined,
      stackFrom: () => null,
      needsNaturalKey: () => undefined,
    },
  }),
);

const { viewLink } = await import('./viewLink.js');

test("a list's link is its key, a dashboard's its own, and a key naming nothing no link", () => {
  expect(viewLink('board')?.href).toBe('/thread/board');
  expect(viewLink('home')?.href).toBe('/thread/home');
  expect(viewLink('nowhere')).toBeUndefined();
});

test("a signed-in form's link opens its own room, not a dashboard's", async () => {
  const { go } = await import('../core.js');
  viewLink('write', 'reset')?.onClick?.({ button: 0, preventDefault() {} } as never);
  expect(go).toHaveBeenLastCalledWith({ kind: 'page', pageId: 'form-write' }, 'reset');
});

test('openView with a tab, a search and filters opens the list that address would open', async () => {
  const { go } = await import('../core.js');
  const { pageBridge } = await import('../uiBridge.js');
  expect(pageBridge.openView?.('board', { tab: 'Needs Reply', search: 'vpn', filters: { priority: 'urgent' } })).toBe(true);
  expect(new URLSearchParams(asked.search).toString()).toBe('tab=needs-reply&search=vpn&priority=urgent');
  expect(go).toHaveBeenLastCalledWith({
    kind: 'table',
    view: 'board',
    table: 'issue',
    query: 'asked tab=needs-reply&search=vpn&priority=urgent',
  });
  expect(pageBridge.openView?.('board')).toBe(true);
  expect(go).toHaveBeenLastCalledWith({ kind: 'table', table: 'issue', query: 'issue cycle_id = 1', tab: 'rows', view: 'board' });
  expect(pageBridge.openView?.('nowhere')).toBe(false);
});
