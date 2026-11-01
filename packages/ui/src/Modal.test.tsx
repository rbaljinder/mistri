import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';
import { Modal, type ModalHandle } from './Modal.js';

afterEach(cleanup);

test.each([true, 'mobile'] as const)('fullscreen %s preserves modal semantics', (fullscreen) => {
  render(
    <Modal className="confirm" ariaLabel="Overlay" fullscreen={fullscreen} onClose={vi.fn()}>
      <button>Close</button>
    </Modal>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Overlay' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveClass(fullscreen === true ? 'modal-fullscreen' : 'modal-fullscreen-mobile');
});

test('a rejected close request leaves the modal open and can later be accepted', async () => {
  const user = userEvent.setup();
  const beforeClose = vi.fn().mockReturnValue(false);
  const onClose = vi.fn();
  render(
    <Modal className="confirm" ariaLabel="Guarded" onClose={onClose} beforeClose={beforeClose}>
      <button>Inside</button>
    </Modal>,
  );
  await user.keyboard('{Escape}');
  expect(beforeClose).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Guarded' })).toBeVisible();
  beforeClose.mockReturnValue(true);
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog', { name: 'Guarded' })).toBeNull();
});

test('imperative close respects the same guard and accepted close is reported once', async () => {
  const user = userEvent.setup();
  const ref = createRef<ModalHandle>();
  const beforeClose = vi.fn().mockReturnValue(false);
  const onClose = vi.fn();
  render(
    <Modal ref={ref} className="confirm" onClose={onClose} beforeClose={beforeClose}>
      <button
        onClick={() => {
          ref.current?.close();
          ref.current?.close();
        }}
      >
        Close
      </button>
    </Modal>,
  );
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).not.toHaveBeenCalled();
  beforeClose.mockReturnValue(true);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('portalled dialogs preserve only their owning component stylesheet scope', () => {
  const { rerender } = render(
    <ComponentStyleScope.Provider value="release-editor">
      <Modal className="confirm" ariaLabel="Scoped" onClose={vi.fn()}>
        <p>Scoped editor</p>
      </Modal>
    </ComponentStyleScope.Provider>,
  );
  expect(screen.getByRole('dialog')).toHaveAttribute('data-component', 'release-editor');
  rerender(
    <ComponentStyleScope.Provider value="other-editor">
      <Modal className="confirm" ariaLabel="Scoped" onClose={vi.fn()}>
        <p>Other editor</p>
      </Modal>
    </ComponentStyleScope.Provider>,
  );
  expect(screen.getByRole('dialog')).toHaveAttribute('data-component', 'other-editor');
  rerender(
    <Modal className="confirm" ariaLabel="Platform" onClose={vi.fn()}>
      <p>Platform dialog</p>
    </Modal>,
  );
  expect(screen.getByRole('dialog')).not.toHaveAttribute('data-component');
});

test('a dialog with no label of its own is named by its first heading', async () => {
  render(
    <Modal className="confirm" onClose={vi.fn()}>
      <h2>Delete invoice 7</h2>
      <button>Cancel</button>
    </Modal>,
  );
  expect(await screen.findByRole('dialog', { name: 'Delete invoice 7' })).toBeVisible();
});

test('an explicit label wins over the heading', async () => {
  render(
    <Modal className="confirm" ariaLabel="Own name" onClose={vi.fn()}>
      <h2>Heading</h2>
    </Modal>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Own name' });
  expect(dialog).not.toHaveAttribute('aria-labelledby');
});

test('a modal needs no class: the box is placed by `modal` alone and the scrim is the plain one', () => {
  render(
    <Modal ariaLabel="Bare" onClose={vi.fn()}>
      <p>Body</p>
    </Modal>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Bare' });
  expect(dialog.className.split(' ')).toContain('modal');
  expect(document.querySelector('.modal-backdrop')?.className).toBe('modal-backdrop');
});
