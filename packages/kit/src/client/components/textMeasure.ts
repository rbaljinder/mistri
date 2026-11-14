import type { TextMeasure } from './gridSizing.js';

/** Text widths in one font, from a shared canvas; `undefined` where there is
    no 2D context (the component tests), which falls back to counting. */
let measuringContext: CanvasRenderingContext2D | null | undefined;
/* Only measures of a face that is here: a canvas measures a face still on its way in the fallback's metrics, and that
   number kept for the page's life sized every column from the wrong font, so a table's columns came out differently
   from one load to the next, by whether the webfont beat the first measure. */
const measures = new Map<string, TextMeasure>();
/* A face may be declared after a text was measured in its name: a look's face sheet is fetched when the look is worn,
   and until its @font-face is on the page `fonts.check` says the font is loaded, there being no declared face to
   wait for. The fallback's widths were then kept under the font's name for the page's life, by whether the sheet
   beat the first measure. Whatever was kept is let go each time a face arrives. */
globalThis.document?.fonts?.addEventListener?.('loadingdone', () => measures.clear());

/** Whether `font` is set in faces that are loaded (or that no `@font-face` declares: a system face). */
export function fontLoaded(font: string): boolean {
  try {
    return globalThis.document?.fonts?.check(font) ?? true;
  } catch {
    return true;
  }
}

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
  const loaded = fontLoaded(font);
  const known = loaded ? measures.get(font) : undefined;
  if (known) return known;
  const cache = new Map<string, number>();
  const measure: TextMeasure = (text) => {
    const seen = cache.get(text);
    if (seen !== undefined) return seen;
    context.font = font;
    /* Cells set their figures tabular (themeFamilies.css), and a canvas cannot: measured proportional,
       "$105,828" came out a few pixels short and its cell cut it to "$105,8…". Every figure is measured as a
       zero, and each mark a tabular setting widens is given what it gains (`tabularGain`). */
    let width = context.measureText(text.replace(/[0-9]/g, '0')).width;
    if (/[0-9]/.test(text)) {
      if (!gain) {
        gain = new Map();
        for (const [mark, more] of tabularGain(font)) gain.set(mark, context.measureText(mark).width * more);
      }
      if (gain.size) for (const mark of text) width += gain.get(mark >= '0' && mark <= '9' ? '0' : mark) ?? 0;
    }
    cache.set(text, width);
    return width;
  };
  /* What each mark gains among tabular figures, in pixels of this font; read when the first figure is measured. */
  let gain: Map<string, number> | undefined;
  if (loaded) measures.set(font, measure);
  return measure;
}

/* The marks a face may draw wider among tabular figures: the figures themselves and what stands between them. */
const TABULAR_MARKS = ['0', '(', ')', '-', '+', '.', ',', ':', '/', '$', '%', ' '];

/**
 * How much wider each mark sets among tabular figures than on its own, as a share of its own width, in `font`.
 * A face whose own figures are proportional (Inter, a Mac's system face) draws a tabular figure wider than its
 * zero and widens the brackets and the hyphen beside it: measured as zeros alone, "(720) 555-4381" came out five
 * pixels short at 13px, and a look that sets a telephone number in its text face cut it to "(720) 555-43…".
 * Read from the page once for a font, as a ratio of two spans in the same place, so the page's zoom cancels.
 */
function tabularGain(font: string): Map<string, number> {
  const gain = new Map<string, number>();
  try {
    const bench = document.createElement('div');
    bench.setAttribute('aria-hidden', 'true');
    bench.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${font}`;
    const spans = TABULAR_MARKS.flatMap((mark) =>
      [false, true].map((tabular) => {
        const span = document.createElement('span');
        span.style.cssText = `display:inline-block;font-variant-numeric:${tabular ? 'tabular-nums' : 'normal'}`;
        // Between figures, since a face widens a mark only where it stands among them.
        span.textContent = `0${mark}`.repeat(8);
        bench.append(span);
        return span;
      }),
    );
    /* The shell's own body is no place to measure in: embedded, it is taken off the page while the host shows
       something else, and what is measured there has no width.
       host-global: two spans that carry their own font and are compared with each other; nothing of the shell's. */
    document.body.append(bench);
    // screen-px: two spans compared with each other, never fed to a style.
    const widths = spans.map((span) => span.getBoundingClientRect().width);
    bench.remove();
    const zero = widths[0]! > 0 ? widths[1]! / widths[0]! - 1 : 0;
    if (zero > 0.001) gain.set('0', zero);
    TABULAR_MARKS.forEach((mark, index) => {
      if (index === 0) return;
      const own = widths[index * 2]!;
      const tabular = widths[index * 2 + 1]!;
      /* The pair's gain less the figure's share of it is the mark's, said against the mark's own width. */
      const pair = own > 0 ? (tabular - own) / 8 : 0;
      const figure = widths[0]! > 0 ? (widths[1]! - widths[0]!) / 16 : 0;
      const markWidth = own / 8 - widths[0]! / 16;
      const more = markWidth > 0 ? (pair - figure) / markWidth : 0;
      if (more > 0.001) gain.set(mark, more);
    });
  } catch {
    // No page to read from: the zero's width stands, as before.
  }
  return gain;
}
