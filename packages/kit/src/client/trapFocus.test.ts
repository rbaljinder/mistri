import { afterEach, expect, test } from 'vitest';
import { trapFocus } from './dom.js';

/* trapFocus (dom.js) keeps the keyboard inside a plain `aria-modal` panel.
   A modal opened over it — every dialog is Base UI's now, an `aria-modal`
   element on a portal of its own, not a `<dialog open>` — keeps its own
   focus: the panel pulling it back while the modal pulled it in again sent
   the connection form's typed name into its URL box. */

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  document.body.replaceChildren();
});

function panelWithModalAbove() {
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.innerHTML = '<button type="button" class="ghost">Add</button>';
  document.body.append(panel);
  release = trapFocus(panel) as () => void;
  const portal = document.createElement('div');
  portal.innerHTML =
    '<div class="modal confirm" role="dialog" aria-modal="true"><input aria-label="Connection URL"><input aria-label="Connection name"></div>';
  document.body.append(portal);
  return { panel, name: portal.querySelector<HTMLInputElement>('[aria-label="Connection name"]')! };
}

test('focus moved into a modal above the panel stays there', () => {
  const { name } = panelWithModalAbove();
  name.focus();
  expect(document.activeElement).toBe(name);
});

test("Tab inside a modal above the panel is the modal's", () => {
  const { name } = panelWithModalAbove();
  name.focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  name.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(name);
});
