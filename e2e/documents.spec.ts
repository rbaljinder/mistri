/**
 * A document on paper (components/Document.tsx), as a field report printed one: a saved statement that said
 * "yesterday", captions too faint to read, a dark screen's pale ink on the white sheet, and "Skip to content" in the
 * PDF. The payslip of the Payday fixture is the document: dates (its own and its pay run's), money and a status.
 */
import { expect, test, type Browser, type Page } from './support/harness';
import { PAYDAY_ADMIN, startSample } from './support/sampleServer';
import { rows } from './support/db';
import { readings } from './support/contrast';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets';

let sample: Awaited<ReturnType<typeof startSample>>;
let stub: { id: number; pay_date: string; period_start: string; period_end: string };

test.setTimeout(240_000);

test.beforeAll(async () => {
  sample = await startSample('payday');
  [stub] = rows<typeof stub>(
    sample.db,
    `SELECT s.id, s.pay_date, r.period_start, r.period_end FROM pay_stub s JOIN pay_run r ON r.id = s.pay_run_id
     WHERE r.status = 'paid' ORDER BY s.id LIMIT 1`,
  );
});
test.afterAll(async () => sample?.stop());

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
    headers: { origin: sample.origin },
    data: PAYDAY_ADMIN,
  });
  expect(login.ok()).toBe(true);
}

async function openPayslip(page: Page): Promise<void> {
  await page.goto(`${sample.origin}/pay-statements/${stub.id}/payslip`);
  await expect(page.locator('.doc-sheet .doc-table, .doc-sheet .doc-totals').first()).toBeVisible();
  await expect(page.locator('.doc-sheet')).not.toHaveAttribute('aria-busy', 'true');
}

/** A day of the stored calendar, plus some days, at noon UTC: the instant a reader's clock is set to. */
const dayAfter = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000);

/** The sheet's words, as a reader sees them. */
const sheetText = (page: Page) => page.locator('.doc-sheet').innerText();

async function readIn(browser: Browser, timezoneId: string, now: Date): Promise<string> {
  const context = await browser.newContext({ timezoneId, locale: 'en-US' });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    await signIn(page);
    await openPayslip(page);
    return await sheetText(page);
  } finally {
    await context.close();
  }
}

test('a saved payslip says its dates as days: the same words on any day, in any zone', async ({ browser }) => {
  /* The day after it was paid in Los Angeles, two weeks on in Auckland (a day ahead of UTC), and next spring. */
  const said = [
    await readIn(browser, 'America/Los_Angeles', dayAfter(stub.pay_date, 1)),
    await readIn(browser, 'Pacific/Auckland', dayAfter(stub.pay_date, 13)),
    await readIn(browser, 'UTC', dayAfter(stub.pay_date, 180)),
  ];
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  for (const text of said) {
    expect(text).not.toMatch(/\b(yesterday|today|tomorrow|ago)\b|\bin \d+ (days?|weeks?|months?)\b/i);
    /* A date is a day: stored 2026-09-04 is Sep 4, 2026 in Auckland and in Los Angeles alike. */
    for (const iso of [stub.pay_date, stub.period_start, stub.period_end]) expect(text).toContain(day(iso));
  }
  expect(said[1]).toBe(said[0]);
  expect(said[2]).toBe(said[0]);
});

test('printed, the payslip is the sheet alone: no skip link, no navigation', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await openPayslip(page);
  await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => ({
    words: document.body.innerText,
    drawn: [
      ...document.querySelectorAll(
        '.skip-link, nav, [role="navigation"], .topbar, .sidebar, .crumbs, .record-trail, .doc-bar, a[href^="#"]',
      ),
    ]
      .filter((el) => el.checkVisibility())
      .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}"`),
  }));
  expect(printed.words).not.toContain('Skip to content');
  expect(printed.drawn).toEqual([]);
  expect(printed.words).toContain('Payslip');
  /* The PDF the browser makes of it: a sheet or more, from the same print styles. */
  const pdf = await page.pdf({ preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
});

/* Every word on the sheet: a caption, a column's head, a value however it is drawn. */
const PAPER = [['.doc-sheet :is(h1, h2, p, span, dt, dd, th, td, time, li):not(.doc-logo, .doc-logo *)', 4.5]] as const;

test('the sheet reads at 4.5:1 in every look, light and dark, on screen and in print', async ({ page }) => {
  await signIn(page);
  const short: string[] = [];
  for (const theme of THEME_PRESETS)
    for (const mode of ['light', 'dark'] as const) {
      await page.addInitScript(
        ([look, wanted]) => {
          localStorage.setItem('mistri.visual-theme', look);
          localStorage.setItem('mistri.theme', wanted);
        },
        [theme.id, mode] as const,
      );
      await page.emulateMedia({ media: 'screen', colorScheme: mode });
      await openPayslip(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      /* A custom value component draws with the tokens (custom-components.md): on the sheet they are paper's. */
      await page
        .locator('.doc-sheet dd')
        .first()
        .evaluate((dd) => {
          for (const token of [
            '--ink',
            '--ink-muted',
            '--ink-subtle',
            '--link',
            '--accent-ink',
            '--status-good',
            '--status-warning',
            '--status-critical',
            '--status-info',
          ]) {
            const drawn = document.createElement('span');
            drawn.textContent = ` ${token}`;
            drawn.style.color = `var(${token})`;
            drawn.style.background = 'var(--surface)';
            dd.append(drawn);
          }
        });
      for (const media of ['screen', 'print'] as const) {
        await page.emulateMedia({ media, colorScheme: mode });
        for (const reading of await readings(page, PAPER))
          if (reading.ratio < reading.need)
            short.push(`${theme.id} ${mode} ${media}: ${reading.what} ${reading.fg} on ${reading.bg} = ${reading.ratio}`);
      }
    }
  expect(short).toEqual([]);
});
