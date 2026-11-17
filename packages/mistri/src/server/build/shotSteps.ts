/**
 * `mistri shot --click … --type … --press … --wait-for …`: what a reader does before the page is taken.
 *
 * A bare screenshot of a page that fetches its rows is the loading skeleton, and a picture of a record, a filled
 * search box or an opened menu needs someone to get there first. The steps are performed in the order the flags were
 * given, and the page is settled again after each (shot.ts: requests done, nothing busy, still for a moment), so
 * the next step and the picture see the page that step led to — never a fixed sleep.
 */
import type { Locator, Page } from 'playwright-core';

export type ShotStep =
  | { kind: 'click'; target: string }
  | { kind: 'type'; target: string; text: string }
  | { kind: 'press'; key: string }
  | { kind: 'wait-for'; text: string };

/** How long one step looks for its element or text: a slow page is waited for, a name that is wrong is told. */
const STEP_MS = 15_000;

/** The flags that make a step, and how many words each takes. */
export const STEP_FLAGS: Readonly<Record<string, number>> = { '--click': 1, '--type': 2, '--press': 1, '--wait-for': 1 };

export function stepOf(flag: string, words: readonly string[]): ShotStep {
  if (flag === '--click') return { kind: 'click', target: words[0]! };
  if (flag === '--type') return { kind: 'type', target: words[0]!, text: words[1]! };
  if (flag === '--press') return { kind: 'press', key: words[0]! };
  return { kind: 'wait-for', text: words[0]! };
}

/** The step as the flag that made it, for a refusal to quote. */
const said = (step: ShotStep) =>
  step.kind === 'click'
    ? `--click ${JSON.stringify(step.target)}`
    : step.kind === 'type'
      ? `--type ${JSON.stringify(step.target)} ${JSON.stringify(step.text)}`
      : step.kind === 'press'
        ? `--press ${JSON.stringify(step.key)}`
        : `--wait-for ${JSON.stringify(step.text)}`;

const CSS = 'css:';

/** What a person would press: a button, link, tab, menu item, option or box by its accessible name, else any visible text; `css:<selector>` is a selector. */
function clickableAll(page: Page, target: string): Locator {
  if (target.startsWith(CSS)) return page.locator(target.slice(CSS.length));
  const roles = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch'] as const;
  return roles
    .map((role) => page.getByRole(role, { name: target }))
    .reduce((all, next) => all.or(next))
    .or(page.getByText(target).filter({ visible: true }));
}

/** How the matches of a click stand: a name often matches a hidden twin (a mobile menu, a template) or a disabled one. */
interface Matches {
  count: number;
  /** Indexes into the matches that a person could press. */
  usable: number[];
  visible: number;
}

async function matchesOf(all: Locator): Promise<Matches> {
  const found = await all.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element as HTMLElement & { disabled?: boolean };
      const shown =
        (box.offsetWidth > 0 || box.offsetHeight > 0 || box.getClientRects().length > 0) &&
        globalThis.getComputedStyle(box).visibility !== 'hidden';
      return {
        shown,
        enabled: !box.disabled && !box.closest('[disabled], [aria-disabled="true"]'),
        /* A button and the text inside it both match the name: that is one thing to press, the outer one. */
        inner: elements.some((other) => other !== element && other.contains(element)),
      };
    }),
  );
  const own = found.map((match, index) => ({ ...match, index })).filter((match) => !match.inner);
  return {
    count: own.length,
    visible: own.filter((match) => match.shown).length,
    usable: own.filter((match) => match.shown && match.enabled).map((match) => match.index),
  };
}

/** A click whose name more than one thing answers to: said as it is, not as a failure of the page. */
class Ambiguous extends Error {}

/** The one element a click means: the visible, enabled match, or a refusal that says how many there were. */
async function clickable(page: Page, target: string): Promise<Locator> {
  const all = clickableAll(page, target);
  const { usable } = await matchesOf(all);
  if (usable.length === 1) return all.nth(usable[0]!);
  if (usable.length > 1)
    throw new Ambiguous(`ambiguous: ${usable.length} matches for ${JSON.stringify(target)}; use a CSS selector (css:<selector>).`);
  /* None usable yet: the page may still be drawing it, so the click's own wait decides, and a timeout says what was found. */
  return all.first();
}

/** What a timed-out click found, to say beside the refusal. */
async function foundFor(page: Page, target: string): Promise<string> {
  try {
    const { count, visible } = await matchesOf(clickableAll(page, target));
    return count === 0 ? 'no element matched' : `${count} matched (${visible} visible, ${count - visible} hidden)`;
  } catch {
    return 'what matched could not be read';
  }
}

/** What a person would type into: a box by its label, placeholder or accessible name; `css:<selector>` is a selector. */
function typable(page: Page, field: string): Locator {
  if (field.startsWith(CSS)) return page.locator(field.slice(CSS.length));
  /* A button can carry the same label ("Search"); only a box takes text. */
  const box = page.locator('input, textarea, [contenteditable]');
  return box
    .and(page.getByLabel(field))
    .or(box.and(page.getByPlaceholder(field)))
    .or(page.getByRole('searchbox', { name: field }))
    .or(page.getByRole('textbox', { name: field }))
    .or(page.getByRole('combobox', { name: field }))
    .first();
}

/**
 * Perform the steps in order. `settle` is shot's own wait for a page to stand still; `refuse` turns a step that
 * found nothing into the one line that names it and the address, which an agent can act on.
 */
export async function performSteps(
  page: Page,
  steps: readonly ShotStep[],
  path: string,
  settle: (page: Page) => Promise<void>,
  refuse: (why: string) => never,
): Promise<void> {
  for (const step of steps) {
    try {
      if (step.kind === 'click') await (await clickable(page, step.target)).click({ timeout: STEP_MS });
      else if (step.kind === 'type') await typable(page, step.target).fill(step.text, { timeout: STEP_MS });
      else if (step.kind === 'press') await page.keyboard.press(step.key);
      else await page.getByText(step.text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: STEP_MS });
    } catch (error) {
      if (error instanceof Ambiguous) refuse(`${said(step)} on ${path}: ${error.message}`);
      const why = (error as Error).message.split('\n')[0];
      const found = step.kind === 'click' && /Timeout/i.test(why) ? await foundFor(page, step.target) : '';
      refuse(
        /Timeout/i.test(why)
          ? `${said(step)}: nothing on ${path} matched within ${STEP_MS / 1000}s${found ? ` (${found})` : ''} (a name is matched against buttons, links, tabs, menu items, boxes and visible text; css:<selector> names an element by selector).`
          : `${said(step)} failed on ${path}: ${why}`,
      );
    }
    /* Settling ends by blurring the focused field, which would take the focus from a key pressed next. */
    if (step.kind !== 'type') await settle(page);
  }
  if (steps.at(-1)?.kind === 'type') await settle(page);
}
