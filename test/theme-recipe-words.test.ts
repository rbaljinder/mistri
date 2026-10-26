import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RECIPE_MENU } from '../packages/engine/src/shared/themeRecipes.js';
import { RECIPE_WORDS, recipeDescription } from '../packages/engine/src/shared/themeRecipeWords.js';
import { alikeNotes } from '../packages/mistri/src/server/build/shot.js';

/**
 * TC9: a recipe value was a picture and an enum. An agent choosing recipes reads
 * text and could not tell `ruled` from `soft` without opening an image, and
 * `shot --recipes` drew two values that look the same in a still side by side
 * without saying so. Every value is now said in a sentence, in the schema an
 * editor and the DSL reference show and on the gallery page, and the sheet's run
 * names the pairs it could not tell apart.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every recipe value on the menu is said in a sentence, in the menu’s order', () => {
  assert.deepEqual(Object.keys(RECIPE_WORDS), Object.keys(RECIPE_MENU));
  for (const part of Object.keys(RECIPE_MENU) as Array<keyof typeof RECIPE_MENU>) {
    assert.deepEqual(Object.keys(RECIPE_WORDS[part]), Object.keys(RECIPE_MENU[part]), `recipes.${part}`);
    for (const [value, words] of Object.entries(RECIPE_WORDS[part] as Record<string, string>))
      assert.match(words, /^[A-Z].{20,}\.$/, `recipes.${part} ${value} is a sentence`);
  }
});

test('the schema describes each recipe part by its values’ words, and the gallery lists them under each picture', () => {
  const schema = JSON.parse(readFileSync(`${ROOT}packages/mistri/schema/theme.schema.json`, 'utf8'));
  const gallery = readFileSync(`${ROOT}site/src/content/docs/docs/theme-recipes.md`, 'utf8');
  for (const part of Object.keys(RECIPE_MENU) as Array<keyof typeof RECIPE_MENU>) {
    const said = schema.properties.recipes.properties[part];
    assert.equal(said.description, recipeDescription(part));
    assert.deepEqual(said.enum, Object.keys(RECIPE_MENU[part]));
    for (const [value, words] of Object.entries(RECIPE_WORDS[part] as Record<string, string>))
      assert.ok(gallery.includes(`- \`${value}\`: ${words}`), `the gallery says recipes.${part} ${value}`);
  }
  // What a person runs when the menu changes: the files are what the script writes.
  execFileSync(process.execPath, ['scripts/recipe-words.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('shot --recipes names each pair of values that draw a page nearly alike, closest first', () => {
  const values = ['ruled', 'soft', 'strip'];
  const notes = alikeNotes('recipes.board', '/orders', values, [
    { a: 0, b: 1, share: 0.001 },
    { a: 0, b: 2, share: 0.2 },
    { a: 1, b: 2, share: 0 },
  ]);
  assert.equal(notes.length, 2);
  assert.match(
    notes[0]!,
    /^note: recipes\.board soft and strip draw \/orders the same: nothing on it shows them apart; https:\/\/mistriwork\.dev\/docs\/theme-recipes\/ says each in words\.$/,
  );
  assert.match(notes[1]!, /^note: recipes\.board ruled and soft draw \/orders nearly alike: 0\.1% of the picture differs;/);
  // A pair a reader tells apart at a glance — a pill against a dot changes 0.4% of a list — is not named.
  assert.deepEqual(alikeNotes('recipes.status', '/leads', ['dot', 'pill'], [{ a: 0, b: 1, share: 0.004 }]), []);
  // A shape part has no words to point at.
  assert.doesNotMatch(
    alikeNotes(
      'radius.pill',
      '/orders',
      ['0', '999', '4'],
      [
        { a: 0, b: 1, share: 0 },
        { a: 0, b: 2, share: 0.3 },
      ],
    )[0]!,
    /says each in words/,
  );
  // A page that draws nothing of the part is said once, not as a pair after pair the same.
  assert.deepEqual(
    alikeNotes(
      'recipes.steps',
      '/leads',
      ['flat', 'tinted', 'strip'],
      [
        { a: 0, b: 1, share: 0 },
        { a: 0, b: 2, share: 0 },
        { a: 1, b: 2, share: 0 },
      ],
    ),
    ['note: no value of recipes.steps changes /leads: nothing on it is drawn by that part. Name a route that shows one.'],
  );
});
