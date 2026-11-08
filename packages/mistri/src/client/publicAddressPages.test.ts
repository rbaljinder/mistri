/**
 * A free-form page's canonical address, as the walk writes it and reads it
 * back: a top-level page is a room, as a dashboard is (`/compass/forecast`),
 * and a page placed as a record's tab is its record's address with the tab's
 * word (`/compass/accounts/13/pipeline`), with no room of its own.
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

const { appAddress, appStackFrom, viewPath } = await import('./publicAddress.js');

test('a free-form page is rewritten to its room, and read back to the same page, as a dashboard is', () => {
  // The walk's own form of the page (`@dash-forecast`, read the older way) is said as its room's address.
  expect(appAddress('compass', [{ kind: 'page', pageId: 'dash-forecast', label: 'Forecast' }])).toBe('/compass/forecast');
  expect(viewPath('forecast')).toBe('/compass/forecast');
  const read = appStackFrom('/compass/forecast');
  expect(read?.stack).toEqual([expect.objectContaining({ kind: 'page', pageId: 'dash-forecast', label: 'Forecast' })]);
  expect(appAddress('compass', read!.stack)).toBe('/compass/forecast');
});

test("a record's tab page is its record's address with the tab's word, and has no room of its own", () => {
  const read = appStackFrom('/compass/accounts/13/pipeline');
  expect(read?.stack.at(-1)).toMatchObject({ kind: 'row', table: 'account', key: { id: '13' }, tab: 'pipeline', view: 'accounts' });
  // The crumb back is the accounts list, as for any tab of the record.
  expect(read?.stack[0]).toMatchObject({ kind: 'table', table: 'account', view: 'accounts' });
  expect(appAddress('compass', read!.stack)).toBe('/compass/accounts/13/pipeline');
  // Written from the walk the tab strip leaves: the record, on the page's tab.
  expect(appAddress('compass', [{ kind: 'row', table: 'account', key: { id: 13 }, tab: 'pipeline', view: 'accounts' }])).toBe(
    '/compass/accounts/13/pipeline',
  );
  expect(viewPath('accounts-pipeline')).toBeUndefined();
  expect(appStackFrom('/compass/accounts-pipeline')).toBeNull();
});
