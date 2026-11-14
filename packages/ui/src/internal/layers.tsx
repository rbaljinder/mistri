/**
 * What the layers share (Modal, Drawer, Popover, Tooltip, DropMenu): the word a caller hears for why one opened or
 * closed, and the caller's own element drawn as a layer's trigger.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ChangeDetails } from '../changeDetails.js';
import { told } from './told.js';

/* Why a layer opened or closed, in the words callers already read: UI SDK's own word where it is one a callback's
   type lists, `imperative-action` for a change the page made through the layer's handle, and `implicit` for a
   change UI SDK has a word for that no caller reads (a parent closing, an unmount). */
const SHARED = new Set([
  'trigger-hover',
  'trigger-focus',
  'trigger-press',
  'outside-press',
  'focus-out',
  'list-navigation',
  'escape-key',
  'item-press',
  'close-press',
  'swipe',
]);

/** UI SDK's open-change details in this package's shape (changeDetails.ts). */
export function heard<Reason extends string>(
  said: { reason?: string; source?: string; event?: unknown } | undefined,
): ChangeDetails<Reason> {
  const reason = said?.reason && SHARED.has(said.reason) ? said.reason : said?.reason === 'imperative' ? 'imperative-action' : 'implicit';
  return told(reason as Reason, said);
}

type Props = Record<string, unknown>;

/** The trigger is rendered as the trigger, not inside one: a button passed in would otherwise nest in a button. */
export const triggerElement = (trigger: ReactNode): ReactElement<Props> =>
  isValidElement<Props>(trigger) ? trigger : <button type="button">{trigger}</button>;

type AnyRef = ((node: unknown) => void) | { current: unknown } | null | undefined;
const bothRefs = (a: AnyRef, b: AnyRef) => (node: unknown) => {
  for (const ref of [a, b]) {
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }
};

/**
 * The trigger with a part's props under its own, as UI SDK lays them, but for what describes it: a note is added to
 * a description the trigger already had (a field's hint, a problem) and does not take its place.
 */
export const describedTrigger = (trigger: ReactNode) => (part: Props) => {
  const own = triggerElement(trigger);
  const merged: Props = { ...part };
  for (const [key, value] of Object.entries(own.props)) {
    const under = part[key];
    if (value === undefined) continue;
    if (/^on[A-Z]/.test(key) && typeof under === 'function' && typeof value === 'function')
      merged[key] = (...args: unknown[]) => {
        (value as (...args: unknown[]) => void)(...args);
        // A handler of the caller's that prevents the event's default keeps the part's own from running.
        if (!(args[0] as { defaultPrevented?: boolean } | undefined)?.defaultPrevented) (under as (...args: unknown[]) => void)(...args);
      };
    else if (key === 'className' && under) merged[key] = `${String(under)} ${String(value)}`;
    else if (key === 'aria-describedby' && under) merged[key] = `${String(value)} ${String(under)}`;
    else if (key === 'ref' && under) merged[key] = bothRefs(under as AnyRef, value as AnyRef);
    else merged[key] = value;
  }
  return cloneElement(own, merged);
};
