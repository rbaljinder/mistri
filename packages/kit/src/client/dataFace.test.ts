/**
 * The data face's order (tokens.css `--data-face`): a host look may name the face a grid's values are set in, and the
 * reader's explicit typography wins over it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { applyTypography, setTypography } from './typography.js';

/* The rules that decide it, taken from where they are written: happy-dom does not cascade the whole sheets (their
   imports, layers and nesting), so each rule is read out of its file whole and the page's order kept. */
const read = (path: string) => readFileSync(path, 'utf8');
const rule = (path: string, selector: string) => {
  const text = read(path);
  const at = text.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`${path} no longer has ${selector}`);
  return text.slice(at, text.indexOf('}', at) + 1);
};
const token = (name: string) => new RegExp(`^\\s*${name}: [^;]+;`, 'm').exec(read('packages/ui/src/tokens.css'))![0];
const RULES = [
  `:root { ${token('--code')} ${token('--mono')} }`,
  rule('packages/kit/src/client/style.css', 'td.mono'),
  rule('packages/kit/src/client/features.css', 'body.type-sans'),
  rule('packages/kit/src/client/features.css', 'body:not(.app-mode):not(.type-sans) td.mono'),
  rule('packages/kit/src/client/visualThemes.css', 'body.type-mono'),
];
const LOOK = `:root[data-host-look='blueprint'] { --data-face: "Barlow Semi Condensed", sans-serif; }`;
const CODE = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const styles: HTMLStyleElement[] = [];

beforeAll(() => {
  for (const text of [...RULES, LOOK]) {
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
    styles.push(style);
  }
  document.body.innerHTML = '<table><tbody><tr><td class="mono">1042</td></tr></tbody></table>';
});
afterAll(() => {
  styles.forEach((style) => style.remove());
  document.documentElement.removeAttribute('data-host-look');
  setTypography('default');
  document.body.replaceChildren();
});

const face = () => getComputedStyle(document.querySelector('td.mono')!).fontFamily;

test("the Workbench's short values keep the code face until a look names a data face", () => {
  setTypography('default');
  expect(face()).toBe(CODE);
  document.documentElement.setAttribute('data-host-look', 'blueprint');
  expect(face()).toBe('"Barlow Semi Condensed", sans-serif');
});

test("the reader's explicit typography wins over the look's data face, both ways", () => {
  document.documentElement.setAttribute('data-host-look', 'blueprint');
  setTypography('mono');
  expect(face()).toBe(CODE);
  setTypography('sans');
  expect(face()).toMatch(/^"?Inter"?,/);
  setTypography('default');
  applyTypography();
  expect(face()).toBe('"Barlow Semi Condensed", sans-serif');
});
