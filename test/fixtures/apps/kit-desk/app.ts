/*
 * Kit desk: the browser gate's own App for a control kit (`uiKit`, Preview) —
 * every button, dialog, menu, typeahead and date field on its pages drawn by
 * ui/kit.tsx, a kit of plain HTML with no dependency, which also passes the
 * conformance suite (ui/kit.test.tsx). Owned by e2e/ui-kit.spec.ts and sized
 * to it: two owners, two tasks. Do not grow it to demonstrate a feature.
 */
import { action, defineApp, fields, listView, page } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export default defineApp({
  id: 'kit-desk',
  name: 'Kit desk',
  sources: { desk: { connection: 'desk' } },
  resources: {
    owner: { noun: 'owner', recordLabel: '{name}' },
    task: {
      noun: 'task',
      access: 'write',
      recordLabel: '{title}',
      form: { show: ['title', 'owner_id', 'due'] },
      actions: {
        close: action('Close task', { set: { status: 'closed' }, when: 'status = open', confirm: true }),
      },
    },
  },
  views: {
    tasks: listView('Tasks', 'task', { show: ['title', 'owner_id', 'due', 'status'], rowActions: true }),
  },
  pages: {
    task: page('task', [fields(['title', 'owner_id', 'due', 'status'], { columns: 2 })]),
  },
  home: 'tasks',
  nav: ['tasks'],
  ui: { locale: 'en-US' },
  uiKit: './ui/kit.tsx',
} satisfies App);
