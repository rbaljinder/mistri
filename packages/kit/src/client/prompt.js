/**
 * A themed replacement for `window.prompt`.
 *
 * The native one cannot be styled at all: it is drawn by the browser, says
 * "localhost:4111 says" above whatever you asked, and appears in the system
 * font on the system chrome regardless of the page. It also blocks the main
 * thread, which is why it is the one dialog that cannot animate or be
 * dismissed by clicking away.
 *
 * `<dialog>` gives back everything that matters — modal focus trapping,
 * Escape to close, backdrop — so this only has to supply the shape.
 */
import { createElement } from 'react';
import { mount, unmount } from './components/mount.js';
import { ConfirmDialog, PromptDialog, RangeDialog } from './components/Prompt.js';
import { say } from './copy/shell/prompt.js';
import { portalRoot } from './shellHost.js';

/** Mount a dialog component on the body and resolve with its one answer. */
export function ask(Dialog, props) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'host-contents';
    portalRoot().append(host);
    mount(
      host,
      createElement(Dialog, {
        ...props,
        onDone: (result) => {
          resolve(result);
          unmount(host);
          host.remove();
        },
      }),
    );
  });
}

/**
 * One question, one field. Resolves the trimmed answer, or null if cancelled.
 * `date` uses the themed date-only picker; `datetime-local` uses the same
 * calendar for a date and a wall-clock time, answering what the browser's
 * control did (`YYYY-MM-DDTHH:MM`, no zone). Other inputs keep their type.
 * @param {Omit<import('./components/Prompt.js').PromptProps, 'onDone'>} options
 * @returns {Promise<string | null>}
 */
export function promptFor({
  title,
  label,
  value = '',
  hint,
  confirmLabel = say('common.save'),
  placeholder,
  type = 'text',
  multiline = false,
}) {
  return /** @type {Promise<string | null>} */ (
    ask(PromptDialog, { title, label, value, hint, confirmLabel, placeholder, type, multiline })
  );
}

/**
 * Two values at once, for `between`. A range asked as two separate prompts
 * is two chances to cancel halfway; it is one question, so it is one dialog.
 * Resolves `{ from, to }`, or null if cancelled.
 *
 * @param {Omit<import('./components/Prompt.js').RangeProps, 'onDone'>} options
 * @returns {Promise<{from: string, to: string}|null>}
 */
export function promptForRange({ title, fromLabel, toLabel, hint, type = 'text', placeholder }) {
  return ask(RangeDialog, { title, fromLabel, toLabel, hint, type, placeholder });
}

/** A yes-or-no with the consequence spelled out. Resolves true only on the confirming button.
 * @param {Omit<import('./components/Prompt.js').ConfirmProps, 'onDone'>} options
 */
export function confirmFor({ title, body, confirmLabel = 'OK' }) {
  return ask(ConfirmDialog, { title, body, confirmLabel });
}
