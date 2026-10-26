/**
 * Getting into Ignition from a browser, once, so four specs say it the same way.
 *
 * A tenant App is two doors rather than one: a native sign-in, and then an
 * explicit choice of which dealership — or the lender — this tab is in. Nothing
 * is fetched between them (the chooser is deliberately drawn before any room),
 * so every spec here signs in through the real endpoint, opens the App, and
 * picks a context by name.
 *
 * Rooms are opened by clicking the sidebar rather than by `page.goto`: a real
 * navigation throws the document away, and with it the tab's chosen context, so
 * a goto lands back on the chooser. That is the App behaving correctly, and it
 * is why `openRoom` clicks.
 */
import { expect, type Page } from '@playwright/test';
import { DEALER_NAMES, type IgnitionFixture } from './ignitionServer.js';

/** The lender's own choice in the chooser, from `auth.tenancy.platform.label`. */
export const LENDER = 'Lender';

/** A context as a person sees it: a dealership by its name, the lender by its label. */
export const contextName = (context: string): string => DEALER_NAMES[context] ?? context;
/** The chooser's choice of a context, by the id it sends (a dealership's, or the platform realm's reserved one). */
const choice = (page: Page, context: string) =>
  page.getByRole('list', { name: 'Available dealers' }).locator(`button[data-tenant="${context === LENDER ? '@platform' : context}"]`);

