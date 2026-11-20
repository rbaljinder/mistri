#!/usr/bin/env node
/**
 * The table of platform words an App's catalog may say (`mistri.*`) in the languages page, generated from the catalog
 * source (packages/engine/src/shared/frameworkWords.ts) so it cannot miss a key. A note beside a key is kept by hand
 * in NOTES below; `Reads` is the `{name}` arguments the English reads.
 *
 *   node scripts/framework-words-doc.mjs           rewrite the table
 *   node scripts/framework-words-doc.mjs --check   fail if the committed table differs (test/framework-words-doc.test.ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_WORDS } from '../packages/engine/src/shared/frameworkWords.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGE = join(ROOT, 'site/src/content/docs/docs/languages.md');
const NOTES = { 'mistri.form.timeHint': 'How a time of day is written after the date' };
const HEADER = '| Key | Said as | Reads |\n| --- | --- | --- |\n';

const cell = (text) => String(text).replace(/\|/g, '\\|').trim();

export function table() {
  const rows = Object.entries(FRAMEWORK_WORDS).map(([key, said]) => {
    const args = [...said.matchAll(/\{(\w+)\}/g)].map((match) => `\`{${match[1]}}\``);
    const reads = [...new Set(args)].join(', ');
    return `| \`${key}\` | ${cell(said)} | ${NOTES[key] ?? reads} |`.replace(/ \| {2}\|$/, ' | |');
  });
  return HEADER + rows.join('\n') + '\n';
}

/** The page with its table made from the catalog: the block from the header to the first line that is not a row. */
export function rewrite(page) {
  const start = page.indexOf(HEADER + '| `mistri.');
  if (start < 0) throw new Error('languages.md has no table of mistri.* words');
  let end = start + HEADER.length;
  while (page.startsWith('| `mistri.', end)) end = page.indexOf('\n', end) + 1;
  return page.slice(0, start) + table() + page.slice(end);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = readFileSync(PAGE, 'utf8');
  const next = rewrite(page);
  if (process.argv.includes('--check')) {
    if (next !== page) {
      console.error('site languages.md table is stale: run node scripts/framework-words-doc.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(PAGE, next);
    console.log(`Wrote ${Object.keys(FRAMEWORK_WORDS).length} words to ${PAGE}`);
  }
}
