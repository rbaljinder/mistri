/*
 * Selectors a browser drops without a word. `:is()` and `:where()` take a
 * forgiving list: an item they cannot read is left out, not refused, and a
 * relative one (`> .head`) is only readable inside `:has()`. So
 * `.section :is(> .head)` matches nothing, no parser warns — lightningcss
 * empties it to `:is()` and moves on — and every declaration under it is
 * dead. Tray's heading band sat on two such rules from the day it was
 * written; its titles wrapped out of the band and nobody could see why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sheets = inPackages('src/client')
  .flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.css'))
      .map((file) => `${dir}/${file.split('\\').join('/')}`),
  )
  .sort();

/** Each `:is(…)`, `:where(…)` and `:not(…)` argument list in the sheet, split at its own top-level commas. */
export function forgivingItems(css: string): Array<{ line: number; pseudo: string; item: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  const found: Array<{ line: number; pseudo: string; item: string }> = [];
  for (const match of text.matchAll(/:(is|where|not|matches)\(/g)) {
    let depth = 1,
      at = match.index! + match[0].length,
      start = at;
    const items: string[] = [];
    for (; at < text.length && depth; at++) {
      const ch = text[at];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) items.push(text.slice(start, at));
      else if (ch === ',' && depth === 1) {
        items.push(text.slice(start, at));
        start = at + 1;
      }
    }
    const line = text.slice(0, match.index).split('\n').length;
    for (const item of items) found.push({ line, pseudo: match[1], item: item.trim() });
  }
  return found;
}

test('the reader finds relative items, and only at their own level', () => {
  assert.deepEqual(
    forgivingItems('.a :is(> .b, .c) {}\n.d:has(> .e) {}').map(({ item }) => item),
    ['> .b', '.c'],
  );
  assert.deepEqual(
    forgivingItems('.a > :is(.b, :not(.c, .d)) {}').map(({ pseudo, item }) => `${pseudo} ${item}`),
    ['is .b', 'is :not(.c, .d)', 'not .c', 'not .d'],
  );
});

test('no stylesheet puts a relative selector where only :has() can read one', () => {
  const dead = sheets.flatMap((file) =>
    forgivingItems(readFileSync(join(root, file), 'utf8'))
      .filter(({ item }) => /^[>+~]/.test(item))
      .map(({ line, pseudo, item }) => `${file}:${line}: :${pseudo}(${item}) matches nothing; write "> :${pseudo}(…)" instead`),
  );
  assert.deepEqual(dead, []);
});
