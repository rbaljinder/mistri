/** Narrow ratchet for cleaned App navigation states, not a blanket exception
 * for the legacy palette and shadow literals still in visualThemes.css. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../packages/kit/src/client/visualThemes.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const body = (selector: string) => {
  const matches = rules.filter((rule) => rule[1].trim().endsWith(selector));
  assert.equal(matches.length, 1, selector);
  return matches[0][2];
};
test('App nav states derive their tints from nav ink and write mode keeps the checked danger/surface pair', () => {
  for (const [selector, percent] of [
    ['.tn-item[aria-current="true"]', 5],
    ['.topbar .tn-search', 3],
    ['.tn-group-button[aria-expanded="true"]', 7],
  ] as const) {
    const declaration = body(selector);
    assert.ok(declaration.includes(`color-mix(in srgb, var(--nav-ink) ${percent}%, transparent)`));
    assert.doesNotMatch(declaration, /#[0-9a-f]{3,8}\b|\brgba?\(/i);
  }
  const write = body('.topbar .mode[aria-pressed="true"]');
  assert.match(write, /color: var\(--status-critical\)/);
  assert.match(write, /background: var\(--surface\)/);
  assert.match(write, /border-color: var\(--status-critical\)/);
  assert.doesNotMatch(write, /#[0-9a-f]{3,8}\b|\brgba?\(/i);
});
test('list filter popovers use the globally defined shadow token without a duplicate color fallback', () => {
  const css = readFileSync(new URL('../../packages/kit/src/client/components/ListFilterBar.css', import.meta.url), 'utf8');
  assert.match(css, /box-shadow: var\(--shadow-pop\);/);
  assert.doesNotMatch(css, /var\(--shadow-pop\s*,/);
});
