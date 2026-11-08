/**
 * Nav workspaces (shared/appNav.ts): top-level groups that say `workspace: true`, each a product of its own in one App.
 * The rules are of the menu's shape: all of the top level or none of it, the footer group alone outside, a view once
 * in each workspace, and nothing nested or mixed with the top bar's `inline`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { placePages } from '../packages/mistri/src/server/app/appPages.js';
import { parseTestApp } from './support/commandCatalog.js';

const LIST = { kind: 'list', from: 'task' } as const;
const views = { tickets: LIST, queue: LIST, leads: LIST, shared: LIST };
const parse = (nav: unknown[]) => parseTestApp({ name: 'x', views, home: 'tickets', resources: { task: {} }, nav }, 'test/app.json');
const space = (id: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  children,
  workspace: true,
  ...extra,
});

describe('nav workspaces', () => {
  test('workspaces split the top level, and a footer group stands outside them', () => {
    const app = parse([
      space('desk', ['tickets', { id: 'more', label: 'More', children: ['queue'] }]),
      space('crm', ['leads']),
      { id: 'help', label: 'Help', placement: 'footer', children: ['shared'] },
    ]);
    assert.deepEqual(
      app.nav.map((node) => ('group' in node ? [node.group, node.workspace ?? false, node.placement ?? null] : null)),
      [
        ['desk', true, null],
        ['crm', true, null],
        ['help', false, 'footer'],
      ],
    );
    /* Served as written: the client reads the flag off the payload. */
    assert.equal(
      (servedApp(app, { label: 'demo', dialect: 'sqlite', readAt: '', tables: [], foreignKeys: [] }).nav[0] as { workspace?: true })
        .workspace,
      true,
    );
  });

  test('a menu with no workspace is as it was', () => {
    const app = parse([{ id: 'work', label: 'Work', children: ['tickets'] }, 'queue']);
    assert.ok(app.nav.every((node) => !('workspace' in node)));
  });

  test('a top-level entry outside the workspaces is refused by name', () => {
    assert.throws(() => parse([space('desk', ['tickets']), 'leads']), /nav entry 2 is the view "leads", outside every workspace/);
    assert.throws(
      () => parse([space('desk', ['tickets']), { id: 'misc', label: 'Misc', children: ['leads'] }]),
      /nav entry 2 is the group "misc", outside every workspace.*placement: 'footer'/,
    );
    assert.throws(() => parse([{ label: 'Docs', to: { app: 'x', kind: 'home' } }, space('desk', ['tickets'])]), /outside every workspace/);
  });

  test('a workspace is a top-level group, true or left out, and not inline or a footer group', () => {
    assert.throws(
      () => parse([space('desk', [{ id: 'inner', label: 'Inner', workspace: true, children: ['tickets'] }])]),
      /group inside a group with "workspace"\. Only a group of the top level is a workspace/,
    );
    assert.throws(() => parse([space('desk', ['tickets'], { workspace: false })]), /"workspace" of false: it is true, or left out/);
    assert.throws(() => parse([space('desk', ['tickets'], { inline: true })]), /is a workspace with "inline"/);
    assert.throws(() => parse([space('desk', ['tickets'], { placement: 'footer' })]), /is a workspace with a "placement"/);
  });

  test('a view may stand in two workspaces, never twice in one, nor in a workspace and outside it', () => {
    const app = parse([space('desk', ['tickets', 'shared']), space('crm', ['leads', 'shared'])]);
    assert.equal(app.nav.length, 2);
    assert.throws(() => parse([space('desk', ['tickets', 'tickets']), space('crm', ['leads'])]), /names the view "tickets" a second time/);
    assert.throws(
      () =>
        parse([
          space('desk', ['tickets', { id: 'a', label: 'A', children: ['shared'] }, { id: 'b', label: 'B', children: ['shared'] }]),
          space('crm', ['leads']),
        ]),
      /names the view "shared" a second time/,
    );
    assert.throws(
      () =>
        parse([
          space('desk', ['tickets']),
          space('crm', ['leads']),
          { id: 'help', label: 'Help', placement: 'footer', children: ['tickets'] },
        ]),
      /names the view "tickets" a second time/,
    );
  });

  test("a free-form page is a workspace's entry where it places itself, and is refused at the top of the menu", () => {
    const page = (nav: unknown) => ({
      key: 'forecast',
      module: './pages/forecast.page.tsx',
      fields: { label: 'Forecast', reads: ['task'], nav },
    });
    const raw = {
      name: 'x',
      views,
      home: 'tickets',
      resources: { task: {} },
      nav: [space('desk', ['tickets', 'queue']), space('crm', ['leads'])],
    };
    const placed = placePages(raw, [page({ group: 'crm', position: 0 })], 'x');
    const app = parseTestApp(placed, 'test/app.json');
    const crm = app.nav[1] as { group: string; workspace?: true; children: Array<{ view?: string }> };
    assert.equal(crm.workspace, true);
    assert.deepEqual(
      crm.children.map((node) => node.view),
      ['forecast', 'leads'],
    );
    assert.ok((app.views.forecast as { page?: object }).page, 'parsed as a page');
    const served = servedApp(app, { label: 'demo', dialect: 'sqlite', readAt: '', tables: [], foreignKeys: [] });
    assert.deepEqual(
      (served.nav[1] as { children: Array<{ view?: string }> }).children.map((node) => node.view),
      ['forecast', 'leads'],
    );
    // Left to the top of the menu, it would stand in no workspace: refused with the place to put it.
    assert.throws(
      () => placePages(raw, [page(undefined)], 'x'),
      /\[page-nav\] x: pages\/forecast\.page\.tsx: the App's nav is split into workspaces.*nav: \{ group: 'desk' \}.*The workspaces: desk, crm/,
    );
    assert.deepEqual(placePages(raw, [page(false)], 'x').nav, raw.nav, 'nav: false keeps it out of every workspace');
  });

  test("workspaces stand in the bar across the window, so a header held in the sidebar's head is refused", () => {
    const nav = [space('desk', ['tickets']), space('crm', ['leads'])];
    const withHeader = (header: string) =>
      parseTestApp({ name: 'x', views, home: 'tickets', resources: { task: {} }, nav, ui: { shell: { header } } }, 'test/app.json');
    assert.throws(() => withHeader('sidebar'), /ui\.shell\.header 'sidebar' draws no bar across the window.*Remove header, or say 'bar'/);
    assert.ok(withHeader('bar'));
  });
});
