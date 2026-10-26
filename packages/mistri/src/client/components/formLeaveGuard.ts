/**
 * A form's leave guard, the platform's own: a surface probe that every in-App
 * exit asks (`allowMutationExit` in core.js), and the browser's generic
 * `beforeunload` prompt for a reload, a closed tab or an address typed over
 * it. Browsers ignore any text a page gives that prompt and show it only after
 * the person has interacted with the page; mobile Safari may not show it at
 * all, so `pagehide` is where the page drops its copy of the answers, best
 * effort, before it goes into the back-forward cache.
 *
 * A module of its own because FormSurface, on the first page, arms it; the
 * saved-form API (savedFormApi.ts) arrives with the surfaces that use it.
 */
import { registerSurfaceMutationPendingProbe } from '@mistriwork/kit/client/core.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

/**
 * Arm the leave guard: every in-App exit is refused and the browser asks
 * before the page unloads. `onHide` runs on `pagehide`. The returned function
 * disarms it — on submit, and when the surface goes.
 */
export function armLeaveGuard(onHide: () => void): () => void {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older engines ask for a return value; its text is never shown.
    event.returnValue = '';
  };
  addHostListener(window, 'beforeunload', beforeUnload);
  addHostListener(window, 'pagehide', onHide);
  const release = registerSurfaceMutationPendingProbe(() => true);
  return () => {
    removeHostListener(window, 'beforeunload', beforeUnload);
    removeHostListener(window, 'pagehide', onHide);
    release();
  };
}
