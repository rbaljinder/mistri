/**
 * workbenchLook.css is Instrument, the Workbench's own look: it must stand down under a host look that is not it
 * (the standalone browser's blueprint, console, folio) and stay as it was for a root that wears none.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const text = readFileSync('packages/kit/src/client/workbenchLook.css', 'utf8');
// The rules, not the header comment that explains them.
const sheet = text.slice(text.indexOf('@layer look {'));
const roots = sheet.match(/:root:not\(\[data-visual-theme\]\)[^{\n]*/g)!.map((text) => text.trim());
const SCOPE = ":where(:not([data-host-look]), [data-host-look='instrument'], [data-host-look^='instrument-'])";

test('every root selector carries the one host-look condition, and nothing else changed', () => {
  expect(roots.length).toBeGreaterThanOrEqual(4);
  for (const selector of roots) expect(selector).toContain(`:root:not([data-visual-theme])${SCOPE}`);
  // No bare root selector is left outside it.
  expect(sheet.replaceAll(`:root:not([data-visual-theme])${SCOPE}`, '')).not.toMatch(/:root:not\(\[data-visual-theme\]\)/);
});

test('the condition holds for no host look, for Instrument and its variants, and not for another host look', () => {
  const holds = (look: string | null) => {
    const root = document.documentElement;
    root.removeAttribute('data-host-look');
    if (look !== null) root.setAttribute('data-host-look', look);
    return root.matches(`:root:not([data-visual-theme])${SCOPE}`);
  };
  expect(holds(null)).toBe(true);
  expect(holds('instrument')).toBe(true);
  expect(holds('instrument-dark')).toBe(true);
  for (const foreign of ['blueprint', 'console', 'folio']) expect(holds(foreign)).toBe(false);
  document.documentElement.removeAttribute('data-host-look');
});
