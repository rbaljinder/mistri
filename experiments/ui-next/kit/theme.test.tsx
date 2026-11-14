import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { ELEVATIONS, lookAttribute, RECIPE_MENU, RHYTHMS, TYPE_ATTRIBUTES } from '../../../packages/engine/src/shared/themeRecipes';
import { FONT_TOKENS, PALETTE_TOKENS, RADIUS_TOKENS } from '../../../packages/engine/src/shared/themeTokens';
import { LOOKS, PALETTES, worn } from '../gallery/theme';
import { wearTheme } from '../src/theme';

/* ui-next wears mistri's themes and has no theme language of its own, so these hold its two sheets to mistri's
   own tables, read from the engine's source: a recipe mistri adds, a token it names or a role it gives type
   fails here until ui-next says what it does about it. */

/* By path, not `new URL(…, import.meta.url)`: Vite reads that form as an asset to serve and hands back another file. */
const here = dirname(fileURLToPath(import.meta.url));
const sheet = (name: string) => readFileSync(join(here, '..', 'src', 'theme', name), 'utf8');
const looks = sheet('looks.css');
const bridge = sheet('bridge.css');
const tokens = sheet('tokens.css');

afterEach(() => {
  wearTheme(null);
  document.body.replaceChildren();
});

/* A recipe value with no rule, because ui-next's own drawing already is that treatment. */
const OWN: Record<string, string[]> = {
  bar: ['plain'],
  tabs: ['underline'],
  stat: ['divided'],
  fields: ['open'],
  table: ['open'],
  status: ['dot'],
  board: ['soft'],
  chart: ['plain'],
  links: ['plain'],
  rules: ['hairline'],
  avatar: ['round'],
  workflow: ['markers'],
  lanes: ['tint'],
  header: ['plain'],
  filters: ['dashed'],
  actionBar: ['plain'],
};
/* A recipe value ui-next does not answer yet: worn, it changes nothing. The README says the same. */
const NOT_YET: Record<string, string[]> = {
  windows: ['segmented', 'lifted', 'chosen'],
  stat: ['icon'],
  banner: ['tint', 'gradient', 'plain'],
  steps: ['flat', 'tinted', 'strip'],
  header: ['hero'],
  required: ['star', 'optional-word'],
  checkbox: ['native', 'drawn'],
  formStep: ['plain', 'ruled'],
};

test('every value on the recipe menu is answered, is ui-next’s own drawing, or is listed as not answered', () => {
  for (const [part, values] of Object.entries(RECIPE_MENU)) {
    for (const value of Object.keys(values)) {
      const answered = looks.includes(`[${lookAttribute(part)}='${value}']`);
      const own = OWN[part]?.includes(value) ?? false;
      const notYet = NOT_YET[part]?.includes(value) ?? false;
      expect([answered, own, notYet].filter(Boolean).length, `${part}: ${value}`).toBe(1);
    }
  }
  // Nothing is listed that the menu does not have.
  for (const table of [OWN, NOT_YET])
    for (const [part, values] of Object.entries(table))
      for (const value of values)
        expect(Object.keys((RECIPE_MENU as Record<string, object>)[part] ?? {}), `${part}: ${value}`).toContain(value);
});

