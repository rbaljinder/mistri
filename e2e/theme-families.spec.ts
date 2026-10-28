// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { COMPASS, CRM_CLOCK, DEMO, expect, test } from './support/ownServers';
import { open } from './support/app';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets';
import { contrastRatio } from '../packages/engine/src/shared/theme';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec';
import { readings } from './support/contrast';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

const CRM = COMPASS;

/* What the looks look like, not how a look is chosen: appearance.spec.ts owns
   the Preferences dialog's picks. So one pair still walks the dialog — picking
   both, closing and reloading, which is the one thing a seeded preference
   cannot prove — and the rest start from the stored choice. The dialog is
   driven again at the end of every one of these, for the boundaries. The
   pair is a look other than the default (Workshop), so the pick is a change. */
const THROUGH_DIALOG = 'sage';

/** Nothing the reader is shown may reach past the window, at any width. */
async function inside(page: import('@playwright/test').Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  const content = await page.locator('.content').evaluate((node) => {
    const edge = node.getBoundingClientRect().right;
    /* Only what can widen the room is named: a box inside one that clips or
       scrolls sideways (a visually-hidden table, a scrolling grid) reaches
       past the edge without moving it, and naming it once hid the culprit. */
    const held = (el: Element) => {
      for (let up = el.parentElement; up && up !== node; up = up.parentElement)
        if (getComputedStyle(up).overflowX !== 'visible') return true;
      return false;
    };
    return {
      overflow: node.scrollWidth - node.clientWidth,
      outside: [...node.querySelectorAll('*')]
        .filter((child) => child.getBoundingClientRect().right > edge + 0.5 && !held(child))
        .slice(0, 10)
        .map(
          (child) =>
            `${child.tagName}.${child.getAttribute('class') ?? ''} (right ${Math.round(child.getBoundingClientRect().right)} of ${Math.round(edge)}): ${child.textContent?.slice(0, 40)}`,
        ),
    };
  });
  expect(content.overflow, `at ${page.viewportSize()!.width}px: ${JSON.stringify(content.outside)}`).toBeLessThanOrEqual(1);
}

/* Sixteen journeys used to run here — eight looks in two modes, each walking
   the dashboard, the list, a record's editor, the New drawer and the
   Workbench. Three assertions in that walk depended on the look: the surface
   token, a field's drawn radius, and what happens when another look replaces
   this one. Everything else — a pager, a focus, a drawer that does not
   overflow, the database browser wearing no look — is the same whichever look is on,
   and running it sixteen times bought nothing but a minute.

   So the look-dependent part runs per look and per mode, and the walk runs
   once. What is checked has not changed; how many times is what changed. */
for (const theme of THEME_PRESETS)
  for (const mode of ['light', 'dark'] as const) {
    test(`${theme.label} ${mode}: surface, a drawn field, room at every width, and replacement`, async ({ page }) => {
      const writes: string[] = [];
      page.on('request', (request) => {
        if (/\/api\/(insert|update|delete)(?:\?|$)/.test(request.url())) writes.push(request.url());
      });
      // The opposite system scheme throughout: the explicit color mode wins.
      await page.emulateMedia({ colorScheme: mode === 'light' ? 'dark' : 'light' });
      await page.addInitScript(
        ([look, wanted]) => {
          localStorage.setItem('mistri.visual-theme', look);
          localStorage.setItem('mistri.theme', wanted);
        },
        [theme.id, mode] as const,
      );
      await page.goto(CRM);
      await expect(page.locator('.chart-donut')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme-style', theme.id);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      expect(await page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--surface'))).toBe(
        theme[mode].surface,
      );

      /* The bar's current group is one mark inside the bar: a block that stood
       past the bar's rule, with the base's underline under it, was two. */
      const bar = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const top = box(document.querySelector('.topbar')!),
          current = document.querySelector('.tn-group.active > .tn-group-button')!;
        const mark = box(current),
          after = getComputedStyle(current, '::after');
        return {
          inside: mark.top >= top.top && mark.bottom <= top.bottom,
          underline: after.display !== 'none' && after.content !== 'none',
        };
      });
      expect(bar).toEqual({ inside: true, underline: false });
      /* A record's tabs are in sentence case, the look's own; Mono and Workshop set
       them as a label. The Workbench's capitals survived a font shorthand. */
      const recordTab = await page.evaluate(() => {
        const tab = document.createElement('button');
        tab.className = 'page-tab';
        tab.textContent = 'Overview';
        document.body.append(tab);
        const transform = getComputedStyle(tab).textTransform;
        tab.remove();
        return transform;
      });
      expect(recordTab).toBe(theme.id === 'mono' || theme.id === 'workshop' ? 'uppercase' : 'none');

      // Room at every width, on the room with the most in it.
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 924 });
        await expect(page.locator('.chart-donut')).toBeVisible();
        await inside(page);
      }
      await page.setViewportSize({ width: 1440, height: 924 });

      /* A field as this look draws it: the New drawer is the shortest way to a
       real input, and it also says the drawer keeps its contents. */
      await page.goto(`${CRM}/lead`);
      await page.getByRole('button', { name: '+ New lead', exact: true }).click();
      const drawer = page.locator('.newpanel');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('textbox').first()).toHaveCSS('border-radius', theme.radius!.field!);
      expect(await drawer.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();

      // The other built-in look replaces this one's tokens outright.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Preferences/ }).click();
      const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
      await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
      const other = THEME_PRESETS.find((preset) => preset.id !== theme.id)!;
      await page.getByRole('option', { name: other.label, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme-style', other.id);
      expect(await page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--surface'))).toBe(
        other[mode].surface,
      );
      expect(writes).toEqual([]);
    });
  }

