/**
 * @mistriwork/ui on a page of its own: the primitives, rendered to markup, and its stylesheet (packages/ui/src/style.css)
 * are all the page has — no kit, no server, no other stylesheet — and each one is drawn styled. The sheet stands in
 * the `mistri-ui` layer, so a rule of the page's own wins over it whatever its specificity.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/harness';

const ORIGIN = 'http://ui.test';

/* The primitives, as React renders them (support/uiMarkup.tsx). */
const markup = execFileSync(resolve('node_modules/.bin/tsx'), ['e2e/support/uiMarkup.tsx'], { encoding: 'utf8' });

test('a page drawn with @mistriwork/ui alone wears its stylesheet, under any rule of its own', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  try {
    await context.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      /* style.css and every sheet it imports, each from its own place in the package: the controls' dress is a
         folder of them (controls.css). */
      if (name.endsWith('.css') && existsSync(resolve('packages/ui/src', name)))
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
    // The Button: one height per size, the accent for primary, a box for secondary. The height is the package's
    // own token for a control (`--control-h`), which a theme moves, so a button and a field stand level.
    const tall = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--control-h').trim());
    expect(tall).toBe('34px');
    const solid = '[data-slot="button"][data-variant="solid"]';
    const plain = '[data-slot="button"]:not([data-variant])';
    expect(await style(solid, 'height')).toBe(tall);
    expect(await style(solid, 'display')).toBe('inline-flex');
    // The package's own accent, read through the names the controls are dressed by.
    expect(await style(solid, 'background-color')).toBe('rgb(36, 85, 223)');
    expect(await style(plain, 'border-top-style')).toBe('solid');
    // The page's own rule wins over the compact size by layer, not by specificity.
    expect(await style(plain, 'min-height')).toBe('50px');
    // The Field: a column, its control one edge and one height.
    expect(await style('[data-slot="field"]', 'display')).toBe('flex');
    expect(await style('[data-slot="field"]', 'flex-direction')).toBe('column');
    expect(await style('[data-slot="field-description"]', 'margin-top')).toBe('0px');
    expect(await style('[data-slot="field"] > [data-slot="input"]', 'height')).toBe(tall);
    expect(await style('[data-slot="field"] > [data-slot="input"]', 'border-top-width')).toBe('1px');
    // The icon and the date field: one box, with the text and the calendar's button inside its edge.
    expect(await style('.mistri-icon', 'display')).toBe('inline-block');
    expect(await style('[data-slot="date-field"]', 'display')).toBe('flex');
    expect(await style('[data-slot="date-field"]', 'border-top-width')).toBe('1px');
    expect(await style('[data-slot="date-field"] > [data-slot="input"]', 'border-top-width')).toBe('0px');
    expect(await style('[data-slot="date-field-hint"]', 'position')).toBe('absolute');
  } finally {
    await context.close();
  }
});

const surfacesMarkup = execFileSync(resolve('node_modules/.bin/tsx'), ['e2e/support/uiMarkup.tsx', '--surfaces'], {
  encoding: 'utf8',
});

