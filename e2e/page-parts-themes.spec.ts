/**
 * The kit parts in every built-in look (test/fixtures/apps/page-kit, its `parts` page): a counted filter, a table with an
 * identity column and a status, a windowed figure, bars, a person and a record's details, each light and dark, at a desk
 * and at a phone. A part takes everything from the look's tokens, so what is held here is what a look's author is
 * promised: the words read at 4.5:1 and a field's edge at 3:1 (the reading `mistri grade` takes), every color a part
 * draws is the look's own (a token, or a mix of tokens), a status is dressed as the look's recipe says, and nothing
 * scrolls sideways. One page per load, 8 looks x 2 modes x 2 widths. It starts its own server over a disposable
 * database (support/layersServer.ts), so it runs beside the other specs.
 */
import { LONG_MS } from './support/budgets';
import { readings } from './support/contrast';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

const LOOKS = ['workshop', 'lumen', 'mono', 'sage', 'ledger', 'atelier', 'graphite', 'bloom'];
const MODES = ['light', 'dark'] as const;
const WIDTHS = [
  { name: 'desk', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

test.describe('The kit parts in every look', () => {
  test.setTimeout(LONG_MS * 2);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp('page-kit');
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  for (const look of LOOKS) {
    test(`${look}: legible, token-only, dressed as its recipe says, and no sideways scroll`, async ({ page }) => {
      const wrong: string[] = [];
      for (const mode of MODES) {
        for (const { name, width, height } of WIDTHS) {
          const at = `${look}, ${mode}, ${name}`;
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
          /* The look and the mode, chosen as a reader would, on the origin before the page boots. */
          await page.goto(`${app.origin}/api/runtime`);
          await page.evaluate(
            ([chosen, scheme]) => {
              localStorage.setItem('mistri.tour.v1', 'done');
              localStorage.setItem('mistri.visual-theme', chosen!);
              localStorage.setItem('mistri.theme', scheme!);
            },
            [look, mode],
          );
          await page.goto(`${app.origin}/parts`);
          await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
          /* Every part is drawn: the table's rows, the bars, a windowed figure. */
          await expect(page.locator('.free-page-body tbody tr').first()).toBeVisible();
          await expect(page.locator('.free-page-body .kit-bars-row').first()).toBeVisible();
          await expect(page.locator('.free-page-body .home-card').first()).toBeVisible();

          for (const reading of await readings(page, [])) {
            if (reading.ratio < reading.need) wrong.push(`${at}: ${reading.what} reads ${reading.ratio}:1, needs ${reading.need}:1`);
          }

          const seen = await page.evaluate(() => {
            const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            const probe = document.createElement('span');
            document.body.append(probe);
            /* The look's own colors: every custom property of the root that is a color, as the page resolves it. */
            const tokens: number[][] = [];
            const root = getComputedStyle(document.documentElement);
            for (const property of Array.from(root)) {
              if (!property.startsWith('--')) continue;
              probe.style.backgroundColor = '';
              probe.style.backgroundColor = `var(${property})`;
              const resolved = getComputedStyle(probe).backgroundColor;
              if (resolved && resolved !== 'rgba(0, 0, 0, 0)') tokens.push(rgb(resolved));
            }
            probe.remove();
            /* A mix of two tokens lies on the line between them (color-mix does, in srgb and near enough in oklab). */
            const SLACK = 10;
            const onLine = (c: number[], a: number[], b: number[]) => {
              const d = b.map((v, i) => v - a[i]!);
              const length = d.reduce((sum, v) => sum + v * v, 0);
              const t = length ? Math.max(0, Math.min(1, c.reduce((sum, v, i) => sum + (v - a[i]!) * d[i]!, 0) / length)) : 0;
              return c.every((v, i) => Math.abs(v - (a[i]! + t * d[i]!)) <= SLACK);
            };
            const ours = (css: string) => {
              if (/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(css)) return true;
              const c = rgb(css);
              return tokens.some((a) => tokens.some((b) => onLine(c, a, b)));
            };
            const foreign: string[] = [];
            const body = document.querySelector('.free-page-body');
            for (const el of body?.querySelectorAll('*') ?? []) {
              if (el.closest('svg') || !(el as HTMLElement).checkVisibility?.()) continue;
              const style = getComputedStyle(el);
              const named = `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(/\s+/)[0]}`;
              const colors: Array<[string, string]> = [
                ['color', style.color],
                ['background', style.backgroundColor],
              ];
              for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
                if (parseFloat(style[`border${side}Width`]) > 0) colors.push([`border-${side.toLowerCase()}`, style[`border${side}Color`]]);
              }
              for (const [property, value] of colors) if (!ours(value)) foreign.push(`${named} ${property} ${value}`);
            }

            /* The status dress: a pill is a ground of its own, a dot a mark before the word. */
            const recipe = document.documentElement.getAttribute('data-look-status');
            const tones = [...(body?.querySelectorAll('.tone:not(.tone-neutral)') ?? [])];
            const undressed = tones.filter((el) => {
              if (recipe === 'pill' || recipe === 'pill-dot') {
                const ground = rgb(getComputedStyle(el).backgroundColor);
                const alpha = Number(getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.[3] ?? 1);
                if (!ground.length || alpha === 0) return true;
              }
              if (recipe === 'dot' || recipe === 'pill-dot' || recipe === 'quiet') {
                const mark = getComputedStyle(el, '::before').content;
                if (mark === 'none' || mark === 'normal') return true;
              }
              return false;
            });
            const sideways = Math.max(
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
              (body?.scrollWidth ?? 0) - (body?.clientWidth ?? 0),
            );
            return { foreign, recipe, tones: tones.length, undressed: undressed.map((el) => el.textContent), sideways };
          });
          if (seen.foreign.length)
            wrong.push(`${at}: colors that are not the look's own: ${[...new Set(seen.foreign)].slice(0, 8).join('; ')}`);
          if (!seen.tones) wrong.push(`${at}: no status drawn, so the recipe is not proven`);
          if (seen.undressed.length) wrong.push(`${at}: a ${seen.recipe} status without its dress: ${seen.undressed.join(', ')}`);
          if (seen.sideways > 1) wrong.push(`${at}: the page scrolls sideways by ${seen.sideways}px`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});
