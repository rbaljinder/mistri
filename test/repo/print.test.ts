/*
 * On paper (docs/design.md): a record or a list prints as its content. The
 * print block in style.css lets the page out of the fixed-height shell,
 * hides what operates the screen, forces ink on white through the system's
 * colours, and keeps rows whole. A block that loses one of these prints a
 * blank sheet or one window's worth, and no screen test would notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../packages/kit/src/client/style.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The whole `@media print { … }` block, braces matched. */
function printBlock(): string {
  const start = css.indexOf('@media print');
  assert.notEqual(start, -1, 'style.css has no @media print block');
  let depth = 0;
  for (let at = css.indexOf('{', start); at < css.length; at += 1) {
    if (css[at] === '{') depth += 1;
    else if (css[at] === '}' && (depth -= 1) === 0) return css.slice(start, at + 1);
  }
  throw new Error('The print block never closes.');
}

test('paper lets the page out of the shell and forces ink on white', () => {
  const block = printBlock();
  assert.match(block, /body\s*\{[^}]*height:\s*auto/);
  assert.match(block, /\.content\s*\{[^}]*overflow:\s*visible/);
  assert.match(block, /color-scheme:\s*light/);
  assert.match(block, /background:\s*Canvas;/);
  assert.match(block, /color:\s*CanvasText/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'paper names no colour of its own');
});

test('paper hides what operates the screen, and keeps a row whole', () => {
  const block = printBlock();
  const hidden =
    /([^{}]+)\{\s*display:\s*none\s*!important;?\s*\}/
      .exec(block)?.[1]!
      .split(',')
      .map((selector) => selector.trim()) ?? [];
  for (const chrome of [
    '.topbar',
    '.sidebar',
    '.page-head-actions',
    '.pending-dock',
    '.applist-controls',
    '.pager',
    '.inline-edit-button',
  ]) {
    assert.ok(hidden.includes(chrome), `${chrome} still prints`);
  }
  assert.match(block, /\.page-section,[^{]*\{[^}]*break-inside:\s*avoid/);
  assert.match(block, /\.page-tabpanel\[hidden\]\s*\{\s*display:\s*none/);
});

/* G79: the trail was sticky, so it printed over the top of a record's first sheet, and a component's own styles
   cannot reach it to hide it. */
test("paper drops the walk's trail: a record prints none of it, a list keeps only its title", () => {
  const block = printBlock();
  for (const part of ['.crumb-home', '.crumbs .sep', '.crumbs > button', '.crumbs > .current', '.record-trail']) {
    assert.match(
      block,
      new RegExp(`${part.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}[^{]*\\{\\s*display:\\s*none !important`),
      `${part} still prints`,
    );
  }
  assert.match(block, /\.crumbs\s*\{[^}]*position:\s*static/, 'the trail no longer stands over the sheet');
  assert.match(block, /\.crumbs:has\(> \.crumb-note:empty\)\s*\{\s*display:\s*none/);
});
