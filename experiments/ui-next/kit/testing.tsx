import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* What the experiment's own tests draw with: React's root and `act`, as @mistriwork/ui's conformance suite does,
   so a test needs nothing installed beyond what the components do. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

export function draw(node: ReactNode): HTMLElement {
  clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

export function clear(): void {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
}

export const all = (role: string, within: ParentNode = document): HTMLElement[] => [
  ...within.querySelectorAll<HTMLElement>(`[role="${role}"]`),
];

/* The one part with this role and this name: its `aria-label`, else its text. */
export function one(role: string, name: string, within: ParentNode = document): HTMLElement {
  const found = all(role, within).filter((part) => (part.getAttribute('aria-label') ?? part.textContent?.trim()) === name);
  if (found.length !== 1) throw new Error(`${found.length} parts with role ${role} named "${name}"`);
  return found[0]!;
}

/* The one part with this `aria-label`, whatever it is: a native button says its role without an attribute. */
export function labelled(name: string, within: ParentNode = document): HTMLElement {
  const found = [...within.querySelectorAll<HTMLElement>(`[aria-label="${name}"]`)];
  if (found.length !== 1) throw new Error(`${found.length} parts labelled "${name}"`);
  return found[0]!;
}

export function key(part: Element, pressed: string, more: KeyboardEventInit = {}): void {
  act(() => {
    part.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true, cancelable: true, ...more }));
  });
}

export function focus(part: HTMLElement): void {
  act(() => part.focus());
}
