/**
 * A light theme's dark menu (`nav`) over Lumen's pill menu: the menu's current entry is drawn in nav.accent on the
 * menu's dark ground and on the accent's light tint, so no shade of its hue reads on both. check said "No color of
 * its hue passes every check it is in: pick another hue" and named none (a field report); the fix that worked was to
 * drop the light theme's `nav` so the look derives it. check now says that, proved by compiling the theme without
 * it, and says only what it proved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { checkThemeWithFixes } from '../packages/mistri/src/shared/themeFix.js';

const theme = (light: Record<string, unknown>) =>
  compileAppTheme({ id: 'harbor', label: 'Harbor', extends: 'lumen', colors: { light } }, 'ui.customThemes[0]', new Set(), {
    faces: false,
  });

test('a menu color no shade of its hue can fix names the override to leave out, and leaving it out passes', () => {
  const problems = checkThemeWithFixes(theme({ nav: { ground: '#1f2937', ink: '#f9fafb', accent: '#2563eb' } })).filter(
    (problem) => problem.role === 'navAccent',
  );
  assert.ok(problems.length, 'the dark menu fails its current entry');
  for (const problem of problems) {
    assert.equal(problem.fix, undefined, problem.message);
    assert.doesNotMatch(problem.message, /pick another hue/);
    assert.match(
      problem.message,
      /No color of its hue, or of another this theme wears, passes every check it is in\. Leave colors\.light\.nav out, and the look derives the menu's colors, which pass every check they are in\.$/,
    );
  }
  // What it says is so: the theme without its `nav` passes every menu check.
  assert.deepEqual(
    checkTheme(theme({}), {}).filter((problem) => problem.role.startsWith('nav')),
    [],
  );
});

test('where leaving the override out would not pass either, check says so instead of naming a hue', () => {
  // The accent itself is a hair short on its tint, so the menu the look derives from it fails too.
  const problems = checkThemeWithFixes(theme({ accent: '#2563eb', nav: { ground: '#1e3a8a', ink: '#ffffff', accent: '#93c5fd' } })).filter(
    (problem) => problem.role === 'navAccent' && !problem.fix,
  );
  assert.ok(problems.length, 'a menu mark with no fix');
  for (const problem of problems) {
    assert.doesNotMatch(problem.message, /pick another hue|Leave /);
    assert.match(problem.message, /passes every check it is in: change a color it is drawn on\.$/);
  }
});
