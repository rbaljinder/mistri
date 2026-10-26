/** CSS literal debt: exact reviewed declarations, never broad property exemptions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cssColorInventory, type CssColorDeclaration } from './cssColorInventory.js';
import { inPackages } from '../support/packages.js';

test('CSS inventory sees declarations, not selectors, comments, strings or URL data', () => {
  const source = `/* color: red */ #abc[data-name="red"] { content: "red; #fff {}"; background: url("data:image/svg+xml,#fff"); color: var(--red); border-color: currentColor; }`;
  assert.deepEqual(cssColorInventory(source), []);
  for (const value of [
    '#abc',
    'RED',
    'rgb(0 0 0 / .2)',
    'hsl(0 20% 20%)',
    'oklch(.5 .2 20)',
    'color(display-p3 1 0 0)',
    'var(--x, blue)',
    'color-mix(in srgb, var(--x), white)',
  ]) {
    assert.deepEqual(cssColorInventory(`@media (prefers-color-scheme: dark) { .selected { color: ${value} } }`), [
      { context: '@media (prefers-color-scheme: dark) > .selected', property: 'color', value },
    ]);
  }
  assert.throws(() => cssColorInventory('.x { color: \\72 ed }'), /review/);
  assert.throws(() => cssColorInventory('.x { color: rgb(0 0 0)'), /Unbalanced/);
  // This inventory conservatively flags invalid 5/7-digit hex too; it is
  // not the stylesheet validator, and does not certify CSS value validity.
  for (const value of ['#abcde', '#abcdef0']) assert.equal(cssColorInventory(`.x { color: ${value} }`).length, 1);
});

test('live CSS literals equal the reviewed palette/shadow/backdrop inventory', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = [...inPackages('src/client'), 'packages/ui/src']
    .flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.css'))
        .map((file) => `${dir}/${file.split('\\').join('/')}`),
    )
    .sort();
  const actual = files.flatMap((file) => cssColorInventory(readFileSync(join(root, file), 'utf8')).map((entry) => ({ file, ...entry })));
  const reviewed = JSON.parse(readFileSync(new URL('./theme-colors.baseline.json', import.meta.url), 'utf8')) as Array<
    CssColorDeclaration & { file: string; reason: string }
  >;
  // `mask-alpha`: a mask reads a gradient's alpha, never its hue, so its opaque stop is `#000` in every look and mode;
  // there is no theme colour to move (a scroll edge's fade, the tabs' edge reveal).
  // `scan-contrast`: a QR code is near-black on white in every look and mode, because many scanners refuse an
  // inverted code (docs/design.md, Lumen's exceptions).
  for (const entry of reviewed)
    assert.ok(
      /* signature-ground: a signature is drawn as dark ink on paper in every look, so the PNG it keeps reads on any page. */
      ['palette', 'shadow', 'backdrop', 'scroll-shadow', 'swatch-boundary', 'scan-contrast', 'signature-ground', 'mask-alpha'].includes(
        entry.reason,
      ),
      'Every exact exception needs a reviewed reason',
    );
  assert.deepEqual(
    actual,
    reviewed.map(({ reason: _reason, ...entry }) => entry),
    'New literals need semantic tokens or explicit review; obsolete exceptions must be removed. No automatic baseline update.',
  );
});