/* The walk itself, once. It starts by picking the look in Preferences and
   reloading — the one thing a seeded preference cannot prove — and then goes
   where a reader goes: a list's pager, a record's editor, the database
   browser and back, and the typography preference. None of it depends on which look is
   on, which is why it is not run once per look. */
test('a look chosen in Preferences survives a reload, and the walk under it reads', async ({ page }) => {
  test.setTimeout(45_000);
  const theme = THEME_PRESETS.find((preset) => preset.id === THROUGH_DIALOG)!;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(insert|update|delete)(?:\?|$)/.test(request.url())) writes.push(request.url());
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(CRM);
  await expect(page.locator('.chart-donut')).toBeVisible();
  const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
  const choose = async (control: string, option: string, exact = true) => {
    await prefs.getByRole('button', { name: control, exact: true }).click();
    await page.getByRole('option', { name: option, exact }).click();
  };
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  await choose('Visual theme', theme.label);
  await choose('Color mode', 'Light');
  await prefs.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-style', theme.id);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  /* At the narrowest width, which is where a list draws itself as summaries
     rather than a table — the shape the pager and the editor are checked in,
     and the one the sixteen journeys ended on. */
  await page.setViewportSize({ width: 320, height: 924 });
  await page.goto(`${CRM}/opportunity`);
  await expect(page.locator('.record-summary').first()).toBeVisible();
  await inside(page);
  const pager = page.locator('.pager');
  await pager.scrollIntoViewIfNeeded();
  await expect(pager.getByRole('button', { name: 'Next', exact: false })).toBeInViewport();
  await pager.getByRole('button', { name: 'Next', exact: false }).click();
  // An App's pager says where the reader is as a range; the page box is the Workbench's.
  await expect(pager.locator('.pager-range')).toHaveText(/^21–/);

  await page.goto(`${CRM}/@opportunity~1`);
  await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Opportunity', exact: true });
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS('border-radius', theme.radius!.field!);
  await inside(page);
  await field.press('Escape');

  await page.setViewportSize({ width: 1440, height: 924 });
  // The standalone browser wears no look at all — its own tokens (style.css)
  // and the code face. An App has no Workbench to wear it in.
  await page.goto(`/${DEMO}/customer`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  expect(await page.locator('html').getAttribute('data-theme-style')).toBeNull();
  expect(await page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--surface'))).toBe('');
  expect(await page.locator('body').evaluate((node) => getComputedStyle(node).getPropertyValue('--mono'))).toContain('monospace');
  await page.goto(CRM);
  await expect(page.locator('.chart-donut')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme-style', theme.id);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  await choose('Typography', 'Mono', false);
  expect(await page.locator('body').evaluate((node) => getComputedStyle(node).getPropertyValue('--mono'))).toContain('monospace');
  expect(writes).toEqual([]);
});

for (const id of [...THEME_PRESETS.map((theme) => theme.id), 'meridian'])
  for (const mode of ['light', 'dark'] as const)
    test(`${id} ${mode}: words on tints read at 4.5:1, field edges at 3:1, the shared structure and type scale hold, and fields and the current menu entry show focus`, async ({
      page,
    }) => {
      await page.addInitScript((look) => {
        // Built-ins are global; custom choices are App-scoped and selected below
        // through Preferences rather than injected into the retired global slot.
        if (look === 'meridian') localStorage.removeItem('mistri.visual-theme');
        else localStorage.setItem('mistri.visual-theme', look);
      }, id);
      await page.emulateMedia({ colorScheme: mode });
      await page.setViewportSize({ width: 1440, height: 924 });
      // The server's pinned day, so the calendar below opens on a month with days either side of it.
      await page.clock.setFixedTime(new Date(CRM_CLOCK));
      await page.goto(`${CRM}/lead`);
      if (id === 'meridian') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Preferences/ }).click();
        const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
        await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
        await page.getByRole('option', { name: 'Meridian', exact: true }).click();
        await prefs.getByRole('button', { name: 'Close', exact: true }).click();
        await page.reload();
      }
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', id);
      await expect(page.locator('.avatar:visible').first()).toBeVisible();
      await expect(page.locator('.tone:visible').first()).toBeVisible();
      const read = await readings(page);
      expect(read.filter((reading) => reading.need === 4.5).length).toBeGreaterThan(10);
      // The list's search box and its Selects (the pager's size); an App's pager has no page box.
      expect(read.filter((reading) => reading.need === 3).length).toBeGreaterThanOrEqual(2);
      expect(read.filter((reading) => reading.ratio < reading.need)).toEqual([]);

      /* What every look shares (docs/design.md):
     a list titled at the list title's step, in the look's heading face, at
     no more than 700 and tracked in; a table in no box (no edge, shadow or
     fill of its own) under one rule in the ink; status words with no container; an opaque page-colored ground
     under the crumbs to mask scrolling content — the page's own, or under a
     `band` head (Sage's) the band's, since the band runs from the top of the
     trail (docs/design.md) and its words hold their contrast on it; and
     no column head clipped into an ellipsis. */
      const shape = await page.evaluate(() => {
        const style = (el: Element | null) => (el ? getComputedStyle(el) : null);
        const title = style(document.querySelector('.crumbs h1.applist-title'));
        const wrap = style(document.querySelector('.table-wrap'));
        const head = style(document.querySelector('.table-wrap thead th'));
        return {
          title: title && {
            size: title.fontSize,
            weight: Number(title.fontWeight),
            tracking: parseFloat(title.letterSpacing),
            face: title.fontFamily.replace(/\s+/g, ''),
          },
          headingFace: getComputedStyle(document.documentElement).getPropertyValue('--heading-font').replace(/\s+/g, ''),
          box: wrap && { border: wrap.borderTopWidth, shadow: wrap.boxShadow, fill: wrap.backgroundColor },
          rule: head && parseFloat(head.borderBottomWidth),
          band: head?.backgroundColor,
          crumbs: style(document.querySelector('.crumbs'))?.backgroundColor,
          lookHeader: document.documentElement.dataset.lookHeader,
          headBand: style(document.querySelector('.applist-host > .applist-controls'))?.backgroundColor,
          pageGround: style(document.body)?.backgroundColor,
          boxedTones: [...document.querySelectorAll('.tone:not(.record-tag)')]
            .filter((el) => el.checkVisibility())
            .filter((el) => {
              const s = getComputedStyle(el);
              return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.paddingLeft) > 0;
            })
            .map((el) => el.textContent),
          meaningfulTones: [...document.querySelectorAll('.tone:not(.tone-neutral):not(.record-tag)')].filter((el) => el.checkVisibility())
            .length,
          boxedNeutral: [...document.querySelectorAll('.tone-neutral:not(.record-tag)')]
            .filter((el) => el.checkVisibility())
            .filter((el) => {
              const s = getComputedStyle(el);
              return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.paddingLeft) > 0;
            })
            .map((el) => el.textContent),
          clippedHeads: [...document.querySelectorAll('.table-wrap thead th')]
            .filter((el) => el.checkVisibility() && el.scrollWidth > el.clientWidth)
            .map((el) => el.textContent),
        };
      });
      // The list title's step, on the look's own base: Workshop's 14px (Barlow is a narrow face) scales it with the rest.
      const base = parseFloat(THEME_PRESETS.find((preset) => preset.id === id)?.type?.base ?? '13px');
      expect(shape.title).toMatchObject({ face: shape.headingFace });
      expect(parseFloat(shape.title!.size)).toBeCloseTo((20 * base) / 13, 2);
      expect(shape.title!.weight).toBeLessThanOrEqual(700);
      expect(shape.title!.tracking).toBeLessThan(0);
      if (id === 'sage') {
        /* Sage's recorded exceptions (docs/design.md), asserted as exactly that
       rather than left unchecked: its list open on the ground as in every
       look, under a hairline rule, and meaning — only meaning — in tinted
       pills: a neutral value stays plain text. */
        expect(shape.box).toEqual({ border: '0px', shadow: 'none', fill: 'rgba(0, 0, 0, 0)' });
        expect(shape.rule).toBeGreaterThan(0.5);
        expect(shape.boxedNeutral).toEqual([]);
        expect(shape.boxedTones.length).toBe(shape.meaningfulTones);
      } else if (id === 'lumen') {
        /* Lumen's recorded exceptions (docs/design.md, Lumen's exceptions),
       exactly: the list open on the ground as in every look, its heads over
       a hairline rather than the 2px rule, and every status a dot and its
       word, boxed by nothing. */
        expect(shape.box).toEqual({ border: '0px', shadow: 'none', fill: 'rgba(0, 0, 0, 0)' });
        expect(shape.rule).toBeGreaterThan(0.5);
        expect(shape.rule).toBeLessThan(1.5);
        expect(shape.boxedNeutral).toEqual([]);
        expect(shape.boxedTones).toEqual([]);
      } else {
        expect(shape.box).toEqual({ border: '0px', shadow: 'none', fill: 'rgba(0, 0, 0, 0)' });
        // 2px, snapped to whole device pixels under the density zoom.
        expect(shape.rule).toBeGreaterThan(1.5);
        expect(shape.boxedTones).toEqual([]);
      }
      expect(shape.crumbs).not.toBe('rgba(0, 0, 0, 0)');
      if (shape.lookHeader === 'band' || shape.lookHeader === 'hero') {
        expect(shape.crumbs).toBe(shape.headBand);
        expect(shape.headBand).not.toBe(shape.pageGround);
        const onBand = await readings(page, [['.crumbs h1.applist-title', 4.5]]);
        expect(onBand.filter((reading) => reading.ratio < reading.need)).toEqual([]);
      } else expect(shape.crumbs).toBe(shape.pageGround);
      expect(shape.clippedHeads).toEqual([]);

      /* A looked field's border is the look's own hairline, so focus is the ring
     — the filter boxes had none at all, and in Mono the border is the accent. */
      const filter = page.locator('.applist-search-input').first();
      await filter.focus();
      await expect(filter).toHaveCSS('outline-style', 'solid');
      // The current group's ring is drawn inside it, in its own ink, so a filled item still shows it.
      const current = page.locator('.tn-group.active > .tn-group-button');
      await current.focus();
      expect(
        await current.evaluate((el) => {
          const style = getComputedStyle(el);
          return el.matches(':focus-visible') && style.outlineStyle === 'solid' && style.outlineColor === style.color;
        }),
      ).toBe(true);

      // The New drawer is not a modal; when it goes, focus goes back to the button that opened it.
      const create = page.getByRole('button', { name: '+ New lead', exact: true });
      await create.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'New lead' })).toBeVisible();
      /* Its fields — text boxes, pickers, Selects — are a command form's: a clean outline and no fill at rest
         (docs/design.md, "A command form is quiet until touched"), or, where the theme names its own field fill,
         that fill with its own edge. Whatever edge is drawn still reads at 3:1. */
      const drawn = await readings(page);
      expect(drawn.filter((reading) => reading.ratio < reading.need)).toEqual([]);
      const fields = await page.getByRole('dialog', { name: 'New lead' }).evaluate((dialog) => {
        const ground = getComputedStyle(dialog.querySelector('.insert-form-app') ?? dialog).backgroundColor;
        return [...dialog.querySelectorAll<HTMLElement>('.insert-input, .dd-button, .picker, .record-picker-trigger')]
          .filter((el) => el.checkVisibility())
          .map((el) => {
            const style = getComputedStyle(el);
            const edged = parseFloat(style.borderTopWidth) > 0 && !/^rgba\(.*,\s*0\)$|^transparent$/.test(style.borderTopColor);
            /* The field the drawer opens in wears the house ring and clears its border under it: the ring is its edge. */
            const ringed = el === document.activeElement && style.outlineStyle === 'solid';
            return { edged: edged || ringed, well: style.backgroundColor !== ground && style.backgroundColor !== 'rgba(0, 0, 0, 0)' };
          });
      });
      expect(fields.length).toBeGreaterThan(2);
      expect(fields.filter((field) => !field.edged && !field.well)).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'New lead' })).toHaveCount(0);
      await expect(create).toBeFocused();

      /* A record's verbs stand at the far end of the crumb bar at a laptop's
     width, so the name beneath has its line (PageHead.tsx). */
      await page.setViewportSize({ width: 1280, height: 924 });
      await page.goto(`${CRM}/@lead~127`);
      const head = page.locator('.page-head.has-record');
      const name = head.locator('.root-current'),
        bar = page.locator('.crumbs'),
        tools = bar.locator('.crumb-tools .page-head-actions');
      await expect(name).toBeVisible();
      await expect(tools).toBeVisible();
      /* Measured together and asked again while the head settles: on a slower
     machine it redraws once the record arrives, and a box read mid-redraw
     is null. */
      await expect
        .poll(async () => {
          const [barred, tooled] = await Promise.all([bar.boundingBox(), tools.boundingBox()]);
          return !!barred && !!tooled && tooled.y >= barred.y - 1 && tooled.y + tooled.height <= barred.y + barred.height + 1;
        })
        .toBe(true);
      expect(Number(await name.evaluate((el) => getComputedStyle(el).fontWeight))).toBeLessThanOrEqual(700);
      await page.setViewportSize({ width: 1440, height: 924 });

      /* A calendar week is not a list row: under the pointer an outside day
     keeps its own ground, and its faint date its 4.5:1 — the looks' row
     tint took it to 4.42:1. */
      await page.goto(`${CRM}/task-calendar`);
      const outside = page.locator('.calendar-grid td.calendar-day.is-outside').first();
      await expect(outside).toBeVisible();
      await outside.hover();
      const dates = (await readings(page)).filter((reading) => reading.what.startsWith('calendar-date'));
      expect(dates.length).toBeGreaterThanOrEqual(28);
      expect(dates.filter((reading) => reading.ratio < reading.need)).toEqual([]);
    });

