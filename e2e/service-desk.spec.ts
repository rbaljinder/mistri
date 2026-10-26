import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { rows, scalar } from './support/db';
import { expandSegments } from '../packages/engine/src/shared/query.js';

// Metadata interception in this spec exercises the boot fetch fallback.
test.use({ carryFirstPaint: false });

/** A stored vocabulary word as a tone chip says it (valueModel.ts): the first word capitalised, underscores as spaces. */
const said = (value: string) =>
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ') : value;

test.describe('Service Atlas ITSM', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('service-desk');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('authored scroll sizing retains horizontal access to wide catalog columns', async ({ page }) => {
    await page.route('**/api/app?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const catalog = body.app.views['service-catalog'];
      for (const section of catalog.sections) section.sizing = 'scroll';
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${sample.origin}/@dash-service-catalog`);
    const table = page.locator('.dash-list .table-wrap').first();
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect.poll(() => table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
    await table.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(await table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const bounds = (await table.boundingBox())!;
    const last = (await table.locator('thead th').last().boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  });

  for (const theme of ['lumen', 'mono'])
    test(`${theme}: catalog descriptions share space with concise columns`, async ({ page }, info) => {
      await page.addInitScript((theme) => {
        localStorage.setItem('mistri.visual-theme', theme);
        localStorage.setItem('mistri.theme', 'light');
      }, theme);
      await page.goto(`${sample.origin}/@dash-service-catalog`);
      const tables = page.locator('.dash-list .table-wrap');
      await expect(tables).toHaveCount(4);
      for (const width of [1440, 2048, 2560]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const table of await tables.all()) {
          await expect(table.locator('tbody tr')).toHaveCount(3);
          await expect.poll(() => table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
          const headers = table.locator('thead th');
          /* Half a 1440px row cannot hold every column beside a name kept whole: an embedded list leaves
             columns out from the end rather than scroll (gridSizing.ts keepFitting), and Mono's wider
             headings leave out Access's last. Wider, all four fit. */
          if (width > 1440) await expect(headers).toHaveCount(4);
          else expect(await headers.count()).toBeGreaterThanOrEqual(3);
          const bounds = (await table.boundingBox())!;
          const last = (await headers.last().boundingBox())!;
          expect(last.x + last.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
          const description = table.locator('tbody tr').first().locator('td').nth(1);
          expect((await description.boundingBox())!.width).toBeLessThan(bounds.width * 0.56);
          // A little over half: headings are measured now, not estimated, so the concise columns shrink to their words and the description takes the slack.
          await expect(description).toContainText('standard configuration');
          /* A description the room wraps whole needs no hover; one it clips carries its whole value as a title. */
          await description.hover();
          await expect
            .poll(() => description.evaluate((td) => td.title.includes('standard configuration') || td.scrollWidth <= td.clientWidth))
            .toBe(true);
        }
        await page.screenshot({ path: info.outputPath(`catalog-columns-${theme}-${width}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await expect(tables.first().locator('tbody tr').first()).toContainText('Replacement headset');
    });

  for (const theme of ['lumen', 'mono'])
    test(`${theme}: authored record context stays usable across viewports`, async ({ page }, info) => {
      await page.addInitScript((theme) => {
        localStorage.setItem('mistri.visual-theme', theme);
        localStorage.setItem('mistri.theme', 'light');
      }, theme);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (/\/api\/(insert|update|delete)(?:\?|$)/.test(request.url())) writes.push(request.url());
      });
      await page.goto(`${sample.origin}/@incident~1`);
      const context = page.getByRole('complementary', { name: 'Record context' });
      await expect(context.getByRole('heading', { name: 'Service context', exact: true })).toBeVisible();
      await expect(context).toContainText('Response minutes');
      await expect(page.locator('.page-broken')).toHaveCount(0);
      const title = page.locator('.root-current');
      const expectedName = String(scalar(sample.db, 'SELECT name FROM incident WHERE id = 1'));
      await expect(title).toHaveText(expectedName);
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 924 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const bounds = (await context.boundingBox())!;
        const main = (await page.locator('.page-main').boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
        if (width > 1100) expect(bounds.x).toBeGreaterThanOrEqual(main.x + main.width);
        else expect(bounds.y).toBeGreaterThanOrEqual(main.y + main.height);
        await context.scrollIntoViewIfNeeded();
        await expect(context.getByRole('button', { name: 'Edit Asset', exact: true })).toBeVisible();
        await context.getByRole('button', { name: 'Edit Asset', exact: true }).click();
        const input = context.locator('.picker-input');
        await expect(input).toBeFocused();
        await context.getByRole('button', { name: 'Done editing Asset', exact: true }).click();
        await expect(context.getByRole('button', { name: 'Edit Asset', exact: true })).toBeVisible();
        await expect(title).toHaveText(expectedName);
        await page.screenshot({ path: info.outputPath(`record-context-${theme}-${width}.png`) });
      }
      expect(writes).toEqual([]);
    });

  for (const width of [1440, 390])
    test(`${width}px: reference filters offer choices on focus and preserve selected IDs`, async ({ page }, info) => {
      await page.addInitScript(() => {
        localStorage.setItem('mistri.visual-theme', 'lumen');
        localStorage.setItem('mistri.theme', 'light');
      });
      await page.setViewportSize({ width, height: 924 });
      const runtime = await page.request.get(`${sample.origin}/api/runtime`);
      expect(runtime.ok()).toBe(true);
      const { active: activeApp } = (await runtime.json()) as { active: string };
      expect(activeApp).toBe('service-desk');
      const lookups: Array<{ q: string; app?: string }> = [];
      page.on('request', (request) => {
        if (!/\/api\/run(?:\?|$)/.test(request.url()) || request.method() !== 'POST') return;
        const body = request.postDataJSON();
        if (body.limit === 8 && /^(service|support_team)\s/.test(body.q ?? '')) lookups.push(body);
      });
      await page.goto(`${sample.origin}/${encodeURIComponent('incident status != resolved and status != closed')}`);
      await expect(page.locator('.applist-count')).toBeVisible();
      const selectedId = Number(scalar(sample.db, 'SELECT id FROM service WHERE name = ?', 'Identity and access'));
      const matching = Number(
        scalar(sample.db, 'SELECT count(*) FROM incident WHERE service_id = ? AND status NOT IN (?, ?)', selectedId, 'resolved', 'closed'),
      );
      // The chip says the name the box used to show; the question keeps the id.
      const chip = page.locator('.applist-chip', { hasText: 'Service is Identity and access' });
      if (width <= 600) {
        /* On a phone the filters are one sheet: a reference is its checklist of
         names with counts, and a tick writes the id as the typeahead's pick did. */
        await page.getByRole('button', { name: /^Filters/ }).click();
        const sheet = page.getByRole('dialog', { name: 'Filters' });
        const services = sheet.getByRole('group', { name: 'Service' });
        await expect(services.getByRole('checkbox').first()).toBeVisible();
        const more = services.getByRole('button', { name: /^Show all/ });
        if (await more.count()) await more.click();
        await services.getByRole('checkbox', { name: /^Identity and access/ }).check();
        await page.screenshot({ path: info.outputPath(`atlas-service-filter-choices-${width}.png`) });
        await sheet.getByRole('button', { name: /^Show \d/ }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('service_id')).toBe(String(selectedId));
        await expect(page.locator('.applist-count')).toHaveText(matching.toLocaleString());
        await expect(chip).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        return;
      }
      /* At a desk "+ Service" opens its picker with the typeahead's list already up. */
      await page.getByRole('button', { name: 'Filter by Service', exact: true }).click();
      const service = page.getByRole('combobox', { name: 'Filter by Service', exact: true });
      await expect(service).toBeFocused();
      const popup = page.locator('.dd-popup:visible');
      const services = rows<{ name: string }>(sample.db, 'SELECT name FROM service ORDER BY name LIMIT 8');
      await expect(popup.getByRole('option')).toHaveCount(services.length);
      for (const { name } of services) await expect(popup.getByRole('option', { name: new RegExp(name) })).toBeVisible();
      await expect(popup.locator('.dd-list')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      // The App's preset is Lumen and it names no radius of its own: Lumen's one radius is 8px.
      await expect(popup.locator('.dd-list')).toHaveCSS('border-radius', '8px');
      await expect(popup.locator('.dd-list')).toHaveCSS('opacity', '1');
      const bounds = (await popup.boundingBox())!;
      const box = (await service.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(925);
      // Under its box, on the zoom-aware ruler, not a zoom's worth away inside the picker.
      expect(Math.abs(bounds.x - box.x)).toBeLessThanOrEqual(2);
      expect(bounds.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
      await page.screenshot({ path: info.outputPath(`atlas-service-filter-choices-${width}.png`) });
      await popup.getByRole('option', { name: /Identity and access/ }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('service_id')).toBe(String(selectedId));
      await expect(page.locator('.applist-count')).toHaveText(matching.toLocaleString());
      await expect(chip).toBeVisible();
      await expect(popup).toHaveCount(0);

      await page.getByRole('button', { name: 'Filter by Team', exact: true }).click();
      const teams = rows<{ name: string }>(sample.db, 'SELECT name FROM support_team ORDER BY name LIMIT 8');
      await expect(popup.getByRole('option')).toHaveCount(teams.length);
      for (const { name } of teams) await expect(popup.getByRole('option', { name: new RegExp(name) })).toBeVisible();
      // The first Escape closes the list, the second the picker.
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.filter-pop')).toHaveCount(0);
      const filteredUrl = page.url();
      // The chip opens its picker again, its name in the box; a name nothing matches says so.
      await chip.locator('.applist-chip-open').click();
      await expect(service).toHaveValue('Identity and access');
      await service.fill('zz-no-such-service');
      await expect(popup).toContainText('Nothing matches.');
      await expect(popup.getByRole('option')).toHaveCount(0);
      await expect(popup.locator('.dd-list')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(popup.locator('.dd-list')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath(`atlas-service-filter-empty-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await page.keyboard.press('Escape');
      expect(page.url()).toBe(filteredUrl);
      expect(lookups.some((lookup) => /^service\s/.test(lookup.q))).toBe(true);
      expect(lookups.some((lookup) => /^support_team\s/.test(lookup.q))).toBe(true);
      expect(lookups.every((lookup) => lookup.app === activeApp)).toBe(true);
      expect(lookups.every((lookup) => !Object.hasOwn(lookup, 'conn'))).toBe(true);
    });

  test('reference filters show loading while initial choices are pending', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lookupStarted = false;
    await page.route(/\/api\/run(?:\?|$)/, async (route) => {
      const body = route.request().postDataJSON();
      if (/^service\s/.test(body?.q ?? '') && body.limit === 8) {
        lookupStarted = true;
        await held;
      }
      await route.continue();
    });
    try {
      await page.goto(`${sample.origin}/incident`);
      // "+ Service" opens its picker with the list already asked for.
      await page.getByRole('button', { name: 'Filter by Service', exact: true }).click();
      await expect.poll(() => lookupStarted).toBe(true);
      const popup = page.locator('.dd-popup:visible');
      await expect(popup).toContainText(/Loading/);
      await expect(popup.getByRole('option')).toHaveCount(0);
      release();
      await expect(popup.getByRole('option').first()).toBeVisible();
      await expect(popup).not.toContainText(/Loading/);
    } finally {
      release();
    }
  });

  for (const width of [1440, 390])
    test(`${width}px: authored work queues navigate to records and preserve terminal filters`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('body')).toHaveClass(/app-mode/);
      await expect(page.locator('#db-label')).not.toBeVisible();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Connections/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.getByRole('button', { name: 'Search (⌘K)' }).click();
      await page.getByRole('combobox', { name: 'Search', exact: true }).fill('Connections');
      await expect(page.getByRole('option', { name: /^action Connections/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      const schema = (await (await page.request.get(`${sample.origin}/api/schema`)).json()) as {
        tables: Array<{ id: string; segments?: Record<string, string> }>;
      };
      const spelled = async (table: string, question: string) =>
        expandSegments(question, schema.tables.find((candidate) => candidate.id === table)?.segments).text;
      const workspaces = [
        {
          label: 'Incident triage',
          group: 'Operate',
          table: 'incident',
          detail: 'incident',
          lanes: ['new', 'triage', 'in_progress', 'pending', 'resolved', 'closed'],
          terminal: ['resolved', 'closed'],
          heading: 'Critical response',
        },
        {
          label: 'Change queue',
          group: 'Change',
          table: 'change_request',
          detail: 'change',
          lanes: ['draft', 'assess', 'authorize', 'scheduled', 'implement', 'review', 'closed'],
          terminal: ['closed', 'canceled'],
          heading: 'Pending change reviews',
        },
        {
          label: 'Fulfillment queue',
          group: 'Fulfill',
          table: 'service_request',
          detail: 'request',
          lanes: ['submitted', 'awaiting_approval', 'approved', 'fulfilling', 'completed'],
          terminal: ['completed', 'canceled'],
          heading: 'Orders awaiting receipt',
        },
      ];
      for (const workspace of workspaces) {
        const trigger =
          width > 600
            ? page.locator('.tn-wide').getByRole('button', { name: new RegExp(`^${workspace.group}`) })
            : page.getByRole('button', { name: 'Menu', exact: true });
        await trigger.click();
        if (width <= 600) {
          await page.locator('.tn-drill-pop:visible').getByRole('menuitem', { name: workspace.group, exact: true }).click();
        }
        await page.getByRole('menuitem', { name: workspace.label, exact: true }).click();
        // A dashboard's address is its key.
        const route = `/${workspace.label.toLowerCase().replaceAll(' ', '-')}(\\?|$)`;
        await expect(page).toHaveURL(new RegExp(route));
        await expect(page.locator('.board-card').first()).toBeVisible();
        await expect(page.getByRole('heading', { name: workspace.heading, exact: true })).toBeVisible();
        await expect(page.locator('.app-issues')).toHaveCount(0);
        /* A lane is headed by its status as a tone chip says it: in_progress reads "In progress". A state the board's
           standing query never admits is no lane (app.ts withMachineLanes): it could only ever stand empty. */
        await expect(page.locator('.board-lane-head .tone')).toHaveText(
          workspace.lanes.filter((status) => !workspace.terminal.includes(status)).map(said),
        );
        for (const status of workspace.terminal) {
          const lane = page
            .locator('.board-lane')
            .filter({ has: page.locator('.board-lane-head .tone', { hasText: new RegExp(`^${said(status)}$`) }) });
          await expect(lane.locator('.board-card')).toHaveCount(0);
        }
        const expected = rows<{ status: string; total: number }>(
          sample.db,
          `SELECT status, count(*) AS total FROM ${workspace.table} WHERE status IN (${workspace.lanes.map(() => '?').join(', ')}) AND status NOT IN (${workspace.terminal.map(() => '?').join(', ')}) GROUP BY status`,
          ...workspace.lanes,
          ...workspace.terminal,
        );
        for (const status of workspace.lanes.filter((lane) => !workspace.terminal.includes(lane))) {
          const lane = page
            .locator('.board-lane')
            .filter({ has: page.locator('.board-lane-head .tone', { hasText: new RegExp(`^${said(status)}$`) }) });
          const total = expected.find((row) => row.status === status)?.total ?? 0;
          await expect(lane.locator('.board-lane-count')).toHaveText(String(total));
          if (!total) await expect(lane.locator('.board-card')).toHaveCount(0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`atlas-${workspace.detail}-queue-${width}.png`) });
        const card = page.locator('.board-card').first();
        const title = (await card.locator('.board-card-title').textContent())!.trim();
        await card.click();
        // The record's own address, under the view that lists its table.
        await expect(page).toHaveURL(/\/[^/?]+\/\d+$/);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        await expect(page.locator('.page-field-summary').first()).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(route));
        await page.locator('.board-head .dash-open').click();
        const total = expected.reduce((sum, row) => sum + row.total, 0);
        await expect(page.locator('.applist-count')).toHaveText(total.toLocaleString());
        // What no filter box can say is the list's question whole, `q=`.
        /* A segment the question names (`active`, the Active tab's) is its conditions: the terminal filter may ride in it. */
        const asked = await spelled(workspace.table, new URL(page.url()).searchParams.get('q') ?? '');
        for (const status of workspace.lanes) expect(asked).toContain(status);
        for (const status of workspace.terminal) expect(asked).toContain(`status != ${status}`);
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(route));
        const moreLane = page
          .locator('.board-lane')
          .filter({ has: page.locator('.board-more') })
          .first();
        await expect(moreLane.locator('.board-lane-count')).toHaveText(/\d/);
        const laneCount = (await moreLane.locator('.board-lane-count').textContent())!.trim();
        await page.locator('.board-more').first().click();
        await expect(page.locator('.applist-title')).toBeVisible();
        await expect(page.locator('.applist-count')).toHaveText(laneCount);
        const more = await spelled(workspace.table, new URL(page.url()).searchParams.get('q') ?? '');
        for (const status of workspace.terminal) expect(more).toContain(`status != ${status}`);
      }
    });

  test('an empty vendor search has an opaque, anchored popup over the next form field', async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
    await page.goto(`${sample.origin}/purchase_order`);
    await page.getByRole('button', { name: '+ New order', exact: true }).click();
    const form = page.locator('.newpanel');
    const buyer = form.getByRole('combobox', { name: 'Buyer', exact: true });
    await buyer.fill('Alex');
    await page.getByRole('option', { name: /Alex Kim/ }).click();
    const vendor = form.getByRole('combobox', { name: 'Vendor', exact: true });
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 924 });
      await vendor.fill('zz-no-such-vendor');
      // The open popup: the one before it may still be playing its exit
      // animation, and is visible until it unmounts.
      const popup = page.locator('.picker-popup[data-open]');
      await expect(popup).toContainText('Nothing matches.');
      await expect(popup.getByRole('option')).toHaveCount(0);
      await expect(popup).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      const anchor = (await vendor.locator('..').boundingBox())!;
      const bounds = (await popup.boundingBox())!;
      expect(Math.abs(bounds.width - anchor.width)).toBeLessThan(2);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(925);
      expect(
        await popup.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`atlas-vendor-empty-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect(form).toBeVisible();
      await expect(buyer).toHaveValue('Alex Kim');
      await vendor.fill('');
      await vendor.click();
      await expect(page.getByRole('option').first()).toBeVisible();
      await page.getByRole('option').first().click();
      await expect(vendor).not.toHaveValue('');
      await expect(page.locator('.picker-popup:visible')).toHaveCount(0);
    }
  });

  test('desktop nested navigation supports keyboard traversal and zoomed popup bounds', async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem('mistri.visual-theme', 'lumen');
      localStorage.setItem('mistri.density', 'spacious');
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${sample.origin}/`);
    await expect(page.getByRole('heading', { name: 'Priority response', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('zoom', '1.24');
    const directory = page.locator('.tn-wide').getByRole('button', { name: 'Directory', exact: true });
    await expect(directory).toBeVisible();
    await directory.click();
    const organization = page.getByRole('menuitem', { name: 'Organization', exact: true });
    await organization.focus();
    await page.keyboard.press('ArrowRight');
    const submenu = page.getByRole('menu', { name: 'Organization', exact: true });
    await expect(submenu).toBeVisible();
    await expect(submenu.getByRole('menuitem', { name: 'Teams', exact: true })).toBeFocused();
    const bounds = await submenu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1441);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1001);
    await page.screenshot({ path: info.outputPath('atlas-organization-submenu-zoom.png') });
    await page.keyboard.press('ArrowLeft');
    await expect(organization).toBeFocused();
    await expect(submenu).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(submenu).toBeVisible();
    await expect(submenu.getByRole('menuitem', { name: 'Teams', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(submenu.getByRole('menuitem', { name: 'Locations', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/location/);
    await expect(page.locator('.tn-wide .tn-group.active').getByRole('button', { name: 'Directory', exact: true })).toBeVisible();
  });

  test('three-level navigation keeps keyboard focus and clickable popups within the viewport', async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem('mistri.visual-theme', 'lumen');
      localStorage.setItem('mistri.density', 'spacious');
    });
    await page.route('**/api/app*', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      /* A third level: the Organization group's rooms (teams, departments, locations) move into a Members group inside it. */
      type Node = { group?: string; label: string; children?: Node[] };
      const nest = (nodes: Node[]) => {
        for (const node of nodes) {
          if (node.group === 'organization') node.children = [{ group: 'members', label: 'Members', children: node.children }];
          else if (node.children) nest(node.children);
        }
      };
      nest(payload.app?.nav ?? []);
      await route.fulfill({ response, json: payload });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${sample.origin}/`);
    await expect(page.locator('html')).toHaveCSS('zoom', '1.24');
    await page.locator('.tn-wide').getByRole('button', { name: 'Directory', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Organization', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    const members = page.getByRole('menuitem', { name: 'Members', exact: true });
    await expect(members).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const submenu = page.getByRole('menu', { name: 'Members', exact: true });
    await expect(submenu).toBeVisible();
    await expect(submenu.getByRole('menuitem', { name: 'Teams', exact: true })).toBeFocused();
    const bounds = await submenu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1441);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1001);
    expect(
      await submenu.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('atlas-three-level-submenu-spacious.png') });
    await page.keyboard.press('ArrowLeft');
    await expect(members).toBeFocused();
    await expect(submenu).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(submenu).toBeVisible();
    await submenu.getByRole('menuitem', { name: 'Locations', exact: true }).click();
    await expect(page).toHaveURL(/\/location/);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('authored group IDs do not collide with internal folded-menu state', async ({ page }) => {
    await page.route('**/api/app*', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      type Node = { group?: string; children?: Node[] };
      const rename = (nodes: Node[]) => {
        for (const node of nodes) {
          if (node.group === 'directory') node.group = 'folded';
          if (node.children) rename(node.children);
        }
      };
      rename(payload.app?.nav ?? []);
      await route.fulfill({ response, json: payload });
    });
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page.locator('.tn-wide').getByRole('button', { name: 'Directory', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Directory', exact: true })).toBeVisible();
    await expect(page.locator('.tn-drill-pop:visible')).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'SLA policies', exact: true }).click();
    /* Every list is a keyed view: as it opens, its address is its key alone. */
    await expect(page).toHaveURL(/\/sla-policies$/);
    await page.setViewportSize({ width: 390, height: 924 });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const popup = page.locator('.tn-drill-pop:visible');
    await expect(popup.getByRole('menuitem')).toHaveCount(6);
    await popup.getByRole('menuitem', { name: 'Directory', exact: true }).click();
    await popup.getByRole('menuitem', { name: 'Organization', exact: true }).click();
    await popup.getByRole('menuitem', { name: 'Departments', exact: true }).click();
    await expect(page).toHaveURL(/\/department/);
  });

  test('iPad retains the navbar; zoom and phone menus stay usable and bounded', async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem('mistri.visual-theme', 'lumen');
      localStorage.setItem('mistri.density', 'compact');
    });
    await page.setViewportSize({ width: 1024, height: 1366 });
    await page.goto(`${sample.origin}/`);
    await expect(page.getByRole('heading', { name: 'Priority response', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(menu).toBeHidden();
    for (const group of ['Operate', 'Change', 'Request', 'Fulfill', 'Estate', 'Directory']) {
      await expect(page.locator('.tn-wide').getByRole('button', { name: new RegExp(`^${group}`) })).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath('atlas-navbar-ipad.png') });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.35';
    });
    await expect(menu).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
    await expect(menu).toBeHidden();
    await page
      .locator('.tn-wide')
      .getByRole('button', { name: /^Directory/ })
      .click();
    await page.keyboard.press('ArrowDown');
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(menu).toBeFocused();

    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 600 });
      await expect(menu).toBeVisible();
      await menu.click();
      const popup = page.locator('.tn-drill-pop:visible');
      await expect(popup).toBeVisible();
      await expect(popup.getByRole('menuitem')).toHaveCount(6);
      await expect(popup.locator('[data-nav-group]')).toHaveText(
        ['Operate', 'Change', 'Request', 'Fulfill', 'Estate', 'Directory'].map((label) => new RegExp(label)),
      );
      expect((await popup.getByRole('menuitem').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const bounds = await popup.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(601);
      expect(await popup.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`atlas-menu-${width}.png`) });
      await popup.getByRole('menuitem', { name: 'Directory', exact: true }).click();
      await expect(popup).toHaveAttribute('aria-label', 'Directory');
      await expect(popup.getByRole('menuitem')).toHaveCount(5);
      await expect(popup.getByRole('menuitem', { name: 'SLA policies', exact: true })).toBeVisible();
      await popup.getByRole('menuitem', { name: 'Organization', exact: true }).click();
      await expect(popup).toHaveAttribute('aria-label', 'Organization');
      await expect(popup.getByRole('menuitem')).toHaveCount(4);
      for (const label of ['Teams', 'Departments', 'Locations']) {
        await expect(popup.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
      }
      expect(await popup.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`atlas-organization-menu-${width}.png`) });
      await popup.locator('.tn-back').click();
      await expect(popup.getByRole('menuitem', { name: 'Organization', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(popup.getByRole('menuitem', { name: 'Directory', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
    }
    await menu.click();
    const popup = page.locator('.tn-drill-pop:visible');
    await expect(popup).toBeVisible();
    await popup.getByRole('menuitem', { name: 'Directory', exact: true }).click();
    await expect(popup).toHaveAttribute('aria-label', 'Directory');
    await expect(popup.locator('.tn-back')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'SLA policies', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    /* Every list is a keyed view: as it opens, its address is its key alone. */
    await expect(page).toHaveURL(/\/sla-policies$/);
    await expect(page.locator('.tn-drill-pop:visible')).toHaveCount(0);
  });

  for (const width of [1440, 768, 390]) {
    test(`${width}px: connected pages and workflow`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('body')).toHaveClass(/app-mode/);
      await expect(page.getByRole('heading', { name: 'Priority response', exact: true })).toBeVisible();
      await expect(page.locator('.app-issues')).toHaveCount(0);
      await expect(page.locator('.chart-line')).toBeVisible();
      await expect(page.locator('.chart-line')).toHaveAttribute('aria-label', /5 points/);
      await expect(page.locator('.chart-donut-total')).toHaveText('56');
      await expect(page.getByRole('heading', { name: 'Active incidents by support team', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`atlas-home-${width}.png`) });
      await page
        .locator('.chart-legend')
        .getByRole('button', { name: /^Critical/ })
        .click();
      await expect(page.locator('.applist-title')).toHaveText('Incidents');
      // The drill is the Incidents list's own words: its open tab, and the priority's box.
      await expect.poll(() => new URL(page.url()).searchParams.get('priority')).toBe('critical');
      expect(new URL(page.url()).pathname).toBe('/incidents');
      await expect(page.locator('.applist-count')).toHaveText(
        Number(
          scalar(sample.db, "SELECT count(*) FROM incident WHERE priority = 'critical' AND status NOT IN ('resolved', 'closed')"),
        ).toLocaleString(),
      );
      for (const detail of ['incident', 'change', 'request', 'order', 'service', 'asset', 'catalog-item', 'problem', 'knowledge']) {
        await page.goto(`${sample.origin}/@${detail}~1`);
        await expect(page.locator('.page-field-summary').first()).toBeVisible();
        await expect(page.locator('.page-broken')).toHaveCount(0);
        if (detail === 'incident' && width === 1440) {
          await expect(page.locator('.tn-wide .tn-group.active').getByRole('button', { name: 'Operate', exact: true })).toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (['incident', 'change', 'request', 'order'].includes(detail))
          await expect(page.locator('.workflow-steps [aria-current="step"]')).toHaveCount(1);
      }
    });

    test(`${width}px: related note creation retains the parent draft`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/@incident~1`);
      await expect(page.locator('.workflow-steps [aria-current]')).toHaveText('Triage');
      await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Parent draft ${width}`);
      await page.getByRole('button', { name: '+ Add work note', exact: true }).click();
      const form = page.locator('.newpanel');
      await expect(form.getByLabel('Incident', { exact: true })).toHaveCount(0);
      await form.getByLabel('Name', { exact: true }).fill(`Context note ${width}`);
      await form.getByLabel('Body', { exact: true }).fill('Parent binding and retained draft verified.');
      await form.locator('.picker-input').fill('Maya');
      await form.locator('.picker-option').first().click();
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(page.locator('.timeline')).toContainText(`Context note ${width}`);
      expect(scalar(sample.db, `SELECT incident_id FROM incident_note WHERE name='Context note ${width}'`)).toBe(1);
      await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(`Parent draft ${width}`);
      await expect(page).toHaveURL(/\/incidents\/1$/);
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.screenshot({ path: info.outputPath(`atlas-incident-${width}.png`) });
    });
  }

  test('workflow reflects a saved state without a confirmation dialog', async ({ page }) => {
    await page.goto(`${sample.origin}/@incident~1`);
    await page.getByRole('button', { name: 'Start investigation', exact: true }).click();
    await expect(page.locator('.workflow-steps [aria-current]')).toHaveText('In progress');
    expect(scalar(sample.db, 'SELECT status FROM incident WHERE id=1')).toBe('in_progress');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // An App has no Undo.
    await expect(page.getByRole('region', { name: 'Saved changes' }).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });

  test('catalog context creates a requested item, not an order or automatic approval', async ({ page }) => {
    const orders = scalar(sample.db, 'SELECT count(*) FROM purchase_order');
    const approvals = scalar(sample.db, 'SELECT count(*) FROM request_approval');
    await page.goto(`${sample.origin}/@catalog-item~1`);
    await page.getByRole('button', { name: '+ Add to request', exact: true }).click();
    const form = page.locator('.newpanel');
    await form.getByLabel('Name', { exact: true }).fill('Laptop for acceptance');
    await form.locator('.picker-input').fill('Engineering laptop');
    await form.locator('.picker-option').first().click();
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(scalar(sample.db, "SELECT catalog_item_id FROM request_item WHERE name='Laptop for acceptance'")).toBe(1);
    expect(scalar(sample.db, 'SELECT count(*) FROM purchase_order')).toBe(orders);
    expect(scalar(sample.db, 'SELECT count(*) FROM request_approval')).toBe(approvals);
    const refusal = await page.request.post(`${sample.origin}/api/update`, {
      data: { app: 'service-desk', table: 'catalog_item', key: { id: 1 }, values: { price: 1 } },
    });
    expect(refusal.status()).toBe(403);
    expect(scalar(sample.db, 'SELECT price FROM catalog_item WHERE id=1')).toBe(1850);
  });
});
