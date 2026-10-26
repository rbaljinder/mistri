import { CRM, expect, test } from './support/ownServers';
import { readings } from './support/contrast';
import type { ThemeDefinition } from '../packages/engine/schema/theme.js';
import { RECIPE_MENU } from '../packages/engine/src/shared/themeRecipes.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* A menu the opposite of its page in both modes — a dark menu beside a light page and a light one beside a dark
   page — so a menu entry drawn in the page's ink instead of the menu's reads as nothing on its ground. That was the
   field report: nav.* dressed one bar recipe and the page's ink leaked into the others. */
const theme = (bar: string, nav: string): ThemeDefinition => ({
  id: 'menu-test',
  label: 'Menu test',
  base: 'lumen',
  recipes: { bar: bar as never, nav: nav as never },
  light: {
    navGround: '#1d2633',
    navInk: '#f4f1ea',
    navMuted: '#b4bcc8',
    navLine: '#3a4556',
    navAccent: '#ffffff',
    navCurrent: '#2f3d52',
    navOnCurrent: '#ffffff',
  },
  dark: {
    navGround: '#efe9dd',
    navInk: '#1d2633',
    navMuted: '#4a5363',
    navLine: '#cfc6b4',
    navAccent: '#101820',
    navCurrent: '#ddd3bf',
    navOnCurrent: '#101820',
  },
});

/* Every element of the menu that draws a word or an icon: its entries, group headings, counts and icons. */
const MENU = ':is(.sidebar, .app-mode .topbar) :is(a, button, span, h2, h3, div, svg)';

test('the menu draws in nav.ink and nav.muted on nav.ground under every bar and nav recipe, placement and mode', async ({ page }) => {
  test.setTimeout(240_000);
  /* Every bar, and beside them every nav recipe once — each marks the current entry its own way, and an inverted
     block once kept the bar's muted caret on it — without multiplying the page loads by six. */
  const bars = Object.keys(RECIPE_MENU.bar),
    navs = Object.keys(RECIPE_MENU.nav);
  const pairs = Array.from({ length: Math.max(bars.length, navs.length) }, (_, i) => [bars[i % bars.length]!, navs[i % navs.length]!]);
  for (const [bar, nav] of pairs) {
    // check holds the menu to the same rule, so a theme it passes is one the browser draws legibly.
    expect(
      checkTheme(theme(bar, nav)).filter((problem) => problem.token.startsWith('nav.')),
      `${bar} ${nav}`,
    ).toEqual([]);
    for (const placement of ['side', 'top'] as const) {
      await page.unrouteAll();
      await page.route(/\/api\/app(?:\?|$)/, async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.app.ui.customThemes = [theme(bar, nav)];
        payload.app.ui.theme = { preset: 'menu-test' };
        payload.app.ui.shell = { ...payload.app.ui.shell, placement };
        await route.fulfill({ response, json: payload });
      });
      for (const mode of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.goto(`${CRM}/`);
        await expect(page.locator('html')).toHaveAttribute('data-look-bar', bar);
        await expect(page.locator(placement === 'top' ? '.topbar .tn-links' : '.sidebar')).toBeVisible();
        // Only what holds a word of its own or is an icon: a wrapper's color is never seen.
        const named = await page.locator('body').evaluate((body, selector) => {
          for (const el of body.querySelectorAll('[data-menu-read]')) el.removeAttribute('data-menu-read');
          const names: string[] = [];
          for (const el of body.querySelectorAll(selector)) {
            if (el.closest('svg') !== el && el.closest('svg')) continue;
            const own = el.tagName === 'svg' || [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim());
            if (!own || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
            el.setAttribute('data-menu-read', '');
            names.push(
              `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').replace(/ /g, '.')} in .${el.parentElement!.className}`,
            );
          }
          return names;
        }, MENU);
        const read = (await readings(page, [['[data-menu-read]', 4.5]]))
          .filter((reading) => reading.what.startsWith('[data-menu-read]'))
          .map((reading, index) => ({ ...reading, what: `${named[index]} ${reading.what.slice('[data-menu-read] '.length)}` }));
        expect(read.length, `${bar} ${nav} ${placement} ${mode}`).toBeGreaterThan(5);
        expect(
          read.filter((reading) => reading.ratio < reading.need),
          `${bar} ${nav} ${placement} ${mode}`,
        ).toEqual([]);
      }
    }
  }
});
