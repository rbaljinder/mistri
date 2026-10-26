#!/usr/bin/env node
/**
 * The surface atlas: one capture of every kind of surface an App draws, side by side on one page, in one look.
 *
 * The visual matrix shows each page in every look, so it answers "does this page hold in Sage by night?". It does not
 * answer "does a dialog's field look like a New form's field?", because those two are pages apart in it. Before 1.0
 * the rule is to guard consistency rather than invent more design, and drift between kinds — a label style, a button
 * order, a heading step, an empty sentence — is only seen when the kinds stand next to each other. This page is that.
 *
 *   node scripts/surface-atlas.mjs                                  Lumen, light, at a desk (1280)
 *   node scripts/surface-atlas.mjs --look mono                      another look (lumen, mono, sage, or default: the App's own)
 *   node scripts/surface-atlas.mjs --look lumen,mono,sage           the looks as columns, kind by kind
 *   node scripts/surface-atlas.mjs --mode dark --device phone       dark, on a phone (390)
 *   node scripts/surface-atlas.mjs --width 1920                     a desk of another width (the wide-view pass)
 *   node scripts/surface-atlas.mjs --fresh                          capture every kind again, ignoring what is on disk
 *   node scripts/surface-atlas.mjs --kinds board,calendar           only these kinds
 *
 * It reads the matrix's own captures (.visual/current, else .visual/baseline) wherever the matrix already takes the
 * page, and captures the rest with the matrix's own helpers — the same seeded Apps, the same pinned clock, the same
 * whole-room capture — into .visual/current, beside the matrix's. It writes .visual/atlas.html (gitignored).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { chromium } from '@playwright/test';
import { APP_DEFAULT, APPS, LOOKS, OUT, VARIANTS, capture, click, quiet, signIn, startApp } from './visual-matrix.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const looks = (option('--look') ?? 'lumen').split(',');
for (const look of looks)
  if (look !== APP_DEFAULT && !LOOKS.includes(look)) throw new Error(`--look ${look}: one of ${[APP_DEFAULT, ...LOOKS].join(', ')}`);
const mode = option('--mode') ?? 'light';
const device = option('--device') ?? 'desk';
const width = option('--width') ? Number(option('--width')) : undefined;
const fresh = args.includes('--fresh');
const only = option('--kinds')?.split(',');

/* The variant: one of the matrix's where it names one, so its captures are read as they are; a desk of another width
   is a variant of its own, keyed by the width so it never stands in for the matrix's 1280. */
const base = VARIANTS.find((variant) => variant.key === `${mode}-${device}`);
if (!base) throw new Error(`--mode ${mode} --device ${device}: no such variant (${VARIANTS.map((v) => v.key).join(', ')})`);
const variant = width && width !== base.width ? { ...base, key: `${mode}-w${width}`, width, height: Math.round(width * 0.625) } : base;

/* A state reached after the page loads. */
const press = (name) => async (page) => {
  await page
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .click();
  await quiet(page);
};
/** The intake fixture's application walked to its review, as e2e/intake-form.spec.ts walks it. */
async function toReview(page) {
  await page.getByRole('textbox', { name: /^Email/ }).fill('ada@example.invalid');
  await page.getByLabel('Confirm email address', { exact: false }).fill('ada@example.invalid');
  await press('Continue')(page);
  await page.getByLabel('First name', { exact: false }).fill('Ada');
  await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
  await page.getByRole('textbox', { name: /^Date of birth/ }).fill('12/10/1990');
  await press('Continue')(page);
  await page.getByRole('radio', { name: 'Savings', exact: true }).check();
  await press('Almost there')(page);
  await press('Skip')(page);
  await page.getByLabel('I agree to the terms', { exact: false }).check();
  await press('Continue')(page);
  await page.getByRole('heading', { name: 'Review your answers' }).waitFor();
}
/** The account menu's Manage accounts: the one administrator's room every App that signs people in has. */
async function manageAccounts(page) {
  await page.locator('.account-menu-trigger, [aria-label^="Account"]').first().click();
  await page.getByRole('menuitem', { name: /Manage accounts/ }).click();
  await quiet(page);
}

/* The browser gate's own form Apps, started as their specs start them (e2e/support/intakeServer.ts): the sample Apps
   have no intake a signed-out reader or the matrix's administrator reaches, and none walks a review. */