/** Sign in natively. Grants nothing on its own: authority is the membership. */
export async function signIn(page: Page, app: IgnitionFixture, email: string): Promise<void> {
  const account = app.accounts.get(email);
  if (!account) throw new Error(`The seed created no account for ${email}.`);
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: account.email, password: account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Which contexts this account may choose between, as the chooser offers them. */
export async function offeredContexts(page: Page, app: IgnitionFixture, email: string): Promise<string[]> {
  await signIn(page, app, email);
  await page.goto(`${app.origin}/`);
  await expect(page.getByRole('heading', { name: 'Choose a dealer' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Available dealers' });
  await expect(list.getByRole('button').first()).toBeVisible();
  return list.getByRole('button').allTextContents();
}

/** Sign in and enter one context — a dealership id, or `LENDER`. The choice
 * says the dealership's name; it is chosen by the id it sends. An account
 * whose one membership is that dealership is entered without the chooser. */
export async function enter(page: Page, app: IgnitionFixture, email: string, context: string): Promise<void> {
  await signIn(page, app, email);
  await page.goto(`${app.origin}/`);
  const offered = choice(page, context).and(page.locator(':enabled'));
  /* On a phone the bar's dealer control is hidden — it is the account menu's
     first item there (structure.css, tenantContextEntry.ts) — so having entered
     is the control being drawn, seen or not. (A role query that includes the
     hidden reads its aria-hidden caret into the name, so it is found by class.) */
  const entered = page.locator('button.tenant-control-trigger').filter({ hasText: `Dealer: ${contextName(context)}` });
  /* The readiness budget, not the default: the chooser (or the entered control) is the first thing a cold tenant
     host draws, and the visual matrix enters four tabs at once — under the default five seconds 14 of its 24
     Ignition loads failed here, and all 24 passed one at a time. */
  await expect(context === LENDER ? offered : offered.or(entered).first()).toBeAttached({ timeout: ROOM_SETTLED_MS });
  if (await offered.isVisible()) {
    await expect(choice(page, context)).toHaveText(contextName(context));
    await offered.click();
  }
  await workspaceReady(page);
}

/** Switch the tab's context without signing in again. */
export async function switchTo(page: Page, current: string, context: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^(Dealer: )?${contextName(current)}`) }).click();
  await choice(page, context).click();
  await workspaceReady(page);
}

/**
 * How long a room of Ignition's may take to settle, and why it is not the
 * default.
 *
 * These helpers first waited on `tbody tr` — a side effect — inside the 7s
 * default, and flaked. Measured on an idle machine against this fixture, a
 * room's first row lands 1.1–2.4s after the click when warm, and 3.7–5.8s on
 * the first open after a fresh deploy and seed, which is what every spec does.
 * So the default left barely a second of headroom, and the gate machine, which
 * runs the rest of the suite around these, does not have that second.
 *
 * That slowness is real and is reported with this suite: a tenant room fetches
 * its rows and its count through the tenant HTTP host, which re-verifies the
 * lease on every request, over Vite's dev middleware and a cold pool. A second
 * per room switch is the floor, not the outlier.
 *
 * This budget covers it with room to spare, and it buys the wait a *signal*
 * rather than a longer guess — see `settled`. Context entry also waits for
 * schema and App metadata before revealing navigation, so it uses this same
 * readiness budget. Assertions about what a room says keep the default, so
 * a wrong answer still fails in seconds.
 */
const ROOM_SETTLED_MS = 30_000;

/** The phone's menu: the bar's one button, which opens the rooms as a dialog. */
const phoneMenu = (page: Page) => page.getByRole('navigation', { name: 'App menu' }).getByRole('button', { name: 'Menu', exact: true });

/** A chosen context is usable only once its scoped metadata reveals the menu:
 * the sidebar at a desk, the bar's Menu on a phone (the visual matrix's). */
export async function workspaceReady(page: Page): Promise<void> {
  await expect(page.locator('.sidebar').or(phoneMenu(page)).filter({ visible: true }).first()).toBeVisible({ timeout: ROOM_SETTLED_MS });
}

/**
 * Wait for the room on screen to be the one that was asked for, and for it to
 * have finished counting.
 *
 * Two signals, and each says something the other does not. `.applist-title` is
 * the room's own label: it is set within milliseconds of the click, so it
 * proves the click landed and the screen is not still the last room — measured,
 * this was never the failure, and asserting it keeps a future lost click from
 * reappearing as a mystery timeout. `.applist-count` is the row count the room
 * reports, and it renders only once the grid has handed back a total, so it is
 * the room saying it is done rather than the test inferring it from a painted
 * row.
 *
 * Waiting on the count instead of on a row is also what keeps the checks
 * honest: a room that settles on nothing is a room that says `0`, and the
 * caller's own assertion about its rows then fails for the true reason instead
 * of timing out with "element(s) not found".
 */
export async function settled(page: Page, label: string): Promise<void> {
  await expect(page.locator('.applist-title'), `the room on screen is "${label}"`).toHaveText(label, { timeout: ROOM_SETTLED_MS });
  await expect(page.locator('.applist-count'), `the room "${label}" reported how many rows it matched`).toBeVisible({
    timeout: ROOM_SETTLED_MS,
  });
}

/** Open a sidebar room by its physical table, the way a reader clicks it, and
 * leave it settled: the room the button names, with its count in. */
/* A room's own query, where the App gives it one the menu carries: the lists
   over the financing form's root leave its drafts out (savedFormLists.ts), so
   the Leads room's is the condition that does it. */
const OWN_QUERY: Readonly<Record<string, string>> = { lead: 'status != draft' };

export async function openRoom(page: Page, table: string, query = ''): Promise<void> {
  const navq = query || OWN_QUERY[table] || '';
  const room = `button[data-table="${table}"][data-navq="${navq}"]`;
  const button = page.locator(`#table-list ${room}`).first();
  /* Just after the window is resized the shell may still be the other one: wait for the sidebar or the phone's
     Menu before asking which it is, or a desk is taken for a phone whose Menu then never shows. */
  await expect(page.locator('.sidebar').or(phoneMenu(page)).first()).toBeVisible();
  if (!(await page.locator('.sidebar').isVisible())) {
    /* A phone has no sidebar: its menu is a dialog of the same rooms, closed
       once one is chosen, so the room is held to its name alone. */
    await phoneMenu(page).click();
    const item = page.getByRole('dialog').locator(room).first();
    const label = ((await item.textContent()) ?? '').trim();
    await item.click();
    await settled(page, label);
    return;
  }
  // The button carries the room's label, so the room can be held to its own name.
  // Its words, not their rendering: Mono sets the current room in capitals (docs/design.md).
  const label = ((await button.locator('.nav-label').textContent()) ?? '').trim();
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
  await settled(page, label);
}

/**
 * Open one row of the open list by a value it shows.
 *
 * The room is waited out first, because a tab click or a crumb back to the list
 * starts a fetch whose old rows are still on screen: without this, a search for
 * a row could read the previous tab's. `strip` then waits for the record's own
 * workflow section, which arrives after the head does — the same ordering the
 * room has, one level down.
 */
export async function openRow(page: Page, text: string, strip = false): Promise<void> {
  const title = page.locator('.applist-title');
  await expect(title).toBeVisible({ timeout: ROOM_SETTLED_MS });
  const label = (await title.innerText()).trim();
  await settled(page, label);
  /* A phone draws the list as cards of the same records, each opened by its name. */
  const row = page.locator('tbody tr', { hasText: text }).first();
  const card = page.getByRole('list', { name: 'Records' }).getByRole('listitem').filter({ hasText: text }).first();
  await expect(row.or(card).first(), `a row reading "${text}" in "${label}"`).toBeVisible({ timeout: ROOM_SETTLED_MS });
  if (await row.isVisible()) await row.click();
  else await card.getByRole('button').first().click();
  await expect(page.locator('.page-head.has-record')).toBeVisible();
  if (strip) await expect(page.locator('.workflow-steps li').first()).toBeVisible({ timeout: ROOM_SETTLED_MS });
}

/** One labelled field's value on the open record page. */
export function recordField(page: Page, label: string) {
  return page
    .locator('.page-field', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd')
    .first();
}
