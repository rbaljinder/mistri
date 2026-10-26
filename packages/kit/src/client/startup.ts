// Hidden dialogs cannot receive focus. Do not let app shortcuts open one
// while boot is still resolving the workspace; native reload remains usable.
import { say } from './copy/shell/startup.js';
import { herePath } from './addressMount.js';
import { addHostListener, removeHostListener, shellBody, shellById, shellRoot } from './shellHost.js';

function guardStartupKeys(event: KeyboardEvent): void {
  if (!shellRoot().hasAttribute('data-starting')) return;
  event.stopImmediatePropagation();
}
addHostListener(window, 'keydown', guardStartupKeys, true);

/** Reveal only after boot has selected its route, workspace and appearance. */
export function rememberStartupAppearance(): void {
  if (shellRoot().hasAttribute('data-starting')) return;
  try {
    const colors = getComputedStyle(shellBody());
    // The App's id as index.html's first script reads it: the inside address's first segment.
    const signature = JSON.stringify([
      herePath().split('/')[1] || '',
      localStorage.getItem('mistri.theme'),
      localStorage.getItem('mistri.visual-theme'),
      matchMedia('(prefers-color-scheme: dark)').matches,
      localStorage.getItem('mistri.workbench-visual-theme'),
      localStorage.getItem('mistri.visual-palettes'),
    ]);
    sessionStorage.setItem('mistri.startup.v1', JSON.stringify({ signature, background: colors.backgroundColor, text: colors.color }));
  } catch {
    /* An unavailable appearance hint must never prevent startup. */
  }
}

let watching = false;
export function whenStartupReady(callback: () => void): () => void {
  if (!shellRoot().hasAttribute('data-starting')) {
    callback();
    return () => {};
  }
  addHostListener(window, 'mistri:ready', callback, { once: true });
  return () => removeHostListener(window, 'mistri:ready', callback);
}

export async function finishStartup(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  shellRoot().removeAttribute('data-starting');
  removeHostListener(window, 'keydown', guardStartupKeys, true);
  window.dispatchEvent(new Event('mistri:ready'));
  rememberStartupAppearance();
  if (!watching) {
    addHostListener(window, 'pagehide', rememberStartupAppearance);
    watching = true;
  }
}

/** The page's name for the App it is: the title the server wrote for it, never the tablewalk wordmark. */
function appNameOnPage(): string {
  const title = document.title.trim(); // host-global: reads the title the server wrote before any shell exists
  return title && title !== 'tablewalk' ? title.replace(/\s+[-\u2013\u2014|]\s+tablewalk$/i, '') : '';
}

/** One failure page for every way an App does not start: its name, one line of why, one way on. It wears the
    look tokens the page was started with (index.html's `--startup-*`), so a white-labelled tenant never sees the
    vendor here. The App framework's own unavailable screen (appUnavailable.js) draws the same three lines in the same classes. */
export function failStartup(error: unknown): void {
  const status = shellById('startup-status');
  if (!status) return;
  status.dataset.failed = 'true';
  status.setAttribute('role', 'alert');
  const name = appNameOnPage();
  let title = status.querySelector('.unavail-title');
  if (!title) {
    title = document.createElement('p');
    title.className = 'unavail-title';
    status.querySelector('p')?.before(title);
  }
  title.textContent = name ? say('couldNotStart', { name }) : say('couldNotStartTheApplication');
  const message = status.querySelector('p:not(.unavail-title)');
  if (message) {
    message.classList.add('unavail-line');
    message.textContent = error instanceof Error ? error.message : say('unexpectedStartupError');
  }
  const reload = status.querySelector('a');
  if (reload) {
    reload.classList.add('unavail-action');
    reload.hidden = false;
  }
}
