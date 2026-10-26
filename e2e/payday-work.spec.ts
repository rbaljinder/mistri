import { expect, test, type Page } from './support/harness';
import { startSample, PAYDAY_ADMIN } from './support/sampleServer';
import { count, scalar } from './support/db';
import { chooseTab } from './support/tabs';

/* Payday's second and third journeys: approving hourly timesheets together,
   the time-off decisions a balance can refuse, a signature reminder, and the
   person page that gathers pay, time off and documents. Each test starts its
   own server over a fresh seed. */
test.describe('Payday people operations', () => {
  test.setTimeout(90_000);

  const signIn = async (page: Page, origin: string) => {
    const login = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: PAYDAY_ADMIN });
    expect(login.ok()).toBe(true);
  };

  test('submitted timesheets approve together from their queue, and only those', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      await signIn(page, sample.origin);
      await page.goto(`${sample.origin}/`);
      const today = page.getByRole('list', { name: 'Timesheets to approve' });
      await expect(today.getByRole('listitem')).toHaveCount(3);
      await page.goto(`${sample.origin}/timesheet-tasks`);
      const queue = page.getByRole('grid', { name: 'Timesheets to approve' });
      await expect(queue.getByRole('row')).toHaveCount(3);
      await queue.getByRole('row').nth(0).click();
      await queue
        .getByRole('row')
        .nth(1)
        .click({ modifiers: ['ControlOrMeta'] });
      const toolbar = page.getByRole('toolbar', { name: 'Selected records' });
      await expect(toolbar).toContainText('2 selected');
      // A fixed action granted by name: each selected sheet is its own write, stamped by the server.
      await toolbar.getByRole('button', { name: 'Approve timesheet', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Approve timesheet: 2 applied.' })).toBeVisible();
      expect(count(sample.db, "SELECT count(*) FROM timesheet WHERE id IN (7, 14, 15) AND status = 'approved'")).toBe(2);
      expect(
        count(
          sample.db,
          `SELECT count(*) FROM timesheet WHERE status = 'approved' AND approved_at IS NOT NULL
        AND approved_by = '${PAYDAY_ADMIN.email}' AND id IN (7, 14, 15)`,
        ),
      ).toBe(2);
      // The open week and the one left unselected are untouched.
      expect(
        count(sample.db, "SELECT count(*) FROM timesheet WHERE id IN (7, 14, 15) AND status = 'submitted' AND approved_by IS NULL"),
      ).toBe(1);
      expect(count(sample.db, "SELECT count(*) FROM timesheet WHERE status = 'open'")).toBe(2);
      await expect(queue.getByRole('row')).toHaveCount(1);
    } finally {
      await sample.stop();
    }
  });

  test('a balance that cannot cover a request refuses its approval; declining keeps the reason; a reminder is recorded', async ({
    page,
  }) => {
    const sample = await startSample('payday');
    try {
      await signIn(page, sample.origin);
      const balance = () => scalar(sample.db, 'SELECT used_hours FROM time_off_balance WHERE employee_id = 8 AND policy_id = 4');
      expect(balance()).toBe(16);
      await page.goto(`${sample.origin}/timeoff/~19`);
      await expect(page.getByRole('heading', { name: 'Quinn Davis', exact: true })).toBeVisible();
      /* Approve asks nothing, so it runs on one click with no dialog (df773272): its refusal is the notice, in the
         handler's own reason, verbatim, not the fixed ineligible sentence. */
      await page.getByRole('button', { name: 'Approve request', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('Quinn Davis has 0 h of Personal left, and this request is 8 h.');
      await expect(page.locator('#toast')).not.toContainText('This record is not eligible for this command.');
      await expect(page.getByRole('dialog', { name: 'Approve request' })).toHaveCount(0);
      expect(scalar(sample.db, 'SELECT status FROM time_off WHERE id = 19')).toBe('pending');
      expect(scalar(sample.db, 'SELECT version FROM time_off WHERE id = 19')).toBe(0);
      expect(balance()).toBe(16);

      // Declining is a fixed action granted by name: it asks its reason, and nothing is written without one.
      await page.getByRole('button', { name: 'Decline request', exact: true }).click();
      const decline = page.getByRole('dialog', { name: 'Decline request: reason' });
      await expect(decline.getByRole('button', { name: 'Decline request', exact: true })).toBeDisabled();
      expect(scalar(sample.db, 'SELECT status FROM time_off WHERE id = 19')).toBe('pending');
      await decline.getByLabel('Reason', { exact: true }).fill('Your personal days are used for this year.');
      await decline.getByRole('button', { name: 'Decline request', exact: true }).click();
      await expect(page.locator('#toast').getByText('Decline request — done')).toBeVisible();
      expect(scalar(sample.db, 'SELECT status FROM time_off WHERE id = 19')).toBe('declined');
      expect(scalar(sample.db, 'SELECT decision_note FROM time_off WHERE id = 19')).toBe('Your personal days are used for this year.');
      expect(balance()).toBe(16);
      await expect(page.getByRole('button', { name: /Why it was declined$/ })).toBeVisible();
      await expect(page.getByText('Your personal days are used for this year.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Decline request', exact: true })).toHaveCount(0);

      const handbook = scalar(sample.db, "SELECT id FROM document WHERE employee_id = 6 AND kind = 'policy' AND status = 'pending'");
      expect(scalar(sample.db, 'SELECT reminded_on FROM document WHERE id = ?', handbook)).toBeNull();
      await page.goto(`${sample.origin}/documents/~${handbook}`);
      await page.getByRole('button', { name: 'Send reminder', exact: true }).click();
      await expect(page.locator('#toast').getByText('Send reminder — done')).toBeVisible();
      // The server's day, stamped inside the write; the button waits for the next pending document.
      expect(scalar(sample.db, 'SELECT reminded_on FROM document WHERE id = ?', handbook)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(scalar(sample.db, 'SELECT status FROM document WHERE id = ?', handbook)).toBe('pending');
    } finally {
      await sample.stop();
    }
  });

  test('Who’s out draws each request across its days; Today’s aside lists names; a metric opens its list', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      await signIn(page, sample.origin);
      await page.setViewportSize({ width: 1440, height: 900 });
      // The seed's September, whatever day the suite runs on.
      await page.clock.setFixedTime(new Date('2026-09-22T12:00:00'));
      await page.goto(`${sample.origin}/timeoff-calendar`);
      const calendar = page.getByRole('region', { name: 'Who’s out' });
      await expect(calendar.locator('.calendar-title')).toHaveText('September 2026');
      // Jordan's vacation, Monday the 28th to Friday October 2: one bar five days wide.
      // A card says its status first, as the dot before its title (d4e6956a), then whose it is.
      const jordan = calendar.getByRole('button', { name: /^Pending\s*:\s*Jordan Brooks/ });
      await expect(jordan).toHaveCount(1);
      await expect(jordan).toContainText('Pending');
      await expect(jordan).toContainText('Vacation');
      const day = await calendar.locator('td[data-date="2026-09-28"]').boundingBox();
      const bar = await jordan.boundingBox();
      expect(bar!.width).toBeGreaterThan(day!.width * 4.5);
      // Morgan's parental leave runs through the month: a bar on every week's row.
      await expect(calendar.getByRole('button', { name: /^Approved\s*:\s*Morgan Lee/ })).toHaveCount(5);

      await page.goto(`${sample.origin}/`);
      const starting = page.getByRole('list', { name: 'Starting soon' });
      await expect(starting.getByRole('button')).toHaveCount(
        Number(scalar(sample.db, "SELECT COUNT(*) FROM employee WHERE employment_status = 'onboarding'")),
      );
      const name = starting.locator('.dash-mini-name').first();
      expect(await name.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(page.locator('.dashboard-layout .page-aside table')).toHaveCount(0);

      await page.goto(`${sample.origin}/reports`);
      const headcount = page.getByRole('button', { name: /^Active headcount: / });
      const expected = Number(scalar(sample.db, "SELECT COUNT(*) FROM employee WHERE employment_status IN ('active', 'leave')"));
      await expect(headcount).toHaveAccessibleName(`Active headcount: ${expected}`);
      await expect(headcount.locator('.home-card-go')).toBeVisible();
      await headcount.click();
      // The People room, from the dashboard, narrowed to the rows the card counted.
      await expect(page).toHaveURL(
        (url) => url.pathname === '/people' && url.searchParams.get('q') === '(employment_status = active or employment_status = leave)',
      );
      // The URL changes before the room's lazy imports finish. Prove the destination
      // rendered its filtered records before shutting down the server it still needs.
      // The room's own heading; the menu's group of the same name is a heading too.
      await expect(page.getByRole('main').getByRole('heading', { name: 'People', exact: true })).toBeVisible();
      const people = page.getByRole('grid');
      await expect(people).toBeVisible();
      await expect(people.locator('tbody tr[data-row]')).toHaveCount(expected);
      await expect(page.locator('[data-section-error]')).toHaveCount(0);
    } finally {
      // End the browser client before taking away its server; the harness still
      // checks every page error collected while the page was open.
      try {
        await page.close();
      } finally {
        await sample.stop();
      }
    }
  });

  for (const width of [1440, 390]) {
    test(`${width}px: a person's page gathers reports, pay, time off and documents`, async ({ page }) => {
      const sample = await startSample('payday');
      try {
        await signIn(page, sample.origin);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${sample.origin}/people/~1`);
        await expect(page.getByRole('heading', { name: 'Avery Johnson', exact: true })).toBeVisible();
        const reports = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Direct reports', exact: true }) });
        await expect(reports).toContainText('Drew Wilson');
        await expect(reports).not.toContainText('Mina Patel');

        await page.goto(`${sample.origin}/people/~11`);
        await expect(page.getByRole('heading', { name: 'Robin Taylor', exact: true })).toBeVisible();
        await expect(
          page
            .getByRole('group')
            .filter({ has: page.getByRole('button', { name: /Employment$/ }) })
            .getByRole('button', { name: 'Avery Johnson', exact: true }),
        ).toBeVisible();
        // Robin manages no one: the list is left out, not drawn empty.
        await page.waitForLoadState('networkidle');
        await expect(page.getByRole('heading', { name: 'Direct reports', exact: true })).toHaveCount(0);
        await chooseTab(page, 'Pay', { exact: true });
        await expect(page.getByRole('heading', { name: 'Pay history', exact: true })).toBeVisible();
        if (width > 760) {
          // The footer sums every statement, not the twelve on the page.
          const gross = Number(scalar(sample.db, 'SELECT SUM(gross) FROM pay_stub WHERE employee_id = 11'));
          await expect(page.locator('.grid-totals').filter({ visible: true })).toContainText(
            `$${Math.round(gross).toLocaleString('en-US')}`,
          );
        }
        await expect(page.getByText('September 1–15 payroll', { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await chooseTab(page, 'Time off', { exact: true });
        await expect(page.getByRole('heading', { name: 'Balances', exact: true })).toBeVisible();
        await expect(page.getByText('Sick leave', { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await chooseTab(page, 'Documents', { exact: true });
        await expect(
          page.getByText('Employee handbook 2026 acknowledgment', { exact: true }).filter({ visible: true }).first(),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        await page.goto(`${sample.origin}/pay-statements/~7`);
        await expect(page.getByRole('button', { name: /Taxes withheld$/ })).toBeVisible();
        const net = Number(scalar(sample.db, 'SELECT net FROM pay_stub WHERE id = 7'));
        const lines = Number(
          scalar(
            sample.db,
            'SELECT gross - federal_tax - state_tax - social_security - medicare - benefits - retirement FROM pay_stub WHERE id = 7',
          ),
        );
        expect(net).toBe(lines);
        await expect(
          page
            .getByText(`$${net.toLocaleString('en-US')}`, { exact: true })
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await sample.stop();
      }
    });
  }
});
