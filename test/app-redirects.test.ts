import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAddressBook, type AddressBookInput } from '../packages/mistri/src/shared/appAddress.js';
import { parseRedirects, redirectProblems, redirectedTo } from '../packages/mistri/src/shared/appRedirects.js';
import { parseUi } from '../packages/mistri/src/shared/appUi.js';

/**
 * `ui.redirects`: the shape the parser takes, the address the server sends an old one to (query aside, which the
 * handler appends), and what `mistri check --routes` refuses against the App's own routes.
 */
const col = (name: string, primaryKey = false) => ({ name, primaryKey });
const book = appAddressBook({
  order: ['leads', 'sales-dashboard'],
  views: { leads: { table: 'lead' }, 'sales-dashboard': { sections: [] } },
  resources: {},
  pages: [],
  tables: [{ id: 'lead', name: 'lead', columns: [col('id', true), col('name')] }],
} satisfies AddressBookInput);

test('a redirect is an old in-App path and the path it moved to, and names only what its source holds', () => {
  assert.deepEqual({ ...parseRedirects({ '/old/:id': '/leads/:id', '/gone': '/' }, 'x') }, { '/old/:id': '/leads/:id', '/gone': '/' });
  for (const bad of [
    {},
    [],
    { old: '/leads' },
    { '/old': 'leads' },
    { '/old?x=1': '/leads' },
    { '/': '/leads' },
    { '/old/': '/leads' },
    { '/old': '/leads/:id' },
  ])
    assert.throws(() => parseRedirects(bad, 'x'), /ui\.redirects|"ui\.redirects"/, JSON.stringify(bad));
  assert.deepEqual(parseUi({ redirects: { '/old': '/leads' } }, 'x').redirects, { '/old': '/leads' });
});

test('an address that has moved goes to its new place with its names carried over; any other is left alone', () => {
  const moves = { '/old/:id': '/leads/:id', '/gone': '/', '/a/:x/b/:y': '/leads/:y/:x' };
  assert.equal(redirectedTo(moves, ['old', '12']), '/leads/12');
  assert.equal(redirectedTo(moves, ['gone']), '');
  assert.equal(redirectedTo(moves, ['a', '1', 'b', '2']), '/leads/2/1');
  assert.equal(redirectedTo(moves, ['old']), undefined);
  assert.equal(redirectedTo(moves, ['old', '1', 'more']), undefined);
  assert.equal(redirectedTo(undefined, ['old', '1']), undefined);
});

test('check refuses a target that is no address, a chain, a cycle, and a source that is a live route', () => {
  assert.deepEqual(redirectProblems({ '/old/:id': '/leads/:id', '/older': '/sales-dashboard' }, book), []);
  assert.match(
    redirectProblems({ '/old': '/nowhere' }, book)[0]!,
    /"\/old" goes to "\/nowhere", which is not an address the App answers to/,
  );
  assert.match(
    redirectProblems({ '/a': '/b', '/b': '/leads' }, book)[0]!,
    /"\/a" goes to "\/b", which is itself moved on by "\/b": a redirect of a redirect/,
  );
  assert.match(redirectProblems({ '/a': '/b', '/b': '/a' }, book).join('\n'), /goes round in a circle/);
  assert.match(redirectProblems({ '/leads/:id': '/sales-dashboard' }, book)[0]!, /"\/leads" is an address the App answers to/);
  assert.match(redirectProblems({ '/:page': '/leads' }, book)[0]!, /would move every address/);
});
