import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { useEditInteraction } from './editInteraction.js';

let epoch = 0;
const save = vi.fn();
const cancel = vi.fn();
function Field({
  enabled = true,
  portal = false,
  open = false,
  owner = 'record',
}: {
  enabled?: boolean;
  portal?: boolean;
  open?: boolean;
  owner?: string;
}) {
  const interaction = useEditInteraction({
    enabled,
    owner,
    onCancel: cancel,
    captureGuard: (current) => {
      const captured = epoch;
      return () => captured === epoch && current();
    },
    onLeave: (guard) => {
      if (guard()) save();
    },
  });
  interaction.onOpenChange(open);
  return (
    <div ref={interaction.root} data-edit-field="">
      <input aria-label="Edit" onChange={interaction.changed} />
      {portal &&
        createPortal(
          <div ref={interaction.popupRef}>
            <button>Option</button>
          </div>,
          document.body,
        )}
    </div>
  );
}
function draw(props: { enabled?: boolean; portal?: boolean; open?: boolean } = {}) {
  return render(
    <>
      <Field {...props} />
      <div data-edit-field="">
        <input aria-label="Next field" />
      </div>
      <button>Discard</button>
      <a href="#next">Navigate</a>
      <div tabIndex={-1}>Background</div>
    </>,
  );
}
const focus = (name: string) => act(() => screen.getByLabelText(name).focus());
const edit = () => {
  focus('Edit');
  fireEvent.change(screen.getByLabelText('Edit'), { target: { value: 'Changed' } });
};
const settle = () => act(() => vi.runOnlyPendingTimers());
beforeEach(() => {
  vi.useFakeTimers();
  epoch++;
  save.mockClear();
  cancel.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('fresh value change and leaving for another field saves exactly once', () => {
  draw();
  edit();
  settle();
  expect(save).not.toHaveBeenCalled();
  focus('Next field');
  settle();
  settle();
  expect(save).toHaveBeenCalledTimes(1);
  focus('Edit');
  focus('Next field');
  settle();
  expect(save).toHaveBeenCalledTimes(1);
});

test('mounting, focusing, and popup closure never arm a write', () => {
  const view = draw({ portal: true, open: true });
  focus('Edit');
  focus('Next field');
  settle();
  view.rerender(<Field portal open={false} />);
  settle();
  expect(save).not.toHaveBeenCalled();
});

test('portalled focus and a held pointer remain owned until focus actually leaves', () => {
  const view = draw({ portal: true, open: true });
  edit();
  const option = screen.getByRole('button', { name: 'Option' });
  fireEvent.pointerDown(option);
  act(() => option.focus());
  settle();
  fireEvent.pointerUp(option);
  settle();
  expect(save).not.toHaveBeenCalled();
  focus('Edit');
  view.rerender(
    <>
      <Field portal open={false} />
      <div data-edit-field="">
        <input aria-label="Next field" />
      </div>
    </>,
  );
  settle();
  expect(save).not.toHaveBeenCalled();
  focus('Next field');
  settle();
  expect(save).toHaveBeenCalledTimes(1);
});

test('another field pointer holds settlement until pointer-up', () => {
  draw();
  edit();
  fireEvent.pointerDown(screen.getByLabelText('Next field'));
  focus('Next field');
  settle();
  expect(save).not.toHaveBeenCalled();
  fireEvent.pointerUp(screen.getByLabelText('Next field'));
  settle();
  expect(save).toHaveBeenCalledTimes(1);
});

test.each(['Discard', 'Navigate'])('outside %s cancels before delayed pointer-up/click', (name) => {
  draw();
  edit();
  const target = screen.getByText(name);
  fireEvent.pointerDown(target);
  act(() => target.focus());
  settle();
  expect(save).not.toHaveBeenCalled();
  fireEvent.pointerUp(target);
  fireEvent.click(target);
  settle();
  focus('Edit');
  focus('Next field');
  settle();
  expect(save).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});

test('Escape in any layer cancels a different field awaiting settlement', () => {
  draw();
  edit();
  focus('Next field');
  fireEvent.keyDown(screen.getByLabelText('Next field'), { key: 'Escape' });
  settle();
  expect(save).not.toHaveBeenCalled();
});

test('keyboard focus on an outside action cancels before its activation', () => {
  draw();
  edit();
  act(() => screen.getByText('Discard').focus());
  settle();
  fireEvent.keyDown(screen.getByText('Discard'), { key: 'Enter' });
  settle();
  expect(save).not.toHaveBeenCalled();
});

test('actual focus overrides a misleading relatedTarget', () => {
  draw();
  edit();
  fireEvent.focusOut(screen.getByLabelText('Edit'), { relatedTarget: screen.getByLabelText('Next field') });
  settle();
  expect(save).not.toHaveBeenCalled();
});

test.each(['unmount', 'disabled', 'owner'] as const)('%s invalidates already scheduled work', (reason) => {
  const view = draw();
  edit();
  focus('Next field');
  if (reason === 'unmount') view.unmount();
  if (reason === 'disabled') view.rerender(<Field enabled={false} />);
  if (reason === 'owner') epoch++;
  settle();
  expect(save).not.toHaveBeenCalled();
});

test('popup closure cannot recapture a retired owner while waiting for the pointer', () => {
  const view = draw({ portal: true, open: true });
  edit();
  fireEvent.pointerDown(screen.getByLabelText('Next field'));
  focus('Next field');
  settle();
  epoch++;
  view.rerender(
    <>
      <Field portal open={false} />
      <div data-edit-field="">
        <input aria-label="Next field" />
      </div>
    </>,
  );
  fireEvent.pointerUp(screen.getByLabelText('Next field'));
  settle();
  expect(save).not.toHaveBeenCalled();
});

test('reusing a mounted field for a replacement owner requires a fresh value change', () => {
  const view = draw();
  edit();
  view.rerender(
    <>
      <Field owner="replacement" />
      <div data-edit-field="">
        <input aria-label="Next field" />
      </div>
    </>,
  );
  focus('Next field');
  settle();
  expect(save).not.toHaveBeenCalled();
  focus('Edit');
  fireEvent.change(screen.getByLabelText('Edit'), { target: { value: 'New owner edit' } });
  focus('Next field');
  settle();
  expect(save).toHaveBeenCalledTimes(1);
});
