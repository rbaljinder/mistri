// e2e-client: source — imports /messages.ts from the page
import { expect, test } from './support/harness';
import { startSample, PAYDAY_ADMIN } from './support/sampleServer';
import { scalar } from './support/db';
import { chooseTab } from './support/tabs';

test.describe('Payday payroll workflow', () => {
  test.setTimeout(120_000);
  for (const built of [false, true]) {
    test(`${built ? 'built' : 'source'}: review and approval persist across sessions`, async ({ page, browser }) => {
      const sample = await startSample('payday', { built });
      try {
        const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
          headers: { origin: sample.origin },
          data: PAYDAY_ADMIN,
        });
        expect(login.ok()).toBe(true);
        await page.goto(`${sample.origin}/@dash-benefits`);
        const sidebar = page.locator('.sidebar');
        await expect(sidebar.locator('.sidebar-identity')).toContainText('Payday demo workspace');
        // The People room, not the People section's fold toggle (a heading's button, with aria-expanded) of the same name.
        await expect(sidebar.locator('li:not(.nav-group)').getByRole('button', { name: 'People', exact: true })).toBeVisible();
        await expect(sidebar.getByRole('button', { name: 'People', exact: true, expanded: true })).toBeVisible();
        await page.getByRole('button', { name: 'Hide the table list', exact: true }).click();
        await expect(sidebar.getByRole('button', { name: 'Workbench', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Show the table list', exact: true }).click();
        await expect(sidebar.locator('.sidebar-identity')).toBeVisible();
        await page.getByRole('button', { name: /^Account: / }).click();
        for (const name of [
          /^Workbench/,
          /^App definition/,
          /^Theme lab/,
          /^Editing enabled/,
          /^Undo the last edit/,
          /^Keyboard shortcuts/,
        ]) {
          await expect(page.getByRole('menuitem', { name })).toHaveCount(0);
        }
        await expect(page.getByRole('menuitem', { name: /^Preferences/ })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('ControlOrMeta+k');
        const commandSearch = page.getByRole('combobox', { name: 'Search', exact: true });
        for (const query of ['Workbench', 'App definition', 'Theme lab', 'Editing enabled', 'Undo the last edit']) {
          await commandSearch.fill(query);
          await expect(page.getByRole('option', { name: new RegExp(`^action ${query}`) })).toHaveCount(0);
        }
        await page.keyboard.press('Escape');
        // Benefits is a dashboard of the seeded plans and elections, not a page of notes.
        await expect(page.locator('h1')).toHaveText('Benefits');
        await expect(page.getByText('Health Plus', { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await expect(page.getByText('Priya Shah', { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await page.goto(`${sample.origin}/benefit-plans/~1`);
        await expect(page.getByRole('heading', { name: 'Core Health', exact: true })).toBeVisible();
        const enrolled = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Enrollments', exact: true }) });
        await expect(enrolled).toContainText('Jordan Brooks');
        await expect(enrolled).not.toContainText('Mina Patel');
        await page.goto(`${sample.origin}/`);
        const payrollTasks = page.getByRole('list', { name: 'Payroll to review' });
        await expect(payrollTasks).toBeVisible();
        await expect(payrollTasks.getByRole('option')).toHaveCount(0);
        const payroll = payrollTasks.getByRole('listitem').filter({ hasText: 'September 16–30 payroll' });
        await expect(payroll.locator('dt').filter({ hasText: /^Employees$/ })).toBeVisible();
        await expect(payroll.locator('dd').filter({ hasText: /^12$/ })).toBeVisible();
        const timeOff = page.getByRole('list', { name: 'Time off to review' }).getByRole('listitem').first();
        await expect(timeOff.locator('dt').filter({ hasText: /^Starts$/ })).toBeVisible();
        await expect(timeOff.locator('dt').filter({ hasText: /^Ends$/ })).toBeVisible();
        await page.getByRole('button', { name: 'Review payroll September 16–30 payroll', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Approve payroll', exact: true })).toHaveCount(0);
        /* The run page's own component, compiled from source or served from the
           build's components/ graph: every run on the axis, this one marked. */
        const history = page.locator('[data-component="payroll-timeline"]');
        await expect(history.getByRole('list', { name: 'Payroll runs by pay period' }).getByRole('button')).toHaveCount(18);
        await expect(history.locator('[aria-current="true"] button')).toHaveAccessibleName(/^September 16–30 payroll:/);
        await expect(page.locator('[data-section-error]')).toHaveCount(0);
        // Two fixed actions granted by name to roles that write no pay run: the server admits each as itself.
        await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
        await expect(page.locator('#toast').getByText('Submit for review — done')).toBeVisible();
        expect(scalar(sample.db, 'SELECT status FROM pay_run WHERE id = 3')).toBe('review');
        await page.getByRole('button', { name: 'Approve payroll', exact: true }).click();
        const approval = page.getByRole('dialog', { name: 'Approve payroll: reason' });
        await expect(approval.getByRole('button', { name: 'Approve payroll', exact: true })).toBeDisabled();
        await approval.getByLabel('Reason', { exact: true }).fill('Reviewed all twelve pay statements.');
        await approval.getByRole('button', { name: 'Approve payroll', exact: true }).click();
        await expect(page.locator('#toast').getByText('Approve payroll — done')).toBeVisible();
        expect(scalar(sample.db, 'SELECT status FROM pay_run WHERE id = 3')).toBe('approved');
        // 'me' and 'now', resolved by the server inside the write.
        expect(scalar(sample.db, 'SELECT approved_by FROM pay_run WHERE id = 3')).toBe(PAYDAY_ADMIN.email);
        expect(scalar(sample.db, 'SELECT approved_at FROM pay_run WHERE id = 3')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(scalar(sample.db, 'SELECT approval_note FROM pay_run WHERE id = 3')).toBe('Reviewed all twelve pay statements.');
        expect(scalar(sample.db, 'SELECT sum(gross) FROM pay_stub WHERE pay_run_id = 3')).toBe(
          scalar(sample.db, 'SELECT gross_total FROM pay_run WHERE id = 3'),
        );
        await page.goto(`${sample.origin}/`);
        await page.getByRole('button', { name: 'Review request Jordan Brooks', exact: true }).click();
        const storedVersion = scalar(sample.db, 'SELECT version FROM time_off WHERE id = 1');
        const preparation = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/commands/prepare' && response.request().postDataJSON()?.command === 'approveTimeOff',
        );
        const submission = page.waitForRequest(
          (sent) => new URL(sent.url()).pathname === '/api/commands/execute' && sent.postDataJSON()?.command === 'approveTimeOff',
        );
        // It asks nothing, so one click prepares and sends it with no dialog (df773272), and the notice says its words.
        await page.getByRole('button', { name: 'Approve request', exact: true }).click();
        const prepared = await (await preparation).json();
        expect(typeof prepared.expectedVersion).toBe('number');
        expect((await submission).postDataJSON().expectedVersion).toBe(prepared.expectedVersion);
        await expect(page.locator('#toast').getByText('Time off approved.')).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Approve request' })).toHaveCount(0);
        expect(scalar(sample.db, 'SELECT status FROM time_off WHERE id = 1')).toBe('approved');
        // The command takes its revision from the row's own `version` column, so its write advances it.
        expect(scalar(sample.db, 'SELECT version FROM time_off WHERE id = 1')).toBe(Number(storedVersion) + 1);
        // The same transaction spent the forty hours from Jordan's vacation balance.
        expect(scalar(sample.db, 'SELECT used_hours FROM time_off_balance WHERE employee_id = 3 AND policy_id = 1')).toBe(40);
        expect(scalar(sample.db, 'SELECT available_hours FROM time_off_balance WHERE employee_id = 3 AND policy_id = 1')).toBe(49);
        const again = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
          await again.request.post(`${sample.origin}/api/auth/sign-in/email`, { headers: { origin: sample.origin }, data: PAYDAY_ADMIN });
          const fresh = await again.newPage();
          await fresh.goto(`${sample.origin}/timeoff/~1`);
          await expect(fresh.getByRole('button', { name: 'Approve request', exact: true })).toHaveCount(0);
          await expect(
            fresh.locator('.page-section').filter({ has: fresh.getByRole('heading', { name: 'Request details', exact: true }) }),
          ).toContainText('Approved');
          expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await fresh.goto(`${sample.origin}/@pay-run~3`);
          await expect(fresh.getByText('Reviewed all twelve pay statements.', { exact: true })).toBeVisible();
          await expect(fresh.getByRole('button', { name: 'Approve payroll', exact: true })).toHaveCount(0);
          expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await fresh.goto(`${sample.origin}/people`);
          await fresh.getByRole('button', { name: 'Robin Taylor', exact: true }).click();
          await expect(fresh.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
          await fresh.getByRole('tab', { name: 'Overview', exact: true }).focus();
          await fresh.keyboard.press('ArrowRight');
          await expect(fresh.getByRole('tab', { name: 'Job & pay', exact: true })).toBeFocused();
          await expect(fresh.getByRole('tab', { name: 'Job & pay', exact: true })).toHaveAttribute('aria-selected', 'true');
          // A lone whole rate is said whole (45aaa320: cents only where the figure has some).
          await expect(fresh.getByText('$28/hr', { exact: true })).toBeVisible();
          await fresh.keyboard.press('Home');
          await expect(fresh.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
          await expect(fresh.getByText('$28/hr', { exact: true })).toBeHidden();
          expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await fresh.keyboard.press('End');
          const onboardingTab = fresh.getByRole('tab', { name: 'Onboarding', exact: true });
          await expect(onboardingTab).toBeFocused();
          expect(
            await onboardingTab.evaluate((tab) => {
              const strip = tab.parentElement!;
              const tabs = [...strip.querySelectorAll('[role="tab"]')].map((node) => node.getBoundingClientRect());
              const bounds = strip.getBoundingClientRect(),
                selected = tab.getBoundingClientRect();
              return (
                tabs.every((rect) => Math.abs(rect.top - tabs[0].top) < 1) &&
                selected.left >= bounds.left - 1 &&
                selected.right <= bounds.right + 1
              );
            }),
          ).toBe(true);
          await fresh.getByRole('tab', { name: 'Onboarding', exact: true }).click();
          await expect(fresh.getByText('No onboarding tasks yet', { exact: true })).toBeVisible();
          await fresh.getByRole('link', { name: 'View onboarding', exact: true }).click();
          await expect(fresh).toHaveURL(/\/onboarding$/);
          await expect(fresh.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
          await fresh.goto(`${sample.origin}/onboarding/~2`);
          await expect(fresh.getByRole('heading', { name: 'Choose equipment', exact: true })).toBeVisible();
          await expect(fresh.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
          await expect(fresh.getByRole('heading', { name: 'Teammate', exact: true })).toBeVisible();
          await expect(fresh.locator('dt').filter({ hasText: /^(ID|Version)$/ })).toHaveCount(0);
          const otherTasks = fresh
            .locator('.page-section')
            .filter({ has: fresh.getByRole('heading', { name: 'Other tasks for this teammate', exact: true }) });
          await expect(otherTasks).toContainText('Complete security training');
          await expect(otherTasks).not.toContainText('Choose equipment');
          expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally {
          await again.close();
        }
      } finally {
        await sample.stop();
      }
    });
  }

  test('related payroll records switch presentation and open the same statement on a phone', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${sample.origin}/@pay-run~1`);
      const related = page.locator('.page-related-results');
      const table = related.locator('.result-table');
      const summaries = related.getByRole('list', { name: 'Records', exact: true });
      await expect(table).toBeVisible();
      await expect(summaries).toBeHidden();
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(summaries).toBeVisible();
        await expect(table).toBeHidden();
        await expect(summaries.getByRole('button', { name: 'Avery Johnson', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await related.getByRole('button', { name: 'Table', exact: true }).click();
        await expect(table).toBeVisible();
        await expect(summaries).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await related.getByRole('button', { name: 'Records', exact: true }).click();
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(table).toBeVisible();
      await expect(summaries).toBeHidden();
      await page.setViewportSize({ width: 390, height: 844 });
      const statement = summaries.getByRole('button', { name: 'Avery Johnson', exact: true });
      await statement.focus();
      await page.keyboard.press('Enter');
      // The statement's own address, not the run's path to it; Back retraces the walk.
      await expect(page).toHaveURL(/\/pay-statements\/1$/);
      await expect(page.locator('.page-related-results')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Next record', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await sample.stop();
    }
  });

  test('phone App menu is the sidebar in a modal drawer', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      await page.goto(`${sample.origin}/`);
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.click();
      const drawer = page.getByRole('dialog', { name: 'Payday navigation', exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Close menu' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(drawer.getByRole('button', { name: 'Today', exact: true })).toBeFocused();
      await expect(drawer.getByRole('navigation', { name: 'Payday menu', exact: true })).toContainText('Payday demo workspace');
      expect(await drawer.evaluate((node) => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(menu).toBeFocused();
      await menu.click();
      await drawer.locator('li:not(.nav-group)').getByRole('button', { name: 'People', exact: true }).click();
      await expect(drawer).toHaveCount(0);
      await expect(page).toHaveURL(/\/people$/);
      for (const width of [320, 412]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await menu.click();
        await expect(drawer).toBeVisible();
        await page.mouse.click(width - 8, 400);
        await expect(drawer).toHaveCount(0);
        await expect(menu).toBeFocused();
      }
      await menu.click();
      await expect(drawer).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 844 });
      await expect(page.getByRole('dialog', { name: 'Payday navigation', exact: true })).toHaveCount(0);
      await expect(page.locator('.sidebar')).toBeVisible();
    } finally {
      await sample.stop();
    }
  });

  test("a section heading that folds keeps the plain heading's geometry, so the menu fits as it did", async ({ page }) => {
    /* 0.8.9's fold toggle made each top-level heading 40px against 0.8.8's 26.4px, and Enrollments and
       Documents fell out of a 1440x900 window. The fold is held to a plain heading drawn beside it, and the
       offsets below are measured: 0.8.8's at Sage's comfortable zoom (24px at 1.1), re-measured when Sage
       began an App compact (ca0a0ed8d) and the heading's 10px text stood on the 11px step (80077020f), and again
       when a heading's line became its capitals' own height (style.css, line-height 1), 2px shorter. */
    const sample = await startSample('payday');
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      await page.goto(`${sample.origin}/`);
      const headings = page.locator('#table-list li.nav-group');
      await expect(headings).toHaveText(['People', 'Payroll', 'Time off', 'Benefits']);
      await expect(page.locator('#table-list .nav-group-fold')).toHaveCount(4);
      const rows = await page
        .locator('#table-list > li')
        .evaluateAll((items) => items.map((li) => ({ group: li.classList.contains('nav-group'), ...li.getBoundingClientRect().toJSON() })));
      const groups = rows.filter((row) => row.group);
      // A heading with no fold, its words where the button was, in the same list.
      const plain = await page
        .locator('#table-list li.nav-group')
        .first()
        .evaluate((li) => {
          const copy = li.cloneNode(false) as HTMLElement;
          copy.append(li.querySelector('.nav-group-fold > span')?.textContent ?? li.textContent ?? '');
          li.after(copy);
          const height = copy.getBoundingClientRect().height;
          copy.remove();
          return height;
        });
      expect(plain).toBeCloseTo(23, 0);
      for (const group of groups) expect(group.height).toBeCloseTo(plain, 0);
      // The same gap from each heading to its first room, and the rooms where they were measured.
      for (const group of groups) {
        const first = rows[rows.indexOf(group) + 1];
        expect(first.top - group.top).toBeCloseTo(24, 0);
      }
      const offsets = groups.map((group) => group.top - rows[0].top);
      [25.2, 149.9, 249.5, 399.4].forEach((offset, i) => expect(Math.abs(offsets[i] - offset)).toBeLessThan(1));
      expect(rows.at(-1)!.bottom).toBeLessThanOrEqual(900);
    } finally {
      await sample.stop();
    }
  });

  test('Payday framework language persists without translating record values or changing the route', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      await page.setViewportSize({ width: 412, height: 924 });
      await page.goto(`${sample.origin}/`);
      // A fresh server's first paint is the client transformed cold: it is the one wait here that is not an interaction.
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible({ timeout: 30_000 });
      const before = page.url();
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET' && /\/api\/(insert|update|delete|commands)/.test(request.url())) writes.push(request.url());
      });
      await page.getByRole('button', { name: /^Account: / }).click();
      await page.getByRole('menuitem', { name: /^Preferences/ }).click();
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('option', { name: 'Español', exact: true }).click();
      const prefs = page.getByRole('dialog', { name: 'Preferencias', exact: true });
      await expect(prefs.getByRole('button', { name: 'Idioma', exact: true })).toContainText('Español');
      await prefs.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await expect(page).toHaveURL(before);
      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      await expect(page.getByRole('button', { name: 'Ver todo', exact: true }).first()).toBeVisible();
      await page.reload();
      const menu = page.getByRole('button', { name: 'Menú', exact: true });
      await expect(menu).toBeVisible();
      await menu.click();
      await page.getByRole('button', { name: 'Cerrar menú', exact: true }).click();
      await expect(menu).toBeFocused();
      await expect(page.getByText('September 16–30 payroll', { exact: true }).first()).toBeVisible();
      await page.goto(`${sample.origin}/people`);
      await expect(page.getByRole('heading', { name: 'Personas', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Robin Taylor', exact: true }).click();
      await expect(page.getByRole('button', { name: /Datos básicos$/ })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Resumen', exact: true })).toBeVisible();
      await expect(page.locator('dt').filter({ hasText: /^Correo electrónico$/ })).toBeVisible();
      await chooseTab(page, 'Incorporación', { exact: true });
      // The address follows the click: read it once the tab is the selected one, or the
      // pre-click address is what every later assertion holds the page to.
      await expect(page.getByRole('tab', { name: 'Incorporación', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => page.url()).toMatch(/\/people\/[^/]+\/onboarding/i);
      const selectedTabUrl = page.url();
      await page.evaluate(async () => {
        const path = '/messages.ts';
        (await import(path)).setMessageLanguage('en');
      });
      await expect(page.getByRole('tab', { name: 'Onboarding', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(selectedTabUrl);
      await page.evaluate(async () => {
        const path = '/messages.ts';
        (await import(path)).setMessageLanguage('es');
      });
      await expect(page.getByRole('tab', { name: 'Incorporación', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(selectedTabUrl);
      await expect(page.getByText('Aún no hay tareas de incorporación', { exact: true })).toBeVisible();
      await expect(page.getByText('Aquí aparecerán las tareas asignadas y su progreso.', { exact: true })).toBeVisible();
      /* The language is set under the page, which draws itself again in it: a click that lands while the new page is
         still held out of sight (PageRoom.tsx Revealed) meets its empty pane, so the click is asked again until the
         link has gone somewhere. The whole address: the person's Onboarding tab also ends in /onboarding, so a pattern
         passes before the link has gone anywhere. */
      await expect(async () => {
        await page.getByRole('link', { name: 'Ver incorporación', exact: true }).click({ timeout: 2_000 });
        await expect(page).toHaveURL(`${sample.origin}/onboarding`, { timeout: 1_500 });
      }).toPass({ timeout: 10_000 });
      await expect(page.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
      await expect(
        page.getByRole('list', { name: 'Records', exact: true }).getByRole('button', { name: 'Choose equipment', exact: true }),
      ).toBeVisible();
      expect(writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Check the rendered page before closing it, then stop its server. Lazy
      // requests from a live page must not race the fixture's server teardown.
      await expect(page.locator('[data-section-error]')).toHaveCount(0);
      await page.close();
    } finally {
      await sample.stop();
    }
  });

  test('Payday live caption changes preserve an unsaved new-record form', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      await page.goto(`${sample.origin}/people`);
      await page.getByRole('button', { name: '+ New person', exact: true }).click();
      const name = page.getByRole('textbox', { name: /^Name/ });
      await name.fill('Unsaved caption review');
      const element = await name.elementHandle();
      const before = page.url();
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET' && /\/api\/(insert|update|delete|commands)/.test(request.url())) writes.push(request.url());
      });
      // The drawer owns focus, so invoke the same store Preferences uses without
      // dismissing the form merely to reach a setting behind its modal scrim.
      await page.evaluate(async () => {
        const path = '/messages.ts';
        (await import(path)).setMessageLanguage('es');
      });
      await expect(page.getByRole('textbox', { name: /^Nombre/ })).toHaveValue('Unsaved caption review');
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(page).toHaveURL(before);
      await page.evaluate(async () => {
        const path = '/messages.ts';
        (await import(path)).setMessageLanguage('en');
      });
      await expect(name).toHaveValue('Unsaved caption review');
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
      expect(writes).toEqual([]);
    } finally {
      await sample.stop();
    }
  });
});
