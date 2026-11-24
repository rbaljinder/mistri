import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECIPE_MENU } from '../packages/engine/src/shared/themeRecipes.js';

/**
 * A look is tokens and recipes, and the kit's sheets answer the recipes for the kit's own parts by the kit's own
 * class names. The on-demand entries (`@mistriwork/mistri/charts`, `/primitives`, `/views`) draw `.nx-*` parts none
 * of those rules reach, so their sheets answer the same recipes again (components/sdk/surfaces-*.css, in `look`).
 * This holds the two sides together: every value the kit dresses for a part that has an SDK twin is answered for
 * the twin, by value and never by a look's name, in tokens and never in a colour.
 */
const SDK = 'packages/mistri/src/client/components/sdk';
const SDK_SHEETS = ['surfaces-base.css', 'surfaces-charts.css', 'surfaces-primitives.css', 'surfaces-views.css'];
const bare = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** What the on-demand sheets say in `look`: everything from their first `@layer look` to the next layer. */
const lookOf = (file: string) => {
  const css = bare(join(SDK, file));
  return [...css.matchAll(/@layer look \{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join('\n');
};
const sdkLook = SDK_SHEETS.map(lookOf).join('\n');

/* The kit's sheets: every stylesheet of the kit, and @mistriwork/ui's answers for its own slots. */
const KIT = 'packages/kit/src/client';
const kitCss = [
  ...readdirSync(KIT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.css'))
    .map((file) => join(KIT, file)),
  'packages/ui/src/styles/looks.css',
]
  .map(bare)
  .join('\n');

const valuesIn = (css: string, part: string) =>
  new Set([...css.matchAll(new RegExp(`data-look-${part}=["']([a-z-]+)["']`, 'g'))].map((match) => match[1]!));

/**
 * The parts with an SDK twin, the twin's hook (a class the twin renders, which lookRecipes.test.tsx holds it to), and
 * the values that need no rule of their own with the reason: such a value is the part's drawing under every look, said
 * once by the `[data-theme-style]` rule or by the part's own sheet.
 */
const TWINS: Record<string, { hook: string; own: Record<string, string> }> = {
  table: { hook: '.nx-data-table-surface', own: {} },
  stat: { hook: '.nx-stat-card', own: {} },
  board: { hook: '.nx-kanban-lane', own: { ruled: 'what every look draws unless it says otherwise: the [data-theme-style] rule' } },
  lanes: { hook: '.nx-kanban-lane-title', own: {} },
  tabs: { hook: '.nx-tabs-list', own: { underline: "the tabs' own drawing (layout-display.css): an underline under the chosen tab" } },
  status: { hook: '.nx-badge', own: {} },
  chart: { hook: '.nx-chart-', own: { plain: "the charts' own drawing (charts.css)" } },
};

for (const [part, { hook, own }] of Object.entries(TWINS)) {
  test(`${part}: every value the kit dresses, and every value on the menu, reaches the SDK twin`, () => {
    const menu = Object.keys((RECIPE_MENU as Record<string, Record<string, string | null>>)[part]!);
    const dressed = valuesIn(kitCss, part);
    const answered = valuesIn(sdkLook, part);
    const wanted = new Set([...menu, ...dressed]);
    const missing = [...wanted].filter((value) => !answered.has(value) && !(value in own));
    assert.deepEqual(
      missing,
      [],
      `a ${part} value the kit dresses and the SDK twin does not: answer it in ${SDK}/surfaces-*.css, or say in TWINS why it needs no rule`,
    );
    for (const value of Object.keys(own))
      assert.ok(!answered.has(value), `${part}=${value} is answered now; take it off TWINS.${part}.own`);
    for (const value of answered) assert.ok(menu.includes(value), `${part}=${value} is not on the menu (${menu.join(', ')})`);
    /* Each answered value names the twin in a rule of its own: a value read only beside another part's hook is not this part's answer. */
    for (const value of answered) {
      const rule = new RegExp(`data-look-${part}=["']${value}["'][^{}]*\\{`, 'g');
      const selectors = [...sdkLook.matchAll(rule)].map((match) => match[0]);
      assert.ok(selectors.length > 0, `${part}=${value}`);
    }
    assert.ok(sdkLook.includes(hook), `${hook} is named by the look rules`);
  });
}

test('the SDK look rules read a recipe by its value, never a look by its name', () => {
  assert.deepEqual(
    [...sdkLook.matchAll(/data-(?:visual-theme|theme-style|theme-preset)=["']?[a-z]/g)].map((match) => match[0]),
    [],
  );
});

test('the SDK look rules say no colour of their own: every colour is a token of the look', () => {
  const literals = [...sdkLook.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/g)].map((match) => match[0]);
  assert.deepEqual(literals, []);
});

test('the SDK look rules dress only the on-demand parts: a declarative page keeps the kit’s drawing', () => {
  /* The sheets stay loaded when a reader walks from a free-form page to a list, so a rule here that named only a
     kit part, a bare element or a slot would redress the kit's own. A rule either names an `.nx-*` part (a nested
     rule names its parent's), or sets nothing but properties those parts read, on what wears the look. */
  const stray: string[] = [];
  for (const file of ['surfaces-base.css', 'surfaces-charts.css', 'surfaces-views.css']) {
    for (const match of lookOf(file).matchAll(/(?:^|[{};])\s*([^{};@]+)\{([^{}]*)/g)) {
      const prelude = match[1]!.trim();
      const setsOnlyProperties = /^(?:\[data-[a-z-]+(?:~?='[a-z-]+')?\](?:,\s*)?)+$/.test(prelude) && !/(?:^|;)\s*[a-z]/.test(match[2]!);
      if (prelude && !prelude.includes('.nx-') && !prelude.includes('&') && !setsOnlyProperties) stray.push(`${file}: ${prelude}`);
    }
  }
  assert.deepEqual(stray, []);
});
