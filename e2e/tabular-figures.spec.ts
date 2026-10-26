import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/harness';

/**
 * Tabular figures turn the figures tabular and nothing else. Inter, the face
 * Lumen ships, set its hyphen, comma, period, colon, brackets, operators and
 * space a figure wide under `tnum` too, so text under `tabular-nums` (a
 * document, a record's values) read "Sign - ins" and "SR - 1". The shipped
 * file's `tnum` is cut to the ten figures (packages/kit/src/client/lumenLook.css); this
 * loads that file and measures.
 *
 * No server and no database: the face is read from the source tree.
 */
test('the shipped Inter sets text the same width with and without tabular figures, and still makes its figures tabular', async ({
  page,
}) => {
  const face = readFileSync(resolve('packages/kit/src/client/fonts/inter-latin.woff2')).toString('base64');
  await page.setContent(
    `<style>@font-face { font-family: Shipped; src: url(data:font/woff2;base64,${face}) format('woff2'); font-weight: 100 900; }
      span { font: 500 16px Shipped; white-space: pre; }</style><body></body>`,
  );
  const widths = await page.evaluate(async () => {
    await document.fonts.load('500 16px Shipped');
    const measure = (text: string, numeric: string) => {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.fontVariantNumeric = numeric;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    const words = ['Sign-ins, passwords: (all) [x] = a.b + c', 'Wi-Fi', 'SR-', 'line-of-business'];
    return {
      words: words.map((word) => [word, measure(word, 'normal'), measure(word, 'tabular-nums')] as const),
      one: [measure('1111', 'normal'), measure('1111', 'tabular-nums'), measure('0000', 'tabular-nums')],
    };
  });
  for (const [word, normal, tabular] of widths.words) expect(tabular, word).toBeCloseTo(normal, 1);
  // The figures still go tabular: a 1 is narrower than a 0 until they do.
  const [ones, tabularOnes, tabularZeros] = widths.one;
  expect(tabularOnes).toBeGreaterThan(ones + 1);
  expect(tabularOnes).toBeCloseTo(tabularZeros, 1);
});
