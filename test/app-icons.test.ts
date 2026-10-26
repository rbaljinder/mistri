/**
 * Menu icons and the icon rail, as authored: an `icon` on a view or a nav
 * group is one of the curated App icons or refused with the nearest ones; it
 * rides the served App to the menus; `ui.shell.rail` folds only a side menu
 * that exists. And the one list of names agrees with the public types and
 * the JSON schema, so an author's editor and the parser never disagree.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { parseAppConfig, resolveViews } from '../packages/mistri/src/shared/app.js';
import { parseFormView } from '../packages/mistri/src/shared/appForms.js';
import { APP_ICONS } from '../packages/engine/src/shared/appIcons.js';
import { appLook } from '../packages/mistri/src/shared/appUi.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Icons',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'tasks',
      name: 'tasks',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
};
const parse = (extra: object = {}) =>
  parseAppConfig(
    {
      name: 'Icons',
      resources: { tasks: {} },
      views: {
        tasks: { kind: 'list', from: 'tasks', icon: 'list-checks' },
        overview: { kind: 'dashboard', label: 'Overview', icon: 'gauge', sections: [{ kind: 'note', text: 'Hello.' }] },
      },
      nav: [{ id: 'work', label: 'Work', icon: 'briefcase', children: ['overview', 'tasks'] }],
      home: 'tasks',
      ...extra,
    },
    'icons fixture',
  );

test('a view and a nav group name an icon, and it rides the served App to the menus', () => {
  const app = parse();
  const served = servedApp(app, schema);
  assert.equal((resolveViews(app, schema).tasks as { icon?: string }).icon, 'list-checks');
  assert.equal((served.views.overview as { icon?: string }).icon, 'gauge');
  assert.equal((served.views.tasks as { icon?: string }).icon, 'list-checks');
  assert.deepEqual(served.nav[0], {
    group: 'work',
    label: 'Work',
    icon: 'briefcase',
    children: [
      { view: 'overview', label: 'Overview' },
      { view: 'tasks', label: 'Tasks' },
    ],
  });
});

test("a dashboard's star rides the served App, as a list's does", () => {
  /* resolveDashboard rebuilds its view key by key; `favorite` was parsed and
     then dropped there, so a starred dashboard never showed its star. */
  const app = parse({
    views: {
      tasks: { kind: 'list', from: 'tasks', favorite: true },
      overview: { kind: 'dashboard', label: 'Overview', favorite: true, sections: [{ kind: 'note', text: 'Hello.' }] },
    },
  });
  const served = servedApp(app, schema);
  assert.equal((served.views.overview as { favorite?: true }).favorite, true);
  assert.equal((served.views.tasks as { favorite?: true }).favorite, true);
});

test('an icon that is not an App icon is refused with the nearest names and where the rest are', () => {
  const view = (icon: unknown) => () => parse({ views: { tasks: { kind: 'list', from: 'tasks', icon } }, nav: undefined });
  assert.throws(view('kanbam'), /"icon": "kanbam", which is not one of the App icons\. Did you mean "kanban"\?/);
  assert.throws(view('chart'), /Did you mean "chart-bar", "chart-line", "chart-pie"\?/);
  // Nothing near: no guess, only the list.
  assert.throws(
    view('xylophone'),
    (error: Error) => /The icons: house, tray, list/.test(error.message) && !/Did you mean/.test(error.message),
  );
  assert.throws(view(''), /has an "icon" that is not an icon's name/);
  assert.throws(
    () => parse({ nav: [{ id: 'work', label: 'Work', icon: 'suitcase', children: ['tasks'] }] }),
    /\(work\) has "icon": "suitcase"/,
  );
  // A public form is in no menu, so it has nowhere to show one.
  assert.throws(
    () => parseFormView({ kind: 'form', label: 'Apply', public: true, icon: 'house' }, 'views.apply'),
    /public form, which is in no menu, so it takes no "icon"/,
  );
});

test('a decorative App logo uses the curated icon names and reaches signed-out presentation', () => {
  const app = parse({ ui: { logo: 'buildings' } });
  assert.equal(app.ui.logo, 'buildings');
  assert.deepEqual(appLook(app), { id: 'icons', name: 'Icons', logo: 'buildings' });
  assert.throws(() => parse({ ui: { logo: 'building' } }), /ui has "logo": "building", which is not one of the App icons/);
  assert.throws(
    () => parse({ ui: { logo: 'https://example.com/logo.svg' } }),
    /ui has "logo": "https:\/\/example.com\/logo\.svg", which is not one of the App icons/,
  );
  assert.throws(() => parse({ ui: { logo: '' } }), /ui has a "logo" that is not an icon's name/);
});

test('the rail folds a side menu that exists, and is refused where there is none to fold', () => {
  assert.deepEqual(parse({ ui: { shell: { rail: true } } }).ui.shell, { rail: true });
  assert.deepEqual(parse({ ui: { shell: { placement: 'side', rail: true } } }).ui.shell, { placement: 'side', rail: true });
  assert.throws(() => parse({ ui: { shell: { rail: 'yes' } } }), /ui\.shell\.rail must be true or false/);
  assert.throws(
    () => parse({ ui: { shell: { placement: 'top', rail: true } } }),
    /needs the side placement; this shell has placement "top"/,
  );
  // `rail: false` says nothing a default does not, and is accepted as written.
  assert.deepEqual(parse({ ui: { shell: { placement: 'top', rail: false } } }).ui.shell, { placement: 'top', rail: false });
});

test('one list of icon names: the parser, the public types and the JSON schema agree', () => {
  const types = readFileSync(new URL('../packages/mistri/schema/app.d.ts', import.meta.url), 'utf8');
  const union = /export type AppIconName =([^;]+);/.exec(types)?.[1] ?? '';
  assert.deepEqual(
    [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]),
    [...APP_ICONS],
  );
  const jsonSchema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(jsonSchema.$defs.appIcon.enum, [...APP_ICONS]);
  assert.equal(new Set(APP_ICONS).size, APP_ICONS.length, 'no icon is listed twice');
});

test("a misspelled icon in a helper with overloads does not break the helper's typing; check names it at the icon", () => {
  /* AppIcon was a closed union, so an icon the types did not know failed every overload of `metric` and TypeScript
     reported the last one ("'to' does not exist in type ..."), far from the typo. The types now take the names
     and any lowercase word; the parser is what refuses one that is not an App icon. */
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.app-icons-typecheck.ts');
  const source = [
    'import { metric } from "@mistriwork/mistri/app";',
    'import type { AppIcon } from "@mistriwork/mistri/app";',
    'export const known: AppIcon = "stethoscope";',
    'export const typo: AppIcon = "stethoscop";',
    'export const section = metric("Visits", "visit", { icon: "stethoscop", compare: "previous" });',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
  assert.throws(
    () => parse({ views: { tasks: { kind: 'list', from: 'tasks', icon: 'stethoscop' } }, nav: undefined }),
    /Did you mean "stethoscope"/,
  );
  assert.match(APP_ICONS.join(','), /stethoscope/);
});
