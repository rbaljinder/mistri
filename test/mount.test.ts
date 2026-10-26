import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appHome,
  appMounts,
  cookieUnder,
  inward,
  mountJson,
  NO_MOUNT,
  outward,
  parseBasePath,
  parseMountPath,
  publicRoot,
  readMountJson,
  rootApp,
  segmentsTakenFrom,
  serverPath,
  settingsMount,
  type AddressMount,
} from '../packages/engine/src/shared/mount.js';
import {
  appAddressBook,
  mountClashes,
  RESERVED_PATHS,
  routeTable,
  type AddressBookInput,
} from '../packages/mistri/src/shared/appAddress.js';

/**
 * Where an App is served, as one rule both ways: the inside address every
 * part of tablewalk writes (`/compass/leads/127`) and the one the browser
 * shows, for one App at the root, several under their ids, a main App at
 * the root beside others, and all of it under a reverse proxy's path.
 */

/* Every kind of address an App has, in its inside form. */
const KINDS: Record<string, string> = {
  home: '/compass',
  record: '/compass/leads/127',
  tab: '/compass/accounts/13/opportunities',
  new: '/compass/leads/new',
  dashboard: '/compass/sales-dashboard?period=last-30-days&period.pipeline=last-7-days',
  list: '/compass/leads?tab=working&search=stone',
  form: '/compass/form/intake',
  status: '/compass/form/intake/status',
  claim: '/compass/form/intake/claim?account=new',
  signIn: '/compass/sign-in',
  welcome: '/compass/welcome',
  component: '/compass/_components/chart-0123456789ab.js',
};

const single = appMounts(['compass']);
const byId = appMounts(['compass'], { mounts: { compass: 'compass' } });
const underBase = appMounts(['compass'], { base: '/tools' });
const suite = appMounts(['compass', 'billing'], { mounts: { compass: '' } });

const expected: Record<string, Record<string, string>> = {
  single: {
    home: '/',
    record: '/leads/127',
    tab: '/accounts/13/opportunities',
    new: '/leads/new',
    dashboard: '/sales-dashboard?period=last-30-days&period.pipeline=last-7-days',
    list: '/leads?tab=working&search=stone',
    form: '/form/intake',
    status: '/form/intake/status',
    claim: '/form/intake/claim?account=new',
    signIn: '/sign-in',
    welcome: '/welcome',
    component: '/_components/chart-0123456789ab.js',
  },
  byId: Object.fromEntries(Object.entries(KINDS)),
  underBase: {
    home: '/tools/',
    record: '/tools/leads/127',
    tab: '/tools/accounts/13/opportunities',
    new: '/tools/leads/new',
    dashboard: '/tools/sales-dashboard?period=last-30-days&period.pipeline=last-7-days',
    list: '/tools/leads?tab=working&search=stone',
    form: '/tools/form/intake',
    status: '/tools/form/intake/status',
    claim: '/tools/form/intake/claim?account=new',
    signIn: '/tools/sign-in',
    welcome: '/tools/welcome',
    component: '/tools/_components/chart-0123456789ab.js',
  },
};

test('one App is served at the root, several each under its id, and a --mount overrides either', () => {
  assert.deepEqual(single, { base: '', apps: { compass: '' } });
  assert.deepEqual(appMounts(['compass', 'billing']), { base: '', apps: { compass: 'compass', billing: 'billing' } });
  assert.deepEqual(suite.apps, { compass: '', billing: 'billing' });
  assert.deepEqual(byId.apps, { compass: 'compass' });
  assert.equal(rootApp(single), 'compass');
  assert.equal(rootApp(appMounts(['a', 'b'])), undefined);
  assert.deepEqual(appMounts([]), { base: '', apps: {} });
});

test('each kind of address, written for the browser and read back, in every placement', () => {
  for (const [name, mount] of Object.entries({ single, byId, underBase })) {
    for (const [kind, inside] of Object.entries(KINDS)) {
      const said = outward(mount, inside);
      assert.equal(said, expected[name][kind], `${name} ${kind}`);
      // Read back: a home under a base comes back without its trailing slash, as the App's id alone.
      assert.equal(inward(mount, said), inside, `${name} ${kind} reads back`);
    }
  }
});

test("the main App at the root beside another: each is its own, and the server's own paths are nobody's", () => {
  assert.equal(outward(suite, '/compass/leads/127'), '/leads/127');
  assert.equal(outward(suite, '/billing/invoices/9'), '/billing/invoices/9');
  assert.equal(inward(suite, '/leads/127'), '/compass/leads/127');
  assert.equal(inward(suite, '/billing/invoices/9'), '/billing/invoices/9');
  assert.equal(inward(suite, '/billing'), '/billing');
  assert.equal(inward(suite, '/'), '/compass');
  for (const own of ['/api/whoami', '/api/auth/sign-in/email', '/assets/index-abc.js', '/_mistri/sdk/react.js']) {
    assert.equal(inward(suite, own), own);
    assert.equal(outward(suite, own), own);
  }
  assert.equal(serverPath(underBase, '/api/whoami'), '/tools/api/whoami');
  assert.equal(inward(underBase, '/tools/api/whoami'), '/api/whoami');
});

