import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const section = (s: Record<string, unknown>) =>
  parsePagesConfig({ pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections: [s] }] }, 'pages');

test('a retired fields form is refused with the whole table of what each is now', () => {
  for (const s of [
    { kind: 'fields', show: ['a'], presentation: 'accordion' },
    { kind: 'fields', show: ['a'], collapsed: true },
    { kind: 'fields', show: ['a'], presentation: 'card' },
    { kind: 'fields', show: ['a'], presentation: 'headline' },
    { kind: 'fields', show: ['a'], actions: [] },
  ]) {
    assert.throws(
      () => section(s),
      /Fields forms that are gone, and what each is now:\n.*presentation: 'card'[\s\S]*presentation: 'headline'[\s\S]*presentation: 'accordion'[\s\S]*collapsed/,
    );
  }
});

test('ui.shell.workbench says an App serves no Workbench and what to do instead', () => {
  assert.throws(
    () => parseAppConfig({ name: 'X', resources: {}, views: {}, ui: { shell: { workbench: true } } }, 'x'),
    /"workbench", which is gone: an App serves only the resources it declares and no Workbench at all.*npx tablewalk/,
  );
});

test("a metric's `view` is told as `to`", () => {
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'X',
          resources: { task: {} },
          views: {
            tasks: { kind: 'list', from: 'task' },
            overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'metric', title: 'Open', from: 'task', view: 'tasks' }] },
          },
        },
        'x',
      ),
    /has "view", which is now "to"/,
  );
});

test("sizing on an App page's related list says nothing there replaces it, and what to do for a wide table", () => {
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'X',
          resources: { vehicle: {}, part: {} },
          views: { vehicles: { kind: 'list', from: 'vehicle' } },
          pages: {
            vehicle: { base: 'vehicle', sections: [{ kind: 'list', title: 'Parts', from: 'part', whose: 'vehicle_id', sizing: 'scroll' }] },
          },
        },
        'x',
      ),
    /an App page does not use it: a related table fits its pane.*fewer columns.*list view of its own/i,
  );
});
