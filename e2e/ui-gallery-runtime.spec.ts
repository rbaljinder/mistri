/**
 * Runtime verification across the 8 UI gallery pages (`test/fixtures/apps/page-kit/pages/gallery-*.page.tsx`):
 * - A1: zero infinite animations under `reducedMotion: 'reduce'` and `[data-nx-motion="reduced"]`
 * - A4: exactly one bordered box per adorned input/picker control, with icons/steppers/toggles inside its rect, across all 8 themes at 390 and 1440
 * - C1, C3, C7, C8: 8 pages × 8 themes × light/dark × 390/1440 with zero console warnings/errors, zero 4xx/5xx responses, zero sideways card/page overflow, bounded heights, keyboard focus + accessible names, and axe-core checks
 * - every load is held to the look and scheme it asked for and to its on-demand stylesheet having arrived, and no two
 *   labels of one axis or header row overlap (support/labelOverlap.ts): a clean console says nothing of either
 */
import AxeBuilder from '@axe-core/playwright';
import { LONG_MS } from './support/budgets';
import { expect, test, type Page } from './support/harness';
import { overlappingLabels, settleSurfaces } from './support/labelOverlap';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

const LOOKS = ['workshop', 'lumen', 'mono', 'sage', 'ledger', 'atelier', 'graphite', 'bloom'] as const;
const MODES = ['light', 'dark'] as const;
const WIDTHS = [
  { name: 'desk', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const GALLERY_PAGES = [
  'gallery-inputs',
  'gallery-pickers',
  'gallery-display',
  'gallery-charts',
  'gallery-views',
  'gallery-product',
  'gallery-kit',
  'gallery-behaviors',
] as const;

async function bootGalleryPage(page: Page, origin: string, slug: string, look: string, mode: 'light' | 'dark') {
  await page.goto(`${origin}/api/runtime`);
  await page.evaluate(
    ([chosen, scheme]) => {
      localStorage.setItem('mistri.tour.v1', 'done');
      localStorage.setItem('mistri.visual-theme', chosen!);
      localStorage.setItem('mistri.theme', scheme!);
    },
    [look, mode],
  );
  await page.goto(`${origin}/${slug}`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
  await expect(page.locator('.free-page-body').first()).toBeVisible({ timeout: 30_000 });
  /* The pick is written to storage and read by the shell: a key it stopped reading would leave every cell of the
     matrix in the default look, and sixteen identical loads would pass as eight looks in two schemes. */
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', look);
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  /* The body is there before the page's parts are: their chunks and the surfaces stylesheet arrive after it. */
  await settleSurfaces(page, '.free-page-body', 30_000, slug !== 'gallery-kit');
}

/* The axis rows a page must be measured on, so a class renamed under the probe fails here instead of matching nothing. */
const AXES_ON: Partial<Record<(typeof GALLERY_PAGES)[number], readonly string[]>> = {
  'gallery-charts': ['chart axis'],
  'gallery-views': ['spans axis', 'waterfall axis'],
};

test.describe('UI gallery runtime contract', () => {
  test.setTimeout(LONG_MS * 4);
  let app: Fixture;

  test.beforeAll(async () => {
    app = await startLayersApp('page-kit');
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test('A1: indeterminate gauge, pulse dot, and AI streaming cursor run zero infinite animations under reduced motion', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await bootGalleryPage(page, app.origin, 'gallery-display', 'workshop', 'light');

    await expect(page.locator('[data-slot="meter"], .nx-meter, [role="progressbar"]').first()).toBeVisible();
    await expect(page.locator('.nx-status-dot, .status-dot').first()).toBeVisible();
    await expect(page.locator('[data-slot="ai-assistant-panel"], .nx-ai-panel').first()).toBeVisible();

    const infiniteReducedMedia = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((anim) => anim.effect?.getTiming().iterations === Infinity)
        .map((anim) => (anim as CSSAnimation).animationName || anim.id || 'unnamed'),
    );
    expect(infiniteReducedMedia).toEqual([]);

    // Also verify explicit [data-nx-motion="reduced"] attribute when OS media preference is no-preference
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.evaluate(() => document.documentElement.setAttribute('data-nx-motion', 'reduced'));
    const infiniteDataAttr = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((anim) => anim.effect?.getTiming().iterations === Infinity)
        .map((anim) => (anim as CSSAnimation).animationName || anim.id || 'unnamed'),
    );
    expect(infiniteDataAttr).toEqual([]);
  });

  test('A4: every adorned input and picker has one bordered field box containing its icons and controls across all 8 themes at 390 and 1440', async ({
    page,
  }) => {
    const faults: string[] = [];

    for (const look of LOOKS) {
      for (const { name, width, height } of WIDTHS) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

        for (const slug of ['gallery-inputs', 'gallery-pickers'] as const) {
          await bootGalleryPage(page, app.origin, slug, look, 'light');
          const pageFaults = await page.evaluate((ctx) => {
            const issues: string[] = [];
            const wrappers = document.querySelectorAll<HTMLElement>('[data-gallery-field]');
            for (const wrapper of wrappers) {
              const id = wrapper.dataset.galleryField ?? 'unknown';
              const isChip = (el: Element) =>
                Boolean(
                  el.closest(
                    '[data-slot="combobox-chip"], .nx-tag-chip, .nx-token-chip, .nx-password-strength, [data-slot="field-description"], [data-slot="field-error"]',
                  ),
                );
              const bordered: HTMLElement[] = [];
              for (const el of wrapper.querySelectorAll<HTMLElement>('*')) {
                if (el.tagName === 'LABEL' || isChip(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const cs = getComputedStyle(el);
                if (cs.visibility === 'hidden' || cs.display === 'none') continue;
                const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
                const transparent = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].every((c) =>
                  /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c),
                );
                if (bw.every((w) => w >= 0.5) && !transparent) {
                  bordered.push(el);
                }
              }
              if (bordered.length !== 1) {
                issues.push(
                  `${ctx}/${id}: expected 1 bordered element, found ${bordered.length} (${bordered.map((b) => `${b.tagName.toLowerCase()}.${b.className}`).join(', ')})`,
                );
                continue;
              }
              const boxRect = bordered[0]!.getBoundingClientRect();
              for (const adornment of wrapper.querySelectorAll<Element>('svg, button')) {
                if (isChip(adornment) || adornment.closest('label')) continue;
                const r = adornment.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (
                  r.left < boxRect.left - 1.5 ||
                  r.right > boxRect.right + 1.5 ||
                  r.top < boxRect.top - 1.5 ||
                  r.bottom > boxRect.bottom + 1.5
                ) {
                  issues.push(`${ctx}/${id}: adornment ${adornment.tagName.toLowerCase()} lies outside field box`);
                }
              }
              if (id === 'date-picker-disabled') {
                const clearBtn = wrapper.querySelector('[data-slot="date-picker-clear"], .nx-input-clear');
                if (clearBtn && (clearBtn as HTMLElement).offsetWidth > 0) {
                  issues.push(`${ctx}/${id}: disabled DatePicker still shows clear button`);
                }
              }
              if (id === 'time-input') {
                for (const seg of wrapper.querySelectorAll<HTMLElement>('[data-slot="time-input-segment"]')) {
                  if (seg.scrollWidth > seg.clientWidth + 2) {
                    issues.push(`${ctx}/${id}: time segment "${seg.textContent}" clipped (${seg.scrollWidth} > ${seg.clientWidth})`);
                  }
                }
              }
            }
            return issues;
          }, `${look}@${name}/${slug}`);
          faults.push(...pageFaults);
        }
      }
    }

    expect(faults).toEqual([]);
  });

  for (const slug of GALLERY_PAGES) {
    test(`C1/C7/C8 matrix (${slug}): 8 themes × light/dark × 390/1440 load with zero warnings, zero sideways scroll, and bounded heights`, async ({
      page,
    }) => {
      const consoleIssues: string[] = [];
      const httpIssues: string[] = [];
      const layoutIssues: string[] = [];
      const measuredAxes = new Set<string>();

      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          const text = msg.text();
          if (/Download the React DevTools|Permissions-Policy header: Unrecognized feature/i.test(text)) return;
          consoleIssues.push(`[${msg.type()}] ${text}`);
        }
      });
      page.on('response', (res) => {
        if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) {
          httpIssues.push(`${res.status()} ${new URL(res.url()).pathname}`);
        }
      });

      for (const look of LOOKS) {
        for (const mode of MODES) {
          for (const { name, width, height } of WIDTHS) {
            const label = `${slug} [${look}/${mode}/${name}]`;
            await page.setViewportSize({ width, height });
            await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
            await bootGalleryPage(page, app.origin, slug, look, mode);

            const probe = await page.evaluate(() => {
              const docOver = document.documentElement.scrollWidth - window.innerWidth;
              const room = document.querySelector('#content, .content, .free-page-body') ?? document.body;
              const sideways: string[] = [];
              for (const element of room.querySelectorAll('*')) {
                const over = element.scrollWidth - element.clientWidth;
                if (over <= 1 || element.clientWidth === 0) continue;
                const cs = getComputedStyle(element);
                if (!/auto|scroll/.test(cs.overflowX)) continue;
                if (element.closest('[data-scrolls]')) continue;
                // Exclude intentionally scrollable dense data tables/timelines on narrow phone viewports where mobile scroll is permitted
                if (
                  window.innerWidth <= 420 &&
                  element.matches('.nx-gantt-scroll, .nx-waterfall-scroll, .nx-calendar-week-scroll, .table-wrap')
                )
                  continue;
                const tag = `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join('.')}`;
                sideways.push(`${tag}(+${over}px)`);
              }
              const pageHeight = document.documentElement.scrollHeight;
              return { docOver, sideways, pageHeight };
            });

            if (probe.docOver > 1) layoutIssues.push(`${label}: document overflows sideways by ${probe.docOver}px`);
            if (probe.sideways.length) layoutIssues.push(`${label}: inner sideways scroll: ${probe.sideways.join(', ')}`);
            if (probe.pageHeight > 14_000) layoutIssues.push(`${label}: unbounded page height ${probe.pageHeight}px`);

            const labels = await overlappingLabels(page);
            for (const fault of labels.faults) layoutIssues.push(`${label}: ${fault}`);
            for (const name of labels.seen) measuredAxes.add(name);
          }
        }
      }

      expect(httpIssues, `HTTP >= 400 responses on ${slug}`).toEqual([]);
      expect(consoleIssues, `console warnings/errors on ${slug}`).toEqual([]);
      expect(layoutIssues, `layout overflow/height bounds and overlapping axis labels on ${slug}`).toEqual([]);
      expect(
        (AXES_ON[slug] ?? []).filter((name) => !measuredAxes.has(name)),
        `axis rows ${slug} draws that the overlap probe never measured`,
      ).toEqual([]);
    });
  }

  test('C3: keyboard focus ring, accessible names, focusable WidthsHandle, and axe-core check across gallery pages', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

    // Verify WidthsHandle keyboard focusability & Alt+Arrow shortcuts on /gallery-behaviors (G-B2)
    await bootGalleryPage(page, app.origin, 'gallery-behaviors', 'workshop', 'light');
    const handle = page.locator('[data-slot="widths-handle"]').first();
    await expect(handle).toHaveAttribute('tabindex', '0');
    await expect(handle).toHaveAttribute('aria-keyshortcuts', /Alt\+ArrowLeft/);
    await handle.focus();
    const hasRing = await handle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return parseFloat(cs.outlineWidth) >= 1 || cs.boxShadow !== 'none';
    });
    expect(hasRing).toBe(true);

    // Verify TagInput and TokenInput visible focus rings and accessible names on /gallery-inputs & /gallery-pickers
    for (const slug of ['gallery-inputs', 'gallery-pickers'] as const) {
      await bootGalleryPage(page, app.origin, slug, 'workshop', 'light');
      const unnamed = await page.evaluate(() => {
        const bad: string[] = [];
        const controls = document.querySelectorAll<HTMLElement>(
          '.free-page-body input:not([type="hidden"]), .free-page-body textarea, .free-page-body select, .free-page-body [role="combobox"], .free-page-body [role="listbox"]',
        );
        for (const el of controls) {
          if (el.closest('[aria-hidden="true"], [inert]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const ariaLabel = el.getAttribute('aria-label')?.trim();
          const labelledBy = el.getAttribute('aria-labelledby');
          const labelledText = labelledBy
            ? labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
                .join(' ')
                .trim()
            : '';
          const id = el.id;
          const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : '';
          const wrappingLabel = el.closest('label')?.textContent?.trim();
          const title = el.getAttribute('title')?.trim();
          if (!ariaLabel && !labelledText && !explicitLabel && !wrappingLabel && !title) {
            bad.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
          }
        }
        return bad;
      });
      expect(unnamed, `controls missing accessible name on ${slug}`).toEqual([]);

      const axe = await new AxeBuilder({ page }).include('.free-page-body').disableRules(['color-contrast']).analyze();
      const serious = axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(
        serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
        `axe serious/critical violations on ${slug}`,
      ).toEqual([]);
    }
  });
});
