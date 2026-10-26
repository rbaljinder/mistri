import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { showToast } from './toast.js';

let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('App notifications have a hidden status icon, plain text and a dismiss control', () => {
  showToast(host, '<b>Saved</b>', 'ok', undefined, true);
  expect(host.querySelector('.toast-message')?.textContent).toBe('<b>Saved</b>');
  expect(host.querySelector('b')).toBeNull();
  expect(host.querySelector('.toast-icon')?.getAttribute('aria-hidden')).toBe('true');
  (host.querySelector('.toast-dismiss') as HTMLButtonElement).click();
  expect(host.hidden).toBe(true);
});

test('Undo dismisses and runs once; Workbench keeps its existing controls', () => {
  const run = vi.fn();
  showToast(host, 'Saved', 'ok', { label: 'Undo', run });
  expect(host.querySelector('.toast-dismiss')).toBeNull();
  (host.querySelector('.toast-action') as HTMLButtonElement).click();
  (host.querySelector('.toast-action') as HTMLButtonElement).click();
  expect(run).toHaveBeenCalledOnce();
  expect(host.hidden).toBe(true);
});

test('hover pauses the remaining lifetime instead of losing the action', () => {
  showToast(host, 'Saved', 'ok', { label: 'Undo', run: vi.fn() }, true);
  vi.advanceTimersByTime(2000);
  host.dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(20000);
  expect(host.hidden).toBe(false);
  host.dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(6999);
  expect(host.hidden).toBe(false);
  vi.advanceTimersByTime(1);
  expect(host.hidden).toBe(true);
});

test('focus pauses expiry and dismiss returns focus to its previous owner', () => {
  const field = document.createElement('input');
  document.body.append(field);
  field.focus();
  showToast(host, 'Saved', 'ok', { label: 'Undo', run: vi.fn() }, true);
  const close = host.querySelector('.toast-dismiss') as HTMLButtonElement;
  close.focus();
  vi.advanceTimersByTime(20000);
  expect(host.hidden).toBe(false);
  close.click();
  expect(document.activeElement).toBe(field);
  field.remove();
});

test('the words are said in a region that was there before them, and said again when repeated', () => {
  const live = document.createElement('div');
  live.id = 'toast-test-live';
  live.setAttribute('role', 'status');
  document.body.append(live);
  host.dataset.live = live.id;
  showToast(host, 'Moved to Done', 'ok', undefined, true);
  expect(live.textContent).toBe('');
  vi.advanceTimersByTime(50);
  expect(live.textContent).toBe('Moved to Done');
  // The box it is drawn in comes and goes; the region stays.
  vi.advanceTimersByTime(4000);
  expect(host.hidden).toBe(true);
  expect(live.isConnected).toBe(true);
  showToast(host, 'Moved to Done', 'ok', undefined, true);
  expect(live.textContent).toBe('');
  vi.advanceTimersByTime(50);
  expect(live.textContent).toBe('Moved to Done');
  live.remove();
});

test('an error stays until it is dismissed, in the Workbench too, and interrupts', () => {
  const polite = document.createElement('div');
  polite.id = 'toast-test-polite';
  const urgent = document.createElement('div');
  urgent.id = 'toast-test-alert';
  document.body.append(polite, urgent);
  Object.assign(host.dataset, { live: polite.id, alert: urgent.id });
  showToast(host, 'Could not save', 'error');
  vi.advanceTimersByTime(60_000);
  expect(host.hidden).toBe(false);
  expect(urgent.textContent).toBe('Could not save');
  expect(polite.textContent).toBe('');
  (host.querySelector('.toast-dismiss') as HTMLButtonElement).click();
  expect(host.hidden).toBe(true);
  // What is not an error still goes, and politely.
  showToast(host, 'Saved', 'ok');
  vi.advanceTimersByTime(50);
  expect(polite.textContent).toBe('Saved');
  vi.advanceTimersByTime(4000);
  expect(host.hidden).toBe(true);
  polite.remove();
  urgent.remove();
});

test('replacing a notification cancels its old timer', () => {
  showToast(host, 'Old');
  vi.advanceTimersByTime(3000);
  showToast(host, 'New');
  vi.advanceTimersByTime(1000);
  expect(host.hidden).toBe(false);
  expect(host.textContent).toBe('New');
  vi.advanceTimersByTime(3000);
  expect(host.hidden).toBe(true);
});
