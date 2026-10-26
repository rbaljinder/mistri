import { test as base, expect, type Locator, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { startAutosaveApp, type AutosaveApp } from './support/autosaveServer.js';

type Update = { table: string; key: Record<string, unknown>; values: Record<string, unknown>; expected: Record<string, unknown> };
const updateURL = (url: URL) => url.pathname === '/api/update';
// A task's canonical address: its id under the view that lists tasks.
const recordPath = '/tasks/1';
const test = base.extend<{ sample: AutosaveApp; saveMode: 'blur' | 'explicit'; updates: Update[] }>({
  saveMode: ['blur', { option: true }],
  sample: async ({ saveMode }, use) => {
    const sample = await startAutosaveApp(saveMode);
    try {
      await use(sample);
    } finally {
      await sample.stop();
    }
  },
  updates: async ({ page }, use) => {
    const updates: Update[] = [];
    const collect = (request: import('@playwright/test').Request) => {
      if (updateURL(new URL(request.url()))) updates.push(request.postDataJSON());
    };
    page.on('request', collect);
    try {
      await use(updates);
    } finally {
      page.off('request', collect);
    }
  },
});

async function edit(page: Page, label: string) {
  await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
  return page.getByRole('textbox', { name: label, exact: true });
}

async function leaveField(page: Page) {
  // A real click on passive field-heading text, outside the complete editor.
  // Base UI marks outside content aria-hidden while its popup is open; the
  // heading remains visible and is a legitimate outside-pointer destination.
  await page.getByRole('heading', { name: 'Task fields', exact: true, includeHidden: true }).click();
}

async function quiet(page: Page, updates: Update[], count: number) {
  // Negative assertions must span deferred blur and picker debounce, not just
  // inspect the array synchronously before a browser event can run.
  await page.waitForTimeout(350);
  expect(updates).toHaveLength(count);
}

async function saved(page: Page, updates: Update[], count: number) {
  await expect(page.getByRole('region', { name: 'Saved changes', exact: true })).toContainText('Changes saved');
  await quiet(page, updates, count);
}

async function slowPress(page: Page, target: Locator, whileDown: () => Promise<void>) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    await whileDown();
  } finally {
    await page.mouse.up();
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const width of [1440, 390])
  test.describe(`Record autosave ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
    });

    test('preview, Details and cold keyed/generic record routes autosave', async ({ page, sample, updates }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}/task`);
      await page.getByText('Review the draft', { exact: true }).filter({ visible: true }).click();
      const preview = page.locator('.peekpanel-modal');
      await expect(preview).toBeVisible();
      await expect(preview.getByRole('button', { name: 'Edit Name', exact: true })).toBeVisible();
      // Simply opening the editable modal does not start an edit or a write.
      await expect(preview.getByRole('textbox')).toHaveCount(0);
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await preview.getByRole('button', { name: 'Details →', exact: true }).click();
      await expect(page).toHaveURL(/\/tasks\/1$/);
      await expect(page.locator('.page-body')).toBeVisible();
      // Cold URLs must resolve policy without having selected a list entry first.
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      await leaveField(page);
      await name.focus();
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await name.pressSequentially(' amended');
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await leaveField(page);
      await saved(page, updates, 1);
      expected.tasks[0].name += ' amended';
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
      expect(updates[0]).toMatchObject({
        table: 'task',
        key: { id: '1' },
        values: { name: expected.tasks[0].name },
        expected: { name: 'Review the draft' },
      });

      await page.goto(`${sample.origin}/note/~1`);
      // App row URLs resolve to suggested Pages.
      await expect(page.getByRole('heading', { name: 'Generic record', exact: true })).toBeVisible();
      const generic = await edit(page, 'Name');
      await generic.fill('Generic saved');
      await quiet(page, updates, 1);
      // The heading holds the name editor now; leave through the page name above it.
      await page.locator('.page-head .page-title').click();
      await saved(page, updates, 2);
      expected.notes[0].name = 'Generic saved';
      expected.applied.push({ table_name: 'note', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
      expect(updates[1]).toMatchObject({ table: 'note', values: { name: 'Generic saved' }, expected: { name: 'Generic record' } });
    });

    test('Discard clears an unresolved reference search without changing its stored ID or blocking the next save', async ({
      page,
      sample,
      updates,
    }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      await name.fill('');
      await page.getByRole('button', { name: 'Edit Assignee', exact: true }).click();
      const assignee = page.getByRole('combobox', { name: 'Assignee', exact: true });
      await assignee.fill('Missing');
      await leaveField(page);
      await expect(assignee).toHaveAttribute('aria-invalid', 'true');
      await quiet(page, updates, 0);
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(assignee).toHaveValue('Ada North');
      await expect(assignee).not.toBeFocused();
      await expect(page.locator('.edit-field-error')).toHaveCount(0);
      expect(sample.snapshot()).toEqual(expected);
      await name.fill('Fresh after discard');
      await leaveField(page);
      await saved(page, updates, 1);
      expected.tasks[0].name = 'Fresh after discard';
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
      expect(updates[0].values).toEqual({ name: 'Fresh after discard' });
    });

    test('required validation blocks the whole draft; Save and Enter each dispatch once with exact originals', async ({
      page,
      sample,
      updates,
    }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      await name.fill('');
      await leaveField(page);
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      const description = await name.getAttribute('aria-describedby');
      expect(description).toBeTruthy();
      await expect(name).toHaveAccessibleDescription('Required');
      await expect(page.locator('.edit-field-error')).toHaveCount(1);
      await expect(name).not.toBeFocused();
      const details = await edit(page, 'Details');
      await details.fill('Whole draft details');
      await leaveField(page);
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(name).toBeFocused();
      await quiet(page, updates, 0);
      await name.fill('Whole draft name');
      await expect(page.locator('.edit-field-error')).toHaveCount(0);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await saved(page, updates, 1);
      expect(updates[0].values).toEqual({ name: 'Whole draft name', details: 'Whole draft details' });
      expect(updates[0].expected).toEqual({ name: 'Review the draft', details: 'Original details' });
      Object.assign(expected.tasks[0], updates[0].values);
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);

      await name.fill('Enter submits once');
      await name.press('Enter');
      await leaveField(page);
      await saved(page, updates, 2);
      expect(updates[1].values).toEqual({ name: 'Enter submits once' });
      expect(updates[1].expected).toEqual({ name: 'Whole draft name' });
      expected.tasks[0].name = 'Enter submits once';
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
    });

    test.describe('explicit policy', () => {
      test.use({ saveMode: 'explicit' });
      test('App keeps explicit submission after blur', async ({ page, sample, updates }) => {
        const expected = sample.snapshot();
        await page.goto(`${sample.origin}${recordPath}`);
        const name = await edit(page, 'Name');
        await name.fill('Explicit app save');
        await leaveField(page);
        await quiet(page, updates, 0);
        expect(sample.snapshot()).toEqual(expected);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await saved(page, updates, 1);
        expected.tasks[0].name = 'Explicit app save';
        expected.applied.push({ table_name: 'task', record_id: 1 });
        expect(sample.snapshot()).toEqual(expected);
      });
    });

    test('held acknowledgement locks the editor and navigation, then refreshes the original list', async ({ page, sample, updates }) => {
      const expected = sample.snapshot();
      // Warm the list cache before changing its displayed name.
      await page.goto(`${sample.origin}/task`);
      await page.getByText('Review the draft', { exact: true }).filter({ visible: true }).click();
      await page.locator('.peekpanel-modal').getByRole('button', { name: 'Details →', exact: true }).click();
      await expect(page).toHaveURL(/\/tasks\/1$/);
      const editorURL = page.url();
      const held = deferred();
      await page.route(updateURL, async (route) => {
        const response = await route.fetch();
        await held.promise;
        await route.fulfill({ response });
      });
      try {
        const name = await edit(page, 'Name');
        const node = await name.elementHandle();
        await name.fill('Acknowledged later');
        await leaveField(page);
        expected.tasks[0].name = 'Acknowledged later';
        expected.applied.push({ table_name: 'task', record_id: 1 });
        await expect.poll(() => sample.snapshot()).toEqual(expected);
        await expect.poll(() => name.evaluate((node) => node.matches(':disabled') || node.hasAttribute('readonly'))).toBe(true);
        if (await name.isEnabled()) {
          await name.focus();
          await name.pressSequentially(' must not queue');
          await expect(name).toHaveValue('Acknowledged later');
        }
        await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
        await page.locator('#home-button').click();
        await expect(page.locator('#toast')).toContainText('pending record update');
        await expect(page).toHaveURL(editorURL);
        await expect(page).toHaveURL(editorURL);
        await quiet(page, updates, 1);
        expect(updates[0].values).toEqual({ name: 'Acknowledged later' });
        held.release();
        await saved(page, updates, 1);
        await expect(name).toBeEnabled();
        await expect(name).toHaveValue('Acknowledged later');
        expect(await name.evaluate((current, previous) => current === previous, node)).toBe(true);
        await page.getByRole('navigation', { name: 'Trail' }).getByRole('button', { name: 'Tasks', exact: true }).click();
        await expect(page.getByText('Acknowledged later', { exact: true }).filter({ visible: true })).toBeVisible();
        await expect(page.getByText('Review the draft', { exact: true })).toHaveCount(0);
        expect(sample.snapshot()).toEqual(expected);
      } finally {
        held.release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });

    test('real database rejection is atomic and correction needs manual Save before blur can resume', async ({ page, sample, updates }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      // Local invalidity keeps the snapshot together across separate field visits;
      // separate valid blur gestures are intentionally separate transactions.
      await name.fill('');
      await leaveField(page);
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      const details = await edit(page, 'Details');
      await details.fill('reject: complete snapshot');
      await leaveField(page);
      await quiet(page, updates, 0);
      await name.fill('Rejected snapshot name');
      await leaveField(page);
      await expect(page.locator('.pending-error')).toBeVisible();
      await quiet(page, updates, 1);
      expect(updates[0].values).toEqual({ name: 'Rejected snapshot name', details: 'reject: complete snapshot' });
      expect(updates[0].expected).toEqual({ name: 'Review the draft', details: 'Original details' });
      expect(sample.snapshot()).toEqual(expected);
      await details.fill('Corrected details');
      await leaveField(page);
      await name.focus();
      await leaveField(page);
      await quiet(page, updates, 1);
      expect(sample.snapshot()).toEqual(expected);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await saved(page, updates, 2);
      expect(updates[1].expected).toEqual(updates[0].expected);
      Object.assign(expected.tasks[0], { name: 'Rejected snapshot name', details: 'Corrected details' });
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
      await details.fill('Fresh blur after retry');
      await leaveField(page);
      await saved(page, updates, 3);
      expected.tasks[0].details = 'Fresh blur after retry';
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
    });

    test('lost real acknowledgement remains unknown and locked through navigation without retry', async ({ page, sample, updates }) => {
      const expected = sample.snapshot();
      await page.route(updateURL, async (route) => {
        await route.fetch();
        await route.abort('failed');
      });
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      await name.fill('Committed without acknowledgement');
      await leaveField(page);
      await expect(page.locator('.pending-uncertain')).toContainText('Update not confirmed');
      await expect(name).toBeDisabled();
      await expect(page.getByRole('region', { name: 'Saved changes', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
      expected.tasks[0].name = 'Committed without acknowledgement';
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
      await page.locator('#home-button').click();
      await expect(page).not.toHaveURL(`${sample.origin}${recordPath}`);
      // Home resets the browser trail; use the suite's same-document cold-link
      // helper to return without throwing away this tab's uncertain owner.
      await follow(page, recordPath);
      await expect(page).toHaveURL(`${sample.origin}${recordPath}`);
      await expect(page.locator('.pending-uncertain')).toContainText('Update not confirmed');
      await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeDisabled();
      await leaveField(page);
      await page.keyboard.press('Enter');
      await quiet(page, updates, 1);
      expect(sample.snapshot()).toEqual(expected);
    });

    test('pointerdown cancels blur before delayed Discard/navigation; Resume requires manual review', async ({ page, sample, updates }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}${recordPath}`);
      let name = await edit(page, 'Name');
      await name.fill('Discard on release');
      await slowPress(page, page.getByRole('button', { name: 'Discard', exact: true }), async () => {
        await quiet(page, updates, 0);
        expect(sample.snapshot()).toEqual(expected);
      });
      await expect(name).toHaveValue('Review the draft');
      await quiet(page, updates, 0);
      await name.fill('Retained on navigation');
      await slowPress(page, page.locator('#home-button'), async () => {
        await quiet(page, updates, 0);
        await expect(page).toHaveURL(`${sample.origin}${recordPath}`);
        expect(sample.snapshot()).toEqual(expected);
      });
      await expect(page).not.toHaveURL(`${sample.origin}${recordPath}`);
      await expect(page.locator('#toast')).toContainText(/retain|kept|unsaved/i);
      await follow(page, recordPath);
      const recovery = page.getByRole('region', { name: 'Retained draft', exact: true });
      await expect(recovery).toBeVisible();
      await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click();
      name = page.getByRole('textbox', { name: 'Name', exact: true });
      await expect(name).toHaveValue('Retained on navigation');
      await name.focus();
      await leaveField(page);
      const details = await edit(page, 'Details');
      await details.fill('New edit must not submit retained name');
      await leaveField(page);
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await saved(page, updates, 1);
      expect(updates[0].values).toEqual({ name: 'Retained on navigation', details: 'New edit must not submit retained name' });
      expect(updates[0].expected).toEqual({ name: 'Review the draft', details: 'Original details' });
      Object.assign(expected.tasks[0], updates[0].values);
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);
    });

    test('FK search blocks the draft; real portalled pointer/keyboard picks, Escape and nullable/required Clear', async ({
      page,
      sample,
      updates,
    }) => {
      const expected = sample.snapshot();
      await page.goto(`${sample.origin}${recordPath}`);
      const name = await edit(page, 'Name');
      await name.fill('');
      await leaveField(page);
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await page.getByRole('button', { name: 'Edit Assignee', exact: true }).click();
      const assignee = page.getByRole('combobox', { name: 'Assignee', exact: true });
      // Edit mode puts the current value in the box; typing before that lands
      // appended ("Ada NorthBea") and matches nothing.
      await expect(assignee).toBeFocused();
      await expect(assignee).toHaveValue('Ada North');
      await assignee.fill('Bea');
      const option = page.getByRole('option', { name: /Bea South/ });
      await expect(option).toBeVisible();
      // Prove this is the actual portal, outside the field that owns the input.
      const field = await assignee.locator('xpath=ancestor::*[@data-edit-field][1]').elementHandle();
      expect(await option.evaluate((node, owner) => owner!.contains(node), field)).toBe(false);
      await quiet(page, updates, 0);
      await leaveField(page);
      await expect(assignee).toHaveAttribute('aria-invalid', 'true');
      // Correcting Name cannot submit while its sibling has unresolved FK text.
      await name.fill('Name beside picker');
      await leaveField(page);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(assignee).toBeFocused();
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);
      await assignee.click();
      await expect(option).toBeVisible();
      await assignee.press('Escape');
      await expect(page.locator('.picker-popup')).toHaveCount(0);
      await expect(assignee).toHaveValue('Ada North');
      await leaveField(page);
      await quiet(page, updates, 0);
      expect(sample.snapshot()).toEqual(expected);

      await assignee.fill('Bea');
      await expect(option).toBeVisible();
      await slowPress(page, option, async () => {
        await quiet(page, updates, 0);
        expect(sample.snapshot()).toEqual(expected);
      });
      await expect(assignee).toHaveValue('Bea South');
      await expect(assignee).toBeFocused();
      await quiet(page, updates, 0);
      await leaveField(page);
      await saved(page, updates, 1);
      expect(updates[0].values).toEqual({ name: 'Name beside picker', assignee_id: '2' });
      expect(updates[0].expected).toEqual({ name: 'Review the draft', assignee_id: '1' });
      Object.assign(expected.tasks[0], { name: 'Name beside picker', assignee_id: 2 });
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);

      await assignee.fill('Ada');
      await expect(page.getByRole('option', { name: /Ada North/ })).toBeVisible();
      await assignee.press('ArrowDown');
      await assignee.press('Enter');
      await expect(assignee).toHaveValue('Ada North');
      await quiet(page, updates, 1);
      await leaveField(page);
      await saved(page, updates, 2);
      expect(updates[1].values).toEqual({ assignee_id: '1' });
      expect(updates[1].expected).toEqual({ assignee_id: '2' });
      expected.tasks[0].assignee_id = 1;
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);

      await page.getByRole('button', { name: 'Edit Backup', exact: true }).click();
      const backup = page.getByRole('combobox', { name: 'Backup', exact: true });
      await backup.locator('xpath=ancestor::*[contains(@class,"picker")][1]').getByRole('button', { name: 'Clear', exact: true }).click();
      await leaveField(page);
      await saved(page, updates, 3);
      expect(updates[2].values).toEqual({ backup_id: null });
      expect(updates[2].expected).toEqual({ backup_id: '3' });
      expected.tasks[0].backup_id = null;
      expected.applied.push({ table_name: 'task', record_id: 1 });
      expect(sample.snapshot()).toEqual(expected);

      await assignee.locator('xpath=ancestor::*[contains(@class,"picker")][1]').getByRole('button', { name: 'Clear', exact: true }).click();
      await leaveField(page);
      await expect(assignee).toHaveAttribute('aria-invalid', 'true');
      await quiet(page, updates, 3);
      expect(sample.snapshot()).toEqual(expected);
      await assignee.press('Escape');
      await expect(page.getByRole('button', { name: 'Edit Assignee', exact: true })).toBeVisible();
      await quiet(page, updates, 3);
      expect(sample.snapshot()).toEqual(expected);
    });
  });
