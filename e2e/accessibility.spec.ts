// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
/**
 * Every room, read by axe: the smoke rooms of the Workbench and an App, and
 * the sample Apps' own pages, in several looks, light and dark.
 *
 * docs/design.md holds every look to WCAG 2.2 AA and lists where that was
 * found not to hold; until this spec the finding was by hand, a pass at a
 * time. It fails on axe's serious and critical findings — the ones that
 * stop someone, not the ones that slow them — and names each by rule, look
 * and element so the failure reads as the fix.
 *
 * A finding is left only in ALLOWED, with the reason it cannot be fixed
 * here. The list is short on purpose: a rule silenced for a whole page
 * hides the next real finding of the same kind.
 *
 * It shares the config, App and CRM servers with the serial lane (it
 * addresses them by their ports) and starts the sample Apps it needs on
 * ports of their own.
 */
import AxeBuilder from '@axe-core/playwright';
import { CRM, DEMO, expect, FIELDOPS, type Page, test } from './support/ownServers';
import { open, runQuery } from './support/app';
import { COMMONS_ADMIN, DEPOT_ADMIN, PAYDAY_ADMIN, FORECOURT_STAFF, startSample } from './support/sampleServer';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm', 'fieldops'] });

const APP = FIELDOPS;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const GATED = new Set(['serious', 'critical']);

/* The App's own default (no chosen look) and every built-in look, light
   and dark between them. Every page is read in the App's own look; past that,
   neighbouring pages take alternate looks, so an App's pages together meet
   every look in both modes without each paying for all of them (the suite's serial lane is
   where this runs). */
const LOOKS: Array<{ look?: string; mode: 'light' | 'dark' }> = [
  { mode: 'light' },
  { look: 'workshop', mode: 'dark' },
  { look: 'lumen', mode: 'light' },
  { look: 'lumen', mode: 'dark' },
  { look: 'mono', mode: 'light' },
  { look: 'mono', mode: 'dark' },
  { look: 'sage', mode: 'light' },
  { look: 'sage', mode: 'dark' },
  { look: 'ledger', mode: 'light' },
  { look: 'ledger', mode: 'dark' },
];
const reads = (pageIndex: number, lookIndex: number) => lookIndex === 0 || (pageIndex + lookIndex) % 2 === 0;

/** What axe may report and the spec lets stand, and why. Matched on the rule
    and a piece of the element's selector or markup. */
const ALLOWED: Array<{ rule: string; target: string; why: string }> = [
  {
    rule: 'scrollable-region-focusable',
    target: 'role="menu"',
    why:
      'An open menu (Base UI) holds the focus itself and moves it through its items with the arrow keys, ' +
      'which scroll it; axe asks for a Tab stop inside, and a menu has none by design (APG menu pattern).',
  },
];

interface Finding {
  where: string;
  rule: string;
  impact: string;
  targets: string[];
  help: string;
}

async function audit(page: Page, where: string, findings: Finding[]) {
  // Motion is off, so a colour mid-transition is not what is measured.
  await page.waitForTimeout(150);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const violation of violations) {
    if (!GATED.has(violation.impact ?? '')) continue;
    const targets = violation.nodes
      .map((node) => `${node.target.join(' ')}  ${node.html.slice(0, 160)}`)
      .filter((target) => !ALLOWED.some((allowed) => allowed.rule === violation.id && target.includes(allowed.target)));
    if (targets.length)
      findings.push({ where, rule: violation.id, impact: violation.impact!, targets: targets.slice(0, 4), help: violation.help });
  }
}

function report(findings: Finding[]) {
  return findings.map((f) => `${f.where}: ${f.rule} (${f.impact}) — ${f.help}\n    ${f.targets.join('\n    ')}`).join('\n');
}

/** A page in a look: the look chosen as a reader would, the mode as the system says. */
async function dress(page: Page, origin: string, look: string | undefined, mode: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
  await page.goto(`${origin}/api/runtime`);
  await page.evaluate((chosen) => {
    localStorage.setItem('mistri.tour.v1', 'done');
    if (chosen) localStorage.setItem('mistri.visual-theme', chosen);
    else localStorage.removeItem('mistri.visual-theme');
  }, look);
}

async function painted(page: Page) {
  // Cold sample servers load the client through dynamic imports after `load`.
  // Let that module graph settle before starting the short readiness checks.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await expect.poll(async () => ((await page.locator('#content').textContent()) ?? '').trim().length).toBeGreaterThan(0);
}

test.describe.configure({ timeout: 240_000 });

test('the Workbench’s rooms, light and dark', async ({ page }) => {
  const findings: Finding[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    await open(page, DEMO, '');
    await painted(page);
    await audit(page, `workbench ${mode} landing`, findings);
    await runQuery(page, 'invoice sort total desc');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await audit(page, `workbench ${mode} table`, findings);
    await page.locator('thead .th-filter').first().click();
    await expect(page.locator('.th-menu')).toBeVisible();
    await audit(page, `workbench ${mode} column menu`, findings);
    await page.keyboard.press('Escape');
    await page.locator('tbody tr').first().click();
    await expect(page.locator('.record, .layout').first()).toBeVisible();
    await audit(page, `workbench ${mode} record`, findings);
    await page.getByRole('button', { name: 'As a page' }).click();
    await expect(page.locator('.page-body .page-section').first()).toBeVisible();
    await audit(page, `workbench ${mode} page`, findings);
    await runQuery(page, 'invoice count by status');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await audit(page, `workbench ${mode} breakdown`, findings);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeVisible();
    await audit(page, `workbench ${mode} palette`, findings);
    await page.keyboard.press('Escape');
  }
  expect(findings, report(findings)).toEqual([]);
});

