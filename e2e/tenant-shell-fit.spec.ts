import { test, expect, type Page } from './support/harness.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { SLOW_MS } from './support/budgets';

// The tenant control's own tools — the picker, "Enter dealer", "Support sessions" — stand in the header or in the
// side menu's foot, where a field report found them wider than their place: 81px past the edge at 768px, and over the
// content at 1280. They wrap; nothing may run past the box that holds it or sit on the page's content, at a tablet's,
// a laptop's and a desk's width, in either shell.
const shells = ['top', 'side'] as const;
const widths = [768, 1024, 1280];

test.describe('the tenant control fits its place', () => {
  test.setTimeout(SLOW_MS);
  for (const shell of shells) {
    test.describe(`${shell} shell`, () => {
      let app: TenantAppFixture;
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
        process.env.MISTRI_E2E_SHELL = shell;
        process.env.MISTRI_E2E_APP_NAME = 'Lender desk for the whole regional dealer network';
        app = await startTenantApp({ support: true });
      });
      test.afterEach(async () => {
        delete process.env.MISTRI_E2E_SHELL;
        delete process.env.MISTRI_E2E_APP_NAME;
        await app?.stop();
      });

      const enter = async (page: Page) => {
        const bob = app.accounts.bob;
        expect(
          (
            await page.request.post(app.origin + '/api/auth/sign-in/email', {
              headers: { origin: app.origin },
              data: { email: bob.email, password: bob.password },
            })
          ).status(),
        ).toBe(200);
        await page.goto(`${app.origin}/${app.appId}`);
        await page.getByRole('list', { name: 'Available dealers' }).getByRole('button', { name: 'Lender', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Enter dealer', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Support sessions', exact: true })).toBeVisible();
      };

      for (const width of widths) {
        test(`at ${width}px nothing runs past its box or covers the content`, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 });
          await enter(page);
          const found = await page.evaluate(`(() => {
            const rect = (e) => e.getBoundingClientRect();
            const host = document.querySelector('.tenant-control-host');
            // Beside a side menu at a desk the control stands in the bar over the room (the pane's bar), with the search and the account.
            const box = host.closest('.sidebar, .topbar, .pane-bar');
            const bar = box.classList.contains('topbar') || box.classList.contains('pane-bar');
            const content = rect(document.querySelector('#content'));
            const problems = [];
            const pieces = [...host.querySelectorAll('button')].filter((b) => rect(b).width > 0);
            for (const b of pieces) {
              const r = rect(b), c = rect(box);
              if (r.right > c.right + 0.5 || r.left < c.left - 0.5) problems.push(b.textContent + ' runs past the ' + box.className + ': ' + [r.left, r.right, c.left, c.right].map(Math.round));
              const overlaps = r.left < content.right - 0.5 && r.right > content.left + 0.5 && r.top < content.bottom && r.bottom > content.top;
              if (overlaps && !bar) problems.push(b.textContent + ' sits on the content');
              if (bar && r.top < content.top - 0.5 && r.bottom > content.top + 0.5) problems.push(b.textContent + ' crosses the content edge');
            }
            for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
              const a = rect(pieces[i]), b = rect(pieces[j]);
              if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(pieces[i].textContent + ' overlaps ' + pieces[j].textContent);
            }
            const de = document.documentElement;
            if (de.scrollWidth > de.clientWidth) problems.push('the page scrolls sideways: ' + de.scrollWidth + ' > ' + de.clientWidth);
            if (box.scrollWidth > box.clientWidth + 1) problems.push(box.className + ' scrolls sideways: ' + box.scrollWidth + ' > ' + box.clientWidth);
            return problems;
          })()`);
          expect(found).toEqual([]);
        });
      }
    });
  }
});

// A dealer's long name beside a top bar's tabs (#514): the chooser's 24rem, and the whole name's width its box held
// empty beside the cut label, folded five tabs into the menu at 1280 and 1440. The name gives way, to an ellipsis
// with its whole in the button's title and name; the tabs stand, and nothing crowds them or scrolls sideways.
test.describe('a long tenant name beside the top bar tabs', () => {
  test.setTimeout(SLOW_MS);
  const name = 'North Motors and Commercial Fleet Leasing of the Greater Lakes Region';
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    process.env.MISTRI_E2E_SHELL = 'top';
    process.env.MISTRI_E2E_DEALER_NAME = name;
    app = await startTenantApp({ support: true });
  });
  test.afterEach(async () => {
    delete process.env.MISTRI_E2E_SHELL;
    delete process.env.MISTRI_E2E_DEALER_NAME;
    await app?.stop();
  });

  for (const width of [1280, 1440, 1600]) {
    test(`at ${width}px the tabs keep their place and the name is cut`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const alice = app.accounts.alice;
      expect(
        (
          await page.request.post(app.origin + '/api/auth/sign-in/email', {
            headers: { origin: app.origin },
            data: { email: alice.email, password: alice.password },
          })
        ).status(),
      ).toBe(200);
      await page.goto(`${app.origin}/${app.appId}`);
      const trigger = page.locator('.topbar .tenant-control-trigger');
      await expect(trigger).toHaveAccessibleName(`Dealer: ${name}`);
      await expect(trigger).toHaveAttribute('title', name);
      const nav = page.getByRole('navigation', { name: 'App menu' });
      for (const tab of ['Desk', 'Pipeline', 'Follow-ups', 'Appraisals', 'Financing'])
        await expect(nav.getByRole('button', { name: tab, exact: true })).toBeVisible();
      const found = await page.evaluate(`(() => {
        const rect = (e) => e.getBoundingClientRect();
        const problems = [];
        const label = document.querySelector('.topbar .tenant-control-trigger > :first-child');
        if (label.scrollWidth <= label.clientWidth) problems.push('the name is not cut: ' + label.scrollWidth + ' <= ' + label.clientWidth);
        const tabs = [...document.querySelectorAll('.topnav .tn-wide .tn-item')];
        const pieces = [...tabs, ...document.querySelectorAll('.topbar .tenant-control-host button, .topbar .account-host')].filter((e) => rect(e).width > 0);
        for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
          const a = rect(pieces[i]), b = rect(pieces[j]);
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(pieces[i].textContent + ' overlaps ' + pieces[j].textContent);
        }
        const bar = rect(document.querySelector('.topbar'));
        for (const e of pieces) if (rect(e).top > bar.top + bar.height / 2) problems.push(e.textContent + ' wrapped to a second row');
        const de = document.documentElement;
        if (de.scrollWidth > de.clientWidth) problems.push('the page scrolls sideways: ' + de.scrollWidth + ' > ' + de.clientWidth);
        return problems;
      })()`);
      expect(found).toEqual([]);
    });
  }
});
