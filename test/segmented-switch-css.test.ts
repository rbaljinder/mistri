/**
 * One drawing for every segmented switch (themeFamilies.css): a tray whose corner is its item's plus the gap between
 * them, no field edge on it, and the chosen item shown as the look's `current` recipe says. A switch drawn with a
 * `--line-control` outline and a solid accent fill inside a smaller-cornered box is what Bloom showed (pills in a
 * rounded rectangle, framed like a text field); these hold the rules that stop it coming back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../packages/kit/src/client/themeFamilies.css', import.meta.url), 'utf8');
const rules = [...css.matchAll(/(^|\n)([^\n{}@/][^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[2].trim(), body: m[3] }));
const TRACK = '.kit-segmented, .list-layout, .record-presentation, .json-modes';
const track = rules.find((rule) => rule.selector.includes(`:is(${TRACK})`) && rule.body.includes('--seg-pad'));
const sel = (rule: { selector: string }) => rule.selector;

test('the tray and its items are the same switch in every surface', () => {
  assert.ok(track, 'a rule draws the tray of every switch');
  for (const part of ['.kit-segmented', '.list-layout', '.record-presentation', '.json-modes']) assert.ok(sel(track!).includes(part), part);
  for (const item of ['.kit-segment', '.list-layout-seg', '.presentation-seg', '.json-mode'])
    assert.ok(
      rules.some((rule) => sel(rule).includes(item) && rule.body.includes('--seg-item-radius')),
      `${item} takes the item radius`,
    );
});

test('the tray corner is the item corner plus its padding and hairline, and a square item keeps a square tray', () => {
  const radius =
    /border-radius:\s*min\(calc\(var\(--seg-item-radius\) \+ var\(--seg-pad\) \+ 1px\),\s*calc\(var\(--seg-item-radius\) \* 1000\)\)/;
  assert.match(track!.body, radius);
  assert.match(track!.body, /--seg-item-radius:\s*var\(--control-radius,\s*var\(--radius\)\)/);
});

test('a switch tray wears no field edge', () => {
  assert.doesNotMatch(track!.body, /line-control/);
  assert.match(track!.body, /border:\s*1px solid var\(--line\)/);
  for (const rule of rules.filter((r) => /list-layout|presentation|kit-segment|json-mode/.test(sel(r))))
    assert.doesNotMatch(rule.body, /line-control/, sel(rule));
});

test('the chosen item follows the current recipe: a lifted key, a tint, or the filled base', () => {
  const chosen = (attribute: string) =>
    rules.find((r) => sel(r).startsWith(`:root[data-theme-style]${attribute} `) && sel(r).includes('aria-pressed'));
  const lifted = chosen("[data-look-windows='lifted']");
  assert.ok(
    lifted &&
      /background:\s*var\(--surface\)/.test(lifted.body) &&
      /color:\s*var\(--ink\)/.test(lifted.body) &&
      /--shadow-control/.test(lifted.body),
  );
  assert.doesNotMatch(lifted!.body, /--accent\b/);
  const tint = chosen("[data-look-windows='tint']");
  assert.ok(tint && /--accent-soft/.test(tint.body));
  assert.ok(
    rules.some((r) => sel(r).startsWith(":root[data-theme-style][data-look-tabs='inverted']") && r.body.includes('background: var(--ink)')),
  );
});
