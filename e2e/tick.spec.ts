/*
 * e2e-lane: shared
 *
 * Tick owns its server and its database, so the lane rule reads it as parallel
 * and by the rule's own terms it is right: this spec collides with nothing.
 * What it cannot survive is a second browser on the machine.
 *
 * Most of the file is an assertion *about timing* rather than about state —
 * `expectCenteredHeader` measures the header against the content frame to
 * within a pixel once a ResizeObserver has settled, inside a seven-second
 * `toPass`, and several tests resize and measure again. A busy machine changes
 * the answer to that question without changing the code, and the first paint
 * after a `goto` can miss even a forty-five-second budget while another
 * worker's Vite is compiling. Run beside one other spec it failed three runs
 * out of three, a different test each time; run alone it passes.
 *
 * So it is here for the reason the serial lane exists — a red gate nobody
 * trusts costs more than the thirty-eight seconds this spec adds to it.
 */
import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';
import type { AppShell } from '../packages/mistri/src/shared/app';
import { chooseTab } from './support/tabs';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

async function expectCenteredHeader(page: Page) {
  await expect(page.locator('.topbar')).toHaveAttribute('data-header-width', 'content');
  // ResizeObserver updates header spacing after the pane finishes layout.
  await expect(async () => {
    const geometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.topbar')!;
      const frame = document.querySelector<HTMLElement>('.app-content-frame')!;
      const brand = document.querySelector('.brand-mark')!.getBoundingClientRect();
      const actions = document.querySelector('.topbar-actions')!.getBoundingClientRect();
      const rect = frame.getBoundingClientRect();
      const scale = rect.width / frame.offsetWidth;
      const css = getComputedStyle(frame);
      return {
        left: rect.left + parseFloat(css.paddingLeft) * scale,
        right: rect.right - parseFloat(css.paddingRight) * scale,
        brandLeft: brand.left,
        actionsRight: actions.right,
        headerLeft: header.getBoundingClientRect().left,
        headerWidth: header.getBoundingClientRect().width,
        viewport: innerWidth,
        border: parseFloat(getComputedStyle(header).borderBottomWidth),
      };
    });
    expect(Math.abs(geometry.brandLeft - geometry.left)).toBeLessThan(1);
    expect(Math.abs(geometry.actionsRight - geometry.right)).toBeLessThan(1);
    expect(geometry.headerLeft).toBe(0);
    expect(geometry.headerWidth).toBeCloseTo(geometry.viewport);
    expect(geometry.border).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }).toPass({ timeout: 7000 });
}

async function overrideShell(page: Page, shell: AppShell) {
  // A URL predicate pauses every Vite module request in Playwright. Match at
  // the browser instead so cold client startup does not depend on those hops.
  await page.route('**/api/app{,?*}', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.app.ui.shell = shell;
    await route.fulfill({ response, json });
  });
}

