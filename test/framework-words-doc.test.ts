/**
 * The languages page lists every platform word an App's catalog may say (`mistri.*`). It is generated from the
 * catalog source (scripts/framework-words-doc.mjs), so a word added there cannot be missing from the page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PAGE, rewrite } from '../scripts/framework-words-doc.mjs';
import { FRAMEWORK_WORDS } from '../packages/engine/src/shared/frameworkWords.js';

test('the languages page lists every framework word, as the catalog says it', () => {
  const page = readFileSync(PAGE, 'utf8');
  assert.equal(page, rewrite(page), 'run node scripts/framework-words-doc.mjs and commit the page');
  for (const key of Object.keys(FRAMEWORK_WORDS)) assert.ok(page.includes(`| \`${key}\` |`), key);
});
