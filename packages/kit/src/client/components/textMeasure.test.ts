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

  it('keeps the widths of a loaded face', () => {
    loaded = true;
    const measure = textMeasure('400 15px Barlow, sans-serif')!;
    expect(measure('abcd')).toBe(48);
    expect(textMeasure('400 15px Barlow, sans-serif')).toBe(measure);
  });
});