/* The database browser wears its own tokens and no
   look; its fields draw the same 3:1 edge — the query bar, the table
   filter, a list's filter boxes, the pager's page box. */
/* Lumen's table, held: the row anchored on the record's name, the head small and faint, a neutral status a grey
   dot and its word, placeholder rows the real rows' height, and a head that stays under the trail once the page
   scrolls past it (useStickyHead.ts). */
test('lumen: a table anchors on its name, keeps its head in view, and its placeholders are its rows', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.clock.setFixedTime(new Date(CRM_CLOCK));
  await page.goto(`${CRM}/lead`);
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
  const row = page.locator('.table-wrap tbody tr').first();
  await expect(row).toBeVisible();
  const read = await page.evaluate(() => {
    const first = document.querySelector('.table-wrap tbody tr')!;
    const cells = [...first.querySelectorAll('td:not(.row-host)')];
    const head = getComputedStyle(document.querySelector('.table-wrap thead th')!);
    const neutral = document.querySelector('.table-wrap .tone-neutral');
    const app = getComputedStyle(document.querySelector('.app-mode')!);
    return {
      name: { weight: getComputedStyle(cells[0]!).fontWeight, color: getComputedStyle(cells[0]!).color },
      other: getComputedStyle(cells[1]!).color,
      head: { size: head.fontSize, weight: head.fontWeight },
      dot: neutral && getComputedStyle(neutral, '::before').backgroundColor,
    };
  });
  expect(read.name.weight).toBe('500');
  expect(read.other).not.toBe(read.name.color);
  expect(read.head).toEqual({ size: '12px', weight: '500' });
  expect(read.dot).not.toBeNull();
  expect(read.dot).not.toBe('rgba(0, 0, 0, 0)');

  const wrap = page.locator('.table-wrap').first();
  await expect(wrap).toHaveAttribute('data-fits', '');
  await expect(wrap).not.toHaveAttribute('data-stuck');
  await page.locator('.content').evaluate((node) => node.scrollBy(0, 600));
  await expect(wrap).toHaveAttribute('data-stuck', '');
  const [trail, head] = await Promise.all([
    page.locator('.crumbs').first().boundingBox(),
    page.locator('.table-wrap thead th').first().boundingBox(),
  ]);
  expect(Math.abs(head!.y - (trail!.y + trail!.height))).toBeLessThan(2);

  /* A row of one line each (a lead's name carries its email under it) is what a placeholder row stands for. */
  await page.goto(`${CRM}/opportunity`);
  await expect(page.locator('.table-wrap tbody tr').first()).toBeVisible();
  const heights = await page.evaluate(() => ({
    skeleton: parseFloat(getComputedStyle(document.querySelector('.app-mode')!).getPropertyValue('--sk-row-h')),
    row: [...document.querySelectorAll('.table-wrap tbody tr')].find((tr) => !tr.querySelector('.cell-sub'))?.getBoundingClientRect()
      .height,
  }));
  expect(Math.abs(heights.skeleton - heights.row!)).toBeLessThan(1.5);
});