test('no aliases: the spelling that applies is the only one', () => {
  // The App's id under a root mount is a route of the App named like it, never the App again.
  assert.equal(inward(single, '/compass/leads/127'), '/compass/compass/leads/127');
  // Outside the base path is no address of this server.
  assert.equal(inward(underBase, '/leads/127'), undefined);
  assert.equal(inward(underBase, '/toolsbox/leads'), undefined);
  // An App mounted under another segment does not answer to its id.
  const renamed = appMounts(['compass', 'billing'], { mounts: { billing: 'pay' } });
  assert.equal(outward(renamed, '/billing/invoices/9'), '/pay/invoices/9');
  assert.equal(inward(renamed, '/pay/invoices/9'), '/billing/invoices/9');
  assert.equal(inward(renamed, '/billing/invoices/9'), undefined);
});

test('the standalone browser mounts nothing: every address is its own, and a base path only adds and takes off', () => {
  for (const path of ['/', '/demo/customer/~1', '/demo/@invoice~7', '/demo/invoice%20total%20%3E%20500']) {
    assert.equal(outward(NO_MOUNT, path), path);
    assert.equal(inward(NO_MOUNT, path), path);
  }
  const proxied = appMounts([], { base: '/db' });
  assert.equal(outward(proxied, '/demo/customer/~1'), '/db/demo/customer/~1');
  assert.equal(inward(proxied, '/db/demo/customer/~1'), '/demo/customer/~1');
});

