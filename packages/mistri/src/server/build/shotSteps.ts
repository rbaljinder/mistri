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
function clickable(page: Page, target: string): Locator {
  if (target.startsWith(CSS)) return page.locator(target.slice(CSS.length));
  const roles = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch'] as const;
  return roles
    .map((role) => page.getByRole(role, { name: target }))
    .reduce((all, next) => all.or(next))
    .or(page.getByText(target).filter({ visible: true }))
    .first();
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
      if (step.kind === 'click') await clickable(page, step.target).click({ timeout: STEP_MS });
      else if (step.kind === 'type') await typable(page, step.target).fill(step.text, { timeout: STEP_MS });
      else if (step.kind === 'press') await page.keyboard.press(step.key);
      else await page.getByText(step.text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: STEP_MS });
    } catch (error) {
      const why = (error as Error).message.split('\n')[0];
      refuse(
        /Timeout/i.test(why)
          ? `${said(step)}: nothing on ${path} matched within ${STEP_MS / 1000}s (a name is matched against buttons, links, tabs, menu items, boxes and visible text; css:<selector> names an element by selector).`
          : `${said(step)} failed on ${path}: ${why}`,
      );
    }
    /* Settling ends by blurring the focused field, which would take the focus from a key pressed next. */
    if (step.kind !== 'type') await settle(page);
  }
  if (steps.at(-1)?.kind === 'type') await settle(page);
}
