import type { TenantRenewalState } from './tenantRenewal.js';
import { say } from './copy/tenancy/tenantSuspension.js';
import { shellBody } from '@mistriwork/kit/client/shellHost.js';

/** Keep every private root and portal mounted. The recovery dialog occupies
 * the top layer so an already-open private modal cannot paint above it. */
export function tenantSuspensionOverlay(retry: () => void) {
  let dialog: HTMLDialogElement | undefined;
  let status: HTMLParagraphElement, button: HTMLButtonElement;
  let focused: HTMLElement | null = null;
  let selection: { start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | undefined;
  const hidden = new Map<Element, { inert: string | null; aria: string | null }>();
  const obscure = () => {
    for (const child of shellBody().children) {
      if (child === dialog || hidden.has(child)) continue;
      hidden.set(child, { inert: child.getAttribute('inert'), aria: child.getAttribute('aria-hidden') });
      child.setAttribute('inert', '');
      child.setAttribute('aria-hidden', 'true');
    }
  };
  const observer = new MutationObserver(obscure);
  const close = (restoreFocus = true) => {
    if (!dialog) return;
    observer.disconnect();
    // Closing while private roots are still inert prevents native automatic
    // focus restoration from sending input into a retiring account.
    dialog.close();
    dialog.remove();
    dialog = undefined;
    shellBody().classList.remove('tenant-suspended');
    for (const [child, previous] of hidden) {
      for (const [name, value] of [
        ['inert', previous.inert],
        ['aria-hidden', previous.aria],
      ] as const) {
        if (value === null) child.removeAttribute(name);
        else child.setAttribute(name, value);
      }
    }
    hidden.clear();
    if (restoreFocus && focused?.isConnected) {
      focused.focus({ preventScroll: true });
      if (selection && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
        try {
          focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
        } catch {
          /* Non-text input. */
        }
      }
    }
    focused = null;
    selection = undefined;
  };
  const update = (state: TenantRenewalState) => {
    if (!state.suspended) {
      close();
      return;
    }
    if (!dialog) {
      focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
        selection = { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection };
      }
      dialog = document.createElement('dialog');
      dialog.className = 'tenant-renewal-overlay';
      dialog.setAttribute('aria-labelledby', 'tenant-renewal-title');
      dialog.setAttribute('aria-describedby', 'tenant-renewal-description');
      dialog.setAttribute('aria-modal', 'true');
      const panel = document.createElement('section');
      panel.className = 'tenant-renewal-panel';
      const heading = document.createElement('h1');
      heading.id = 'tenant-renewal-title';
      heading.textContent = say('tenantAccessPaused');
      const description = document.createElement('p');
      description.id = 'tenant-renewal-description';
      description.textContent = say('yourDraftsAreKept');
      status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = say('checkAgain');
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-disabled') !== 'true') retry();
      });
      panel.append(heading, description, status, button);
      dialog.append(panel);
      dialog.addEventListener('cancel', (event) => event.preventDefault());
      shellBody().append(dialog);
      shellBody().classList.add('tenant-suspended');
      obscure();
      observer.observe(shellBody(), { childList: true });
      dialog.showModal();
      button.focus({ preventScroll: true });
    }
    status.textContent = state.offline
      ? say('youAreOfflineReconnect')
      : state.busy
        ? say('verifyingTenantAccess')
        : say('accessCouldNotBeConfirmed');
    // Keep the recovery focus target stable while a request is in flight.
    button.setAttribute('aria-disabled', String(state.busy || state.offline));
  };
  return { update, close };
}
