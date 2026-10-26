/**
 * What a signed-out visitor meets at a public door, in a browser
 * (test/fixtures/apps/door): the landing's hero with its badge, photo tiles
 * and icon rows; the stock public form drawing the human check's widget
 * (Turnstile's local stand-in, so nothing leaves the machine), the makes from
 * their table and the App's own swatch input, and sending the widget's token;
 * and a public page whose command goes through the page's own door with its
 * ticket. Each wait for the page to finish is `settled` from @mistriwork/mistri/testing.
 * It starts its own server over a disposable database (support/doorServer.ts),
 * so it shares nothing with another spec.
 */
import { DatabaseSync } from 'node:sqlite';
import { settled } from '@mistriwork/mistri/testing';
import { expect, test } from './support/harness';
import { startDoorApp } from './support/doorServer';

type Fixture = Awaited<ReturnType<typeof startDoorApp>>;

function rows(app: Fixture, sql: string) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test.describe('A public door', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startDoorApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test("the landing's hero: a badge, three photo tiles the public reads, two icon rows", async ({ page }) => {
    await page.goto(`${app.origin}/`);
    await settled(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Paint that outlasts the weather');
    await expect(page.locator('.front-badge')).toHaveText('Mixed while you wait');
    // The hero's rules are the public chunk's sheet, not the shell's (landingHero.css): they came with it.
    await expect(page.locator('.front-badge')).toHaveCSS('justify-self', 'start');
    await expect(page.locator('.front-hero-tiles')).toHaveCSS('display', 'grid');
    const tiles = page.locator('.front-hero-tiles img');
    await expect(tiles).toHaveCount(3);
    for (const alt of ['A wall of paint tins', 'A brush on a fresh coat', 'The mixing counter']) {
      const tile = page.getByRole('img', { name: alt });
      await expect(tile).toBeVisible();
      // Each photo arrived: the public image pipeline served it.
      expect(await tile.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    const points = page.locator('.front-points li');
    await expect(points).toHaveText(['Ten-year finish guarantee', 'Ready in fifteen minutes']);
    await expect(points.first().locator('svg')).toHaveCount(1);
  });

  test("the public form draws the widget, the makes and the App's swatch, and sends the widget's token", async ({ page }) => {
    await page.goto(`${app.origin}/form/ask`);
    await settled(page);
    // The stand-in's widget drew itself with the App's site key, and handed the form its token.
    await expect(page.locator('[data-turnstile-stub="door-site-key"]')).toHaveText('Verified');
    // The makes are the table's rows, offered by name.
    const makes = page.getByRole('radiogroup', { name: /^Make/ });
    await expect(makes.getByRole('radio')).toHaveCount(3);
    await makes.getByText('Ridge Matte').click();
    await expect(makes.getByRole('radio', { name: 'Ridge Matte' })).toBeChecked();
    // The color field is the App's own component, loaded for a visitor.
    const swatches = page.getByRole('radiogroup', { name: /^Color/ });
    await expect(swatches).toBeVisible();
    await swatches.getByRole('radio', { name: 'teal' }).click();
    await expect(swatches.getByRole('radio', { name: 'teal' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Continue' }).click();
    const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/forms/ask'));
    await page.getByRole('button', { name: /Submit|Send/ }).click();
    const request = await sent;
    // A fresh token of the person's, issued on this page's host, good once.
    expect(request.headers()['x-mistri-challenge']).toMatch(/^person~\w+~127\.0\.0\.1$/);
    expect(JSON.parse(request.postData() ?? '{}')).not.toHaveProperty('trap');
    await expect(page.getByText('We have your question')).toBeVisible();
    expect(rows(app, 'SELECT make_id, color FROM inquiry')).toEqual([{ make_id: 2, color: 'teal' }]);
  });

  test('a submission without the widget’s token, or with a decoy filled, is not written', async ({ page }) => {
    const before = rows(app, 'SELECT count(*) AS n FROM inquiry')[0].n;
    const post = (headers: Record<string, string>, extra: Record<string, unknown>, n: number) =>
      page.request.post(`${app.origin}/api/forms/ask`, {
        // From an address of its own (this machine is a trusted proxy), so its refusals spend no other test's budget.
        headers: { origin: app.origin, 'x-forwarded-for': '198.51.100.10', ...headers },
        data: { input: { make: 1, color: 'navy' }, submission: `door-spec-${String(n).padStart(8, '0')}`, ...extra },
      });
    const robot = await post({}, {}, 1);
    expect(robot.status()).toBe(403);
    expect((await robot.json()).code).toBe('challenge_failed');
    expect((await post({ 'x-mistri-challenge': 'robot' }, {}, 2)).status()).toBe(403);
    // A filled decoy is answered as if it went, and nothing is written.
    const trapped = await post({ 'x-mistri-challenge': 'spec-person' }, { trap: 'https://spam.example.test' }, 3);
    expect(trapped.status()).toBeLessThan(300);
    expect(rows(app, 'SELECT count(*) AS n FROM inquiry')[0].n).toBe(before);
    // The token that passed is spent: sent again, it is refused.
    expect((await post({ 'x-mistri-challenge': 'spec-person' }, {}, 4)).status()).toBe(403);
  });

  test('a refused submission is fixed and sent again with a fresh token, under the same submission key', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': '198.51.100.20' });
    await page.goto(`${app.origin}/form/ask`);
    await settled(page);
    await expect(page.locator('[data-turnstile-stub="door-site-key"]')).toHaveText('Verified');
    const posts: Array<{ token: string | undefined; submission: string }> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/forms/ask'))
        posts.push({ token: request.headers()['x-mistri-challenge'], submission: JSON.parse(request.postData() ?? '{}').submission });
    });
    // A make the page offers is deleted behind its back: the submit reads the key in its transaction and refuses it.
    const db = new DatabaseSync(app.database, { timeout: 5000 });
    try {
      db.prepare('DELETE FROM make WHERE id = 3').run();
    } finally {
      db.close();
    }
    const makes = page.getByRole('radiogroup', { name: /^Make/ });
    await makes.getByText('Willow Satin').click();
    await page
      .getByRole('radiogroup', { name: /^Color/ })
      .getByRole('radio', { name: 'navy' })
      .click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /Submit|Send/ }).click();
    await expect(page.getByText(/not one of the choices/).first()).toBeVisible();
    expect(posts).toHaveLength(1);
    // Fixed, and sent again: a fresh token (the first is spent), the same submission key.
    await page.getByRole('button', { name: /Back|Previous/ }).click();
    await makes.getByText('Harbor Gloss').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /Submit|Send/ }).click();
    await expect(page.getByText('We have your question')).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1].token).toMatch(/^person~/);
    expect(posts[1].token).not.toBe(posts[0].token);
    expect(posts[1].submission).toBe(posts[0].submission);
    expect(rows(app, "SELECT make_id, color FROM inquiry WHERE color = 'navy'")).toEqual([{ make_id: 1, color: 'navy' }]);
  });

  test("a public page's command goes through the page's door with its ticket", async ({ page }) => {
    await page.goto(`${app.origin}/lobby`);
    await settled(page);
    const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/pages/lobby/commands/enrol'));
    await page.getByLabel('Your name').fill('Mara Quill');
    // The makes come with the command, read as the public reads them: the page made no read of its own for them.
    // (The spec before this one deleted a make, so the table says which there are.)
    const paint = page.getByRole('combobox', { name: /^Paint/ });
    const makes = rows(app, 'SELECT name FROM make ORDER BY name').map((row) => String(row.name));
    expect(makes).toContain('Ridge Matte');
    await expect(paint.locator('option:not([disabled])')).toHaveText(makes);
    await paint.selectOption({ label: 'Ridge Matte' });
    await page.getByRole('button', { name: 'Enrol' }).click();
    const request = await sent;
    expect(request.headers()['x-mistri-ticket']).toBeTruthy();
    expect(request.headers()['x-mistri-challenge']).toBe('lobby-person');
    await expect(page.getByRole('form', { name: 'Enrol' }).getByRole('status')).toHaveText(/^Enrolled: ENR-/);
    expect(rows(app, 'SELECT name, make_id FROM enrolment')).toEqual([{ name: 'Mara Quill', make_id: 2 }]);
  });
});
