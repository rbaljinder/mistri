/**
 * The addresses `useHref` hands a component: each is the one the walk writes for the same thing and reads back to it,
 * built through the App's own address book, and none for a view, page or record the App has no room for.
 */
import { expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';

const account = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const pipeline = { record: { view: 'accounts', table: 'account', tab: 'pipeline' } };
const rooms: Record<string, unknown> = {
  accounts: { id: 'accounts', table: 'account', label: 'Accounts' },
  forecast: { id: 'forecast', kind: 'dashboard', label: 'Forecast', sections: [], page: { params: [] } },
  'accounts-pipeline': { id: 'accounts-pipeline', kind: 'dashboard', label: 'Pipeline', sections: [], page: pipeline },
};
/* One App object, so the address book is built once for it. */
const app = {
  id: 'compass',
  nav: [],
  resources: {},
  pages: [],
  views: {
    accounts: { table: 'account', label: 'Accounts' },
    forecast: { label: 'Forecast', sections: [], page: { params: [] } },
    'accounts-pipeline': { label: 'Pipeline', sections: [], page: pipeline },
  },
};

vi.mock('./appState.js', () => ({ activeApp: () => app }));
beforeEach(bridgeShell);
vi.mock('../../../kit/src/client/components/appRooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../kit/src/client/components/appRooms.js')>()),
  viewRoom: (_app: unknown, key: string) => rooms[key],
  appRooms: () => Object.values(rooms),
  offeredBy: () => ({}),
  resourceOf: () => undefined,
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  findTable: (id: string) => (id === 'account' ? account : undefined),
  recordLabel: () => undefined,
  labelPath: () => undefined,
  quote: (value: string) => `"${value.replace(/"/g, '\\"')}"`,
  tableView: (table: string, query: string) => ({ kind: 'table', table, query, tab: 'rows' }),
  pageView: (pageId: string, table: undefined, key: undefined, label: string) => ({ kind: 'page', pageId, table, key, label }),
  state: { schema: { tables: [account], foreignKeys: [] } },
}));

const { appStackFrom, hrefFor } = await import('./publicAddress.js');

test('a sign-in, a view, a page and a record are each the address the walk reads back', () => {
  expect(hrefFor({ kind: 'signIn' })).toBe('/compass/sign-in');
  expect(hrefFor({ kind: 'view', view: 'accounts', params: { tab: 'open', search: 'acme' } })).toBe(
    '/compass/accounts?tab=open&search=acme',
  );
  expect(hrefFor({ kind: 'page', path: 'forecast', params: { period: 'q3' } })).toBe('/compass/forecast?period=q3');
  const record = hrefFor({ kind: 'record', view: 'accounts', key: { id: 13 } })!;
  expect(record).toBe('/compass/accounts/13');
  expect(appStackFrom(record)?.stack.at(-1)).toMatchObject({ kind: 'row', table: 'account', key: { id: '13' } });
  const tab = hrefFor({ kind: 'record', view: 'accounts', key: { id: 13 }, tab: 'pipeline' })!;
  expect(tab).toBe('/compass/accounts/13/pipeline');
  expect(appStackFrom(tab)?.stack.at(-1)).toMatchObject({ kind: 'row', table: 'account', key: { id: '13' }, tab: 'pipeline' });
});

test('a view the App has no room for, a record tab as a page, and a key too short for a record have no address', () => {
  expect(hrefFor({ kind: 'view', view: 'nowhere' })).toBeUndefined();
  expect(hrefFor({ kind: 'page', path: 'accounts-pipeline' })).toBeUndefined();
  expect(hrefFor({ kind: 'record', view: 'forecast', key: { id: 1 } })).toBeUndefined();
  expect(hrefFor({ kind: 'record', view: 'accounts', key: {} })).toBeUndefined();
});
