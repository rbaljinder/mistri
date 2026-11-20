/**
 * Every sentence a public page says is a framework word (`mistri.*`), so an App with a catalog says the whole page in
 * its visitor's language rather than half of it: the public form, the saved form, its status check and receipt, and
 * the link page drawn on the server. Enumerated, not sampled: a sentence added to one of these surfaces in English
 * alone fails here, before a visitor is shown it beside their own language.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FRAMEWORK_WORDS, type FrameworkWordKey } from '../packages/engine/src/shared/frameworkWords.js';
import { FRAMEWORK_WORDS_ES } from '../packages/engine/src/shared/frameworkWordsEs.js';
import { say as formSay } from '../packages/mistri/src/client/copy/forms/components/FormSurface.js';
import { say as savedSay } from '../packages/mistri/src/client/copy/forms/components/SavedFormSurface.js';
import { say as statusSay } from '../packages/mistri/src/client/copy/public/components/FormStatusSurface.js';

const root = new URL('../packages/mistri/src/', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

/* Said by count (`one`/`other`): the form's "N answers need another look" line, which a framework word, one sentence,
   cannot carry. Named here so the list of what a catalog cannot say stays short and seen. */
const PLURAL = new Set(['answersNeedALook', 'fieldsNeedFixing']);

const SURFACES = [
  { component: 'client/components/FormSurface.tsx', copy: 'client/copy/forms/components/FormSurface.ts', say: formSay },
  { component: 'client/components/SavedFormSurface.tsx', copy: 'client/copy/forms/components/SavedFormSurface.ts', say: savedSay },
  { component: 'client/components/FormStatusSurface.tsx', copy: 'client/copy/public/components/FormStatusSurface.ts', say: statusSay },
] as const;

/** A copy table's own keys: its first-level members, two spaces in. */
const keysOf = (table: string) => [...table.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]!);

for (const surface of SURFACES) {
  test(`${surface.component}: every sentence of its own is said through a framework word whose English it is`, () => {
    const text = source(surface.component);
    const keys = keysOf(source(surface.copy));
    assert.ok(keys.length > 5, 'the copy table was read');
    const said = (key: string) => (surface.say as (key: string) => string)(key);
    for (const key of keys) {
      if (PLURAL.has(key)) continue;
      const calls = [...text.matchAll(new RegExp(`\\bsay\\('${key}'`, 'g'))];
      for (const call of calls) {
        const before = text.slice(Math.max(0, call.index! - 80), call.index);
        const word = /appWord\(\s*'(mistri\.[\w.]+)',\s*$/.exec(before)?.[1];
        assert.ok(word, `${key} is said bare at ${surface.component}:${text.slice(0, call.index).split('\n').length}`);
        assert.ok(Object.hasOwn(FRAMEWORK_WORDS, word), `${word} is a framework word`);
        assert.equal(FRAMEWORK_WORDS[word as FrameworkWordKey], said(key), `${word} is ${key}'s English`);
      }
    }
  });
}

test('the link page says every sentence through a framework word, and its English is the table’s', () => {
  const text = source('server/links/linkPage.ts');
  const used = new Set([...text.matchAll(/'(mistri\.[\w.]+)'/g)].map((match) => match[1]!));
  const link = Object.keys(FRAMEWORK_WORDS).filter((key) => key.startsWith('mistri.link.'));
  for (const key of link) assert.ok(used.has(key), `${key} is drawn by the link page`);
  assert.ok(used.has('mistri.language'), 'the switch is named by a framework word');
  for (const key of used) assert.ok(Object.hasOwn(FRAMEWORK_WORDS, key), `${key} is a framework word`);
});

test('Spanish ships for every framework word, with the same placeholders as the English', () => {
  for (const [key, english] of Object.entries(FRAMEWORK_WORDS)) {
    const spanish = FRAMEWORK_WORDS_ES[key as FrameworkWordKey];
    assert.ok(spanish && spanish.trim(), `${key} has Spanish`);
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(holes(spanish), holes(english), `${key} fills the same placeholders`);
  }
  assert.deepEqual(Object.keys(FRAMEWORK_WORDS_ES).sort(), Object.keys(FRAMEWORK_WORDS).sort());
});
