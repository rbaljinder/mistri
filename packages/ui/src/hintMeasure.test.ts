import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* happy-dom lays nothing out, so a measure is read where it is written: a hint under a field stands at a reading
   width, not the width of a wide room (a field report: one line of 150 characters). */
describe('a hint', () => {
  const rule = (file: string, selector: string) => {
    const css = readFileSync(file, 'utf8');
    const start = css.indexOf(`${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };
  it.each([
    ['packages/ui/src/primitives.css', '.form-field-hint'],
    ['packages/kit/src/client/style.css', '.command-help'],
    ['packages/kit/src/client/style.css', '.field-hint'],
  ])('%s %s stops at a reading measure', (file, selector) => {
    expect(rule(file, selector)).toMatch(/max-width: 70ch/);
  });
});
