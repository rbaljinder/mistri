/**
 * The page kit's layout vocabulary, in a browser (test/fixtures/apps/page-kit): a rail beside a column that stacks when
 * the box is narrow, a Card's description, an Item's lead column and tone mark, a button that is a link followed in
 * place, a Skeleton that holds its size, a segmented choice whose chosen count reads, and a file field drawn as a
 * button, and parts in Cards lining up with the Card. It starts its own server over a disposable database
 * (support/layersServer.ts).
 */
import { settled } from '@mistriwork/mistri/testing';
import { LONG_MS } from './support/budgets';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

/** WCAG's relative luminance contrast of two computed `rgb(...)` colors. */
const contrast = (a: string, b: string) => {
  const light = (color: string) => {
    const [r, g, bl] = (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const s = v! / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test.describe('The page kit vocabulary', () => {
  test.setTimeout(LONG_MS);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp('page-kit');
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('a rail stands beside the column at a desk and under it at a phone, with nothing running sideways', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    let main = await box('.kit-beside-main');
    let rail = await box('.kit-beside-rail');
    expect(rail.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    expect(Math.abs(rail.y - main.y)).toBeLessThan(2);
    await page.setViewportSize({ width: 390, height: 800 });
    await settled(page);
    main = await box('.kit-beside-main');
    rail = await box('.kit-beside-rail');
    expect(rail.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("a free-form page's first part starts one space under its head, not three margins' worth", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const gap = await page.evaluate(() => {
      const head = document.querySelector('.dash-head')!.getBoundingClientRect();
      const first = document.querySelector('.free-page-body .custom-room')!.getBoundingClientRect();
      return first.top - head.bottom;
    });
    /* A field report measured 62px (the head's margin, the body's and the section's); a list's tabs sit about 27px under. */
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
  });

  // `head: false` drops the head, not the space above it: the page's first part stands where a head's title would.
  test("a page that draws its own head keeps the pane's top space above its first part", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/headed`);
    await settled(page);
    const { top, token } = await page.evaluate(() => {
      const body = document.querySelector('.free-page-body')!;
      const probe = document.createElement('div');
      probe.style.paddingTop = 'var(--page-top)';
      body.append(probe);
      const token = getComputedStyle(probe).paddingTop;
      probe.remove();
      return { top: getComputedStyle(body).paddingTop, token };
    });
    expect(parseFloat(token)).toBeGreaterThan(0);
    expect(top).toBe(token);
    const gap = await page.evaluate(
      () =>
        document.querySelector('.free-page-body .dash-head')!.getBoundingClientRect().top -
        document.querySelector('.free-page-body')!.getBoundingClientRect().top,
    );
    expect(gap).toBeGreaterThanOrEqual(parseFloat(token) - 1);
  });

  test("a Card says what it holds, in its tone; an Item's lead and tone mark share one column", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await expect(page.getByText('Everything we hold')).toBeVisible();
    const title = page.getByRole('heading', { name: 'Things', level: 3 }).first();
    expect(await title.getAttribute('class')).toContain('kit-card-title-warn');
    const leads = page.locator('.kit-item-lead');
    await expect(leads).toHaveCount(2);
    const [first, second] = await Promise.all([leads.nth(0).boundingBox(), leads.nth(1).boundingBox()]);
    // One column the rows share: both lead boxes are as wide as the widest, and the third row's text lines up with them.
    expect(Math.abs(first!.width - second!.width)).toBeLessThan(1);
    const titles = page.locator('.kit-item-body');
    const [a, b, c] = await Promise.all([0, 1, 2].map(async (at) => (await titles.nth(at).boundingBox())!.x));
    expect(Math.abs(a! - b!)).toBeLessThan(1);
    expect(Math.abs(a! - c!)).toBeLessThan(1);
  });

  test('a button with an address is a link, followed in place', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    const open = page.getByRole('link', { name: 'Open' });
    await expect(open).toHaveAttribute('href', '/vocabulary?opened=1');
    expect(await open.getAttribute('data-slot')).toBe('button');
    await open.click();
    await expect(page).toHaveURL(/opened=1/);
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(1);
  });

  // A field report: `<Button href intent="primary">` drew its words in the link color on the primary fill, 1.22:1,
  // because a free-form page's plain-link rule outranked the button's ink. A button and a button that is a link
  // share one contract, in every variant and every state a link has.
  test('a button that is a link reads as the button, 4.5:1 at least, in every variant and state', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    // What a person sees: the ink and the ground it stands on, each laid over everything behind it (a canvas
    // resolves any color syntax and composites the alpha), as rgb() the contrast helper reads.
    const seen = (name: string) =>
      page.getByRole('link', { name }).evaluate((link) => {
        const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const grounds: string[] = [];
        for (let at: Element | null = link; at; at = at.parentElement) grounds.unshift(getComputedStyle(at).backgroundColor);
        paint.fillStyle = '#fff';
        paint.fillRect(0, 0, 1, 1);
        for (const ground of grounds) {
          paint.fillStyle = ground;
          paint.fillRect(0, 0, 1, 1);
        }
        const pixel = () => `rgb(${[...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(', ')})`;
        const ground = pixel();
        paint.fillStyle = getComputedStyle(link).color;
        paint.fillRect(0, 0, 1, 1);
        return { ink: pixel(), ground, focusVisible: link.matches(':focus-visible'), active: link.matches(':active') };
      });
    const names = ['Go primary', 'Go secondary', 'Go quiet', 'Go danger', 'Go held'];
    const failures: string[] = [];
    const check = async (name: string, state: string) => {
      const { ink, ground } = await seen(name);
      const ratio = contrast(ink, ground);
      if (ratio < 4.5) failures.push(`${name} ${state}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`);
    };
    for (const name of names) {
      const link = page.getByRole('link', { name });
      await expect(link).toHaveAttribute('data-slot', 'button');
      await check(name, 'at rest');
      await link.hover();
      await check(name, 'hovered');
      await page.mouse.down();
      expect((await seen(name)).active, `${name} is pressed`).toBe(true);
      await check(name, 'pressed');
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await page.keyboard.press('Shift');
      await link.focus();
      expect((await seen(name)).focusVisible, `${name} shows its keyboard focus`).toBe(true);
      await check(name, 'focused');
      await link.blur();
    }
    expect(failures).toEqual([]);
    // A held link is drawn as a held button: it dims with the rest of it and hovering moves nothing.
    const held = page.getByRole('link', { name: 'Go held' });
    expect(await held.evaluate((link) => getComputedStyle(link).opacity)).not.toBe('1');
    const before = await seen('Go held');
    await held.hover();
    expect(await seen('Go held')).toMatchObject({ ink: before.ink, ground: before.ground });
    // Playwright waits for an aria-disabled element to be enabled; `force` clicks it as a person would, so the
    // refusal under test is the link's own.
    await held.click({ force: true });
    await expect(page).not.toHaveURL(/intent=held/);
  });

  test("a row's link is followed in place too, from anywhere on the row", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page
      .locator('.kit-item')
      .first()
      .click({ position: { x: 300, y: 8 } });
    await expect(page).toHaveURL(/seen=1/);
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(1);
  });

  test("at a phone's width a row's actions stand under its words, and the row is a finger tall", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const row = page.locator('.kit-item', { has: page.locator('.kit-item-action') });
    const [body, action, whole] = await Promise.all(
      ['.kit-item-body', '.kit-item-action', ''].map(async (selector) => (await (selector ? row.locator(selector) : row).boundingBox())!),
    );
    // Three buttons would squeeze the words into a sliver beside them: the action wraps under the note instead.
    expect(action.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(body.width).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A clickable row answers a finger anywhere on it, and is at least 44px tall to be hit.
    expect(whole.height).toBeGreaterThanOrEqual(44);
    for (const item of await page.locator('.kit-item-clickable').all())
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test('a row of five choices is a picker at a phone, and the row at a desk; className reaches whichever is drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const row = page.getByRole('radiogroup', { name: 'Stage' });
    const pick = page.getByRole('combobox', { name: 'Stage' });
    await expect(row).toBeVisible();
    await expect(pick).toBeHidden();
    await expect(row).toHaveClass(/vocabulary-stage/);
    await page.setViewportSize({ width: 390, height: 800 });
    await settled(page);
    await expect(row).toBeHidden();
    await expect(pick).toBeVisible();
    await expect(pick).toHaveClass(/vocabulary-stage/);
    // Nothing runs past the window, and the picker is a finger tall.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await pick.selectOption('quoted');
    await expect(pick).toHaveValue('quoted');
    // The two-choice row beside it is never folded.
    await expect(page.getByRole('radiogroup', { name: 'Range' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('radio', { name: /Quoted/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('a Skeleton holds the size it was given', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const bar = (await page.locator('.kit-skeleton-bar').last().boundingBox())!;
    expect([Math.round(bar.height), Math.round(bar.width)]).toEqual([24, 160]);
  });

  test("the chosen segment's count reads against its fill, 4.5:1 at least", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const chosen = page.getByRole('radio', { name: /Week/ }).or(page.locator('[aria-checked="true"], [aria-pressed="true"]')).first();
    const colors = await chosen.evaluate((button) => {
      const count = button.querySelector<HTMLElement>('[class*="count"]')!;
      return [getComputedStyle(count).color, getComputedStyle(count).backgroundColor];
    });
    expect(contrast(colors[0]!, colors[1]!)).toBeGreaterThanOrEqual(4.5);
  });

  test('a file field is drawn with the house button', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await expect(page.locator('[data-slot="button"]', { hasText: /Choose file/ }).first()).toBeVisible();
    // The browser's own "Choose File" stays in the page for the keyboard but draws nothing (kit-fields.css).
    const native = await page
      .locator('[data-slot="file-field"] input[type="file"]')
      .first()
      .evaluate((input) => {
        const box = input.getBoundingClientRect();
        return { width: box.width, height: box.height, opacity: getComputedStyle(input).opacity };
      });
    expect(native.width).toBeLessThanOrEqual(1);
    expect(native.height).toBeLessThanOrEqual(1);
    expect(native.opacity).toBe('0');
  });

  // A field report: a page that drew its own head (`head: false`) laid its title, intro and picker in one row, so at a
  // desk the intro stood beside the picker, and the head stood a second gutter in from the page's body.
  test("a chart in a Card with no title of its own heads the Card, in line with a titled Card's head and its parts", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/cards`);
    await settled(page);
    // One title, the Card's: the chart's own section title is not drawn a second time inside it.
    const head = page.getByRole('heading', { name: 'Things by name' });
    await expect(head).toHaveCount(1);
    await expect(head).toHaveClass(/kit-card-title/);
    await expect(page.locator('.kit-card-part-chart canvas, .kit-card-part-chart svg').first()).toBeVisible();
    const edges = await page.evaluate(() => {
      const left = (el: Element | null) => el!.getBoundingClientRect().left;
      const [titled, untitled] = [...document.querySelectorAll('.kit-card')];
      const pad = (card: Element) =>
        card.getBoundingClientRect().left +
        parseFloat(getComputedStyle(card).borderLeftWidth) +
        parseFloat(getComputedStyle(card).paddingLeft);
      const section = (card: Element) => card.querySelector('.kit-card-part > .page-section')!;
      return {
        titledInner: pad(titled!),
        titledHead: left(titled!.querySelector('.kit-card-title')),
        bars: left(titled!.querySelector('.kit-bars')),
        untitledInner: pad(untitled!),
        chartHead: left(untitled!.querySelector('.kit-card-title')),
        chart: left(section(untitled!)),
        chartInset: getComputedStyle(section(untitled!)).paddingLeft,
        chartBorder: getComputedStyle(section(untitled!)).borderLeftWidth,
      };
    });
    // Both heads stand at their Card's padding edge, and what the Card holds starts there too: no box inside the box.
    expect(Math.abs(edges.titledHead - edges.titledInner)).toBeLessThan(1);
    expect(Math.abs(edges.bars - edges.titledInner)).toBeLessThan(1);
    expect(Math.abs(edges.chartHead - edges.untitledInner)).toBeLessThan(1);
    expect(Math.abs(edges.chart - edges.chartHead)).toBeLessThan(1);
    expect(edges.chartInset).toBe('0px');
    expect(edges.chartBorder).toBe('0px');
  });

  test("a page's own head is two regions, words and verbs, side by side at a desk and stacked at a phone, in the body's gutter", async ({
    page,
  }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${app.origin}/headed`);
      await settled(page);
      const head = page.locator('.free-page-body .dash-head');
      await expect(head.getByRole('heading', { level: 2, name: 'Floor' })).toBeVisible();
      const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
      const title = await box('.free-page-body .dash-head .applist-title');
      const intro = await box('.free-page-body .dash-head .dash-description');
      const verbs = await box('.free-page-body .dash-head .dash-head-actions');
      expect(intro.y, `${width}: the intro is under its title`).toBeGreaterThanOrEqual(title.y + title.height - 1);
      expect(Math.abs(intro.x - title.x), `${width}: the intro starts where its title does`).toBeLessThan(1);
      if (width === 1440) {
        expect(verbs.x, 'at a desk the verbs stand at the far end').toBeGreaterThanOrEqual(intro.x + intro.width);
        expect(verbs.y, 'at a desk the verbs stand beside the words, not under them').toBeLessThan(intro.y + intro.height);
      } else {
        expect(verbs.y, 'at a phone the verbs stand under the words').toBeGreaterThanOrEqual(intro.y + intro.height - 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      /* The head's words start where the body's content does: one gutter, the body's. */
      const inset = await page.locator('.free-page-body').evaluate((body) => {
        const at = body.getBoundingClientRect();
        return at.x + parseFloat(getComputedStyle(body).paddingLeft);
      });
      expect(Math.abs(title.x - inset), `${width}: the head stands in the body's gutter`).toBeLessThan(1);
    }
  });

  // A field report: a theme that declared the page's ground as a part (`parts: { ground: { ground } }`) was drawn as
  // the plain surface, because the shell's pane said its own background after the theme's layer. The pane reads the
  // part's token now; here the computed ground, in the sidebar's header and the bar's, the inset pane and the edge,
  // light and dark, on a custom page.
  test("a theme's declared page ground is the pane's, in either header, either pane, light and dark", async ({ page }) => {
    test.setTimeout(LONG_MS);
    const bar = await startLayersApp('page-kit', { env: { PAGE_KIT_HEADER: 'bar' } });
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      const wrong: string[] = [];
      for (const [header, origin] of [
        ['sidebar', app.origin],
        ['bar', bar.origin],
      ] as const) {
        for (const theme of ['grounded', 'grounded-edge']) {
          for (const mode of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: mode });
            await page.goto(`${origin}/vocabulary`);
            await page.evaluate(
              ([pick, scheme]) => {
                localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([['page-kit', pick]]));
                localStorage.setItem('mistri.theme', scheme!);
              },
              [theme, mode],
            );
            await page.reload();
            /* Not settled(): after the first reload it waits out its whole deadline here, eight times over. The
               page is drawn when the boot is done and the page's body stands. */
            await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
            await expect(page.locator('.free-page-body')).toBeVisible();
            await expect(page.locator('html')).toHaveAttribute('data-parts', /ground:ground/);
            await expect(page.locator('body')).toHaveClass(header === 'sidebar' ? /app-sidebar-shell/ : /app-mode/);
            if (header === 'bar') await expect(page.locator('body')).not.toHaveClass(/app-sidebar-shell/);
            if (theme === 'grounded-edge') await expect(page.locator('html')).toHaveAttribute('data-look-pane', 'edge');
            const seen = await page.evaluate((sidebar) => {
              const resolve = (value: string) => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = value;
                document.body.append(probe);
                const color = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return color;
              };
              const ground = (selector: string) => {
                const element = document.querySelector(selector);
                return element ? getComputedStyle(element).backgroundColor : 'absent';
              };
              return {
                part: resolve('var(--accent-soft)'),
                surface: resolve('var(--surface)'),
                content: ground('.app-mode .content'),
                bar: sidebar ? ground('.layout > .pane-bar') : null,
              };
            }, header === 'sidebar');
            const at = `${header} header, ${theme}, ${mode}`;
            if (seen.part === seen.surface) wrong.push(`${at}: the part's role is the surface, so nothing is proven`);
            if (seen.content !== seen.part) wrong.push(`${at}: the pane is ${seen.content}, the part says ${seen.part}`);
            if (seen.bar !== null && seen.bar !== seen.part) wrong.push(`${at}: the pane's bar is ${seen.bar}, the part says ${seen.part}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    } finally {
      await bar.stop();
    }
  });

  /* A field report: a page of nineteen lists asked nineteen requests at once, each queued behind the others on a
     remote database. The lists asked in one moment now go as one batch (kit breakdownBatch.ts); a second request is
     room for a list that mounts a moment late, not for the nineteen. */
  test("a page's nineteen lists on entry are at most two read requests, and each draws its own rows", async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(view\/run|breakdowns?|run)$/.test(path)) reads.push(path);
    });
    await page.goto(`${app.origin}/many`);
    await settled(page);
    const cards = page.locator('.free-page-body').getByText(/^\d+ rows$/);
    await expect(cards).toHaveCount(19);
    expect(await cards.allTextContents()).toEqual(
      ['3', '1', '1', '1', '2', '1', '1', '1', '10', '4', '2', '2', '2', '4', '3', '3', '4', '3', '3'].map((count) => `${count} rows`),
    );
    /* Counted, so a read that moved to another address fails here rather than passing as no reads at all. */
    expect(reads.length, reads.join(', ')).toBeGreaterThan(0);
    expect(reads.length, reads.join(', ')).toBeLessThanOrEqual(2);
  });
});