for (const mode of ['light', 'dark'] as const) {
  test(`the database browser ${mode}: every field's edge reads at 3:1 on the field and on its ground`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 1440, height: 924 });
    await open(page, DEMO, 'customer');
    await expect(page.locator('.table-wrap table').first()).toBeVisible();
    // A focused field wears the ring instead of its edge; read them at rest.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const edges = (await readings(page)).filter((reading) => reading.need === 3);
    expect(edges.some((reading) => reading.what.includes('#query'))).toBe(true);
    expect(edges.length).toBeGreaterThan(2);
    expect(edges.filter((reading) => reading.ratio < reading.need)).toEqual([]);
  });
}

test('new bases honor authored defaults and inherit custom palette roles across system changes', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.app.ui.customThemes = [
      {
        id: 'my-sage',
        label: 'My Sage',
        base: 'sage',
        light: { surface: '#ffffff', ink: '#20211f', accent: '#bb341c' },
        dark: { surface: '#1d1e1b', ink: '#f2f3ed', accent: '#ff9d81' },
      },
    ];
    data.app.ui.theme = { preset: 'my-sage' };
    await route.fulfill({ response, json: data });
  });
  await page.goto(CRM);
  await expect(page.locator('.chart-donut')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme-style', 'sage');
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    const preset = THEME_PRESETS.find((theme) => theme.id === 'sage')!;
    await expect
      .poll(() => page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--nav-ground')))
      .toBe(preset[mode].navGround);
    const colors = await page.locator('html').evaluate((node) => {
      const style = (node as HTMLElement).style;
      return [style.getPropertyValue('--ink-muted'), style.getPropertyValue('--surface')];
    });
    expect(contrastRatio(colors[0]!, colors[1]!)).toBeGreaterThanOrEqual(4.5);
  }
});

