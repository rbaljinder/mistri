/**
 * A component built on the behaviors (`@mistriwork/mistri/behaviors`), in a browser: test/fixtures/apps/layers's Order
 * page orders a list and carries a card between two lanes with nothing but the public entry. The module and its
 * stylesheet are fetched by the page that imports them and by no other; the keyboard and a pointer both move things,
 * and a screen reader is told where each landed. It starts its own server over a disposable database
 * (support/layersServer.ts).
 */
import { settled } from '@mistriwork/mistri/testing';
import { LONG_MS } from './support/budgets';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

test.describe('A page built on the behaviors', () => {
  test.setTimeout(LONG_MS);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('the behaviors are fetched by the page that imports them, and by no page that does not', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      /* Under the build's hash where a component names it (server http/componentRoutes.ts), bare where it does not. */
      if (/\/_mistri\/sdk\/(?:[0-9a-f]{10}\/)?behaviors\.js/.test(request.url())) asked.push(request.url());
    });
    await page.goto(`${app.origin}/things`);
    await settled(page);
    await page.goto(`${app.origin}/kit`);
    await settled(page);
    expect(asked, 'a list and a page of controls draw no behavior').toEqual([]);
    await page.goto(`${app.origin}/order`);
    await settled(page);
    await expect(page.locator('[data-slot="sortable-item"]')).toHaveCount(4);
    expect(asked).toHaveLength(1);
    // The grip is dressed by the behaviors' own sheet, which came with them: bare, and a hand to say it is grabbed.
    const grip = page.getByRole('button', { name: 'Move Measure' });
    await expect(grip).toHaveCSS('cursor', 'grab');
    await expect(grip).toHaveCSS('border-top-width', '0px');
  });

  test('the keyboard orders the list from its grip, and the change is heard as the keyboard’s and said aloud', async ({ page }) => {
    await page.goto(`${app.origin}/order`);
    await settled(page);
    const steps = page.locator('[data-slot="sortable-item"]');
    await expect(steps).toHaveText(['Measure', 'Cut', 'Sand', 'Paint']);
    await page.getByRole('button', { name: 'Move Measure' }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    // Shown where it would land, and nothing told until it is put down.
    await expect(steps).toHaveText(['Cut', 'Sand', 'Measure', 'Paint']);
    await expect(page.locator('.c-page-order-said')).toHaveText('');
    await page.keyboard.press('Space');
    await expect(page.locator('.c-page-order-said')).toHaveText('move-key by keyboard');
    await expect(page.locator('[aria-live]').filter({ hasText: 'Dropped Measure at position 3 of 4.' })).toHaveCount(1);
    // Escape puts a held item back.
    await page.getByRole('button', { name: 'Move Cut' }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(steps).toHaveText(['Cut', 'Sand', 'Measure', 'Paint']);
  });

  test('a pointer carries an item by its grip, and the change is heard as a pointer’s', async ({ page }) => {
    await page.goto(`${app.origin}/order`);
    await settled(page);
    const steps = page.locator('[data-slot="sortable-item"]');
    const from = (await page.getByRole('button', { name: 'Move Paint' }).boundingBox())!;
    const to = (await steps.first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 4, from.y - 10, { steps: 4 });
    await page.mouse.move(to.x + 20, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect(steps).toHaveText(['Paint', 'Measure', 'Cut', 'Sand']);
    await expect(page.locator('.c-page-order-said')).toHaveText('drag by pointer');
  });

  test('the keyboard carries a card to the lane beside, and says where it landed', async ({ page }) => {
    await page.goto(`${app.origin}/order`);
    await settled(page);
    const todo = page.locator('[data-slot="transfer-list"][aria-label="To do"]');
    const done = page.locator('[data-slot="transfer-list"][aria-label="Done"]');
    await expect(todo.locator('[data-slot="transfer-item"]')).toHaveText(['Measure', 'Cut']);
    await page.getByRole('button', { name: 'Carry Measure' }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(done.locator('[data-slot="transfer-item"]')).toHaveText(['Measure', 'Sand']);
    await expect(todo.locator('[data-slot="transfer-item"]')).toHaveText(['Cut']);
    await expect(page.locator('[aria-live]').filter({ hasText: 'Dropped Measure in Done, position 1 of 2.' })).toHaveCount(1);
  });
});