const FORM_APPS = [
  { id: 'intake', pages: [], start: async () => (await import('../e2e/support/intakeServer.ts')).startIntakeApp() },
  { id: 'quote', pages: [], start: async () => (await import('../e2e/support/intakeServer.ts')).startIntakeApp([], 'quote') },
];
const appSpec = (id) => APPS.find((app) => app.id === id) ?? FORM_APPS.find((app) => app.id === id);

/**
 * Each kind of surface, and the page that shows it. `from` names a page the matrix already takes (its App id and
 * page name); otherwise `app` names the App and `path` (with `act`, `signedIn`) the page.
 */
const KINDS = [
  { kind: 'shell', label: 'Shell: top menu', from: ['compass', 'list'] },
  { kind: 'shell-side', label: 'Shell: side menu', from: ['lintel', 'units'] },
  { kind: 'list', label: 'List and table', from: ['compass', 'list'] },
  { kind: 'record', label: 'Record', from: ['compass', 'record'] },
  { kind: 'inline-edit', label: 'Record, a field in edit', from: ['compass', 'editing'] },
  { kind: 'new-drawer', label: 'New form, drawer', from: ['compass', 'new'] },
  { kind: 'new-page', label: 'New form, page', app: 'depot', path: '/products', act: click(/^\+ New/), signedIn: true },
  { kind: 'command', label: 'Command dialog', app: 'lintel', path: '/leases/1', act: press(/^Add charge/), signedIn: true },
  { kind: 'command-page', label: 'Command form, page', app: 'lintel', path: '/post-rent', signedIn: true },
  { kind: 'public-form', label: 'Public form', app: 'lintel', path: '/request-viewing', signedIn: false },
  { kind: 'intake', label: 'Intake, first step', app: 'intake', path: '/form/apply', signedIn: false },
  { kind: 'stepped', label: 'Stepped form, its steps beside it', app: 'quote', path: '/form/quote', signedIn: false },
  { kind: 'review', label: 'Review step', app: 'intake', path: '/form/apply', act: toReview, signedIn: false },
  { kind: 'dashboard', label: 'Dashboard', from: ['lintel', 'today'] },
  { kind: 'board', label: 'Board', from: ['lintel', 'repair-board'] },
  { kind: 'calendar', label: 'Calendar', from: ['compass', 'calendar'] },
  { kind: 'landing', label: 'Landing', from: ['forecourt', 'landing'] },
  { kind: 'public-list', label: 'Public list', from: ['lintel', 'listings'] },
  { kind: 'sign-in', label: 'Sign-in', from: ['lintel', 'sign-in'] },
  { kind: 'empty', label: 'Empty list: no matches', app: 'lintel', path: '/residents?search=zzzz', signedIn: true },
  { kind: 'refused', label: 'A room refused', app: 'lintel', path: '/report', signedIn: true },
  { kind: 'error', label: 'Record not found', app: 'lintel', path: '/leases/987654', signedIn: true },
  { kind: 'admin', label: 'Settings: Manage accounts', app: 'lintel', path: '/today', act: manageAccounts, signedIn: true },
].filter((entry) => !only || only.includes(entry.kind));

/** Where a kind's capture is (or will be) for a look: the matrix's path where it takes the page, else the atlas's. */
function subjectOf(entry) {
  if (entry.from) {
    const [id, name] = entry.from;
    const app = appSpec(id);
    const signedOut = app.signedOut?.find(([page]) => page === name);
    const page = signedOut ?? app.pages.find(([page]) => page === name);
    if (!page) throw new Error(`${entry.kind}: the matrix takes no page ${id}/${name}`);
    return { group: id, name, appId: id, path: page[1], act: page[2], signedIn: !signedOut && Boolean(app.signedOut) };
  }
  return { group: entry.app, name: `atlas-${entry.kind}`, appId: entry.app, path: entry.path, act: entry.act, signedIn: entry.signedIn };
}
const fileOf = (subject, look, root) => join(OUT, root, subject.group, subject.name, `${look}-${variant.key}.png`);

const plan = KINDS.map((entry) => ({ entry, subject: subjectOf(entry) }));
const found = new Map();
const missing = [];
for (const { entry, subject } of plan)
  for (const look of looks) {
    const on = fresh ? undefined : ['current', 'baseline'].map((root) => fileOf(subject, look, root)).find(existsSync);
    if (on) found.set(`${entry.kind}/${look}`, on);
    else missing.push({ entry, subject, look });
  }

