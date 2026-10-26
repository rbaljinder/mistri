/*
 * Every page the server sends sizes itself to the visible keyboard and runs under the notch: the viewport
 * meta says `viewport-fit=cover` (so env(safe-area-inset-*) means something) and
 * `interactive-widget=resizes-content` (so an open keyboard shrinks the layout, and a sticky action bar rides above it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { withHead, groundsMeta } from '../packages/engine/src/server/clientHttp.js';

const files = execFileSync(
  'grep',
  ['-rl', 'name="viewport"', ...['kit', 'mistri', 'engine', 'tablewalk', 'ui'].map((p) => `packages/${p}/src`)],
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean);

test('every served page asks for the cover viewport that resizes with the keyboard', () => {
  assert.ok(files.length >= 7, `found ${files.length} pages`);
  for (const file of files) {
    if (file.endsWith('PagePreview.ts')) continue; // an iframe's srcdoc, not a served page
    const metas = readFileSync(file, 'utf8').match(/<meta name="viewport"[^>]*>/g) ?? [];
    assert.ok(metas.length, file);
    for (const meta of metas) {
      assert.match(meta, /width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content/, file);
    }
  }
});

test('a page wears its theme: color-scheme and one theme-color per mode', () => {
  const page = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>';
  const both = withHead(page, { grounds: { light: '#fafaf7', dark: '#111111' } });
  assert.match(both, /<meta name="color-scheme" content="light dark">/);
  assert.match(both, /<meta name="theme-color" content="#fafaf7" media="\(prefers-color-scheme: light\)">/);
  assert.match(both, /<meta name="theme-color" content="#111111" media="\(prefers-color-scheme: dark\)">/);
  const dark = groundsMeta({ light: '#fafaf7', dark: '#111111', scheme: 'dark-only' });
  assert.match(dark, /color-scheme" content="dark"/);
  assert.equal(dark.match(/theme-color/g)?.length, 1);
  assert.doesNotMatch(dark, /#fafaf7/);
});
