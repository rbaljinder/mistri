import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { startDrawerApp } from './support/commandDrawerServer';

/* A command form's frame follows New's rule: a short one is the centered dialog, a long one a side drawer over the
   record it was started from. The drawer takes no address, so Back leaves the record's page and the drawer with it. */
type Fixture = Awaited<ReturnType<typeof startDrawerApp>>;

async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
const notes = (app: Fixture) => {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare('SELECT name FROM visit_note WHERE patient_id=1').all();
  } finally {
    db.close();
  }
};

test.describe('Command drawer', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startDrawerApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('a long command opens as a drawer on the right edge, and a short one stays a dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/@patient~1`);

    await page.getByRole('button', { name: 'Quick note', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Quick note', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveClass(/command-drawer/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    const opener = page.getByRole('button', { name: 'Write a note', exact: true });
    const heading = page.locator('h1').first();
    const before = await heading.boundingBox();
    await opener.click();
    const drawer = page.getByRole('dialog', { name: 'Write a note', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveClass(/command-drawer/);
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    // Settled (the slide has ended) before it is measured.
    await expect
      .poll(async () => {
        const box = await drawer.boundingBox();
        return box ? Math.round(box.x + box.width) : -1;
      })
      .toBe(1440);
    const box = (await drawer.boundingBox())!;
    // 560px at the App's density zoom, which the ruler scales: not the window's width, and not a dialog's 34rem.
    expect(box.width).toBeGreaterThan(500);
    expect(box.width).toBeLessThanOrEqual(560);
    expect(Math.round(box.height)).toBe(900);
    // An overlay: the page under it has not moved.
    expect(await heading.boundingBox()).toEqual(before);
    // The foot (the verb and Cancel) stands inside the drawer, in view.
    await expect(drawer.getByRole('button', { name: 'Cancel' })).toBeInViewport();

    // Cancel closes it and focus returns to the button that opened it.
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    expect(notes(app)).toEqual([]);
  });

  test("a short form's accept box, date and time and cards keep their layout in the dialog (a field report)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/@patient~1`);
    await page.getByRole('button', { name: 'Book a visit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Book a visit', exact: true });
    await expect(dialog).toBeVisible();

    // The accept box is on its label's line, level with the first line of it, and not over it.
    const row = await dialog.locator('[data-slot="field-check-row"]').evaluate((node) => {
      const [box, label] = [node.querySelector('input')!, node.querySelector('label')!].map((el) => el.getBoundingClientRect());
      return { before: box.right <= label.left + 1, offset: Math.abs(box.top + box.height / 2 - (label.top + 10)) };
    });
    expect(row.before).toBe(true);
    expect(row.offset).toBeLessThan(10);

    // The date's text is as wide as a full date in the field's own font, and so is the time.
    const fits = await dialog.locator('[data-slot="date-field"]').evaluate((field) => {
      const measure = (input: HTMLInputElement, text: string) => {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(input).font}`;
        document.body.append(span);
        const width = span.getBoundingClientRect().width;
        span.remove();
        return input.clientWidth - width;
      };
      const date = field.querySelector<HTMLInputElement>('[data-slot="input"]')!;
      const time = field.querySelector<HTMLInputElement>('[data-slot="date-field-time"]')!;
      return { date: measure(date, 'MM/DD/YYYY'), time: time.scrollWidth <= time.clientWidth };
    });
    expect(fits.date).toBeGreaterThanOrEqual(0);
    expect(fits.time).toBe(true);

    // A card's line is under its title, not beside it.
    const first = dialog.locator('[data-slot="choice"]').first();
    const title = (await first.locator('[data-slot="choice-label"]').boundingBox())!;
    const help = (await first.locator('.intake-choice-help').boundingBox())!;
    expect(help.y).toBeGreaterThanOrEqual(title.y + 10);
    expect(Math.abs(help.x - title.x)).toBeLessThan(2);
  });

  test('the drawer submits and lands on the record; Back closes it and takes the page back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/`);
    await page.getByText('Ada Quill', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/patients\/1$/);
    const record = page.url();

    await page.getByRole('button', { name: 'Write a note', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Write a note', exact: true });
    await expect(drawer.getByRole('status')).toContainText('Ready to submit');
    // The drawer is not an address.
    expect(page.url()).toBe(record);
    await drawer.getByLabel('Title', { exact: false }).fill('Follow-up');
    await drawer.getByRole('button', { name: 'Write a note', exact: true }).click();
    await expect(drawer.getByRole('status')).toContainText('Note written.');
    await drawer.getByRole('button', { name: 'Done' }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(record);
    await expect(page.getByRole('heading', { name: /Ada Quill/ }).first()).toBeVisible();
    expect(notes(app)).toEqual([{ name: 'Follow-up' }]);

    await page.getByRole('button', { name: 'Write a note', exact: true }).click();
    await expect(drawer).toBeVisible();
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(record);
  });
});
