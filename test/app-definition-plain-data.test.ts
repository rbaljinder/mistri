/**
 * N05: a definition that holds a function is refused at the load, naming the key and where it is, and the fix.
 * Before, the worker's own sentence ("() => {} could not be cloned") reached the author with no key in it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';

test('a function in the definition is named by its path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-plain-data-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'app.mjs'),
    `export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: { title: () => 'Tasks' } }, views: { tasks: { kind: 'list', from: 'task', show: ['a', () => 1] } }, home: 'tasks' };\n`,
  );
  await assert.rejects(
    loadApp(dir),
    (error: Error) =>
      /the app must be plain data — default export\.resources\.task\.title is a function, which a definition cannot hold\. Write it as a literal value/.test(
        error.message,
      ) && /command, job or page module/.test(error.message),
  );
});

test('a function inside a list is named with its index', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-plain-data-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'app.mjs'),
    `export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task', show: ['a', () => 1] } }, home: 'tasks' };\n`,
  );
  await assert.rejects(loadApp(dir), /default export\.views\.tasks\.show\[1\] is a function/);
});
