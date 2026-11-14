/** The stylesheet's promises about the form controls, read off the source: a theme's roles reach them, a screen's needs are met, and nothing shouts. */
import { expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const styles = join(import.meta.dirname, 'styles');
const sheet = (name: string): string => readFileSync(join(styles, name), 'utf8');
const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('a field label takes the weight the theme label role says', () => {
  const looks = sheet('looks.css');
  const at = looks.indexOf("@scope ([data-type-label~='weight'])");
  expect(at).toBeGreaterThan(-1);
  const rule = looks.slice(at, looks.indexOf('}', at));
  expect(rule).toContain("[data-slot='field-label']");
  expect(rule).toContain('font-weight: var(--type-label-weight)');
});

test('a control is as wide as its answer, from the kind the form already knows', () => {
  const screens = bare(sheet('screens.css'));
  for (const kind of ['number', 'time', 'money', 'date', 'datetime']) expect(screens).toContain(`[data-answer='${kind}']`);
  expect(screens).toMatch(
    /\[data-slot='field'\]\[data-answer\] > :is\([^)]*\[data-slot='field-box'\][^)]*\) \{\s*max-inline-size: var\(--answer-max\)/,
  );
});

test('no colour is a literal in the form controls: each is a token a theme can move', () => {
  for (const name of ['forms.css', 'kit-fields.css', 'kit-parts.css', 'screens.css'])
    expect(bare(sheet(name)), name).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});

test('nothing is !important but what is said again against a bare-element rule', () => {
  const shouting = readdirSync(styles)
    .filter((name) => name.endsWith('.css') && bare(sheet(name)).includes('!important'))
    .sort();
  expect(shouting).toEqual(['guard.css']);
});

test("a theme's form recipes are answered: the optional word, the ruled step and the raised bar", () => {
  const looks = sheet('looks.css');
  expect(looks).toContain("[data-look-required='optional-word']");
  expect(looks).toContain("[data-look-form-step='ruled']");
  expect(looks).toContain("[data-look-action-bar='raised']");
});

test('a finger gets 44px and a phone gets 16px text, both under a coarse pointer', () => {
  const screens = bare(sheet('screens.css'));
  const finger = screens.slice(screens.indexOf('@media (pointer: coarse), (max-width: 40rem)'));
  expect(finger).toContain('min-height: calc(44px / var(--density-zoom, 1))');
  expect(finger).toContain("[data-slot='button']:not([data-size='sm'])");
  const phone = screens.slice(screens.lastIndexOf('@media (pointer: coarse)'));
  expect(phone).toMatch(/font-size: max\(16px, var\(--m-text\)\)/);
});

test("the reader's contrast and transparency settings win over a theme, and reach the parts through the tokens they read", () => {
  const preferences = readFileSync(join(import.meta.dirname, 'preferences.css'), 'utf8');
  expect(preferences).toContain('@media (prefers-contrast: more)');
  expect(preferences).toContain('@media (prefers-reduced-transparency: reduce)');
  const moved = [...preferences.matchAll(/^\s*(--[a-z-]+):[^;]*!important/gm)].map((found) => found[1]!);
  expect(moved).toContain('--line-control');
  expect(moved).toContain('--scrim');
  // Each token the reader's setting moves is one a part reads, by its own name or under the part's: none is left
  // for a sheet here to say a second time.
  const read = sheet('m-tokens.css');
  const NOT_A_PART = ['--scrim-light', '--lightbox-ground'];
  expect(moved.filter((token) => !NOT_A_PART.includes(token) && !read.includes(`var(${token}`))).toEqual([]);
});

test("a part its caller dresses keeps the SDK's coarse-pointer hit area anchored to itself, not to the pane", () => {
  // The SDK draws a touch hit area as an absolute `::after` against a part it makes relative; `data-own` reverts the
  // part to static, so the m-own layer makes it relative again or the hit area spreads over the nearest positioned ancestor.
  expect(bare(sheet('ui-sdk.css'))).toMatch(/@media \(pointer: coarse\)[\s\S]*::after[\s\S]*position: absolute/);
  const own = bare(sheet('guard.css'));
  const layer = own.slice(own.indexOf('@layer m-own'));
  expect(layer).toMatch(/@media \(pointer: coarse\) \{\s*button\[data-slot\]\[data-own\],[\s\S]*?\{\s*position: relative;/);
  expect(layer).not.toMatch(/\[data-own\]::after/);
});