test('bundled @mistriwork/ui views, charts, and primitives fit desktop (1440px, 1280px) and mobile (390px) under both standalone and host stylesheets with zero button bleed or overlap', async ({
  browser,
}) => {
  const hostStyleCss = readFileSync(resolve('packages/kit/src/client/style.css'), 'utf8')
    .replace("@import '@mistriwork/ui/tokens.css' layer(base);", '@import "/tokens.css" layer(base);')
    .replace("@import '@mistriwork/ui/controls.css' layer(base);", '@import "/controls.css" layer(base);');

  for (const mode of ['standalone', 'host'] as const) {
    for (const viewport of [
      { width: 1440, height: 900, cols: 3, desktop: true },
      { width: 1280, height: 800, cols: 3, desktop: true },
      { width: 390, height: 844, cols: 1, desktop: false },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await context.route(`${ORIGIN}/**`, (route) => {
          const name = new URL(route.request().url()).pathname.slice(1);
          if (name === 'host-style.css') return route.fulfill({ contentType: 'text/css', body: hostStyleCss });
          if (name === 'host-surfaces.css')
            return route.fulfill({
              contentType: 'text/css',
              body: '@import "/styles/ui-sdk-surfaces.css" layer(ui-sdk-lazy);\n@import "/styles/surfaces.css" layer(surfaces);',
            });
          if (name.endsWith('.css') && existsSync(resolve('packages/ui/src', name)))
            return route.fulfill({ contentType: 'text/css', body: readFileSync(resolve('packages/ui/src', name), 'utf8') });
          const links =
            mode === 'host'
              ? '<link rel="stylesheet" href="/host-style.css"><link rel="stylesheet" href="/host-surfaces.css">'
              : '<link rel="stylesheet" href="/style.css">';
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>html,body{margin:0;padding:0}[data-testid="dark-island"]{padding:18px}</style></head><body>${surfacesMarkup}</body></html>`,
          });
        });
        const page = await context.newPage();
        await page.goto(`${ORIGIN}/`);
        const metrics = await page.evaluate((isDesktop) => {
          const grid = document.querySelector('[data-testid="kpi-grid"]')!;
          const island = document.querySelector('[data-testid="dark-island"]')!;
          const tableSurface = document.querySelector('.nx-data-table-surface') as HTMLElement;
          const tableScroll = document.querySelector('.nx-table-scroll') as HTMLElement;
          const kanbanBoard = document.querySelector('.nx-kanban-board') as HTMLElement;
          const reviewWrap = document.querySelector('[data-testid="review-wrap"]') as HTMLElement;
          const accountWrap = document.querySelector('[data-testid="account-wrap"]') as HTMLElement;
          const accountTabsList = accountWrap.querySelector('[data-slot="tabs-list"]') as HTMLElement;
          const accountTabs = [...accountWrap.querySelectorAll('[data-slot="tabs-tab"]')] as HTMLElement[];

          // Host button bleed check: view buttons keep their own backgrounds, never var(--accent)
          const calInactiveBtn = document.querySelector('.nx-calendar-mode-btn:not([data-active])') as HTMLElement;
          const calModeBtns = [...document.querySelectorAll('.nx-calendar-mode-btn')] as HTMLElement[];
          const calEventChip = document.querySelector(
            '.nx-calendar-event-pill, .nx-calendar-month-pill, .nx-calendar-timed-event',
          ) as HTMLElement | null;
          const reviewRowBtn = document.querySelector(
            '.nx-review-queue-item, .nx-rq-item, [data-testid="review-wrap"] button',
          ) as HTMLElement;
          const sortBtn = document.querySelector('.nx-table-sort-btn') as HTMLElement;
          const thMenuBtn = document.querySelector('.nx-table-th-menu-btn') as HTMLElement;

          const sortBox = sortBtn.getBoundingClientRect();
          const thMenuBox = thMenuBtn.getBoundingClientRect();
          const headerOverlap = isDesktop ? Math.max(0, sortBox.right - thMenuBox.left) : 0;

          // Mobile 390px DataTable card checks: checkbox vs actions menu, Priority badge width, Assignee line count
          const firstRow = document.querySelector('.nx-table-row') as HTMLElement;
          const checkCell = firstRow.querySelector('.nx-table-cell-check')!.getBoundingClientRect();
          const actionsCell = firstRow.querySelector('.nx-table-cell-actions')!.getBoundingClientRect();
          const checkActionOverlap = Math.max(0, Math.min(checkCell.right, actionsCell.right) - Math.max(checkCell.left, actionsCell.left));
          const priorityCells = [...document.querySelectorAll('.nx-table-cell[data-label="Priority"] .nx-badge')] as HTMLElement[];
          const minPriorityWidth = Math.min(...priorityCells.map((el) => el.getBoundingClientRect().width));
          const assigneeName = firstRow.querySelector('.nx-person-name') as HTMLElement;
          const assigneeHeight = assigneeName.getBoundingClientRect().height;

          return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            trackCount: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
            islandTheme: island.getAttribute('data-theme'),
            islandBg: getComputedStyle(island).getPropertyValue('--surface').trim(),
            islandPad: getComputedStyle(island).paddingTop,
            tableScrollOverflow: Math.max(
              tableSurface.scrollWidth - tableSurface.clientWidth,
              tableScroll.scrollWidth - tableScroll.clientWidth,
            ),
            kanbanScrollOverflow: kanbanBoard.scrollWidth - kanbanBoard.clientWidth,
            reviewScrollOverflow: reviewWrap.scrollWidth - reviewWrap.clientWidth,
            accountScrollOverflow: accountWrap.scrollWidth - accountWrap.clientWidth,
            accountTabsOverflow: accountTabsList.scrollWidth - accountTabsList.clientWidth,
            thirdAccountTabWidth: accountTabs[2]!.getBoundingClientRect().width,
            calInactiveBg: getComputedStyle(calInactiveBtn).backgroundColor,
            calModeLabelClipped: calModeBtns.some((b) => b.scrollWidth > b.clientWidth + 1),
            calEventBg: calEventChip ? getComputedStyle(calEventChip).backgroundColor : null,
            reviewRowBg: getComputedStyle(reviewRowBtn).backgroundColor,
            sortBtnBg: getComputedStyle(sortBtn).backgroundColor,
            headerOverlap,
            checkActionOverlap,
            minPriorityWidth,
            assigneeHeight,
          };
        }, viewport.desktop);

        expect(metrics.innerWidth).toBe(viewport.width);
        expect(metrics.scrollWidth).toBeLessThanOrEqual(viewport.width);
        expect(metrics.trackCount).toBe(viewport.cols);
        expect(metrics.islandTheme).toBe('dark');
        expect(metrics.islandBg).toBe('#13161c');
        expect(metrics.islandPad).toBe('18px');

        // Item 1: Host button rule (`background: var(--accent)` = rgb(36, 85, 223)) never paints view buttons!
        expect(metrics.calInactiveBg).not.toBe('rgb(36, 85, 223)');
        expect(metrics.calModeLabelClipped).toBe(false);
        if (metrics.calEventBg) expect(metrics.calEventBg).not.toBe('rgb(36, 85, 223)');
        expect(metrics.reviewRowBg).not.toBe('rgb(36, 85, 223)');
        expect(metrics.sortBtnBg).toBe('rgba(0, 0, 0, 0)');

        // Items 2 & 19: Zero horizontal overflow on DataTable, ReviewQueueView, AccountSettingsView, and Account tabs!
        expect(metrics.tableScrollOverflow).toBeLessThanOrEqual(1);
        expect(metrics.reviewScrollOverflow).toBeLessThanOrEqual(1);
        expect(metrics.accountScrollOverflow).toBeLessThanOrEqual(1);
        expect(metrics.accountTabsOverflow).toBeLessThanOrEqual(1);
        expect(metrics.thirdAccountTabWidth).toBeGreaterThan(100);
        expect(metrics.headerOverlap).toBeLessThanOrEqual(0.5);
        expect(metrics.checkActionOverlap).toBe(0);
        expect(metrics.minPriorityWidth).toBeGreaterThan(40);
        expect(metrics.assigneeHeight).toBeLessThanOrEqual(26);

        if (viewport.desktop) {
          expect(metrics.kanbanScrollOverflow).toBeLessThanOrEqual(1);
        }
      } finally {
        await context.close();
      }
    }
  }
});
