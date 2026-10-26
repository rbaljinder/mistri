/**
 * @mistriwork/ui on a page of its own: the primitives, rendered to markup, and its stylesheet (packages/ui/src/style.css)
 * are all the page has — no kit, no server, no tablewalk stylesheet — and each one is drawn styled. The sheet stands in
 * the `mistri-ui` layer, so a rule of the page's own wins over it whatever its specificity.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/harness';

const ORIGIN = 'http://ui.test';
const SHEETS = ['style.css', 'tokens.css', 'primitives.css'];

/* The primitives, as React renders them (support/uiMarkup.tsx). */
const markup = execFileSync(resolve('node_modules/.bin/tsx'), ['e2e/support/uiMarkup.tsx'], { encoding: 'utf8' });

test('a page drawn with @mistriwork/ui alone wears its stylesheet, under any rule of its own', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  try {
    await context.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (SHEETS.includes(name))
        return route.fulfill({ contentType: 'text/css', body: readFileSync(resolve('packages/ui/src', name), 'utf8') });
      return route.fulfill({
        contentType: 'text/html',
        /* The page's own rule, in no layer, at less specificity than the compact size it overrides. */
        body: `<!doctype html><html><head><link rel="stylesheet" href="/style.css"><style>[data-host] { min-height: 50px; }</style></head><body>${markup}</body></html>`,
      });
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const style = (selector: string, property: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    expect(accent).not.toBe('');
    // The Button: one height per size, the accent for primary, a box for secondary.
    expect(await style('.btn-primary', 'min-height')).toBe('34px');
    expect(await style('.btn-primary', 'display')).toBe('inline-flex');
    expect(await style('.btn-primary', 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
    expect(await style('.btn-secondary', 'border-top-style')).toBe('solid');
    // The page's own rule wins over the compact size by layer, not by specificity.
    expect(await style('.btn-secondary', 'min-height')).toBe('50px');
    // The Field: a column, its control one edge and one height.
    expect(await style('.form-field', 'display')).toBe('grid');
    expect(await style('.form-field-hint', 'margin-top')).toBe('0px');
    expect(await style('.field-control', 'min-height')).toBe('34px');
    expect(await style('.field-control', 'border-top-width')).toBe('1px');
    // The icon and the date field.
    expect(await style('.tw-icon', 'display')).toBe('inline-block');
    expect(await style('.date-field', 'display')).toBe('flex');
    expect(await style('.date-field-trigger', 'position')).toBe('absolute');
    expect(await style('.date-field-hint', 'position')).toBe('absolute');
  } finally {
    await context.close();
  }
});
