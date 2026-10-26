import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* An App has no Workbench: it serves its declared resources through its own
   surfaces, and the standalone browser is the tool for the rest. So there is
   no switch that shows one, in the definition or in its types. */
const parse = (shell: unknown) =>
  parseAppConfig(
    {
      name: 'Workbench visibility',
      resources: { tasks: {} },
      views: { tasks: { kind: 'list', from: 'tasks' } },
      home: 'tasks',
      ui: { shell },
    },
    'workbench shell fixture',
  );

test('an App definition has no Workbench switch', () => {
  assert.equal(parse({}).ui.shell, undefined);
  for (const value of [true, false]) assert.throws(() => parse({ workbench: value }), /ui\.shell has "workbench", which is gone/);
});

test('the public App declarations have no Workbench switch either', () => {
  const filename = new URL('./.app-no-workbench-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, type AppConfig, listView } from '@mistriwork/mistri/app';
    defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{counts:true}}});
    // @ts-expect-error An App has no Workbench.
    const invalid: AppConfig = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{workbench:true}}};
    void invalid;
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
