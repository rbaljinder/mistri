import { say } from './copy/shell/toast.js';

interface ToastAction {
  label: string;
  run: () => unknown;
}

const active = new WeakMap<HTMLElement, () => void>();
const spoken = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/* The box is shown and hidden, so it cannot be the live region: a status
   that enters the accessibility tree already holding its message is one a
   screen reader never hears change, and "Saved" or "Moved to Done" went
   unsaid. The words go to a region that is always there (the box's
   `data-live`), emptied first and filled a beat later, so the same message
   twice is said twice. An error goes to the assertive region (`data-alert`)
   instead: a refused save is news that should interrupt, and a polite
   status waited behind whatever was being read. */
function announce(box: HTMLElement, message: string, urgent: boolean) {
  const id = urgent ? (box.dataset.alert ?? box.dataset.live) : box.dataset.live;
  const live = id ? box.ownerDocument.getElementById(id) : null;
  if (!live) return;
  clearTimeout(spoken.get(live));
  live.textContent = '';
  spoken.set(
    live,
    setTimeout(() => {
      live.textContent = message;
    }, 50),
  );
}

/** One notification per host, with its timer owned by that notification. */
export function showToast(box: HTMLElement, message: string, tone = 'info', action?: ToastAction, app = false) {
  active.get(box)?.();
  const previousFocus = box.ownerDocument.activeElement;
  /* An error does not time out (WCAG 2.2.1): it says what went wrong and
     often what to do, and four seconds was less than it took to read. It
     stays until it is dismissed or replaced. */
  const persists = tone === 'error';
  let remaining = action ? 9000 : 4000;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let dismissed = false;
  const focusOut = () => queueMicrotask(resume);
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - started));
  };
  const dispose = () => {
    dismissed = true;
    pause();
    box.onmouseenter = box.onmouseleave = null;
    box.removeEventListener('focusin', pause);
    box.removeEventListener('focusout', focusOut);
  };
  const dismiss = () => {
    const hadFocus = box.contains(box.ownerDocument.activeElement);
    dispose();
    box.hidden = true;
    if (hadFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected && !box.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  };
  const resume = () => {
    if (persists || dismissed || hovered || box.contains(box.ownerDocument.activeElement) || timer !== undefined) return;
    started = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  const span = (className: string, text: string) => {
    const node = box.ownerDocument.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  };
  box.className = `toast toast-${tone}`;
  box.replaceChildren();
  if (app) {
    const icon = span('toast-icon', tone === 'ok' ? '\u2713' : tone === 'error' ? '!' : 'i');
    icon.setAttribute('aria-hidden', 'true');
    box.append(icon);
  }
  box.append(span('toast-message', message));
  announce(box, message, tone === 'error');
  if (action) {
    const button = box.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => {
      if (dismissed) return;
      dismiss();
      action.run();
    };
    box.append(button);
  }
  // An error that stays needs a way to go, in the Workbench as in an App.
  if (app || persists) {
    const close = box.ownerDocument.createElement('button');
    close.type = 'button';
    close.className = 'toast-dismiss';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', say('dismissNotification'));
    close.title = say('dismissNotification');
    close.onclick = dismiss;
    box.append(close);
  }
  box.onmouseenter = () => {
    hovered = true;
    pause();
  };
  box.onmouseleave = () => {
    hovered = false;
    resume();
  };
  box.addEventListener('focusin', pause);
  box.addEventListener('focusout', focusOut);
  active.set(box, dispose);
  box.hidden = false;
  resume();
}
