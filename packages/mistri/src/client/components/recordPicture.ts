/**
 * A still of the record dialog's body, held over it while the next record
 * reads, so a step swaps the record in place instead of collapsing the page to
 * "Reading…" and growing it back. The dialog remounts its page for every
 * record on purpose (one record's actions, drafts and delete state never reach
 * the next), so the still is presentation only: a copy of the DOM, inert,
 * hidden from assistive technology, without ids (a copied `id` would answer
 * getElementById and a label's `for` ahead of the real one), and scrolled to
 * where the reader was.
 */
import { motionStill } from '@mistriwork/kit/client/motionStill.js';
import { shellRoot } from '@mistriwork/kit/client/shellHost.js';
export interface RecordPicture {
  node: HTMLElement;
  scrollTop: number;
}

export function takePicture(body: HTMLElement | null): RecordPicture | null {
  if (!body) return null;
  const node = body.cloneNode(true) as HTMLElement;
  node.removeAttribute('id');
  for (const element of node.querySelectorAll('[id]')) element.removeAttribute('id');
  node.setAttribute('aria-hidden', 'true');
  return { node, scrollTop: body.scrollTop };
}

export function showPicture(host: HTMLElement, picture: RecordPicture): void {
  host.inert = true;
  host.replaceChildren(picture.node);
  picture.node.scrollTop = picture.scrollTop;
}

/** Whether there was a still to take away. It leaves at once: an exit is not animated. */
export function clearPicture(host: HTMLElement | null): boolean {
  if (!host?.firstChild) return false;
  host.replaceChildren();
  return true;
}

/** The arriving record decelerates in on the design's own tokens; reduced motion silences it. */
export function enterRecord(body: HTMLElement | null): void {
  if (!body || typeof body.animate !== 'function') return;
  if (motionStill()) return;
  const tokens = getComputedStyle(shellRoot());
  const duration = Number.parseFloat(tokens.getPropertyValue('--t-popover')) || 160;
  const easing = tokens.getPropertyValue('--ease-out').trim() || 'ease-out';
  body.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
}

/* A still that outlives its pane. Every pick in an App's split remounts the
   room (Content keys it by the paint), so the dialog's way — a still taken
   before the step, inside one mounted host — has no host to live in. The pane
   being left keeps its still here as it goes, and the next pane of the same
   split takes it, for a moment only: a still found later belongs to a pane
   closed long ago. */
let kept: { key: string; picture: RecordPicture; height: number; at: number } | null = null;

/** Keep a still of `body` for the next pane of the same split (`key`). */
export function keepStill(key: string, body: HTMLElement | null): void {
  const picture = takePicture(body);
  kept = picture && body ? { key, picture, height: body.offsetHeight, at: Date.now() } : null;
}

/** The still the pane before this one kept, once, and only if it is the same split's and fresh. */
export function takeStill(key: string, within = 1500): { picture: RecordPicture; height: number } | null {
  const still = kept;
  kept = null;
  return still && still.key === key && Date.now() - still.at <= within ? { picture: still.picture, height: still.height } : null;
}