if (missing.length) {
  const ids = [...new Set(missing.map((job) => job.subject.appId))];
  console.log(`Capturing ${missing.length} of ${plan.length * looks.length} (${ids.join(', ')}); the rest are the matrix's.`);
  const temp = mkdtempSync(join(tmpdir(), 'tablewalk-atlas-'));
  const browser = await chromium.launch();
  const apps = [];
  try {
    const started = await Promise.allSettled(ids.map((id) => startApp(temp, appSpec(id))));
    apps.push(...started.filter((result) => result.status === 'fulfilled').map((result) => result.value));
    const failed = started.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const sessions = new Map();
    for (const app of apps)
      if (app.signedOut && missing.some((job) => job.subject.appId === app.id && job.subject.signedIn))
        sessions.set(app.id, await signIn(browser, app));
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < missing.length) {
          const { entry, subject, look } = missing[next++];
          const app = apps.find((candidate) => candidate.id === subject.appId);
          const job = {
            group: subject.group,
            name: subject.name,
            app,
            signedIn: subject.signedIn,
            act: subject.act,
            url: () => `${app.origin}${subject.path}`,
          };
          try {
            const result = await capture(browser, job, look, variant, sessions);
            if (result.errors.length) console.warn(`${entry.kind} ${look}: ${result.errors.join('; ')}`);
            found.set(`${entry.kind}/${look}`, result.file);
          } catch (error) {
            console.warn(`${entry.kind} ${look}: ${error.message.split('\n')[0]}`);
          }
        }
      }),
    );
  } finally {
    await browser.close();
    await Promise.allSettled(apps.map((app) => app.stop()));
    rmSync(temp, { recursive: true, force: true });
  }
}

/* The page: a row per kind, a column per look, each capture cut to its first screen (the whole room is a click away),
   so a field, a heading and a button stand at one scale across the row. */
const rel = (file) => relative(OUT, file);
const title = `Surface atlas — ${looks.join(', ')} · ${variant.key}`;
const html = `<!doctype html><meta charset="utf-8"><title>Surface atlas</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #111; background: #f4f4f4; }
  h1 { font-size: 20px; margin: 0 0 4px; } p.lede { color: #555; margin: 0 0 24px; }
  .kinds { display: grid; grid-template-columns: repeat(auto-fill, minmax(${looks.length > 1 ? 900 : 420}px, 1fr)); gap: 24px; }
  section { background: #fff; border: 1px solid #ddd; padding: 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; } h2 small { color: #777; font-weight: 400; }
  .looks { display: grid; grid-template-columns: repeat(${looks.length}, minmax(0, 1fr)); gap: 8px; }
  figure { margin: 0; } figcaption { font-size: 12px; color: #555; padding: 4px 0 0; }
  .shot { display: block; aspect-ratio: ${variant.width} / ${Math.min(variant.height, Math.round(variant.width * 0.75))}; overflow: hidden; border: 1px solid #e4e4e4; }
  .shot img { width: 100%; display: block; }
  .none { display: grid; place-items: center; color: #b00020; font-size: 12px; }
</style>
<h1>${title}</h1>
<p class="lede">One capture of every kind of surface, its first screen; open one for the whole room. Made by scripts/surface-atlas.mjs from the visual matrix's captures.</p>
<div class="kinds">${plan
  .map(({ entry, subject }) => {
    const cells = looks
      .map((look) => {
        const file = found.get(`${entry.kind}/${look}`);
        return `<figure>${file ? `<a class="shot" href="${rel(file)}"><img loading="lazy" src="${rel(file)}" alt=""></a>` : '<div class="shot none">not captured</div>'}${looks.length > 1 ? `<figcaption>${look}</figcaption>` : ''}</figure>`;
      })
      .join('');
    return `<section><h2>${entry.label} <small>${subject.group}${subject.path ?? ''}</small></h2><div class="looks">${cells}</div></section>`;
  })
  .join('')}</div>`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'atlas.html'), html);
const lacking = plan.length * looks.length - found.size;
console.log(`${found.size} captures${lacking ? `, ${lacking} could not be taken` : ''}. Review: ${join(OUT, 'atlas.html')}`);
if (lacking) process.exitCode = 1;
