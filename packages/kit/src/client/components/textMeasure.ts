import type { TextMeasure } from './gridSizing.js';

/** Text widths in one font, from a shared canvas; `undefined` where there is
    no 2D context (the component tests), which falls back to counting. */
let measuringContext: CanvasRenderingContext2D | null | undefined;
const measures = new Map<string, TextMeasure>();
export function textMeasure(font: string): TextMeasure | undefined {
  if (measuringContext === undefined) {
    try {
      measuringContext = document.createElement('canvas').getContext('2d');
    } catch {
      measuringContext = null;
    }
  }
  const context = measuringContext;
  if (!context) return undefined;
  const known = measures.get(font);
  if (known) return known;
  const cache = new Map<string, number>();
  const measure: TextMeasure = (text) => {
    const seen = cache.get(text);
    if (seen !== undefined) return seen;
    context.font = font;
    /* Cells set their figures tabular (themeFamilies.css), and a canvas cannot: measured proportional,
       "$105,828" came out a few pixels short and its cell cut it to "$105,8…". A tabular figure is as wide
       as a zero, so every figure is measured as one. */
    const width = context.measureText(text.replace(/[0-9]/g, '0')).width;
    cache.set(text, width);
    return width;
  };
  measures.set(font, measure);
  return measure;
}
