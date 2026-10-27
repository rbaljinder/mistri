import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { startDeskBlocks } from './support/deskBlocksServer';

type Fixture = Awaited<ReturnType<typeof startDeskBlocks>>;
async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
function messages(app: Fixture) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare('SELECT body, kind FROM message WHERE ticket_id=1 AND id>5 ORDER BY id').all();
  } finally {
    db.close();
  }
}
function status(app: Fixture, id: number) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return (db.prepare('SELECT status FROM ticket WHERE id=?').get(id) as { status: string }).status;
  } finally {
    db.close();
  }
}

test.describe('Desk blocks', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startDeskBlocks();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const width of [1440, 390])
    test(`conversation timeline reads oldest first and takes a reply and a note at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, app);
      await page.goto(`${app.origin}/all/1`);
      const rows = page.locator('.timeline-scroll [data-timeline-row]');
      await expect(rows.first()).toContainText('VPN drops about once an hour');
      await expect(rows.last()).toContainText('Priority raised to urgent');
      await expect(page.locator('.is-compact')).toHaveCount(1);
      await expect(page.locator('[data-tone="warn"]')).toHaveCount(1);
      const composer = page.locator('.timeline-composer');
      // A form control anywhere but the composer, whose own box is drawn as a field too.
      const actionForm = page.locator('.field-control:not(.timeline-composer .field-control)');
      await composer.getByRole('textbox').fill('Rebooted the gateway.');
      await composer.locator('button[type="submit"]').click();
      // While it is in flight the composer alone holds the words: the action bar draws no form of its own.
      await expect(actionForm).toHaveCount(0);
      await expect(rows.filter({ hasText: 'Rebooted the gateway.' })).toHaveCount(1);
      await expect.poll(() => messages(app)).toEqual([{ body: 'Rebooted the gateway.', kind: 'reply' }]);
      await composer.getByRole('button', { name: 'Internal note' }).click();
      await composer.getByRole('textbox').fill('Waiting on network.');
      await composer.locator('button[type="submit"]').click();
      // While it is in flight the composer alone holds the words: the action bar draws no form of its own.
      await expect(actionForm).toHaveCount(0);
      await expect(rows.filter({ hasText: 'Waiting on network.' })).toHaveCount(1);
      await expect.poll(() => messages(app).at(-1)).toEqual({ body: 'Waiting on network.', kind: 'internal' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

  /* A conversation longer than its box opens at its newest message, kept there while the rows above it settle, and
     its top edge falls where a message starts: it opened a few pixels short of the foot at a desk and most of a
     message short on a phone, the top line cut (G184). Eight more replies than the seed holds make it overflow. */
  test('a long conversation opens at its newest message with no line cut at its top', async ({ page }) => {
    const db = new DatabaseSync(app.database);
    try {
      const last = db.prepare('SELECT id FROM message WHERE ticket_id=1 ORDER BY sent_at DESC LIMIT 1').get() as { id: number };
      for (let i = 0; i < 8; i++)
        db.prepare(
          `INSERT INTO message (name, ticket_id, body, kind, sent_at, author_id)
           SELECT 'Follow-up ' || ?, ticket_id, ?, 'reply', strftime('%Y-%m-%dT%H:%M:%SZ', sent_at, '+' || ? || ' minutes'), author_id
           FROM message WHERE id = ?`,
        ).run(i, `Follow-up ${i}: the gateway dropped again around lunch, and the reconnect took about two minutes.`, i + 1, last.id);
    } finally {
      db.close();
    }
    await login(page, app);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 800 });
      await page.goto(`${app.origin}/all/1`);
      const box = page.locator('.timeline-scroll');
      await expect(box.locator('[data-timeline-row]').last()).toContainText('Follow-up 7', { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() =>
          box.evaluate((element) => {
            const top = element.getBoundingClientRect().top;
            const lines = [...element.querySelectorAll('.timeline-day-label, [data-timeline-row], .timeline-fold')];
            return {
              overflows: element.scrollHeight > element.clientHeight,
              atFoot: element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
              cut: lines.filter((line) => {
                const edge = line.getBoundingClientRect();
                return edge.top < top - 0.5 && edge.bottom > top + 0.5;
              }).length,
            };
          }),
        )
        .toEqual({ overflows: true, atFoot: true, cut: 0 });
      // The App's own panes draw no scroll bar, even on a Mac with a mouse (style.css): the feed that scrolls inside
      // the page, and the navigation list. A popup's listbox keeps its bar, the only sign it has more.
      const bars = await page.evaluate(() => {
        const read = (element: Element | null) =>
          element
            ? {
                width: getComputedStyle(element).scrollbarWidth,
                taken: (element as HTMLElement).offsetWidth - (element as HTMLElement).clientWidth,
              }
            : null;
        const popup = document.body.appendChild(document.createElement('div'));
        popup.className = 'picker-popup';
        const listbox = read(popup);
        popup.remove();
        return { feed: read(document.querySelector('.timeline-scroll')), nav: read(document.querySelector('#table-list')), listbox };
      });
      expect(bars.feed).toEqual({ width: 'none', taken: 0 });
      // The nav list is behind the menu button on a phone; where it is drawn its bar is not.
      if (bars.nav) expect(bars.nav.width).toBe('none');
      expect(bars.listbox?.width).not.toBe('none');
    }
  });

  test("a canned reply fills the box and sends nothing; an author that is a reference is said by the person's name", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/all/1`);
    const rows = page.locator('.timeline-scroll [data-timeline-row]');
    await expect(rows.filter({ hasText: 'Thanks, looking into it now.' }).locator('.timeline-by')).toHaveText('Robin Bell');
    const composer = page.locator('.timeline-composer');
    const send = composer.locator('button[type="submit"]');
    /* Where Send sits in the composer: focusing the box may scroll the page a few pixels to show it whole, which moves
       the composer, not its foot. */
    const inComposer = async () => {
      const [box, form] = [(await send.boundingBox())!, (await composer.boundingBox())!];
      return { x: box.x - form.x, y: box.y - form.y, width: box.width, height: box.height };
    };
    const before = await inComposer();
    await composer.getByRole('button', { name: 'Templates' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Apology', 'Restart first']);
    await page.getByRole('menuitem', { name: 'Restart first' }).click();
    await expect(composer.getByRole('textbox')).toHaveValue('Please restart the device and tell us whether it helps.');
    await expect(composer.getByRole('textbox')).toBeFocused();
    expect(messages(app)).toEqual([]);
    // The menu sits at the foot's start: Send has not moved.
    expect(await inComposer()).toEqual(before);
    await send.click();
    await expect.poll(() => messages(app)).toEqual([{ body: 'Please restart the device and tell us whether it helps.', kind: 'reply' }]);
  });

  test('a split inbox served as the home picks within itself, as it does at its own address', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/`);
    const picks = page.locator('.queue-pick');
    await expect(picks).toHaveCount(3);
    await picks.filter({ hasText: 'VPN drops every hour' }).click();
    // Beside the list, at the split's own address, and its keys answer — not the whole ticket's page.
    await expect(page).toHaveURL(`${app.origin}/inbox/1`);
    await expect(picks).toHaveCount(3);
    await expect(picks.filter({ hasText: 'VPN drops every hour' })).toHaveAttribute('aria-current', 'true');
    // A key answers once its verb is offered: the hint beside it says so.
    await expect(page.locator('.key-hint').first()).toBeVisible();
    await page.keyboard.press('s');
    await expect.poll(() => status(app, 1)).toBe('solved');
  });

  test('split rows show their chosen lines and a key runs an action outside inputs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/inbox/1`);
    const picks = page.locator('.queue-pick');
    await expect(picks).toHaveCount(3);
    const first = picks.filter({ hasText: 'VPN drops every hour' });
    await expect(first).toContainText('Ana Pereira');
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.key-hint').first()).toBeVisible();
    await page.keyboard.press('s');
    await expect.poll(() => status(app, 1)).toBe('solved');
  });

  /* Seen once while 0.8.13's blocks were built: a desk record narrowed from 1440px to 390px without a reload left its
     conversation a column about 89px wide. The phone's layout is read off the window as the window changes, never
     fixed at load, so a resized record is the record a phone opens fresh. */
  test('a desk record narrowed to a phone reflows as a phone opens it', async ({ page, browser }) => {
    const measure = () =>
      page.evaluate(() => {
        const width = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().width);
        return {
          layout: getComputedStyle(document.querySelector('.page-layout')!).gridTemplateColumns.split(' ').length,
          main: width('.page-main'),
          timeline: width('.page-timeline'),
          rows: Array.from(document.querySelectorAll('.timeline-scroll [data-timeline-row]'), (row) =>
            Math.round(row.getBoundingClientRect().width),
          ),
        };
      });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/all/1`);
    const rows = page.locator('.timeline-scroll [data-timeline-row]');
    await expect(rows.last()).toContainText('Priority raised to urgent');
    // At a desk: the record and its context side by side, the conversation the main column's width.
    expect((await measure()).layout).toBe(2);
    for (const width of [1100, 900, 600, 390]) await page.setViewportSize({ width, height: 844 });
    await expect.poll(async () => (await measure()).layout).toBe(1);
    const resized = await measure();
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await login(phone, app);
      await phone.goto(`${app.origin}/all/1`);
      await expect(phone.locator('.timeline-scroll [data-timeline-row]').last()).toContainText('Priority raised to urgent');
      const fresh = await phone.evaluate(() => {
        const width = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().width);
        return {
          layout: getComputedStyle(document.querySelector('.page-layout')!).gridTemplateColumns.split(' ').length,
          main: width('.page-main'),
          timeline: width('.page-timeline'),
          rows: Array.from(document.querySelectorAll('.timeline-scroll [data-timeline-row]'), (row) =>
            Math.round(row.getBoundingClientRect().width),
          ),
        };
      });
      expect(resized.timeline).toBe(resized.main);
      expect(resized).toEqual(fresh);
    } finally {
      await phone.close();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
