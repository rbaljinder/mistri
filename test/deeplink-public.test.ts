/**
 * A public visitor's address is the one thing on screen: a page alone, and a
 * list the App names as its view key with its question as parameters. The
 * way back reads a bare view key through the caller, and a table named like
 * the segment is still the table, so no link written before means anything new.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionFromHash, fromHash, hashFor, publicPathFor } from '../packages/kit/src/client/deeplink.js';

type Entry = Record<string, unknown>;
const tables = [{ id: 'vehicle', name: 'vehicle', columns: [{ name: 'id', primaryKey: true }] }];
const find = (id: string) => tables.find((table) => table.id === id);

const list: Entry = {
  kind: 'table',
  table: 'vehicle',
  query: 'vehicle status != sold and body_type = Sedan show title, price',
  tab: 'rows',
  view: 'vehicles',
};
const page: Entry = { kind: 'page', pageId: 'vehicle', table: 'vehicle', key: { id: 49 } };

test('a page is its own address, whatever list it was opened from', () => {
  assert.equal(publicPathFor('forecourt', [list, page]), '/forecourt/@vehicle~49');
  assert.equal(publicPathFor('forecourt', []), '/forecourt');
});

test('a list the App names is its key and its words; one the caller cannot say is written as ever', () => {
  assert.equal(publicPathFor('forecourt', [list], { listParams: () => 'body_type=Sedan' }), '/forecourt/vehicles?body_type=Sedan');
  assert.equal(publicPathFor('forecourt', [list], { listParams: () => '' }), '/forecourt/vehicles');
  assert.match(publicPathFor('forecourt', [list], { listParams: () => undefined }), /^\/forecourt\/vehicles:vehicle%20status/);
});

test('a bare view key and its parameters come back through the caller; a table of that name wins', () => {
  const seen: Array<[string, string]> = [];
  const viewEntry = (key: string, search: string) => {
    seen.push([key, search]);
    return key === 'vehicles' ? { kind: 'table', table: 'vehicle', query: 'vehicle x', tab: 'rows', view: key } : null;
  };
  const parsed = fromHash('/forecourt/vehicles?body_type=Sedan&sort=-price', find, { viewEntry }) as { connection: string; stack: Entry[] };
  assert.deepEqual(seen, [['vehicles', 'body_type=Sedan&sort=-price']]);
  assert.equal(parsed.connection, 'forecourt');
  assert.equal(parsed.stack[0].view, 'vehicles');
  // A table named like the segment is the table, and the resolver is not asked.
  const byTable = fromHash('/forecourt/vehicle', find, { viewEntry }) as { stack: Entry[] };
  assert.equal(byTable.stack[0].table, 'vehicle');
  assert.equal(seen.length, 1);
  // Without a resolver a segment reads as it always did.
  const plain = fromHash('/forecourt/vehicles', find) as { stack: Entry[] };
  assert.equal(plain.stack[0].kind, 'table');
});

test('the connection is before the question', () => {
  assert.equal(connectionFromHash('/forecourt?make=Toyota'), 'forecourt');
  assert.equal(connectionFromHash('/forecourt/vehicles?make=Toyota'), 'forecourt');
});

/* Signed in, the whole walk is the address and each list a view opened is said in words. */
const walkTables = [
  { id: 'issue', name: 'issue', columns: [{ name: 'id', primaryKey: true }] },
  { id: 'member', name: 'member', columns: [{ name: 'id', primaryKey: true }] },
];
const findWalk = (id: string) => walkTables.find((table) => table.id === id);
const board: Entry = {
  kind: 'table',
  table: 'issue',
  query: 'issue cycle_id = 1 and status != canceled show name, status, priority',
  tab: 'rows',
  view: 'board',
};
const inbox: Entry = { kind: 'table', table: 'issue', query: 'issue show name, status, assignee_id.name', tab: 'rows', view: 'inbox' };
const pick: Entry = { kind: 'row', table: 'issue', key: { id: 2 }, view: 'inbox' };
const words = (map: Record<string, string | undefined>) => (entry: Entry) => map[entry.view as string];