test('the sheet answers nothing that is not on mistri’s menu', () => {
  const menu = new Map(Object.entries(RECIPE_MENU).map(([part, values]) => [lookAttribute(part), Object.keys(values)]));
  menu.set('data-look-elevation', Object.keys(ELEVATIONS));
  menu.set('data-look-rhythm', Object.keys(RHYTHMS));
  const said = [...looks.matchAll(/\[(data-look-[a-z-]+)='([a-z-]+)'\]/g)];
  expect(said.length).toBeGreaterThan(60);
  for (const [, attribute, value] of said) expect(menu.get(attribute!), `${attribute}="${value}"`).toContain(value);
  for (const [, attribute] of looks.matchAll(/\[(data-type-[a-z-]+)~=/g)) expect(TYPE_ATTRIBUTES).toContain(attribute);
});

test('a rule reaches as far as the next theme and no further', () => {
  // Every recipe and type rule is a scope that ends where another theme begins, so a theme inside a theme is its own.
  const rules = [...looks.matchAll(/^ {2}(@scope[^\n]*|\[data-(?:look|type|custom)[^\n]*) \{$/gm)].map((found) => found[1]!);
  expect(rules.length).toBeGreaterThan(100);
  for (const rule of rules) expect(rule).toMatch(/^@scope \(.+\) to \(\[data-custom-theme\](, \[data-look-[a-z-]+\])?\)$/);
});

test('a theme inside another starts from nothing: every token mistri can say is put back', () => {
  const start = bridge.indexOf('[data-custom-theme]:not(:root) {');
  const reset = bridge.slice(start, bridge.indexOf('}', start));
  const names = [...Object.values(PALETTE_TOKENS), ...Object.values(FONT_TOKENS), ...Object.values(RADIUS_TOKENS)];
  for (const name of names) {
    // The code face is put back to ui-next's own; every other to nothing, for its fallback to stand in.
    if (name === '--code') expect(reset).toContain('--code: var(--m-own-mono);');
    else expect(reset, name).toContain(`${name}: initial;`);
  }
});

test('what is made from other tokens is made again under a theme, in the same words', () => {
  const said = (css: string) => new Map([...css.matchAll(/^\s+(--[a-z0-9-]+): ([^;]+);$/gm)].map((found) => [found[1]!, found[2]!]));
  const own = said(tokens.slice(0, tokens.indexOf(":root[data-m-mode='light']")));
  const derived = bridge.slice(bridge.indexOf('What is made from other tokens'));
  const again = [...derived.matchAll(/^\s+(--[a-z0-9-]+): ([^;]+);$/gm)];
  expect(again.length).toBeGreaterThan(20);
  const last = new Map<string, string>();
  for (const [, name, value] of again) {
    // The first time a name is said it is tokens.css's own line; said again below, it is the theme's over it.
    if (!last.has(name!)) expect(value, name).toBe(own.get(name!));
    last.set(name!, value!);
  }
  // Every token ui-next owns and a theme can change falls back to ui-next's own, kept at the root.
  for (const [, name] of bridge.matchAll(/var\(--m-own-([a-z0-9-]+)\)/g)) expect(bridge).toContain(`--m-own-${name}: var(--m-${name});`);
});

test('a theme is put on, changed and taken off, leaving nothing behind', () => {
  const box = document.body.appendChild(document.createElement('div'));
  wearTheme(
    {
      attributes: { 'data-look-tabs': 'pill' },
      light: { '--accent': '#112233', '--radius': '4px' },
      dark: { '--accent': '#aabbcc', '--radius': '4px' },
    },
    box,
  );
  expect(box.hasAttribute('data-custom-theme')).toBe(true);
  expect(box.getAttribute('data-look-tabs')).toBe('pill');
  // A colour is said once for both modes; a length is the same in each.
  expect(box.style.getPropertyValue('--accent')).toBe('light-dark(#112233, #aabbcc)');
  expect(box.style.getPropertyValue('--radius')).toBe('4px');

  wearTheme({ attributes: { 'data-look-status': 'pill' }, light: { '--ground': '#ffffff' }, dark: { '--ground': '#000000' } }, box);
  expect(box.hasAttribute('data-look-tabs')).toBe(false);
  expect(box.style.getPropertyValue('--accent')).toBe('');
  expect(box.getAttribute('data-look-status')).toBe('pill');

  wearTheme(null, box);
  expect(box.attributes.length).toBe(box.hasAttribute('style') ? 1 : 0);
  expect(box.style.length).toBe(0);
});

test('each of mistri’s looks, in each palette, is worked out by mistri’s own code and worn whole', () => {
  expect(LOOKS).toEqual(['workshop', 'lumen', 'mono', 'sage', 'ledger']);
  expect(PALETTES.length).toBe(12);
  for (const look of LOOKS) {
    for (const palette of [undefined, ...PALETTES.map((one) => one.id)]) {
      const theme = worn(look, palette)!;
      // One attribute a recipe, and the colours a page cannot be drawn without, in both modes.
      for (const part of Object.keys(RECIPE_MENU)) expect(theme.attributes[lookAttribute(part)], `${look}: ${part}`).toBeTruthy();
      for (const mode of [theme.light, theme.dark])
        for (const name of ['--ground', '--surface', '--ink', '--ink-muted', '--line', '--accent', '--status-good', '--chart-1'])
          expect(mode[name], `${look}/${palette}: ${name}`).toBeTruthy();
    }
  }
  // A palette changes the accent and leaves the recipes alone.
  expect(worn('mono', 'cobalt')!.light['--accent']).not.toBe(worn('mono', undefined)!.light['--accent']);
  expect(worn('mono', 'cobalt')!.attributes).toEqual(worn('mono', undefined)!.attributes);
  // A recipe picked over a look is worn in place of the look's own.
  expect(worn('sage', undefined, { tabs: 'rule' })!.attributes['data-look-tabs']).toBe('rule');
  expect(worn('own', undefined)).toBeNull();
});
