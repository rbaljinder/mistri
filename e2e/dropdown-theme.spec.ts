import { COMPASS, expect, test } from './support/ownServers';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;
/* Two rows, not six. One look and the look beside it gave the dropdown the same radii —
   both come from Compass's own `app.ui.theme.radius`, which only the custom
   row deletes — so the look id discriminated nothing between them; and every
   assertion in the body is a radius, a shadow token self-comparison, an
   overflow check or a focus return, none of which the colour mode changes.
   What is left is the minimal covering pair: the App's radius winning over a
   look, and a look's radius winning where the App states none. */
const themes = [
  { id: 'sage', radius: '8px', itemRadius: '5px' },
  { id: 'custom-sage', radius: '6px', itemRadius: '5px' },
];

for (const theme of themes)
  for (const mode of ['light']) {
    test(`${theme.id} ${mode}: dropdown surface and options follow the theme`, async ({ page }, info) => {
      await page.addInitScript(
        ({ id, mode }) => {
          localStorage.setItem('mistri.visual-theme', id);
          // Custom selections belong to an App, unlike global built-in looks.
          if (id === 'custom-sage') localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([['compass', id]]));
          localStorage.setItem('mistri.theme', mode);
        },
        { id: theme.id, mode },
      );
      await page.emulateMedia({ colorScheme: mode as 'light' | 'dark' });
      if (theme.id === 'custom-sage') {
        await page.route(/\/api\/app(?:\?|$)/, async (route) => {
          const response = await route.fetch();
          const data = await response.json();
          // The App's own radius wins over any look; without it the theme's is the one drawn.
          delete data.app.ui.theme?.radius;
          data.app.ui.customThemes = [
            {
              id: theme.id,
              label: 'Custom Sage',
              base: 'sage',
              light: { surface: '#ffffff', ink: '#181919', accent: '#006b73' },
              dark: { surface: '#1c1e1a', ink: '#f0f2e9', accent: '#87d8d3' },
              radius: { control: '6px', field: '2px' },
            },
          ];
          await route.fulfill({ response, json: data });
        });
      }
      await page.goto(`${CRM}/opportunity`);
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', theme.id);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 924 });
        // The list's page size is its themed Select; its filters open pickers, not listboxes.
        const trigger = page.getByRole('button', { name: 'Rows per page', exact: true });
        await trigger.click();
        const list = page.getByRole('listbox', { name: 'Rows per page', exact: true });
        await expect(list).toBeVisible();
        await expect(list).toHaveCSS('border-radius', theme.radius);
        await expect(list.getByRole('option').first()).toHaveCSS('border-radius', theme.itemRadius);
        {
          const shadow = await list.evaluate((node) => {
            const probe = document.createElement('div');
            probe.style.boxShadow = 'var(--shadow-pop)';
            node.append(probe);
            const result = getComputedStyle(probe).boxShadow;
            probe.remove();
            return result;
          });
          await expect(list).toHaveCSS('box-shadow', shadow);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (theme.id === 'sage') await page.screenshot({ path: info.outputPath(`dropdown-${width}.png`) });
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
      // Preferences render the same dropdown inside a dialog's portal container.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Preferences/ }).click();
      await page.getByRole('dialog', { name: 'Preferences', exact: true }).getByRole('button', { name: 'Color mode', exact: true }).click();
      const list = page.getByRole('listbox', { name: 'Color mode', exact: true });
      await expect(list).toHaveCSS('border-radius', theme.radius);
      await expect(list.getByRole('option').first()).toHaveCSS('border-radius', theme.itemRadius);
    });
  }
