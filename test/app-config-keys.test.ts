/**
 * AppConfig's top-level keys, each with the reason it is a key.
 *
 * Every key is something an author learns, a checker validates, a skill teaches and the 1.x promise freezes
 * (docs/compatibility.md). The count only ever grew by "one more thing an App says", so it is held here the way
 * scripts/bundle-budget.mjs holds a ceiling: the number moves only in a commit that records why, beside the key.
 * A new screen is a page (`pages`) or a section of one, or an existing key's option, before it is a key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every top-level key of AppConfig and why it could not be an option of another. */
const KEYS: Record<string, string> = {
  flags: 'Preview: typed feature flags are read by every surface, so they cannot live in one view',
  audiences: 'Preview: flag rules and experiment eligibility share one set of named audiences',
  experiments: 'Preview: epochs span flags and analytics',
  analytics: 'Preview: behavior events are declared once for the whole App',
  assistant: 'The in-App assistant composes any block under the signed-in role, so it belongs to no one view',
  retention: 'How long the runtime keeps what it writes about the whole App',
  id: 'The App is addressed by it',
  name: 'The App is titled by it',
  shortName: 'What a phone bar and an installed icon say where name does not fit',
  connection: 'Which database the App is for',
  sources: 'Named bindings when the App reads more than one database or an HTTP source',
  resources: 'The logical tables every view, page and command refers to',
  unions: 'Read-only resources over tables that share a shape; not a table of their own',
  auth: 'Roles and sign-in decide what every other key may show',
  api: 'What the App API and MCP expose to scoped tokens',
  track: 'What every command keeps unless one says otherwise',
  live: 'Whether open pages follow other people changes, App-wide',
  branding: 'What each tenant may change about how the App looks; a tenant App only',
  views: 'Everything a visitor can open, keyed by address',
  pages: 'Record pages, and free-form pages, keyed by id',
  features: 'Ordered slices of content merged at load',
  home: 'Where a visitor starts',
  nav: 'The menu: arrangement only',
  ui: 'Look, density and components for the whole App',
  uiKit: "The App's own control primitives replace the default ones in every view",
};

const declared = () => {
  const source = readFileSync(fileURLToPath(new URL('../packages/mistri/schema/app.d.ts', import.meta.url)), 'utf8');
  const body = /^export interface AppConfig \{\n([\s\S]*?)\n\}/m.exec(source)?.[1];
  assert.ok(body, 'AppConfig was not found in schema/app.d.ts');
  return [...body.matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)].map((match) => match[1]!);
};

test('AppConfig has the keys recorded here, and no more', () => {
  const found = declared();
  const added = found.filter((key) => !(key in KEYS));
  const removed = Object.keys(KEYS).filter((key) => !found.includes(key));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    'AppConfig gained or lost a top-level key. Adding one needs a recorded reason: put it in KEYS in test/app-config-keys.test.ts ' +
      'with why it could not be an option of an existing key. A new screen should be a page or an existing section first.',
  );
});