test("a theme's round controls are pills, its panels keep their own corner and edge, and its ring is 3px", async ({ page }) => {
  const pebble = compileAppTheme(
    {
      kind: 'theme',
      id: 'pebble',
      label: 'Pebble',
      extends: 'lumen',
      recipes: { section: 'card', stat: 'icon' },
      shape: { radius: { control: 'round', field: '12px', panel: '20px' }, border: { panel: '0px', focus: '3px' } },
    },
    'theme',
  );
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.app.ui.customThemes = [pebble];
    data.app.ui.theme = { preset: 'pebble' };
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(CRM);
  await expect(page.locator('.dash-strip .home-card').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-control-radius', '');
  const radius = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopLeftRadius);
  // A control is a pill over the look's own corner (Lumen draws these at its --radius); a card is not, and keeps
  // the panel's corner with no edge. A phone draws the window as a menu beside the filters.
  await expect.poll(() => radius('.dash-window-button')).toBe('999px');
  expect(await radius('.dash-picks .dd-button')).toBe('999px');
  expect(await radius('.dash-strip .home-card')).toBe('20px');
  expect(
    await page
      .locator('.dash-strip .home-card')
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopWidth),
  ).toBe('0px');
  // Nothing a pill's height made wider than the window, on the narrowest phone.
  await inside(page);
  // The ring the keyboard sees is the theme's width.
  await page.locator('.dash-window-button').first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineWidth)).toBe('3px');
});
