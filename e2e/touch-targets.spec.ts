/**
 * A tablet under a thumb: every control a list room and a record room draw is a 44px target (docs/design.md,
 * Mobile — "Targets are 44px on a coarse pointer"). The tablet band is the ruler's
 * (packages/ui/src/internal/ruler.ts), held upright; `hasTouch` is what makes Chromium answer `(pointer: coarse)`.
 */
import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

/**
 * Runs in the page: each visible control's smaller hit dimension, where it is under 44px. The hit is the box and
 * whatever an absolutely placed ::before/::after adds to it (a chip's ×, a row's reach), as the visual matrix's
 * target probe measures it (scripts/visual-matrix.mjs). The one exception is a link inside a line of prose: WCAG
 * exempts it, and a sentence cannot be 44px tall.
 */
function shortTargets(): string[] {
  const found: string[] = [];
  const controls = document.querySelectorAll<HTMLElement>(
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=row][tabindex]',
  );
  const px = (value: string) => (value.endsWith('px') ? Number.parseFloat(value) : 0);
  /* A control's reach: its box, or the box its label pads round it (a row's checkbox), or the 44px an absolutely
     placed ::before/::after centres on it, whichever is larger in each dimension. */
  const reach = (element: HTMLElement) => {
    const hit = element.matches('input') && element.parentElement?.matches('label') ? element.parentElement : element;
    const box = hit.getBoundingClientRect();
    let { width, height } = box;
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(hit, pseudo);
      if (style.content === 'none' || style.position !== 'absolute') continue;
      width = Math.max(width, px(style.width));
      height = Math.max(height, px(style.height));
    }
    return { width, height, box: element.getBoundingClientRect() };
  };
  for (const element of controls) {
    const box = reach(element);
    if (box.box.width <= 0 || box.box.height <= 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || element.closest('[inert], [aria-hidden="true"]')) continue;
    /* A visually hidden control (a file input under its label, a skip link off screen) is not a target. */
    if (box.box.width <= 1 || box.box.height <= 1) continue;
    if (box.box.bottom + window.scrollY <= 0 || box.box.right + window.scrollX <= 0) continue;
    /* A link in a sentence: its parent says more than the link does. */
    if (element.tagName === 'A' && style.display === 'inline' && element.parentElement?.textContent?.trim() !== element.textContent?.trim())
      continue;
    if (Math.min(box.width, box.height) >= 44 - 0.5) continue;
    const name = `${element.tagName.toLowerCase()}${[...element.classList]
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('')}`;
    const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24);
    found.push(`${name}${label ? ` "${label}"` : ''} is ${Math.round(box.width)}×${Math.round(box.height)}`);
  }
  return [...new Set(found)];
}

test('a list room and a record room are 44px targets under a thumb at tablet width', async ({ page }) => {
  test.slow();
  const sample = await startSample('thread');
  try {
    await page.goto(`${sample.origin}/issues`);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('.applist-title')).toHaveText('Issues');
    await expect(page.getByRole('grid').getByRole('row').nth(1)).toBeVisible();
    expect(await page.evaluate(shortTargets), 'the list room').toEqual([]);

    await page.goto(`${sample.origin}/issues/1`);
    await expect(page.locator('.page-layout')).toBeVisible();
    expect(await page.evaluate(shortTargets), 'the record room').toEqual([]);
  } finally {
    await sample.stop();
  }
});
