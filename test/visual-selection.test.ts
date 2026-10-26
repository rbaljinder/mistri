import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVisualApps } from '../scripts/visual-selection.mjs';

const apps = [
  {
    id: 'tick',
    pages: [
      ['tasks', '/'],
      ['done', '/?tab=done'],
    ],
  },
  { id: 'depot', signedOut: [['sign-in', '/']], pages: [['tasks', '/tasks']] },
  { id: 'dynamic', start() {}, pages: [] },
];
const ids = (filter: string | undefined) => selectVisualApps(apps, filter).map((app: { id: string }) => app.id);

test('unfiltered matrix retains all Apps and their coverage', () => {
  assert.deepEqual(ids(undefined), ['tick', 'depot', 'dynamic']);
});
test('filters retain every matching subject, including signed-out and dynamic pages', () => {
  assert.deepEqual(ids('tick/tasks'), ['tick', 'dynamic']);
  assert.deepEqual(ids('tasks'), ['tick', 'depot', 'dynamic']);
  assert.deepEqual(ids('sign-in'), ['depot', 'dynamic']);
  assert.deepEqual(ids('missing'), ['dynamic']);
});
