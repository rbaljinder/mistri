/**
 * A deprecated key still works and says what replaces it (docs/compatibility.md,
 * "Deprecation"). The registry is empty at 1.0, so the walk is held here with
 * entries of its own, and the real registry is held to the inventory: a key on
 * its way out is still a public name until the major that removes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPRECATIONS, deprecatedKeys, deprecatedOf } from '../packages/mistri/src/shared/deprecations.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { readInventory } from '../scripts/public-surface.mjs';
import { parseTestApp as parseAppConfig } from './support/commandCatalog.js';

const raw = {
  name: 'Desk',
  views: {
    tasks: { kind: 'list', from: 'task', oldKey: 'a' },
    week: { kind: 'dashboard', oldKey: 'b' },
  },
  resources: { task: { display: { due: { oldFormat: true }, owner: { format: 'old' }, total: { format: 'money' } } } },
  features: [{ id: 'billing', views: { invoices: { kind: 'list', from: 'invoice', oldKey: 'c' } } }],
};

test('each place a deprecated key or value is written is one warning, under its own code', () => {
  const found = deprecatedKeys(raw, [
    { key: 'app: views.*[kind=list].oldKey', since: '1.2', instead: 'Say "newKey".' },
    { key: 'app: resources.*.display.*.oldFormat', since: '2.4', instead: 'Say "format".' },
    { key: 'app: resources.*.display.*.format = "old"', since: '1.5', instead: "Say format: 'new'." },
  ]);
  assert.deepEqual(found, [
    '"views.tasks.oldKey" [deprecated]: deprecated since 1.2, and removed in 2.0. Say "newKey".',
    '"features[0].views.invoices.oldKey" [deprecated]: deprecated since 1.2, and removed in 2.0. Say "newKey".',
    '"resources.task.display.due.oldFormat" [deprecated]: deprecated since 2.4, and removed in 3.0. Say "format".',
    '"resources.task.display.owner.format" [deprecated]: deprecated since 1.5, and removed in 2.0. Say format: \'new\'.',
  ]);
  assert.equal(validationCode(found[0]), 'deprecated');
  assert.deepEqual(deprecatedKeys(raw, []), [], 'nothing deprecated, nothing said');
});

test('the registry names public keys, each with the release that deprecated it', () => {
  const dsl = readInventory().sections.dsl as Record<string, string>;
  for (const { key, since, instead } of DEPRECATIONS) {
    assert.equal(dsl[key], 'public', `${key} is deprecated, so it still works: keep it in the inventory until the major that removes it`);
    assert.match(since, /^[1-9]\d*\.\d+$/, `${key}: since is a minor release, "1.3"`);
    assert.ok(instead.trim(), `${key} says what to write instead`);
  }
});

test('a parsed App carries what it deprecates to check, and a current one carries nothing', () => {
  const app = parseAppConfig(
    { name: 'Desk', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' },
    'app',
  );
  assert.deepEqual(deprecatedOf(app), []);
});
