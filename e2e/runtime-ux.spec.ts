import { COMPASS, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

for (const theme of ['lumen', 'mono'])
  test(`mobile record gutters and facts stay aligned with ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('mistri.visual-theme', value), theme);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${CRM}/opportunity`);
      await expect(page.locator('.applist-title')).toBeVisible();
      const heading = await page.locator('.applist-title').boundingBox();
      expect(heading!.height).toBeLessThan(45);
      const list = page.getByRole('list', { name: 'Records', exact: true });
      await expect(list).toBeVisible();
      const record = list.locator('.record-summary').first();
      await record.scrollIntoViewIfNeeded();
      const gutter = await list.boundingBox();
      const title = await record.locator('.record-summary-title').boundingBox();
      expect(title!.x - gutter!.x).toBeGreaterThanOrEqual(16);
      expect(gutter!.x + gutter!.width - title!.x - title!.width).toBeGreaterThanOrEqual(16);
      /* A summary is two lines: the name, then its facts on one wrapping line,
       each caption beside its value, the facts apart where they share a line. */
      const facts = await record.locator('dl > div').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
      expect(facts[0].left).toBeCloseTo(title!.x, 0);
      for (const [before, after] of facts.slice(0, -1).map((fact, i) => [fact, facts[i + 1]])) {
        if (Math.abs(after.top - before.top) < 2) expect(after.left - before.right).toBeGreaterThanOrEqual(16);
        else expect(after.left).toBeCloseTo(title!.x, 0);
      }
      expect(facts[0].top).toBeGreaterThanOrEqual(title!.y + title!.height);
      for (const fact of facts) expect(fact.right).toBeLessThanOrEqual(width - 16);
      await page.screenshot({ path: testInfo.outputPath(`record-gutters-${width}.png`) });
    }
  });

test('runtime UX: app editors are rectangular, named, and discard without a write', async ({ page }, testInfo) => {
  const updates: string[] = [];
  await page.route('**/api/update', async (route) => {
    updates.push(route.request().postData() ?? '');
    await route.abort();
  });
  await page.goto(`${CRM}/opportunity/~1`);
  await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Opportunity', exact: true });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  /* Rectangular in every look: a field's corners stop at the theme contract's
     8px cap and never round into a pill. */
  expect(parseFloat(await name.evaluate((element) => getComputedStyle(element).borderRadius))).toBeLessThanOrEqual(8);
  await expect(page.getByRole('textbox', { name: /^ID$/ })).toHaveCount(0);
  const owner = page.getByRole('combobox', { name: 'Owner', exact: true });
  await page.getByRole('button', { name: 'Edit Owner', exact: true }).click();
  await expect(owner).toHaveValue(/[A-Za-z]/);
  const previousOwner = await owner.inputValue();
  await owner.fill('');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.getByRole('option').last().click();
  await expect(owner).toHaveAttribute('aria-expanded', 'false');
  await name.fill(`${original} edited`);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(name).toHaveValue(original);
  await expect(owner).toHaveValue(previousOwner);
  expect(updates).toEqual([]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await page
      .locator('.page-field .cell-edit, .page-field .cell-edit-control')
      .evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.getBoundingClientRect().toJSON()));
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width + 1);
      expect(box.height).toBeGreaterThanOrEqual(30);
    }
    await page.screenshot({ path: testInfo.outputPath(`edit-controls-${width}.png`) });
  }
});