test('the written forms: a base path made canonical, a mount "/" or one segment, each mistake named', () => {
  assert.equal(parseBasePath(''), '');
  assert.equal(parseBasePath('/'), '');
  assert.equal(parseBasePath('tools/'), '/tools');
  assert.equal(parseBasePath('/a/b/'), '/a/b');
  assert.throws(() => parseBasePath('/a b'), /must be a path like \/tools/);
  assert.equal(parseMountPath('/', 'x'), '');
  assert.equal(parseMountPath('/billing', 'x'), 'billing');
  assert.equal(parseMountPath('billing/', 'x'), 'billing');
  assert.throws(() => parseMountPath('/a/b', '--mount main'), /--mount main: "\/a\/b" must be "\/" \(the root\) or one segment/);
  assert.throws(() => parseMountPath('/api', '--mount main'), /is the server's own/);
  assert.throws(
    () => appMounts(['main', 'billing'], { mounts: { main: '', billing: '' } }),
    /"main" and "billing" are both mounted at the root/,
  );
  assert.throws(() => appMounts(['main', 'billing'], { mounts: { billing: 'main' } }), /both mounted at \/main/);
  assert.throws(
    () => appMounts(['main'], { mounts: { other: '' } }),
    /--mount names "other", which is not an App this server serves \(main\)/,
  );
  assert.throws(() => appMounts(['api', 'b']), /mounted at \/api, which is the server's own/);
  assert.deepEqual(
    settingsMount(['main', 'billing'], { mounts: { main: '/' } }, { mount: { main: '/main', billing: '/pay' }, basePath: '/tools/' }),
    { base: '/tools', apps: { main: '', billing: 'pay' } },
    'a flag wins over the config, App by App',
  );
  assert.deepEqual(settingsMount(['main'], { basePath: '/x' }, { basePath: '/y' }).base, '/x');
});

test('the page carries the mount to the client, and reads anything malformed as none', () => {
  assert.deepEqual(readMountJson(mountJson(suite)), suite);
  assert.deepEqual(readMountJson(mountJson(underBase)), underBase);
  assert.deepEqual(readMountJson(null), NO_MOUNT);
  assert.deepEqual(readMountJson('{not json'), NO_MOUNT);
  assert.deepEqual(readMountJson('{"base":"javascript:x","apps":{"a":1}}'), { base: '', apps: {} });
});

test('the client preserves a reserved Console host base for bootstrap and component addresses', () => {
  for (const base of ['/_mistri/console', '/tools/_mistri/console']) {
    const mount = appMounts(['mistri-console'], { base });
    const client = readMountJson(mountJson(mount));
    assert.deepEqual(client, mount);
    assert.equal(inward(client, `${base}/`), '/mistri-console');
    assert.equal(serverPath(client, '/api/whoami?app=mistri-console'), `${base}/api/whoami?app=mistri-console`);
    assert.equal(outward(client, '/mistri-console/_components/console.js'), `${base}/_components/console.js`);
  }
  for (const base of ['/_other/console', '/_mistri/../console', '//_mistri/console']) {
    assert.equal(readMountJson(JSON.stringify({ base })).base, '');
  }
});

test("a cookie's path, the App home and the other Apps' segments", () => {
  assert.equal(cookieUnder('/tools', 'tw_claim=x; Path=/api/forms/intake; HttpOnly'), 'tw_claim=x; Path=/tools/api/forms/intake; HttpOnly');
  assert.equal(cookieUnder('', 'tw_claim=x; Path=/api/forms/intake'), 'tw_claim=x; Path=/api/forms/intake');
  assert.equal(appHome(single, 'compass'), '/');
  assert.equal(appHome(suite, 'billing'), '/billing');
  assert.equal(appHome(underBase, 'compass'), '/tools/');
  assert.deepEqual(segmentsTakenFrom(suite, 'compass'), { billing: 'billing' });
  assert.deepEqual(segmentsTakenFrom(suite, 'billing'), {});
});

/* The route table and the check read the same mount. */
const tables: AddressBookInput['tables'] = [
  {
    id: 'lead',
    name: 'lead',
    columns: [
      { name: 'id', primaryKey: true },
      { name: 'name', primaryKey: false },
    ],
  },
  { id: 'invoice', name: 'invoice', columns: [{ name: 'id', primaryKey: true }] },
];
const book = appAddressBook({
  order: ['leads', 'billing'],
  views: { leads: { table: 'lead' }, billing: { table: 'invoice' } },
  resources: {},
  pages: [],
  tables,
});

test('the route table says each address as the browser will, at the root, under an id and under a base', () => {
  const at = (mount: AddressMount) => routeTable(book, appHome(mount, 'compass')).map((row) => row.path);
  assert.deepEqual(at(single).slice(0, 4), ['/', '/leads', '/leads/new', '/leads/{id}']);
  assert.deepEqual(at(byId).slice(0, 4), ['/compass', '/compass/leads', '/compass/leads/new', '/compass/leads/{id}']);
  assert.deepEqual(at(underBase).slice(0, 4), ['/tools/', '/tools/leads', '/tools/leads/new', '/tools/leads/{id}']);
});

test("at the root beside another App, a route that App's segment names is refused by name", () => {
  assert.deepEqual(mountClashes(book, segmentsTakenFrom(suite, 'compass')), [
    'the list view "billing": its address "/billing" is where the App "billing" is mounted, beside this one at the root. ' +
      'Give it another "path", or mount "billing" elsewhere (--mount billing=/<segment>).',
  ]);
  assert.deepEqual(mountClashes(book, {}), []);
  // The server's own words are reserved for every App, whatever its mount.
  for (const word of ['api', 'assets', '_mistri', '_components', 'new', 'sign-in', 'form', 'welcome'])
    assert.ok(RESERVED_PATHS.includes(word), word);
  // tablewalk's own tools live under /_mistri, beside a root App and under a base path alike.
  assert.equal(inward(single, '/_mistri/observe'), '/_mistri/observe');
  assert.equal(inward(underBase, '/tools/_mistri/observe'), '/_mistri/observe');
  const tools = appAddressBook({ order: ['_mistri'], views: { _mistri: { table: 'lead' } }, resources: {}, pages: [], tables });
  assert.match(tools.problems.join('\n'), /views "_mistri": its address "_mistri" is reserved/);
  const reserved = appAddressBook({ order: ['assets'], views: { assets: { table: 'lead' } }, resources: {}, pages: [], tables });
  assert.match(reserved.problems.join('\n'), /views "assets": its address "assets" is reserved/);
});

test('a public URL written with the base path or without it names the one root', () => {
  // Sign-in's address is the root and the base: written with the base, it was the base twice.
  for (const given of ['https://tools.example.test/desk', 'https://tools.example.test/desk/', 'https://tools.example.test'])
    assert.equal(publicRoot(given, '/desk'), 'https://tools.example.test');
  // A proxy's own prefix before the base stays; only the base comes off.
  assert.equal(publicRoot('https://example.test/apps/desk', '/desk'), 'https://example.test/apps');
  assert.equal(publicRoot('https://example.test/apps', '/desk'), 'https://example.test/apps');
  // A segment that only ends in the base's letters is not the base, nor is a host that spells it.
  assert.equal(publicRoot('https://example.test/helpdesk', '/desk'), 'https://example.test/helpdesk');
  assert.equal(publicRoot('https://desk', '/desk'), 'https://desk');
  assert.equal(publicRoot('https://example.test/', ''), 'https://example.test');
});
