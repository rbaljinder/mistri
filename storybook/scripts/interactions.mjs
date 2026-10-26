/** A few complete user journeys through the reusable component stories. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.STORYBOOK_URL || 'http://localhost:6006';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const story = async (id) => {
    await page.goto(`${origin}/iframe.html?id=${id}&viewMode=story&globals=look:sage;mode:dark`);
  };

  await story('navigation-app-menus--top-bar');
  const directory = page.getByRole('button', { name: 'Directory', exact: true });
  await directory.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'People', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert(await directory.evaluate((node) => node === document.activeElement), 'Top menu returns keyboard focus');

  await page.setViewportSize({ width: 390, height: 844 });
  // The story's play function opens the folded menu, as its capture shows it.
  await story('navigation-app-menus--folded-menu');
  await page.getByRole('menuitem', { name: 'Directory', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Organization', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Teams', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS nested navigation and keyboard focus');

  await story('forms-controls--in-dialog');
  const edit = page.getByRole('button', { name: 'Edit teammate', exact: true });
  // The story's play function opens the dialog, as its capture shows it.
  await page.getByRole('dialog', { name: 'Edit teammate', exact: true }).waitFor();
  // One field column: every control shares a left edge and a width, and the footer's buttons stand apart.
  const geometry = await page.getByRole('dialog', { name: 'Edit teammate', exact: true }).evaluate((dialog) => ({
    controls: ['#person-name', '.dd-button', '.date-field-input', '.picker', '#note'].map((selector) => {
      const box = dialog.querySelector(selector).getBoundingClientRect();
      return { selector, left: box.left, width: box.width };
    }),
    // Side by side, or stacked where a phone-width dialog puts the primary on top: the clear space between the two boxes.
    gap: (([a, b]) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom))(
      [...dialog.querySelectorAll('.confirm-actions button')].map((button) => button.getBoundingClientRect()),
    ),
  }));
  for (const control of geometry.controls) {
    assert(Math.abs(control.left - geometry.controls[0].left) <= 1, `${control.selector} shares the column's left edge`);
    assert(Math.abs(control.width - geometry.controls[0].width) <= 1, `${control.selector} shares the column's width`);
  }
  assert(geometry.gap > 0, 'Dialog buttons have a gap');
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('option', { name: /Engineering/ }).click();
  await page.getByLabel('Manager', { exact: true }).fill('Maya');
  await page.getByRole('option', { name: 'Maya Chen' }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(
    await page.getByRole('dialog', { name: 'Edit teammate', exact: true }).count(),
    1,
    'Calendar Escape preserves enclosing dialog',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert(await edit.evaluate((node) => node === document.activeElement), 'Dialog returns focus');
  console.log('PASS nested dropdown, picker, calendar and dialog');

  await story('lists-work-collections--split-inbox');
  const task = page.getByRole('row', { name: 'Prepare the onboarding plan', exact: true });
  await task.click();
  await page.getByRole('dialog', { name: 'Details', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Prepare the onboarding plan', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Details', exact: true }).waitFor({ state: 'hidden' });
  assert(await task.evaluate((node) => node === document.activeElement), 'Closing phone details returns focus to the selected task');
  await story('layouts-content--mobile-record-cards');
  await page.locator('.record-summaries').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.record-summary').count(), 3, 'Phone record cards render all fixture rows');
  assert.equal(await page.locator('.result-table').isVisible(), false, 'Phone cards replace the table');
  console.log('PASS mobile record cards and split-detail selection, Escape and focus return');

  await story('forms-complete-form--guided-request');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Your name (required)', exact: true });
  await page.locator('[aria-invalid="true"]').first().waitFor();
  assert(await name.evaluate((node) => node === document.activeElement), 'Invalid step focuses the field');
  await name.fill('Maya Chen');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('radio', { name: 'Laptop', exact: true }).check();
  await page.getByRole('textbox', { name: 'Needed by (required)', exact: true }).fill('2026-10-02');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await name.inputValue(), 'Maya Chen', 'Back preserves the draft');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert(await page.getByRole('radio', { name: 'Laptop', exact: true }).isChecked(), 'Choice survives previous step');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('textbox', { name: 'Additional details', exact: true }).fill('For the new teammate.');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByText('REQ-2041', { exact: true }).waitFor();
  console.log('PASS required fields, step navigation, draft retention and receipt');

  // The story's play function fills and sends the form; the refusal is what it leaves.
  await story('forms-complete-form--server-refusal');
  await page.getByText('Equipment requests are temporarily unavailable. Your entries are still here.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).inputValue(), 'Maya Chen');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await story('forms-command-fields--validation');
  await page.getByText('Enter a complete work email address.', { exact: true }).waitFor();
  const feedback = await page
    .locator('.command-field')
    .first()
    .evaluate((field) => {
      const label = field.querySelector('label').getBoundingClientRect();
      const input = field.querySelector('input').getBoundingClientRect();
      const error = field.querySelector('.form-field-problem').getBoundingClientRect();
      return { labelLeft: label.left, inputLeft: input.left, errorLeft: error.left, inputBottom: input.bottom, errorTop: error.top };
    });
  assert.equal(feedback.labelLeft, feedback.inputLeft, 'Error does not create a second field column');
  assert.equal(feedback.errorLeft, feedback.inputLeft, 'Error aligns with input');
  assert(feedback.errorTop >= feedback.inputBottom, 'Error follows its input');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS server refusal preserves the draft and validation layout stays aligned');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const look of ['lumen', 'mono', 'sage']) {
    for (const mode of ['light', 'dark']) {
      await page.goto(
        `${origin}/iframe.html?id=records-related-collections--table-and-phone-records&viewMode=story&globals=look:${look};mode:${mode}`,
      );
      const records = page.getByRole('button', { name: 'Records', exact: true });
      const table = page.getByRole('button', { name: 'Table', exact: true });
      await page.locator('.record-summaries').waitFor({ state: 'visible' });
      const colors = async (control) =>
        control.evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.color, style.backgroundColor, style.borderColor];
        });
      assert.notDeepEqual(await colors(records), await colors(table), `${look}/${mode}: selected presentation is visible`);
      await records.hover();
      assert.notDeepEqual(await colors(records), await colors(table), `${look}/${mode}: selection survives hover`);
      const title = page.locator('.record-summary-title').first();
      await title.focus();
      const focus = await title.evaluate((node) => ({
        title: getComputedStyle(node).outlineStyle,
        container: getComputedStyle(node.parentElement).outlineStyle,
      }));
      assert.notEqual(focus.title, 'none', 'Record opening action has a keyboard focus ring');
      assert.equal(focus.container, 'none', 'Record opening action has only one focus ring');
      await table.click();
      await page.locator('.result-table').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.record-summaries').isVisible(), false);
      await records.click();
      await page.locator('.record-summaries').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.result-table').isVisible(), false);
    }
  }
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS related record presentation, selected states and one keyboard focus ring in all three looks and both modes');

  // The journeys above are written by hand and so name only the stories someone thought to name; a story added since ran
  // in no script. Every story in Storybook's own index is opened here, so a new one is covered the day it lands: it must
  // paint into the root with no uncaught error and no error screen, and its play function (which runs on load) must pass.
  const index = await (await fetch(`${origin}/index.json`)).json();
  const stories = Object.values(index.entries).filter((entry) => entry.type === 'story');
  assert(stories.length > 0, 'Storybook index lists stories');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const broken = [];
  for (const { id } of stories) {
    errors.length = 0;
    await page.goto(`${origin}/iframe.html?id=${id}&viewMode=story&globals=look:lumen;mode:light`);
    await page.waitForFunction(
      () =>
        (document.body.classList.contains('sb-show-main') && document.querySelector('#storybook-root')?.children.length) ||
        document.querySelector('.sb-errordisplay')?.checkVisibility(),
    );
    // Fixture reads and play functions settle after the first paint.
    await page.waitForTimeout(400);
    const failure = await page.evaluate(() => {
      const display = document.querySelector('.sb-errordisplay');
      return display?.checkVisibility() ? (display.textContent ?? '').trim().slice(0, 300) : '';
    });
    if (failure || errors.length) broken.push(`${id}: ${failure || errors.join('; ')}`);
  }
  assert.deepEqual(broken, [], 'Every story renders without an error');
  console.log(`PASS all ${stories.length} stories in the index render`);
} finally {
  await browser.close();
}