test('a list in words is its key, the rows after it as ever, and its question the search', () => {
  assert.equal(hashFor('thread', [board], { listParams: words({ board: '' }) }), '/thread/board');
  assert.equal(hashFor('thread', [inbox, pick], { listParams: words({ inbox: '' }) }), '/thread/inbox/~2');
  assert.equal(hashFor('thread', [inbox, pick], { listParams: words({ inbox: 'status=done' }) }), '/thread/inbox/~2?status=done');
  // The New drawer rides after the key as it rode after the question.
  assert.equal(hashFor('crm', [{ ...board, tab: 'new' }], { listParams: words({ board: '' }) }), '/crm/board!new');
  // Without words — the Workbench — the question is the segment, as ever.
  assert.match(
    hashFor('thread', [board, { kind: 'row', table: 'issue', key: { id: 7 } }]),
    /^\/thread\/board:issue%20cycle_id%20%3D%201.*\/~7$/,
  );
  // A list no view names, or one its words cannot say, is its question.
  assert.match(hashFor('thread', [board], { listParams: () => undefined }), /^\/thread\/board:issue%20/);
});

test('one address has one search: the last list in words carries it, an earlier one only as authored', () => {
  assert.equal(
    hashFor('thread', [board, inbox], { listParams: words({ board: '', inbox: 'status=done' }) }),
    '/thread/board/inbox?status=done',
  );
  const earlier = hashFor('thread', [board, inbox], { listParams: words({ board: 'q=x', inbox: '' }) });
  assert.match(earlier, /^\/thread\/board:issue%20.*\/inbox$/);
  const seen: Array<[string, string]> = [];
  const viewEntry = (key: string, search: string) => {
    seen.push([key, search]);
    return { kind: 'table', table: 'issue', query: `issue ${key}`, tab: 'rows', view: key };
  };
  fromHash('/thread/board/inbox?status=done', findWalk, { viewEntry });
  assert.deepEqual(seen, [
    ['board', ''],
    ['inbox', 'status=done'],
  ]);
});

test("a split's pick reads back beside its list, the drawer with its list, and every old address as before", () => {
  const viewEntry = (key: string) => ({ kind: 'table', table: 'issue', query: `issue ${key}`, tab: 'rows', view: key });
  const split = fromHash('/thread/inbox/~2', findWalk, { viewEntry }) as { stack: Entry[] };
  assert.deepEqual(
    split.stack.map((entry) => [entry.kind, entry.view]),
    [
      ['table', 'inbox'],
      ['row', 'inbox'],
    ],
  );
  assert.deepEqual(split.stack[1].key, { id: '2' });
  const drawer = fromHash('/crm/board!new', findWalk, { viewEntry }) as { stack: Entry[] };
  assert.equal(drawer.stack[0].tab, 'new');
  assert.equal(drawer.stack[0].view, 'board');
  // The query-language address a walk wrote before: the view's key before its question, the resolver not asked.
  const old = fromHash('/thread/board:issue%20cycle_id%20%3D%201%20and%20status%20!%3D%20canceled/~7', findWalk, {
    viewEntry: () => {
      throw new Error('not a bare key');
    },
  }) as { stack: Entry[] };
  assert.equal(old.stack[0].view, 'board');
  assert.equal(old.stack[0].query, 'issue cycle_id = 1 and status != canceled');
  assert.equal(old.stack[1].view, 'board');
  // A segment that only looks like a key with a tab is a query, as before.
  const odd = fromHash('/thread/issue!ddl', findWalk, { viewEntry }) as { stack: Entry[] };
  assert.deepEqual([odd.stack[0].table, odd.stack[0].tab, odd.stack[0].view], ['issue', 'ddl', undefined]);
});

test('written and read back, a walk in words is the same walk', () => {
  const views: Record<string, Entry> = { board, inbox };
  const viewEntry = (key: string, search: string) =>
    views[key] ? { ...views[key], query: `${views[key].query as string}${search ? ` ?${search}` : ''}` } : null;
  const listParams = (entry: Entry) => {
    const said = / \?(.*)$/.exec(entry.query as string);
    return said ? said[1] : '';
  };
  for (const address of [
    '/thread/board',
    '/thread/inbox/~2',
    '/thread/inbox/~2?status=done',
    '/thread/board/~5/~member%3A3',
    '/thread/board!new?tab=working',
  ]) {
    const parsed = fromHash(address, findWalk, { viewEntry }) as { connection: string; stack: Entry[] };
    assert.equal(hashFor(parsed.connection, parsed.stack, { listParams }), address);
  }
});
