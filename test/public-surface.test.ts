/**
 * The public surface against its checked-in inventory.
 *
 * test/fixtures/public-surface.json lists every public name (the DSL keys and
 * enum values, the package entry points and their exports, the CLI, the MCP
 * tools, the `check` codes); scripts/public-surface.mjs generates it. Any
 * difference fails, an addition too: the change is the regenerated file in
 * the same commit, so a review sees what moved. From 1.0.0 (package.json's
 * version) a public name is promised until the next major (docs/compatibility.md):
 * a removal, a rename or a demotion to preview fails with that said, and
 * `--write` refuses to regenerate it away without `--major`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { breaks, diffSurface, dslSection, frozen, iconsSection, liveSurface, readInventory } from '../scripts/public-surface.mjs';

type Inventory = { sections: Record<string, Record<string, 'public' | 'preview'>> };
type Difference = Record<string, { added: string[]; removed: string[]; changed: string[] }>;

const message = (found: Difference) =>
  Object.entries(found)
    .map(([section, { added, removed, changed }]) =>
      [
        `${section}:`,
        ...added.slice(0, 15).map((name) => `  + ${name}`),
        ...removed.slice(0, 15).map((name) => `  - ${name}`),
        ...changed.slice(0, 15).map((name) => `  ~ ${name}`),
      ].join('\n'),
    )
    .join('\n');

describe('the public surface', () => {
  test('the live surface matches the inventory', async () => {
    const recorded = readInventory() as Inventory;
    const difference = diffSurface(recorded, await liveSurface()) as Difference;
    const broken = frozen() ? (breaks(difference, recorded) as Difference) : {};
    assert.deepEqual(
      broken,
      {},
      `A public name went or became preview, which 1.x promises it will not:\n${message(broken)}\n` +
        'Keep it working and deprecate it (packages/mistri/src/shared/deprecations.ts); it goes only in a major release (docs/compatibility.md).',
    );
    assert.deepEqual(
      difference,
      {},
      `The public surface changed:\n${message(difference)}\nRegenerate with: node scripts/public-surface.mjs --write`,
    );
  });

  test('the freeze starts at the first major version', () => {
    assert.equal(frozen('0.8.14'), false);
    assert.equal(frozen('1.0.0'), true);
    assert.equal(frozen('1.4.2'), true);
    assert.equal(frozen('2.0.0-rc.1'), true);
  });

  test("an App's preview root keys say @preview where an editor shows them", () => {
    /* The root keys of AppConfig in the authored types, each with the doc comment above it. */
    const types = readFileSync(new URL('../packages/mistri/schema/app.d.ts', import.meta.url), 'utf8');
    const body = /^export interface AppConfig \{\n([\s\S]*?)^\}/m.exec(types)?.[1] ?? '';
    const tagged = new Map<string, boolean>();
    let doc = '';
    for (const line of body.split('\n')) {
      const key = /^ {2}([A-Za-z]+)\??:/.exec(line)?.[1];
      if (key) {
        tagged.set(key, /@preview\b/.test(doc));
        doc = '';
      } else if (/^ {2}\/\*\*/.test(line) || doc) doc = /^ {2}[a-z]/.test(line) ? '' : doc + line;
    }
    const dsl = (readInventory() as Inventory).sections.dsl;
    const roots = Object.entries(dsl).filter(([name]) => /^app: [A-Za-z]+$/.test(name));
    assert.ok(roots.length > 10 && tagged.size >= roots.length, 'AppConfig was read');
    for (const [name, status] of roots)
      assert.equal(
        tagged.get(name.slice(5)),
        status === 'preview',
        `${name} is ${status}: its doc comment in packages/mistri/schema/app.d.ts ${status === 'preview' ? 'says' : 'must not say'} @preview`,
      );
  });

  describe('what breaks the promise', () => {
    const recorded: Inventory = { sections: { dsl: { 'app: a': 'public', 'app: b': 'public', 'app: p': 'preview' } } };
    const live = (entries: Record<string, 'public' | 'preview'>) => ({ sections: { dsl: entries } });
    const differs = (entries: Record<string, 'public' | 'preview'>) => diffSurface(recorded, live(entries)) as Difference;
    const broken = (entries: Record<string, 'public' | 'preview'>) => breaks(differs(entries), recorded) as Difference;

    test('every difference needs the regenerated inventory, an addition too', () => {
      assert.deepEqual(differs({ 'app: a': 'public', 'app: b': 'public', 'app: p': 'preview', 'app: c': 'public' }).dsl.added, ['app: c']);
      assert.deepEqual(differs({ 'app: a': 'public', 'app: b': 'public' }).dsl.removed, ['app: p']);
      assert.deepEqual(differs({ 'app: a': 'public', 'app: b': 'public', 'app: p': 'public' }).dsl.changed, ['app: p']);
      assert.deepEqual(differs({ 'app: a': 'public', 'app: b': 'public', 'app: p': 'preview' }), {});
    });

    test('a public name removed, renamed or demoted breaks it; an addition and a preview name do not', () => {
      assert.deepEqual(broken({ 'app: a': 'public', 'app: b': 'public', 'app: p': 'preview', 'app: c': 'public' }), {}, 'an addition');
      assert.deepEqual(broken({ 'app: a': 'public', 'app: b': 'public' }), {}, 'a preview name may go');
      assert.deepEqual(broken({ 'app: a': 'public', 'app: b': 'public', 'app: p': 'public' }), {}, 'a preview name may graduate');
      assert.deepEqual(broken({ 'app: a': 'public', 'app: p': 'preview' }).dsl.removed, ['app: b'], 'a removal');
      assert.deepEqual(broken({ 'app: a': 'public', 'app: b2': 'public', 'app: p': 'preview' }).dsl.removed, ['app: b'], 'a rename');
      assert.deepEqual(broken({ 'app: a': 'public', 'app: b': 'preview', 'app: p': 'preview' }).dsl.changed, ['app: b'], 'a demotion');
    });
  });

  describe('the inventory is compact and still guards', () => {
    /* The schemas, one edit made: what the inventory would say if that edit shipped. */
    const edited = (edit: (app: Record<string, any>) => void) => {
      const app = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
      edit(app);
      return (name: string) =>
        name === 'app.schema.json' ? app : JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}`, import.meta.url), 'utf8'));
    };
    const frozenAfter = (section: 'dsl' | 'icons', entries: object) => {
      const recorded = readInventory() as Inventory;
      const live = { sections: { ...recorded.sections, [section]: entries as Inventory['sections'][string] } };
      return breaks(diffSurface(recorded, live), recorded) as Difference;
    };

    test('an icon is listed once, and removing one breaks the freeze', () => {
      const recorded = readInventory() as Inventory;
      assert.ok(recorded.sections.icons['icon house']);
      // `motion = "house"` is a theme's pace and `rhythm = "house"` its spacing, not icons.
      assert.ok(
        !Object.keys(recorded.sections.dsl).some((name) => name.endsWith(' = "house"') && !/\.(?:motion|rhythm) = "house"$/.test(name)),
        'no icon key repeats the names',
      );
      const found = frozenAfter(
        'icons',
        iconsSection(
          edited((app) => {
            app.$defs.appIcon.enum = app.$defs.appIcon.enum.filter((icon: string) => icon !== 'house');
          }),
        ),
      );
      assert.deepEqual(found.icons?.removed, ['icon house']);
    });

    test('a feature slice is one rule per root key it mirrors, and removing a root key breaks the freeze', () => {
      const recorded = readInventory() as Inventory;
      assert.equal(recorded.sections.dsl['app: features[].views mirrors views'], 'public');
      assert.ok(!Object.keys(recorded.sections.dsl).some((name) => name.startsWith('app: features[].views.')));
      const found = frozenAfter(
        'dsl',
        dslSection(
          edited((app) => {
            delete app.properties.views;
          }),
        ),
      );
      assert.ok(found.dsl?.removed.includes('app: views'), 'the root key');
      assert.ok(found.dsl?.removed.includes('app: features[].views mirrors views'), 'the mirror rule, now listed in full');
    });

    test('a shape many keys take is listed once, so one rename is one failure', () => {
      const recorded = readInventory() as Inventory;
      const names = Object.keys(recorded.sections.dsl);
      assert.ok(recorded.sections.dsl['app: <component>.props'], 'the shape, under its own name');
      assert.ok(recorded.sections.dsl['app: resources.*.display.* = <component>'], 'the key that takes it says so');
      assert.ok(!names.some((name) => /\.component\.props/.test(name)), "no key repeats the shape's keys");
      assert.ok(!names.some((name) => /\.title\.(fallback|translations)$/.test(name)), 'a message is not spelled out at each key');
      const found = frozenAfter(
        'dsl',
        dslSection(
          edited((app) => {
            delete app.$defs.component.properties.props;
          }),
        ),
      );
      assert.ok(found.dsl?.removed.includes('app: <component>.props'), 'one rename, one entry');
      assert.ok(
        !found.dsl?.removed.some((name: string) => name.includes('.component.props')),
        'and not one per key that takes a component',
      );
    });

    test('the keys every kind of a section list shares are listed once', () => {
      const recorded = readInventory() as Inventory;
      const names = Object.keys(recorded.sections.dsl);
      assert.ok(recorded.sections.dsl['app: pages.*.sections[][kind=*].title']);
      assert.ok(recorded.sections.dsl['app: views.*[kind=dashboard].sections[][kind=*].width']);
      assert.ok(!names.some((name) => /sections\[\]\[kind=(fields|metric)\]\.title/.test(name)), 'not once per kind');
    });
  });
});
