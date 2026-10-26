import { afterEach, expect, test, vi } from 'vitest';
import { applyHeaderShell } from './appHeader.js';

const screen = vi.hoisted(() => ({ width: 1440 }));
vi.mock('../../../kit/src/client/core.js', () => ({
  viewportBox: (node: HTMLElement) => ({ left: Number(node.dataset.left ?? 0) }),
  viewportSize: () => ({ width: screen.width }),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test('header tracks available pane width and sidebar/scrollbar offsets without replacing focused content', () => {
  screen.width = 1440;
  const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn();
      constructor(public callback: () => void) {
        observers.push(this);
      }
      observe() {}
    },
  );
  const header = document.createElement('header');
  const content = document.createElement('main');
  const input = document.createElement('input');
  document.body.append(header, content);
  content.append(input);
  input.value = 'Unsaved';
  input.focus();
  Object.defineProperty(header, 'clientWidth', { value: 1440, configurable: true });
  Object.defineProperty(content, 'clientWidth', { value: 1193, configurable: true });
  content.dataset.left = '232';
  applyHeaderShell(header, content, { headerWidth: 'content', width: 'narrow', gutter: 'normal' });
  expect(header.dataset).toMatchObject({ headerWidth: 'content', width: 'narrow', gutter: 'normal' });
  expect(header.style.getPropertyValue('--app-header-left')).toBe('232px');
  expect(header.style.getPropertyValue('--app-header-right')).toBe('15px');
  expect(header.style.getPropertyValue('--app-header-available')).toBe('1193px');
  screen.width = 390;
  // Stale desktop padding can leave the header wider than the new viewport.
  // Its own width must not become the next padding measurement's authority.
  Object.defineProperty(header, 'clientWidth', { value: 667, configurable: true });
  Object.defineProperty(content, 'clientWidth', { value: 375, configurable: true });
  content.dataset.left = '0';
  observers[0].callback();
  expect(header.style.getPropertyValue('--app-header-left')).toBe('0px');
  expect(header.style.getPropertyValue('--app-header-right')).toBe('15px');
  expect(header.style.getPropertyValue('--app-header-available')).toBe('375px');
  expect(content.firstChild).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Unsaved');
  applyHeaderShell(header, content, { headerWidth: 'full', width: 'narrow' });
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  expect(header.style.getPropertyValue('--app-header-available')).toBe('');
  expect(header.dataset.gutter).toBeUndefined();
  expect(observers).toHaveLength(1);
  applyHeaderShell(header, content);
  expect(header.hasAttribute('data-header-width')).toBe(false);
  expect(header.hasAttribute('data-width')).toBe(false);
});
