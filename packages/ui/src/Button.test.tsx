/** The Button primitive: an intent's classes, and busy that keeps the focus. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button, buttonClass, type ButtonIntent, type ButtonSize } from './Button.js';

afterEach(cleanup);

test('every intent and size is one button with one class of its own', () => {
  const intents: ButtonIntent[] = ['primary', 'secondary', 'quiet', 'danger'];
  const sizes: ButtonSize[] = ['compact', 'default', 'large'];
  render(
    <>
      {intents.flatMap((intent) =>
        sizes.map((size) => <Button key={`${intent}-${size}`} intent={intent} size={size}>{`${intent} ${size}`}</Button>),
      )}
    </>,
  );
  for (const intent of intents)
    for (const size of sizes) {
      const button = screen.getByRole('button', { name: `${intent} ${size}` });
      expect(button).toHaveClass('btn', `btn-${intent}`);
      if (size !== 'default') expect(button).toHaveClass(`btn-${size}`);
    }
});

test('each intent wears the class the looks already dress, beside its own', () => {
  expect(buttonClass({ intent: 'primary' }).split(' ')).toEqual(expect.arrayContaining(['btn', 'primary', 'btn-primary']));
  expect(buttonClass({ intent: 'secondary' }).split(' ')).toEqual(expect.arrayContaining(['btn', 'ghost']));
  expect(buttonClass({ intent: 'danger' }).split(' ')).toEqual(expect.arrayContaining(['btn', 'danger']));
  // Quiet is a word in the link ink, not the outlined secondary.
  expect(buttonClass({ intent: 'quiet' }).split(' ')).not.toContain('ghost');
  expect(buttonClass({ size: 'large', block: true, className: 'x' })).toMatch(/btn-large.*btn-block.*x/);
  expect(buttonClass({ size: 'default' })).not.toMatch(/btn-default/);
});

test('a button is a plain button unless it says it submits', () => {
  render(
    <form>
      <Button>Cancel</Button>
      <Button type="submit" intent="primary">
        Save
      </Button>
    </form>,
  );
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
});

test('busy says so, keeps the focus, and refuses the press and the submission it would make', () => {
  const pressed = vi.fn();
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const { rerender } = render(
    <form onSubmit={(e) => submitted(e.nativeEvent)}>
      <Button type="submit" intent="primary" busy busyLabel="Saving…" onClick={pressed}>
        Save
      </Button>
    </form>,
  );
  const button = screen.getByRole('button', { name: 'Saving…' });
  button.focus();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  expect(pressed).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
  rerender(
    <form onSubmit={(e) => submitted(e.nativeEvent)}>
      <Button type="submit" intent="primary" busyLabel="Saving…" onClick={pressed}>
        Save
      </Button>
    </form>,
  );
  const ready = screen.getByRole('button', { name: 'Save' });
  expect(ready).not.toHaveAttribute('aria-disabled');
  fireEvent.click(ready);
  expect(pressed).toHaveBeenCalledTimes(1);
  expect(submitted).toHaveBeenCalledTimes(1);
});

test('a toggle says it is pressed; a disabled button is disabled', () => {
  render(
    <>
      <Button aria-pressed="true">Show archived</Button>
      <Button disabled>Archive</Button>
    </>,
  );
  expect(screen.getByRole('button', { name: 'Show archived' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
});
