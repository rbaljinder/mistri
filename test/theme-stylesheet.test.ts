import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThemeStylesheet, STYLESHEET_MAX } from '../packages/mistri/src/server/app/themeStylesheet.js';
import { partSelector } from '../packages/mistri/src/server/app/themePartSelectors.js';

/**
 * A theme's own stylesheet is read by an allowlist (themeStylesheet.ts): what it admits is re-written from what
 * matched, scoped to the theme and put in the `theme` layer; anything else is a problem naming its line and why.
 * The injection cases are the reason the reader tokenizes rather than matches text: a brace in a string, an
 * escape, a comment splitting a property.
 */
const read = (source: string) =>
  readThemeStylesheet(source, { themeId: 'workshop', selectorFor: partSelector, url: (file) => `/a/_brand/${file.slice(2)}` });
const refused = (source: string) => {
  const { css, problems } = read(source);
  assert.equal(css, '', `nothing is served while a problem stands: ${source}`);
  assert.ok(problems.length, `refused: ${source}`);
  return problems;
};

test('an admitted rule is scoped to the theme, its part written as the platform selects it, in the theme layer', () => {
  const { css, problems } = read('[data-part="stat"] {\n  background: var(--raised);\n  border: 1px solid var(--line-strong);\n}\n');
  assert.deepEqual(problems, []);
  assert.match(css, /^@layer theme \{\n/);
  assert.ok(
    css.includes(
      `:root[data-visual-theme="workshop"] :is(${partSelector('stat')}) { background: var(--raised); border: 1px solid var(--line-strong); }`,
    ),
  );
});

test('dark mode is the theme root in dark, said by the reader and by the system', () => {
  const { css } = read('[data-mode="dark"] [data-part="banner"] { color: var(--ink); }');
  assert.ok(css.includes(':root[data-visual-theme="workshop"][data-theme="dark"] :is('));
  assert.ok(css.includes('@media (prefers-color-scheme: dark) { :root[data-visual-theme="workshop"]:not([data-theme="light"]) :is('));
});

test('accepted: states, role mixes, gradients, pictures, corners, lifts, faces, case and underlines', () => {
  const accepted = [
    '[data-part="nav.item"]:hover { background-color: color-mix(in srgb, var(--nav-ground) 90%, var(--nav-ink)); }',
    '[data-part="tab.current"][aria-selected="true"] { border-bottom: 2px solid var(--accent); }',
    '[data-part="nav.current"][aria-current="page"], [data-part="link"]:focus-visible { text-decoration-line: underline; }',
    '[data-part="ground"] { background-image: repeating-linear-gradient(0deg, var(--line) 0 1px, transparent 1px 4px); }',
    '[data-part="ground"] { background-image: url(./paper.png); background-size: 64px 64px; background-repeat: repeat; }',
    '[data-part="button.primary"] { border-radius: var(--pill-radius); box-shadow: var(--shadow-card); }',
    '[data-part="section.title"] { font-family: var(--heading-font); text-transform: uppercase; letter-spacing: var(--track-caps); }',
    '[data-part="stat.figure"] { font-variant-numeric: oldstyle-nums tabular-nums; }',
    '[data-part="table.row"] { background: linear-gradient(to right, var(--band) 0%, var(--surface) 100%); }',
    '/* a comment */ [data-part="tag"] { color: var(--status-good); }',
  ];
  for (const source of accepted) assert.deepEqual(read(source).problems, [], source);
  assert.ok(read(accepted[4]!).css.includes('url("/a/_brand/paper.png")'));
  assert.deepEqual(read(accepted[4]!).files, ['./paper.png']);
});

test('refused selectors: tags, classes, ids, :has(), *, an unpublished part, an unknown state', () => {
  for (const selector of [
    'div',
    '.btn-primary',
    '#content',
    '[data-part="stat"]:has(a)',
    '*',
    '[data-part="sidebar"]',
    '[data-part="stat"] span',
    '[data-part="stat"]::after',
    '[data-part="stat"]:active',
    ':root',
  ])
    refused(`${selector} { color: var(--ink); }`);
});

test('refused declarations, each with its reason', () => {
  const cases: [string, RegExp][] = [
    ['display: none', /C13/],
    ['visibility: hidden', /C13/],
    ['opacity: 0.5', /C13/],
    ['padding: 4px', /C5/],
    ['width: 100px', /C5/],
    ['font-size: 20px', /type\.roles/],
    ['transition: color 1s', /motion/],
    ['outline: none', /C3/],
    ['color: #ff0000', /role/],
    ['color: red', /role/],
    ['color: var(--anything)', /role/],
    ['background: url(https://example.com/x.png)', /beside the sheet/],
    ['background: url(./missing/../../etc.png)', /beside the sheet/],
    ['border: 4px solid var(--line)', /3px/],
    ['border-radius: 20px', /corner/],
    ['box-shadow: 0 0 40px red', /lift/],
    ['text-shadow: 0 0 8px var(--accent)', /glow.*C2/],
    ['filter: drop-shadow(0 0 6px var(--accent))', /glow.*C2/],
    ['font-family: Comic Sans MS', /face/],
    ['letter-spacing: 1em', /spacing/],
    ['color: var(--ink) !important', /important/],
  ];
  for (const [declaration, why] of cases) {
    const problems = refused(`[data-part="stat"] {\n  ${declaration};\n}`);
    assert.equal(problems[0]!.line, 2, declaration);
    assert.match(problems[0]!.why, why, declaration);
  }
});

test('refused structure: at-rules, nesting, stray braces, an unclosed comment or rule', () => {
  for (const source of [
    '@import url(./x.css);',
    '@media (min-width: 1px) { [data-part="stat"] { color: var(--ink); } }',
    '@font-face { font-family: x; src: url(./x.woff2); }',
    '[data-part="stat"] { [data-part="tag"] { color: var(--ink); } }',
    '} [data-part="stat"] { color: var(--ink); }',
    '[data-part="stat"] { color: var(--ink); /* open',
    '[data-part="stat"] { color: var(--ink);',
  ])
    refused(source);
});

test('injection: a brace in a string, an escape, a comment splitting a property', () => {
  /* A `}` inside a string does not close the rule, so the string is the selector's and the selector is refused. */
  const brace = refused('[data-part="stat}body{display:none"] { color: var(--ink); }');
  assert.match(brace[0]!.why, /not a published part/);
  /* An escape is how `\64isplay` spells display, or a string hides a quote: none is read. */
  assert.match(refused('[data-part="stat"] { \\64isplay: none; }')[0]!.why, /escapes/);
  assert.match(refused('[data-part="st\\"at"] { color: var(--ink); }')[0]!.why, /escapes/);
  /* A comment is whitespace: `dis/**\/play` is two words, not display, and still refused. */
  const split = refused('[data-part="stat"] { dis/* x */play: none; }');
  assert.match(split[0]!.why, /property, a colon and a value/);
  /* A value cannot close the block and open another. */
  refused('[data-part="stat"] { background: url("./a.png){}body{display:none"); }');
  /* A semicolon inside a string does not end the declaration and smuggle a second. */
  refused('[data-part="stat"] { color: "x;display:none"; }');
});

test('a sheet past 8 KB is refused (C11)', () => {
  const rule = '[data-part="stat"] { color: var(--ink); }\n';
  const problems = refused(rule.repeat(Math.ceil(STYLESHEET_MAX / rule.length) + 1));
  assert.match(problems[0]!.why, /8 KB/);
});
