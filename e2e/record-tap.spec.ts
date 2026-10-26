import { COMPASS, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

/* Record summaries are the phone's, 760px and under; a tablet keeps the grid
   (docs/design.md). */
for (const width of [412, 760]) {
  test(`record facts and gutters navigate at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 1024 }, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(`${CRM}/lead`);
      const summary = page.locator('.record-summary').first();
      await expect(summary.locator('.record-summary-title')).toHaveText(/\S/);
      const title = (await summary.locator('.record-summary-title').textContent())!.trim();
      await summary.locator('dd').first().tap();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await page.goBack();
      await expect(summary).toBeVisible();
      await summary.tap({ position: { x: 5, y: 5 } });
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    } finally {
      await context.close();
    }
  });
}

/* A field cannot take a hit area larger than it draws, so on a touch screen an App form draws its fields at the
   44px of its actions (docs/design.md, Access); at a desk they keep the look's height. */
test("a New form's fields stand at a finger's 44px on a touch screen, and at the look's height at a desk", async ({ browser }) => {
  for (const touch of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch });
    const page = await context.newPage();
    try {
      await page.goto(`${CRM}/leads/new`);
      const form = page.getByRole('dialog', { name: 'New lead' });
      await expect(form).toBeVisible();
      // A typeahead's input is drawn inside its picker's box, which is the field the finger meets.
      const fields = form.locator(
        '.insert-field :is(input:not(.picker-input, [type=checkbox], [type=radio], [role=switch]), .dd-button, .record-picker-trigger, .picker)',
      );
      expect(await fields.count()).toBeGreaterThan(2);
      const heights = await fields.evaluateAll((list) =>
        list.map((field) => [field.getBoundingClientRect().height, field.className] as const),
      );
      if (touch) expect(heights.filter(([height]) => height < 44)).toEqual([]);
      else expect(heights.some(([height]) => height < 44)).toBe(true);
    } finally {
      await context.close();
    }
  }
});
