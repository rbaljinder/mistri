/**
 * The keyboard, and the state controls leave behind.
 *
 * Not an audit — an axe run belongs in its own pass. These are the four things
 * that break silently in a hand-written DOM with no framework to keep them
 * honest: a control that only the mouse can reach, a list of sixty-six tables
 * that eats the Tab key, a dialog that cannot be dismissed, and an
 * `aria-expanded` left saying "open" after the menu has gone. The last one is
 * invisible to everyone except the reader who depends on it most.
 */
import { DEMO, expect, type Page, test, WIDE } from './support/ownServers';
import { open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/** What the keyboard is on, named the way the page names it. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.activeElement as HTMLElement | null;
    if (!node || node === document.body) return 'body';
    return node.getAttribute('aria-label') ?? node.id ?? node.textContent?.trim().slice(0, 24) ?? node.tagName;
  });
}

async function tabThrough(page: Page, steps: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab');
    seen.push(await focusedName(page));
  }
  return seen;
}

test('every control in the chrome is reachable with Tab alone', async ({ page }) => {
  await open(page, DEMO, 'customer');
  const seen = await tabThrough(page, 12);

  /* The header is where the tool is driven from, and a control that needs a
     mouse here is a control some people simply do not have. */
  for (const control of ['Query', 'Show the SQL', 'Search', 'More', 'Filter tables']) {
    expect(seen, `${control} should be reachable by Tab`).toContain(control);
  }
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /^Editing enabled/ })).toHaveAttribute('aria-checked', 'false');
});

test('the table list is one stop for Tab and a cursor for the arrows', async ({ page }) => {
  /* Sixty-six tables in the tab sequence makes Tab useless for what Tab is
     for. The list is reached through the filter field and moved within by the
     arrow keys, which is the roving-tabindex pattern every real listbox uses —
     and it is only a pattern if Tab genuinely leaves. */
  await page.goto(`/${WIDE}/ticket`);
  await expect(page.locator('#db-label')).toContainText(WIDE);

  const filter = page.getByRole('searchbox', { name: 'Filter tables' });
  await filter.fill('ticket');
  await page.keyboard.press('ArrowDown');

  const first = page.locator('#table-list button').first();
  await expect(first).toHaveClass(/active/);
  /* The highlight moves and the focus does not, because the hands are in the
     filter field: while you are typing, the highlight is a cursor into the
     list rather than a place the keyboard is. */
  await expect(filter).toBeFocused();

  // Off the field, the two travel together — otherwise the page draws a focus
  // ring on the table you arrowed away from and the highlight on the one you
  // arrowed to, which looks like a list that cannot decide where you are.
  await first.click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#table-list button').nth(1)).toBeFocused();
  await expect(page.locator('#table-list button.active')).toHaveCount(1);

  await page.keyboard.press('Tab');
  const inList = await page.evaluate(() => Boolean(document.getElementById('table-list')?.contains(document.activeElement)));
  expect(inList).toBe(false);
});

test('the shortcuts the panel lists are the shortcuts that work', async ({ page }) => {
  /* `h` for home is the sort of thing nobody guesses, and it was documented
     nowhere someone in the app could reach. A panel that lists a key that
     does nothing would be worse than the silence it replaced, so the two are
     checked against each other. */
  await open(page, DEMO, 'customer');
  /* `?` is the shortcut the panel itself documents, so it is the one the
     test uses to open it. */
  await page.keyboard.press('?');
  const panel = page.getByRole('dialog', { name: 'Query language' });
  const keys = panel.getByRole('heading', { name: 'Keys the page listens for' });
  await expect(keys).toBeVisible();
  await expect(panel).toContainText('home: the schema, your work, the diagram');
  await page.keyboard.press('Escape');

  /* And it works: `h` from a table goes home, where the schema summary is. */
  await page.keyboard.press('h');
  await expect(page.locator('.landing-top')).toBeVisible();

  /* `t` puts the caret in the table filter rather than typing a `t`. */
  await page.keyboard.press('t');
  await expect(page.getByRole('searchbox', { name: /Filter tables/i })).toBeFocused();
});

