/**
 * A signed-out visitor in an App that opens resources to the public
 * (`auth.public`): browsing within that grant, with no account behind it.
 * The per-account stores — history, saved layouts, pages and views — have
 * nothing to say to such a visitor, so their reads are skipped rather than
 * answered with a 401 that would draw the sign-in screen.
 */
import { shellBody } from '@mistriwork/kit/client/shellHost.js';
let visitor = false;

export function setPublicVisitor(value: boolean): void {
  visitor = value;
  /* The stylesheets hear it too: a public reader's pages drop the operator's
     furniture (docs/design.md, public pages). */
  if (typeof document !== 'undefined') shellBody()?.classList.toggle('public-visitor', value);
}

export function isPublicVisitor(): boolean {
  return visitor;
}

/**
 * Whether the header offers its search (`ui.shell.search`). A member's by
 * default; a signed-out visitor has nothing of their own to search, so is
 * offered it only where the App says its public pages are worth searching
 * (`'everyone'`). `false` hides it from everyone.
 */
export function headerSearchShown(search: 'members' | 'everyone' | false | undefined): boolean {
  if (search === false) return false;
  return !visitor || search === 'everyone';
}
