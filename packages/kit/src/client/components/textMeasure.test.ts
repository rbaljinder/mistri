// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textMeasure } from './textMeasure.js';

/* A canvas that measures in the metrics of whichever face is there: 10px a character in the fallback, 12px once the
   webfont has loaded, as a real one does. */
const FACE = '400 14px Barlow, sans-serif';
let loaded = false;

beforeEach(() => {
  loaded = false;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({ font: '', measureText: (text: string) => ({ width: text.length * (loaded ? 12 : 10) }) }) as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => loaded } });
});
afterEach(() => vi.restoreAllMocks());

describe('textMeasure', () => {
  it('does not keep a width measured before its face arrived', () => {
    expect(textMeasure(FACE)!('abcd')).toBe(40); // the fallback's metrics
    loaded = true; // the webfont arrives
    expect(textMeasure(FACE)!('abcd')).toBe(48); // measured again, not the stale 40
  });

  it('measures a figure and the marks beside it as wide as a tabular setting draws them', () => {
    loaded = true;
    /* A face whose tabular figures set a tenth wider than its own, and whose brackets a fifth: the page says so
       (two spans, one tabular), since a canvas cannot set figures tabular. */
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const tabular = this.style.cssText.includes('tabular-nums');
      const width = [...(this.textContent ?? '')].reduce(
        (sum, mark) => sum + 12 * (!tabular ? 1 : /[0-9]/.test(mark) ? 1.1 : mark === '(' || mark === ')' ? 1.2 : 1),
        0,
      );
      return { width } as DOMRect;
    });
    const measure = textMeasure('400 16px Barlow, sans-serif')!;
    expect(measure('(720) 555')).toBeCloseTo(9 * 12 + 6 * 1.2 + 2 * 2.4, 5);
    // Words with no figure in them are no wider for it.
    expect(measure('(abc)')).toBe(60);
  });

  it('keeps the widths of a loaded face', () => {
    loaded = true;
    const measure = textMeasure('400 15px Barlow, sans-serif')!;
    expect(measure('abcd')).toBe(48);
    expect(textMeasure('400 15px Barlow, sans-serif')).toBe(measure);
  });
});