test('runtime UX: mobile records preserve identity and key facts, with the table available', async ({ page }, testInfo) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${CRM}/opportunity`);
    const records = page.getByRole('list', { name: 'Records', exact: true });
    await expect(records).toBeVisible();
    await expect(records.locator('.record-summary').first().locator('dt')).toContainText(['Stage', 'Account']);
    const title = records.locator('.record-summary-title').first();
    const label = await title.innerText();
    const bounds = await records.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`mobile-records-${width}.png`) });
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('.result-table')).toBeVisible();
    await expect(records).toBeHidden();
    await page.getByRole('button', { name: 'Records', exact: true }).click();
    await title.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
  }
});

test('runtime UX: acknowledged edits survive subsequent edits and discard', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: Array<{ app: string; values: Record<string, unknown> }> = [];
  await page.route('**/api/update', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await gate;
    await route.fulfill({ json: { affected: 1, applied: body.values } });
  });
  try {
    await page.goto(`${CRM}/opportunity/~1`);
    await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Opportunity', exact: true });
    await name.fill('Acknowledged edit');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].app).toBe('compass');
    expect(requests[0]).not.toHaveProperty('conn');
    await expect(name).toBeDisabled();
    release();
    await expect(name).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Saved changes', exact: true })).toContainText('Changes saved');
    await expect(name).toHaveValue('Acknowledged edit');
    await expect(name).toHaveClass(/saved/);
    await name.fill('Another draft');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(name).toHaveValue('Acknowledged edit');
    expect(requests).toHaveLength(1);
  } finally {
    release();
  }
});

test('runtime UX: hiding App authoring controls preserves right-aligned business actions', async ({ page }) => {
  await page.goto(`${CRM}/@lead~127`);
  // The record's verbs stand at the far end of the crumb bar (PageHead.tsx), so the name has its own line.
  const bar = page.locator('.crumbs');
  const tools = bar.locator('.crumb-tools');
  await expect(tools.getByRole('button', { name: 'Mark lost', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy layout', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Page', exact: true })).toHaveCount(0);
  const bounds = (await bar.boundingBox())!;
  // The toolbar ends with More when the record also offers Delete; the group is what sits right.
  const lastAction = (await tools.locator('.page-head-actions').boundingBox())!;
  expect(bounds.x + bounds.width - lastAction.x - lastAction.width).toBeLessThan(40);
  expect(lastAction.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(lastAction.y + lastAction.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
});

test('runtime UX: an App has no authoring tools and no Workbench', async ({ page }) => {
  await page.goto(`${CRM}/opportunity/~1`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await expect(page.getByRole('button', { name: 'Copy layout' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Workbench/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^App definition/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('runtime UX: creation fields and validation stay inside the mobile drawer', async ({ page }, testInfo) => {
  await page.goto(`${CRM}/lead`);
  await page.getByRole('button', { name: '+ New lead' }).click();
  const form = page.locator('.newpanel');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form.locator('.insert-field.missing .insert-missing').first()).toContainText('Fill in');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const panel = await form.boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1);
    const boxes = await form
      .locator(
        '.insert-field > label, .insert-field > .form-field-label-row, .insert-field > .insert-input, .insert-field > .dd, .insert-field > .picker, .insert-missing:not([hidden])',
      )
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(panel!.x);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    const missing = form.locator('.insert-field.missing').first();
    const control = await missing.locator('.insert-input').boundingBox();
    const message = await missing.locator('.insert-missing').boundingBox();
    expect(message!.y).toBeGreaterThanOrEqual(control!.y + control!.height);
    expect(Math.abs(message!.x - control!.x)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath(`new-form-${width}.png`) });
  }
  await form.getByRole('button', { name: 'Cancel' }).click();
});

test('runtime UX: mobile navigation has separate, usable targets', async ({ page }, testInfo) => {
  await page.goto(CRM);
  await expect(page.locator('body')).toHaveClass(/app-topnav/);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(menu).toBeVisible();
    const boxes = await page
      .locator('.topbar button')
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => button.checkVisibility({ visibilityProperty: true }))
          .map((button) => ({ name: button.getAttribute('aria-label') ?? button.textContent, ...button.getBoundingClientRect().toJSON() })),
      );
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      expect(a.left, `${a.name} starts inside ${width}px`).toBeGreaterThanOrEqual(0);
      expect(a.right, `${a.name} ends inside ${width}px`).toBeLessThanOrEqual(width);
      expect(a.height, `${a.name} target height`).toBeGreaterThanOrEqual(24);
      for (const b of boxes.slice(i + 1)) {
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        expect(overlapX > 0.5 && overlapY > 0.5, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
    await menu.click();
    /* Compass's groups are one level deep, so the folded menu is labelled
       sections: Leads is one tap away, under Sales. */
    await expect(page.locator('.tn-folded-pop .tn-folded-label').first()).toHaveText('Sales');
    await page.getByRole('menuitem', { name: 'Leads', exact: true }).click();
    await expect(page.locator('.applist-title')).toHaveText('Leads');
  }
});

test('runtime UX: charts resize with their container and keep date labels apart', async ({ page }, testInfo) => {
  await page.goto(CRM);
  const chart = page.locator('.chart-line').first();
  await expect(chart).toBeVisible();
  for (const width of [1440, 768, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        chart.evaluate((svg) => {
          const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
          return Math.abs(svg.getBoundingClientRect().width / scale - (svg as SVGSVGElement).viewBox.baseVal.width);
        }),
      )
      .toBeLessThan(1);
    const labels = await chart.locator('.chart-x-tick').evaluateAll((ticks) => ticks.map((tick) => tick.getBoundingClientRect().toJSON()));
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < labels.length; i++) {
      expect(labels[i].height).toBeGreaterThanOrEqual(9);
      if (i > 0) expect(labels[i].left - labels[i - 1].right).toBeGreaterThanOrEqual(6);
    }
    await chart.screenshot({ path: testInfo.outputPath(`chart-${width}.png`) });
  }
});

test('runtime UX: dismissing search restores its launcher, and search offers no Workbench', async ({ page }) => {
  await page.goto(CRM);
  await expect(page.locator('body')).toHaveClass(/app-topnav/);
  const search = page.getByRole('button', { name: 'Search (⌘K)' });
  await search.click();
  const input = page.getByRole('combobox', { name: 'Search' });
  await expect(input).toHaveAttribute('placeholder', 'Search records, pages and commands…');
  await input.fill('nothing-matches-this-record');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(search).toBeFocused();
  await search.click();
  await input.fill('Workbench');
  await expect(page.getByRole('option', { name: /Workbench/ })).toHaveCount(0);
  await input.press('Escape');
  await expect(search).toBeFocused();
});
