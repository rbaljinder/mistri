/** The stylesheet's promises about the form controls, read off the source: a theme's roles reach them, and nothing shouts. */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css =
  readFileSync(join(import.meta.dirname, 'primitives.css'), 'utf8') + readFileSync(join(import.meta.dirname, 'forms.css'), 'utf8');

const rule = (selector: string): string => new RegExp(`^${selector.replace(/[.[\]*]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';

test('a field label reads the theme label role, 500 where the theme says none', () => {
  expect(rule('.form-field-label')).toContain('font-weight: var(--type-label-weight, 500)');
});

test('the field box reads the fill, height, edge and corner tokens rather than literals', () => {
  const box = rule('.field-control');
  expect(box).toContain('var(--field-fill)');
  expect(box).toContain('var(--control-h)');
  expect(box).toContain('var(--control-border-w)');
  expect(box).toContain('var(--field-radius, var(--radius))');
});

test('nothing here is !important, and no colour is a literal in the form controls', () => {
  expect(css).not.toContain('!important');
  const forms = css.slice(css.indexOf('The form controls (TextField'));
  expect(forms.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});

test("a theme's form recipes are answered here: the optional word, the drawn checkbox, the ruled step and the raised bar", () => {
  expect(css).toContain('[data-look-required="optional-word"] .form-field-optional-word { display: inline; }');
  expect(css).toContain('[data-look-required="optional-word"] .form-field.is-required > .form-field-label::after { content: none; }');
  expect(css).toMatch(/\[data-look-checkbox="drawn"\] :is\(\.field-check[^)]*\)[^{]*\{[^}]*appearance: none/);
  expect(css).toContain('[data-look-form-step="ruled"] .intake-head');
  expect(css).toContain('[data-look-action-bar="raised"] :is(.intake-actions');
});

test('a finger gets 44px and a phone gets 16px text, both under a coarse pointer', () => {
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)', css.indexOf('Mobile.')));
  expect(coarse).toContain('44px / var(--density-zoom, 1)');
  expect(coarse).toMatch(/font-size: max\(16px, var\(--text-base\)\)/);
});

test("the reader's contrast and transparency settings win over a theme, in the one sheet that may say !important", () => {
  const preferences = readFileSync(join(import.meta.dirname, 'preferences.css'), 'utf8');
  expect(preferences).toContain('@media (prefers-contrast: more)');
  expect(preferences).toContain('@media (prefers-reduced-transparency: reduce)');
  expect(preferences).toContain('--line-control: var(--ink) !important');
  expect(preferences).toContain('--scrim: ');
});