test('an App’s smoke rooms, in every look', async ({ page }) => {
  const findings: Finding[] = [];
  for (const [index, { look, mode }] of LOOKS.entries()) {
    const as = `app ${look ?? 'default'} ${mode}`;
    await dress(page, APP, look, mode);
    await page.goto(APP);
    await painted(page);
    if (reads(0, index)) await audit(page, `${as} home`, findings);
    await page.locator('#table-list button[data-table]').first().click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    if (reads(1, index)) await audit(page, `${as} list`, findings);
    await page.locator('tbody tr').first().click();
    await expect(page.locator('.page-body .page-section').first()).toBeVisible();
    if (reads(2, index)) await audit(page, `${as} record`, findings);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  await audit(page, 'app preferences', findings);
  expect(findings, report(findings)).toEqual([]);
});

test('Compass, writable: dashboard, list, a working lead, calendar and the New form', async ({ page }) => {
  const findings: Finding[] = [];
  for (const [index, { look, mode }] of LOOKS.entries()) {
    const as = `compass ${look ?? 'default'} ${mode}`;
    await dress(page, CRM, look, mode);
    for (const [at, [name, path]] of (
      [
        ['dashboard', '/'],
        ['list', '/leads'],
        ['working lead', '/leads/~11'],
        ['calendar', '/task-calendar'],
      ] as const
    ).entries()) {
      if (!reads(at, index)) continue;
      await page.goto(`${CRM}${path}`);
      await painted(page);
      await audit(page, `${as} ${name}`, findings);
    }
    await page.goto(`${CRM}/leads`);
    await painted(page);
    await page.getByRole('button', { name: '+ New lead', exact: true }).click();
    await expect(page.locator('.newpanel')).toBeVisible();
    await audit(page, `${as} new lead`, findings);
  }
  expect(findings, report(findings)).toEqual([]);
});

/* `queues` are the selectable queues offering a bulk action: a selection
   grid whose rows hold an Open button (CollectionSelection.tsx). Each is read
   in every look, where the other pages are sampled across them, because the
   grid's semantics and its row's focus ring are the queue's in every look. */
const SAMPLES = [
  { name: 'thread', pages: ['/', '/issues', '/board'], queues: ['/triage'] },
  { name: 'tick', pages: ['/'] },
  { name: 'forecourt', account: FORECOURT_STAFF, public: ['/'], pages: ['/vehicles', '/vehicles/~1'] },
  { name: 'payday', account: PAYDAY_ADMIN, pages: ['/', '/people', '/people/~1'], queues: ['/timesheet-tasks'] },
  { name: 'depot', account: DEPOT_ADMIN, pages: ['/', '/products', '/products/~42'], queues: ['/pick-lists'] },
  // Thread 42 is "Weather station, version three": the seed numbers threads oldest first.
  { name: 'commons', account: COMMONS_ADMIN, public: ['/', '/latest', '/latest/~42'], pages: ['/', '/members/~5'], queues: ['/queue'] },
] as const;

// Commons has twelve public audits before its signed-in pages and queues.
// Give each authority surface its own case, retaining every look and audit.
// Depot's page and selection-grid audits together exceed the per-case budget
// on CI. Keep both complete surfaces within that same budget independently.
for (const sample of SAMPLES)
  for (const surface of sample.name === 'commons' ? ['public', 'signed-in'] : sample.name === 'depot' ? ['pages', 'queues'] : ['all']) {
    const label = surface === 'all' ? 'its pages' : surface === 'pages' || surface === 'queues' ? surface : `${surface} pages`;
    test(`${sample.name}: ${label} in every look`, async ({ page }) => {
      const server = await startSample(sample.name);
      try {
        const findings: Finding[] = [];
        for (const path of surface !== 'signed-in' && 'public' in sample ? sample.public : []) {
          for (const [index, { look, mode }] of LOOKS.entries()) {
            if (!reads(0, index)) continue;
            await dress(page, server.origin, look, mode);
            await page.goto(`${server.origin}${path}`);
            await page.waitForLoadState('networkidle');
            await audit(page, `${sample.name} ${look ?? 'default'} ${mode} ${path} (signed out)`, findings);
          }
        }
        if (surface !== 'public') {
          if ('account' in sample) {
            const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
              headers: { origin: server.origin },
              data: sample.account,
            });
            expect(login.ok()).toBe(true);
          }
          for (const [index, { look, mode }] of LOOKS.entries()) {
            await dress(page, server.origin, look, mode);
            for (const [at, path] of sample.pages.entries()) {
              if (surface === 'queues' || !reads(at, index)) continue;
              await page.goto(`${server.origin}${path}`);
              await painted(page);
              await audit(page, `${sample.name} ${look ?? 'default'} ${mode} ${path}`, findings);
            }
            for (const path of surface !== 'pages' && 'queues' in sample ? sample.queues : []) {
              await page.goto(`${server.origin}${path}`);
              await painted(page);
              // The selection grid itself, with a row selected, as a moderator works it.
              const grid = page.getByRole('grid').first();
              await expect(grid).toBeVisible();
              await grid.getByRole('row').first().click();
              await audit(page, `${sample.name} ${look ?? 'default'} ${mode} ${path}`, findings);
            }
          }
        }
        expect(findings, report(findings)).toEqual([]);
      } finally {
        await server.stop();
      }
    });
  }
