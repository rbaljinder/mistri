/**
 * `extends` and who is named: a view's or a page's `roles` open to a role that
 * extends one they name, through any depth of `extends` and only upward. The
 * grants a role holds are `extends`' fold as ever; naming never widens a table,
 * a column or a command, and a role the named one extends does not open what
 * names only its extender.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appRoleWarnings } from '../packages/mistri/src/server/app/appRoleChecks.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/appAccess.js';
import { appForRoles, heldRoles, opensTo, pagesForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';

const schema = {
  label: 'desk',
  dialect: 'sqlite',
  readAt: '2026-10-01T00:00:00Z',
  foreignKeys: [],
  tables: [
    { id: 'ticket', name: 'ticket', schema: 'main', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] },
    { id: 'budget', name: 'budget', schema: 'main', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] },
  ],
} as unknown as DatabaseSchema;

const app = parseTestApp(
  {
    id: 'desk',
    name: 'Desk',
    resources: { ticket: { access: 'write' }, budget: {} },
    auth: {
      roles: {
        staff: { label: 'Staff', read: ['ticket'] },
        lead: { label: 'Lead', extends: 'staff' },
        manager: { label: 'Manager', extends: 'lead', write: ['ticket'], read: ['budget'] },
        admin: { label: 'Admin', extends: 'manager', write: true },
        guest: { label: 'Guest', read: ['ticket'] },
      },
    },
    views: {
      tickets: { kind: 'list', from: 'ticket', roles: ['staff'] },
      approvals: { kind: 'list', from: 'ticket', roles: ['manager'] },
      budgets: { kind: 'list', from: 'budget', roles: ['manager', 'guest'] },
      all: { kind: 'list', from: 'ticket' },
    },
    home: 'all',
    nav: ['tickets', 'approvals', 'budgets', 'all'],
  },
  'extends fixture',
);
const seen = (...roles: string[]) => Object.keys(appForRoles(app, roles).views).sort();

test('a role that extends a named one opens the view, through any depth', () => {
  assert.deepEqual(seen('staff'), ['all', 'tickets']);
  assert.deepEqual(seen('lead'), ['all', 'tickets']);
  assert.deepEqual(seen('manager'), ['all', 'approvals', 'budgets', 'tickets']);
  assert.deepEqual(seen('admin'), ['all', 'approvals', 'budgets', 'tickets']);
});

test('only upward: a role the named one extends, a sibling and a stranger do not open it', () => {
  assert.equal(appForRoles(app, ['staff']).views.approvals, undefined, 'the extended role is not the extender');
  assert.equal(appForRoles(app, ['lead']).views.approvals, undefined, 'one rung below is not named');
  assert.equal(appForRoles(app, ['guest']).views.approvals, undefined, 'a stranger');
  assert.equal(appForRoles(app, ['guest']).views.tickets, undefined, 'a sibling that extends nothing');
  assert.deepEqual(seen(), ['all'], 'signed out holds none');
  assert.deepEqual(seen('nobody'), ['all'], 'an undeclared role holds none');
});

test('a principal with several roles opens the union, and the nav follows', () => {
  assert.deepEqual(seen('guest', 'staff'), ['all', 'budgets', 'tickets']);
  assert.deepEqual(
    (appForRoles(app, ['lead']).nav as Array<string | { view?: string }>).map((node) => (typeof node === 'string' ? node : node.view)),
    ['tickets', 'all'],
  );
});

test('pages name roles the same way', () => {
  const pages = [{ id: 'queue', roles: ['manager'] }, { id: 'open' }, { id: 'staffroom', roles: ['staff'] }];
  const ids = (roles: string[]) => pagesForRoles(pages, roles, app.auth).map((page) => page.id);
  assert.deepEqual(ids(['admin']), ['queue', 'open', 'staffroom']);
  assert.deepEqual(ids(['lead']), ['open', 'staffroom']);
  assert.deepEqual(ids(['guest']), ['open']);
  assert.deepEqual(ids([]), ['open']);
});

test('the held roles add what a role extends and nothing else', () => {
  assert.deepEqual(heldRoles(app.auth, ['admin']), ['admin', 'manager', 'lead', 'staff']);
  assert.deepEqual(heldRoles(app.auth, ['staff']), ['staff']);
  assert.deepEqual(heldRoles(app.auth, ['ghost']), ['ghost'], 'an undeclared role is its own name only');
  assert.deepEqual(heldRoles(undefined, ['x']), ['x']);
  assert.equal(opensTo({ roles: ['manager'] }, ['lead'], app.auth), false);
  assert.equal(opensTo({ roles: ['lead'] }, ['manager'], app.auth), true);
  assert.equal(opensTo({}, [], app.auth), true);
});

test('naming opens no data: what a role reads and writes is its grants, not the views it is named in', () => {
  const access = (role: string) => resolveAppAccess(app, schema, [role]);
  // lead extends staff and nothing more: the manager-only view's table stays unread, whatever opens.
  assert.deepEqual([...access('lead').readable].sort(), ['ticket']);
  assert.deepEqual([...access('lead').writable], []);
  // the extended role gains nothing from its extender's grants.
  assert.deepEqual([...access('staff').writable], []);
  assert.equal(access('staff').readable.has('budget'), false);
  assert.deepEqual([...access('guest').readable], ['ticket']);
  assert.equal(access('manager').readable.has('budget'), true);
  assert.deepEqual([...access('manager').writable], ['ticket']);
});

test('check no longer warns that an extending role is hidden from a view', () => {
  const loaded = { app, path: '/apps/desk/app.ts', pages: [], sources: {} } as unknown as LoadedApp;
  const found = appRoleWarnings(loaded, schema).filter((line) => /extends-not-named|is hidden from/.test(line));
  assert.deepEqual(found, []);
});