test('⌘K opens the palette and Escape closes it', async ({ page }) => {
  await open(page, DEMO, 'customer');

  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: 'Search' });
  await expect(search).toBeFocused();
  // A named modal: the page under its scrim is out of the reading, and out of Tab's reach.
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();

  await search.fill('inv');
  // Ranked, not filtered alphabetically: what you typed the most of wins.
  await expect(page.getByRole('option').first()).toContainText('invoice');
  // The lit option is where the keyboard is, so it wears the focus ring, not a tint alone.
  await expect(page.locator('.palette-item.active')).toHaveCSS('outline-style', 'solid');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('a menu leaves no aria-expanded behind, and gives the focus back', async ({ page }) => {
  await open(page, DEMO, 'customer');
  /* By id, not by accessible name. "More" also matches the diagram's
     "+ 2 more" nodes, so the name is ambiguous whenever a schema diagram is on
     screen — which made this resolve to four elements and fail, intermittently
     and only in a full run. A header control has an id; use it. */
  const more = page.locator('#more-button');

  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  /* The attribute is the only thing a screen reader has to go on. Left at
     "true" it announces an open menu that is not on the screen. */
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // And the keyboard is back on the button that opened it, not on <body>.
  await expect(more).toBeFocused();
});

test('the connection picker keeps the listbox contract', async ({ page }) => {
  /* A hand-built listbox replacing a native `<select>` owes the keyboard
     everything the native one gave away for free. Escape is the one that
     matters most: a menu you cannot dismiss without the mouse is a trap. */
  await open(page, DEMO, 'customer');
  const picker = page.getByRole('button', { name: 'Database connection' });

  await picker.click();
  await expect(page.getByRole('listbox', { name: 'Database connection' })).toBeVisible();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Database connection' })).toBeHidden();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toBeFocused();
});

test('skimming the table list shows one selection, not two', async ({ page }) => {
  /* The cursor moves per keypress; the table on screen catches up a debounce
     later. In between, both rows used to wear the identical "you are here"
     treatment — two selected tables flashing on every quick run down the
     list. Dispatched as two immediate keydowns because the bug only exists
     inside that window; real key presses through the driver are slower than
     the debounce. */
  await open(page, WIDE, 'contact');
  const during = await page.evaluate(() => {
    const list = document.getElementById('table-list')!;
    const current = list.querySelector('button[aria-current="true"]') as HTMLElement;
    current.focus();
    const press = () => current.closest('.sidebar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    press();
    press();
    return {
      skimming: list.classList.contains('skimming'),
      /* The stale row keeps aria-current — it is still what the panel shows —
         but must not also carry the cursor class that styles the strong
         indicator. */
      staleAlsoActive: Boolean(list.querySelector('button[aria-current="true"].active')),
    };
  });
  expect(during.skimming).toBe(true);
  expect(during.staleAlsoActive).toBe(false);

  /* Once the preview lands, cursor and current are one row and the list is
     no longer skimming. */
  await expect(page.locator('#table-list.skimming')).toHaveCount(0);
  await expect(page.locator('#table-list button[aria-current="true"].active')).toHaveCount(1);
});

test('the agent console drives a tool and shows what an agent would see', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('Agent');
  await page.getByRole('option', { name: 'Agent console' }).click();

  const console_ = page.getByRole('dialog', { name: 'Agent console' });
  await expect(console_).toContainText('driven by hand');
  /* The read/write split is visible before anything is called: the badge is
     the annotation, rendered. */
  await expect(console_.getByRole('option', { name: /^delete writes/ })).toContainText('destructive');

  await console_.getByRole('option', { name: /^query/ }).click();
  await console_.getByLabel('q', { exact: true }).fill('customer active = true limit 3');
  await console_.getByRole('button', { name: 'Call tool' }).click();

  /* The answer carries its stats — the cost an agent would pay — and the
     deep links come back as doors into the app itself. */
  await expect(console_.locator('.agent-stats')).toContainText('rowsRead 3');
  await expect(console_.locator('.agent-answer')).toContainText('"rows"');
  await console_.locator('.agent-links button').first().click();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue('customer active = true limit 3');
});
