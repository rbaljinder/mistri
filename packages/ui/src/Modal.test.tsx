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
  // The box wears the caller's class and nothing else; how much of the screen it takes is said on it.
  expect(dialog.className).toBe('confirm');
  expect(dialog).toHaveAttribute('data-fullscreen', fullscreen === true ? 'always' : 'mobile');
});

test('a named cross closes the box, stands last in it, and steps aside while the caller’s own button says its word', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const view = render(
    <Modal className="confirm" ariaLabel="Add charge" closeLabel="Close" onClose={onClose}>
      <h2>Add charge</h2>
      <button>Cancel</button>
    </Modal>,
  );
  const cross = screen.getByRole('button', { name: 'Close' });
  expect(cross).toHaveAttribute('data-slot', 'dialog-close');
  // Last in the box: the first Tab goes to the question, not to the way out.
  expect(screen.getByRole('dialog').lastElementChild).toBe(cross);
  // A form that has finished offers "Close" in its foot: one control of that name, the caller's.
  view.rerender(
    <Modal className="confirm" ariaLabel="Add charge" closeLabel="Close" onClose={onClose}>
      <h2>Add charge</h2>
      <button>Close</button>
    </Modal>,
  );
  await vi.waitFor(() => expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1));
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  view.rerender(
    <Modal className="confirm" ariaLabel="Add charge" closeLabel="Close" onClose={onClose}>
      <h2>Add charge</h2>
      <button>Cancel</button>
    </Modal>,
  );
  await vi.waitFor(() => expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull());
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
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
  expect(dialog).toHaveAttribute('data-kind', 'modal');
  expect(dialog.className).toBe('');
  const scrims = document.querySelectorAll('[data-slot="dialog-backdrop"]');
  expect(scrims).toHaveLength(1);
  expect(scrims[0]!.className).toBe('');
  expect(scrims[0]).not.toHaveAttribute('data-for');
});

test('the scrim says which box it stands behind, by the box’s first class', () => {
  render(
    <Modal className="lightbox wide" ariaLabel="Photo" onClose={vi.fn()}>
      <p>Body</p>
    </Modal>,
  );
  const scrim = document.querySelector('[data-slot="dialog-backdrop"][data-for="lightbox"]');
  expect(scrim).not.toBeNull();
  expect(scrim!.className).toBe('');
});

test('the box takes the focus when what had it is taken off the page', async () => {
  function Stepping({ shown }: { shown: boolean }) {
    return (
      <Modal ariaLabel={shown ? 'First' : 'Second'} onClose={vi.fn()}>
        <h2>Record</h2>
        {shown ? <button>Open</button> : <p>Reading…</p>}
      </Modal>
    );
  }
  const { rerender } = render(<Stepping shown />);
  screen.getByRole('button', { name: 'Open' }).focus();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  // The dialog's name changes in the same render that removes the focused button, as a glance's does when it steps.
  rerender(<Stepping shown={false} />);
  /* At once, not when the box next changes: the watcher over the box is let go and begun again by that same render,
     so it sees nothing of it, and a reader pressing J again would be typing at the page under the glance. */
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Second' }));
});
