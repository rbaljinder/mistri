/**
 * provisionStores follows the App's declaration: given the definition and no
 * `only` it makes the stores the App declares, and an `only` that names one
 * it never declared is refused before anything is made.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { declaredStores } from '../packages/mistri/src/server/stores/declaredStores.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';

// declaredStores reads only these keys; the definition is not a whole App.
const app = (declares: object): AppDef => ({ resources: {}, ...declares }) as unknown as AppDef;
const notifying = app({ assistant: {}, resources: { notes: { notify: [{ send: { channel: 'email' } }] } } });

const fresh = () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-declared-'));
  const path = join(directory, 'app.db');
  new DatabaseSync(path).close();
  return { path, done: () => rmSync(directory, { recursive: true, force: true }) };
};
const tables = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '\\_\\_mistri\\_%' ESCAPE '\\'`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
};

test('the declaration names the stores: notify wants the inbox and, by email, the integrations; assistant its own; nothing else', async () => {
  assert.deepEqual(await declaredStores(notifying), ['inbox', 'integrations', 'assistant', 'live-change']);
  assert.deepEqual(await declaredStores(app({})), []);
});

test('given the definition and no `only`, every store the App declares is made, and none it does not', async (t) => {
  const f = fresh();
  t.after(f.done);
  const made = await provisionStores({ sqlite: f.path }, { app: { id: 'notes', definition: notifying } });
  assert.deepEqual(Object.keys(made.stores).sort(), ['assistant', 'inbox', 'integrations', 'live-change']);
  assert.ok(tables(f.path).some((name) => name.startsWith('__mistri_assistant_')));
  assert.ok(!tables(f.path).some((name) => name.startsWith('__mistri_branding_') || name.startsWith('__mistri_decision_')));
  // Again: nothing is created twice.
  const again = await provisionStores({ sqlite: f.path }, { app: { id: 'notes', definition: notifying } });
  assert.ok(Object.values(again.stores).every((each) => each.provisioned === false));
});

test('an `only` naming a store the App does not declare is refused, and nothing is made', async (t) => {
  const f = fresh();
  t.after(f.done);
  await assert.rejects(
    provisionStores({ sqlite: f.path }, { app: { id: 'notes', definition: notifying }, only: ['assistant', 'branding'] }),
    /does not declare "branding".*declares "inbox", "integrations", "assistant", "live-change"/,
  );
  assert.deepEqual(tables(f.path), []);
  const named = await provisionStores({ sqlite: f.path }, { app: { id: 'notes', definition: notifying }, only: ['assistant'] });
  assert.deepEqual(Object.keys(named.stores), ['assistant']);
});
