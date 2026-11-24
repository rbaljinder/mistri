import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carried, carriedSurfaces, tokenizeSlotColors, withoutBareElements } from '../scripts/ui-sdk-css.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The sheets are files here and not imports, so an upgrade of UI SDK would leave the old rules in place unseen. */
test('the carried UI SDK stylesheets match what the installed UI SDK gives', () => {
  assert.equal(
    readFileSync(`${ROOT}packages/ui/src/styles/ui-sdk.css`, 'utf8'),
    carried(),
    'run `node scripts/ui-sdk-css.mjs` and read the difference in ui-sdk.css',
  );
  assert.equal(
    readFileSync(`${ROOT}packages/ui/src/styles/ui-sdk-surfaces.css`, 'utf8'),
    carriedSurfaces(),
    'run `node scripts/ui-sdk-css.mjs` and read the difference in ui-sdk-surfaces.css',
  );
});

/** Both sheets stand in layers that must never dress a host page's bare elements by tag alone. */
test('no rule in the carried sheets dresses an element by its tag alone', () => {
  const kept = withoutBareElements(
    '@layer ui-sdk {\n  a { color: red; }\n  [data-slot="button"] { color: blue; }\n  hr { border: 0; }\n}\n',
  );
  assert.equal(kept.replace(/\s+/g, ' '), '@layer ui-sdk { [data-slot="button"] { color: blue; } } ');
  for (const rel of ['packages/ui/src/styles/ui-sdk.css', 'packages/ui/src/styles/ui-sdk-surfaces.css']) {
    const sheet = readFileSync(`${ROOT}${rel}`, 'utf8');
    for (const tag of ['a', 'hr', 'code', 'kbd', 'button', 'input']) {
      assert.doesNotMatch(sheet, new RegExp(`^  ${tag} \\{`, 'm'), `${rel}: ${tag}`);
    }
  }
});

/** White over a photo or a swatch is not the page's surface: in a dark scheme `--surface` and `--line` are near-black. */
test('parts drawn over imagery keep a light ink in every scheme', () => {
  const said = tokenizeSlotColors(
    '@layer ui-sdk {\n  [data-slot="image-cropper-selection"] {\n    outline: 1px solid oklch(1 0 0);\n  }\n' +
      '  [data-slot="image-cropper-grid"] {\n    --ui-grid-line: oklch(1 0 0 / 0.6);\n  }\n' +
      '  [data-slot="card"] {\n    background: oklch(1 0 0);\n  }\n}\n',
  );
  assert.match(said, /image-cropper-selection"\] \{\n    outline: 1px solid var\(--lightbox-ink\);/);
  assert.match(said, /--ui-grid-line: color-mix\(in srgb, var\(--lightbox-ink\) 60%, transparent\);/);
  assert.match(said, /card"\] \{\n    background: var\(--surface\);/);
  const sheet = readFileSync(`${ROOT}packages/ui/src/styles/ui-sdk-surfaces.css`, 'utf8');
  for (const slot of ['image-cropper-selection', 'image-cropper-grid', 'image-cropper-handle', 'color-picker-area-thumb']) {
    const from = sheet.indexOf(`[data-slot="${slot}"]`);
    assert.notEqual(from, -1, slot);
    const rule = sheet.slice(from, sheet.indexOf('\n  }\n', from));
    assert.match(rule, /var\(--lightbox-ink\)/, slot);
    assert.doesNotMatch(rule, /var\(--(?:surface|line)\)/, slot);
  }
});
