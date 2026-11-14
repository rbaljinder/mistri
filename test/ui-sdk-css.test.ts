import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carried, withoutBareElements } from '../scripts/ui-sdk-css.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The sheet is a file here and not an import, so an upgrade of UI SDK would leave the old rules in place unseen. */
test('the carried UI SDK stylesheet is what the installed UI SDK gives', () => {
  assert.equal(
    readFileSync(`${ROOT}packages/ui/src/styles/ui-sdk.css`, 'utf8'),
    carried(),
    'run `node scripts/ui-sdk-css.mjs` and read the difference',
  );
});

/** It stands in a later layer than the kit's and an App's own element rules: a rule for `a` there would take theirs over. */
test('no rule in it dresses an element by its tag alone', () => {
  const kept = withoutBareElements(
    '@layer ui-sdk {\n  a { color: red; }\n  [data-slot="button"] { color: blue; }\n  hr { border: 0; }\n}\n',
  );
  assert.equal(kept.replace(/\s+/g, ' '), '@layer ui-sdk { [data-slot="button"] { color: blue; } } ');
  const sheet = readFileSync(`${ROOT}packages/ui/src/styles/ui-sdk.css`, 'utf8');
  for (const tag of ['a', 'hr', 'code', 'kbd', 'button', 'input']) assert.doesNotMatch(sheet, new RegExp(`^  ${tag} \\{`, 'm'), tag);
});
