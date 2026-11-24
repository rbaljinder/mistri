// test-package: shared — a check of every package's stylesheets (scripts/test-owners.mjs).
/**
 * test/check-client-space.mjs holds every padding, margin and gap to the space scale (docs/design.md, Space and
 * text). These hold the rule itself: a length is a literal in `rem` as it is in `px`, since `0.4375rem` is 7px by
 * another name and the surface sheets once wrote their spaces that way where a rule reading `px` never looked; a
 * token, a hairline and a function over a token pass; a value off the scale on purpose says why beside it; and the
 * counted list only shrinks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findAll, literalsIn, problems, spaceLiteral, split } from './check-client-space.mjs';

const keys = (css: string) => literalsIn(css).map(({ key }: { key: string }) => key);

test('a length in rem is a literal, as one in px is', () => {
  for (const term of ['7px', '0.4375rem', '-0.25rem', '.5rem', '1rem', '20px', '0.0625rem']) assert.equal(spaceLiteral(term), term, term);
});

test('a token, a zero, a hairline, a share and a keyword pass', () => {
  for (const term of ['var(--space-3)', 'var(--field-gap)', '0', '0px', '0rem', '-0rem', '1px', '-1px', 'auto', '50%', 'inherit', '0.4em'])
    assert.equal(spaceLiteral(term), undefined, term);
});

test('a function passes over a token and is a literal without one', () => {
  for (const term of [
    'calc(var(--space-4) - 1px)',
    'calc(-1 * var(--space-2))',
    'calc(var(--space-2h) + (var(--tree-level, 1) - 1) * 0.9375rem)',
    'max(var(--space-3), env(safe-area-inset-left))',
  ])
    assert.equal(spaceLiteral(term), undefined, term);
  for (const term of ['calc(0.5rem - 1px)', 'min(14dvh, 6rem)', 'clamp(2rem, 9vh, 5.5rem)', 'calc(10px + 2.4ch)'])
    assert.equal(spaceLiteral(term), term, term);
});

test('a shorthand is read term by term, a function being one term', () => {
  assert.deepEqual(split('0 calc(var(--space-2) * -1) 0.5rem  auto'), ['0', 'calc(var(--space-2) * -1)', '0.5rem', 'auto']);
  assert.deepEqual(keys('.a { padding: var(--space-2) 0.4375rem 0 0.6875rem !important; }'), ['space 0.4375rem', 'space 0.6875rem']);
});

test('every space property is held, on each side and axis, and nothing else is', () => {
  const css = `.a {
    padding-inline: 0.75rem;
    margin-block-start: 0.5rem;
    margin: -0.25rem auto 0;
    gap: 0.375rem;
    row-gap: 5px;
    column-gap: 0.3125rem;
    width: 2.75rem;
    height: 0.25rem;
    inset: 0.5rem;
    border-radius: 0.375rem;
    --pad: 0.5rem;
  }`;
  assert.deepEqual(keys(css), ['space 0.75rem', 'space 0.5rem', 'space -0.25rem', 'space 0.375rem', 'space 5px', 'space 0.3125rem']);
});

test('a term is named with its line, and a commented-out one is not read', () => {
  const css = '.a {\n  gap: var(--space-3);\n  /* padding: 0.5rem; */\n  padding: 0.5rem;\n}\n';
  assert.deepEqual(literalsIn(css), [{ key: 'space 0.5rem', line: 4 }]);
});

test('a value off the scale on purpose says why, on its line or the one above', () => {
  assert.deepEqual(keys('.a {\n  padding: 1.75rem; /* off-scale: inside the ring */\n}'), []);
  assert.deepEqual(keys('.a {\n  /* off-scale: inside the ring */\n  padding: 1.75rem;\n}'), []);
  assert.deepEqual(keys('.a {\n  /* a note that gives no reason */\n  padding: 1.75rem;\n}'), ['space 1.75rem']);
  assert.deepEqual(keys('.a {\n  /* off-scale: inside the ring */\n\n  padding: 1.75rem;\n}'), ['space 1.75rem']);
});

test('the counted list refuses one more and asks for a count that fell to be lowered', () => {
  const allowed = { 'a.css': { 'space 0.5rem': 2 } };
  assert.deepEqual(problems({ 'a.css': { 'space 0.5rem': [3, 9] } }, allowed), []);
  assert.match(problems({ 'a.css': { 'space 0.5rem': [3, 9, 12] } }, allowed)[0], /a\.css:3,9,12: space 0\.5rem \(3, 2 allowed\)/);
  assert.match(problems({ 'b.css': { 'space 7px': [1] } }, allowed)[0], /b\.css:1: space 7px \(1, 0 allowed\)/);
  assert.match(problems({ 'a.css': { 'space 0.5rem': [3] } }, allowed)[0], /held 1 times, 2 allowed: lower it/);
  assert.match(problems({}, allowed)[0], /held 0 times, 2 allowed: lower it/);
});

test('the surface sheets hold no counted literal: every space in them is a step or says why', () => {
  const surface = (file: string) => file.startsWith('packages/ui/src/styles/surfaces/');
  assert.deepEqual(Object.keys(findAll()).filter(surface), []);
  const allowed = JSON.parse(readFileSync(fileURLToPath(new URL('./client-space.allow.json', import.meta.url)), 'utf8'));
  assert.deepEqual(Object.keys(allowed).filter(surface), []);
});