test.describe('Tick checklist', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(45_000);
  test.beforeEach(async ({ page }) => {
    sample = await startSample('tick');
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: quick-add stays on list, completion and reopening persist`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('.checklist')).toBeVisible();
      await expect(page).toHaveURL(`${sample.origin}/`);
      // `.work-panel` used to be the other half of this: nothing has drawn it
      // for a long time, so asking for it could only ever pass.
      await expect(page.locator('.shape')).toHaveCount(0);
      await expect(page.locator('.app-issues')).toHaveCount(0);
      await expect(page.locator('.result-table')).toHaveCount(0);
      await expect(page.locator('.applist-filterbar')).toHaveCount(0);
      await expect(page.locator('#topnav')).toBeHidden();
      await expect(page.locator('#search-button')).toBeHidden();
      await expect(page.locator('.crumbs-host')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toHaveCSS('position', 'absolute');
      const frame = await page.locator('.app-content-frame').boundingBox();
      expect(frame).not.toBeNull();
      if (width === 1440) {
        expect(frame!.width).toBeLessThan(width);
        expect(frame!.x).toBeGreaterThan(0);
      }
      await expectCenteredHeader(page);
      await page.getByRole('button', { name: '+ Add task', exact: true }).click();
      const form = page.locator('.quick-add form');
      await expect(form).toBeVisible();
      const name = `A quick task at ${width}`;
      await form.getByRole('textbox').first().fill(name);
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(page.locator('.applist-title')).toBeVisible();
      const checkbox = page.getByRole('checkbox', { name: `Complete ${name}`, exact: true });
      await expect(checkbox).toBeVisible();
      await checkbox.click();
      await expect(checkbox).toHaveCount(0);
      await expect.poll(() => scalar(sample.db, `SELECT completed FROM task WHERE name='${name}'`)).toBe(1);
      await chooseTab(page, /^Done/);
      await expect(page.locator('.crumbs-host')).toHaveCount(0);
      await page.getByRole('checkbox', { name: `Reopen ${name}`, exact: true }).click();
      await expect.poll(() => scalar(sample.db, `SELECT completed FROM task WHERE name='${name}'`)).toBe(0);
      await chooseTab(page, /^Open/);
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.peekpanel-modal')).toBeVisible();
      await expect(page.locator('.peekpanel-modal')).toContainText(name);
      await expect(page.locator('.peekpanel-modal')).toHaveAttribute('aria-modal', 'true');
      if (width <= 640) {
        const box = await page.locator('.peekpanel-modal').boundingBox();
        expect(box?.x).toBeCloseTo(0);
        expect(box?.y).toBeCloseTo(0);
        expect(box?.width).toBeCloseTo(width);
        expect(box?.height).toBeCloseTo(900);
      }
      await page.locator('.peekpanel-modal').getByRole('button', { name: 'Details →', exact: true }).click();
      await expect(page.locator('.page-body')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Page', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Copy layout', exact: true })).toHaveCount(0);
      const id = scalar(sample.db, 'SELECT id FROM task WHERE name=?', name);
      expect(scalar(sample.db, 'SELECT due_on FROM task WHERE id=?', id)).toBe(null);
      await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} edited`);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT name FROM task WHERE id=?', id)).toBe(`${name} edited`);
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} autosaved`);
      // The public manifest opts into blur; clicking a passive field label
      // leaves the editor without activating Save or a business action.
      await page.locator('.page-field dt').first().click();
      await expect.poll(() => scalar(sample.db, 'SELECT name FROM task WHERE id=?', id)).toBe(`${name} autosaved`);
      /* On a phone the record's verbs are a bar at the screen's foot, and the save's dock stands over it until it is
         put away (2d17bc18, page.css): read, and dismissed, as a thumb would. */
      const saved = page.getByRole('region', { name: 'Saved changes' });
      await expect(saved).toContainText('Changes saved');
      await saved.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(saved).toHaveCount(0);
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT completed FROM task WHERE id=?', id)).toBe(1);
      await page.getByRole('button', { name: 'Reopen', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT completed FROM task WHERE id=?', id)).toBe(0);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      expect(scalar(sample.db, 'SELECT count(*) FROM task WHERE id=?', id)).toBe(1);
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT count(*) FROM task WHERE id=?', id)).toBe(0);
      await expect(page).toHaveURL(/\/task/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  }

  for (const width of [1440, 390]) {
    test(`${width}px: with the menu shown, Tick has no nav to draw; the search shares the authored content bounds`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await overrideShell(page, { width: 'narrow', headerWidth: 'content', gutter: 'comfortable' });
      await page.goto(`${sample.origin}/`);
      // `load` precedes boot's dynamic shell import. Measure the authored
      // header after finishStartup reveals it, within the existing test budget.
      await page.locator('html:not([data-starting])').waitFor();
      await expect(page.locator('.checklist')).toBeVisible();
      await expectCenteredHeader(page);
      const nav = page.locator('#topnav');
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Search (⌘K)' })).toBeVisible();
      const frame = await page.locator('.app-content-frame').boundingBox();
      /* On a phone the nav's own box stands aside (display: contents) so its
         search joins the bar's one row; the search is what must stay in bounds. */
      const navBox = await nav.getByRole('button', { name: 'Search (⌘K)' }).boundingBox();
      expect(navBox!.x).toBeGreaterThanOrEqual(frame!.x);
      expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
      /* Tick names its home and no nav: its one list is the whole App, so
         the bar carries no menu item and no fold, whatever the shell allows. */
      await expect(nav.locator('.tn-item, .tn-popitem')).toHaveCount(0);
      await expect(nav.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0);
      await expect(nav.getByRole('button', { name: 'Tasks', exact: true })).toHaveCount(0);
      await nav.getByRole('button', { name: 'Search (⌘K)' }).click();
      await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    });
  }

  test('omitted/full header width preserve default spacing, independently of content width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // The look's own header spacing, with no shell settings at all.
    await overrideShell(page, {});
    await page.goto(`${sample.origin}/`);
    await expect(page.locator('.checklist')).toBeVisible();
    const header = page.locator('.topbar');
    const spacing = await header.evaluate((node) => getComputedStyle(node).paddingLeft);
    const brand = (await page.locator('.brand-mark').boundingBox())!.x;
    await page.unrouteAll({ behavior: 'wait' });
    for (const headerWidth of [undefined, 'full'] as const) {
      await overrideShell(page, { width: 'narrow', gutter: 'comfortable', headerWidth });
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('.checklist')).toBeVisible();
      await expect(header).toHaveCSS('padding-left', spacing);
      expect(Math.abs((await page.locator('.brand-mark').boundingBox())!.x - brand)).toBeLessThan(1);
      expect((await page.locator('.app-content-frame').boundingBox())!.x).toBeGreaterThan(200);
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('header follows width/gutters through resize while quick-add and record drafts keep their DOM owner', async ({ page }) => {
    await overrideShell(page, { width: 'narrow', headerWidth: 'content', gutter: 'comfortable', search: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: '+ Add task', exact: true }).click();
    const draft = page.locator('.quick-add form').getByRole('textbox').first();
    await draft.fill('Keep this unsaved draft');
    const original = await draft.elementHandle();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectCenteredHeader(page);
      await expect(draft).toHaveValue('Keep this unsaved draft');
      await expect(draft).toBeFocused();
      expect(await draft.evaluate((node, previous) => node === previous, original)).toBe(true);
    }
    await draft.fill('');
    await page.locator('.quick-add form').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto(`${sample.origin}/@task~2`);
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('Unsaved name');
    const field = await name.elementHandle();
    await page.setViewportSize({ width: 390, height: 900 });
    await expectCenteredHeader(page);
    await expect(name).toHaveValue('Unsaved name');
    await expect(name).toBeFocused();
    expect(await name.evaluate((node, previous) => node === previous, field)).toBe(true);
    expect(scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Water the plants');
  });

  test('content header reuses full/wide/narrow widths and every gutter including omission', async ({ page }) => {
    const settings: AppShell[] = [
      { width: 'full', gutter: 'none' },
      { width: 'wide', gutter: 'compact' },
      { width: 'narrow', gutter: 'normal' },
      { width: 'narrow' },
      { gutter: 'comfortable' },
    ];
    for (const shell of settings) {
      await overrideShell(page, { ...shell, headerWidth: 'content', search: false });
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('.checklist')).toBeVisible();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectCenteredHeader(page);
      }
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('due views, empty state and keyboard navigation are real questions', async ({ page }) => {
    await page.goto(`${sample.origin}/task`);
    await page.getByRole('tab', { name: /^Today/ }).click();
    // An empty tab says the tab is empty, by the records' noun and the tab's own word (AppList's tabEmpty).
    await expect(page.locator('.list-empty')).toContainText('No tasks in Today right now.');
    await expect(page.locator('body')).not.toContainText('No task for');
    await page.getByRole('tab', { name: /^Upcoming/ }).click();
    await expect(page.getByRole('button', { name: 'Return the library book', exact: true })).toBeVisible();
    await chooseTab(page, /^Open/);
    const checkbox = page.getByRole('checkbox', { name: 'Complete Water the plants', exact: true });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => scalar(sample.db, 'SELECT completed FROM task WHERE id=2')).toBe(1);
    await chooseTab(page, /^Done/);
    await expect(page.getByRole('checkbox', { name: 'Reopen Water the plants', exact: true })).toBeChecked();
  });

  test('lost update acknowledgement stays locked and never retries', async ({ page }) => {
    await page.goto(`${sample.origin}/task`);
    let calls = 0;
    await page.route('**/api/update**', async (route) => {
      calls++;
      await route.fetch();
      await route.abort('failed');
    });
    const checkbox = page.getByRole('checkbox', { name: 'Complete Plan the week', exact: true });
    await checkbox.click();
    await expect(page.locator('.checklist-status[role="alert"]')).toContainText('Update not confirmed');
    await expect(checkbox).toBeDisabled();
    await expect.poll(() => scalar(sample.db, 'SELECT completed FROM task WHERE id=1')).toBe(1);
    expect(calls).toBe(1);
  });

  test('an unbound record page remains a chooser, not a disabled task workspace', async ({ page }) => {
    await page.goto(`${sample.origin}/@task`);
    await expect(page.locator('.applist-grid tbody tr').first()).toBeVisible();
    await expect(page.locator('.checklist-toggle')).toHaveCount(0);
    await expect(page.locator('.quick-add')).toHaveCount(0);
  });

  test('modal becomes a full phone overlay, holds focus and returns it on dismissal', async ({ page }) => {
    await page.goto(`${sample.origin}/`);
    const title = page.getByRole('button', { name: 'Water the plants', exact: true });
    await title.click();
    const modal = page.locator('.peekpanel-modal');
    await expect(modal).toBeVisible();
    await page.setViewportSize({ width: 412, height: 924 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.25';
    });
    await expect
      .poll(async () => {
        const box = await modal.boundingBox();
        return box && Math.abs(box.x) < 1 && Math.abs(box.y) < 1 && Math.abs(box.width - 412) < 1 && Math.abs(box.height - 924) < 1;
      })
      .toBe(true);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      // Base UI cycles its focus guards on the next animation frame.
      await expect.poll(() => modal.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(page).toHaveURL(`${sample.origin}/`);
  });

  test('editable modal saves through its own dock without replacing the collection or URL', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/app',
      async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        json.app.ui.editing = { save: 'explicit' };
        await route.fulfill({ response, json });
      },
    );
    await page.goto(`${sample.origin}/`);
    const list = page.locator('.checklist');
    await expect(list).toBeVisible();
    const original = await list.elementHandle();
    await page.getByRole('button', { name: 'Water the plants', exact: true }).click();
    const modal = page.locator('.record-modal');
    await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const name = modal.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('Water the garden');
    expect(scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Water the plants');
    const save = modal.getByRole('button', { name: 'Save changes', exact: true });
    await expect(save).toBeVisible();
    expect(await save.evaluate((node) => Boolean(node.closest('[role="dialog"]')))).toBe(true);
    await save.click();
    await expect.poll(() => scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Water the garden');
    await expect(modal).toBeVisible();
    await expect(name).toHaveValue('Water the garden');
    expect(await list.evaluate((node, before) => node === before, original)).toBe(true);
    await expect(page).toHaveURL(`${sample.origin}/`);
    await modal.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect.poll(() => scalar(sample.db, 'SELECT completed FROM task WHERE id=2')).toBe(1);
    await expect(list.getByRole('button', { name: 'Water the garden', exact: true })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(`${sample.origin}/`);
  });

  test('modal loaded-record navigation retains an unsaved draft for explicit review', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/app',
      async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        json.app.ui.editing = { save: 'explicit' };
        await route.fulfill({ response, json });
      },
    );
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: 'Water the plants', exact: true }).click();
    const modal = page.locator('.record-modal');
    await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await modal.getByRole('textbox', { name: 'Name', exact: true }).fill('Retained modal draft');
    await modal.getByRole('button', { name: 'Next record', exact: true }).click();
    // The dialog's head says the kind; the record's name is the page's heading.
    await expect(modal.locator('.peekpanel-title')).toHaveText('Task');
    await expect(modal.getByRole('heading', { level: 1 })).toHaveText('Return the library book');
    await modal.getByRole('button', { name: 'Previous record', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Resume draft', exact: true })).toBeVisible();
    expect(scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Water the plants');
    await modal.getByRole('button', { name: 'Resume draft', exact: true }).click();
    // Resuming a retained draft opens its dirty field for review immediately.
    await expect(modal.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Retained modal draft');
    await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Retained modal draft');
    await expect(page).toHaveURL(`${sample.origin}/`);
  });

  test('modal lost Save acknowledgement blocks dismissal and record replacement without retry', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/app',
      async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        json.app.ui.editing = { save: 'explicit' };
        await route.fulfill({ response, json });
      },
    );
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: 'Water the plants', exact: true }).click();
    const modal = page.locator('.record-modal');
    let calls = 0;
    await page.route('**/api/update**', async (route) => {
      calls++;
      await route.fetch();
      await route.abort('failed');
    });
    await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await modal.getByRole('textbox', { name: 'Name', exact: true }).fill('Applied but unconfirmed');
    await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(modal.locator('.pending-uncertain')).toBeVisible();
    await page.keyboard.press('Escape');
    await modal.getByRole('button', { name: 'Next record', exact: true }).click();
    await modal.getByRole('button', { name: 'Details →', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Applied but unconfirmed');
    expect(calls).toBe(1);
    expect(scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Applied but unconfirmed');
    await expect(page).toHaveURL(`${sample.origin}/`);
  });

  test('phone modal uses Tick blur autosave and authorized nested deletion on the same home list', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: 'Water the plants', exact: true }).click();
    const modal = page.locator('.record-modal');
    await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const name = modal.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('Phone modal autosave');
    const original = await name.elementHandle();
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await name.evaluate((node, before) => node === before, original)).toBe(true);
    await expect(name).toBeFocused();
    await modal.locator('.page-field dt').first().click();
    await expect.poll(() => scalar(sample.db, 'SELECT name FROM task WHERE id=2')).toBe('Phone modal autosave');
    await modal.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const confirmation = page.locator('.delete-confirm');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => scalar(sample.db, 'SELECT count(*) FROM task WHERE id=2')).toBe(0);
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.checklist').getByRole('button', { name: 'Phone modal autosave', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(`${sample.origin}/`);
  });
});
