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
            const box = host.closest('.sidebar, .topbar');
            const content = rect(document.querySelector('#content'));
            const problems = [];
            const pieces = [...host.querySelectorAll('button')].filter((b) => rect(b).width > 0);
            for (const b of pieces) {
              const r = rect(b), c = rect(box);
              if (r.right > c.right + 0.5 || r.left < c.left - 0.5) problems.push(b.textContent + ' runs past the ' + box.className + ': ' + [r.left, r.right, c.left, c.right].map(Math.round));
              const overlaps = r.left < content.right - 0.5 && r.right > content.left + 0.5 && r.top < content.bottom && r.bottom > content.top;
              if (overlaps && !box.classList.contains('topbar')) problems.push(b.textContent + ' sits on the content');
              if (box.classList.contains('topbar') && r.top < content.top - 0.5 && r.bottom > content.top + 0.5) problems.push(b.textContent + ' crosses the content edge');
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
