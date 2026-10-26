import type { AppShell } from '../shared/app.js';
import { viewportBox, viewportSize } from '@mistriwork/kit/client/core.js';

const observers = new WeakMap<HTMLElement, ResizeObserver>();

/** Keep the header on the content pane's ruler, including its reserved scrollbar. */
export function applyHeaderShell(header: HTMLElement, content: HTMLElement, shell?: AppShell): void {
  observers.get(header)?.disconnect();
  observers.delete(header);
  for (const [key, value] of Object.entries({ 'header-width': shell?.headerWidth, width: shell?.width, gutter: shell?.gutter })) {
    if (value === undefined) header.removeAttribute(`data-${key}`);
    else header.setAttribute(`data-${key}`, value);
  }
  if (shell?.headerWidth !== 'content') {
    for (const property of ['--app-header-left', '--app-header-right', '--app-header-available']) header.style.removeProperty(property);
    return;
  }
  const measure = () => {
    const pane = viewportBox(content);
    const left = pane.left - viewportBox(header).left;
    header.style.setProperty('--app-header-left', `${left}px`);
    // Previous desktop padding can temporarily expand the flex header during
    // a phone resize. Measuring that padded box feeds the overflow back into
    // its padding forever; the full-width header's outer ruler is the viewport.
    header.style.setProperty('--app-header-right', `${Math.max(0, viewportSize().width - pane.left - content.clientWidth)}px`);
    header.style.setProperty('--app-header-available', `${content.clientWidth}px`);
  };
  const observer = new ResizeObserver(measure);
  observers.set(header, observer);
  observer.observe(content);
  observer.observe(header);
  measure();
}
