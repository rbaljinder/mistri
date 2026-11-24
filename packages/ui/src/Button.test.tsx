/** The Button primitive: canonical variant and size attributes, and loading that keeps the focus. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button, buttonClass, type ButtonSize, type ButtonVariant } from './Button.js';

afterEach(cleanup);

test('every variant and size is one button part with canonical data-variant and data-size attributes', () => {
  const variants: ButtonVariant[] = ['primary', 'secondary', 'soft', 'outline', 'ghost', 'danger', 'danger-soft'];
  const sizes: ButtonSize[] = ['xs', 'sm', 'md', 'lg'];
  render(
    <>
      {variants.flatMap((variant) =>
        sizes.map((size) => (
          <Button key={`${variant}-${size}`} variant={variant} size={size}>
            {`${variant} ${size}`}
          </Button>
        )),
      )}
    </>,
  );
  const expectedVariant: Record<ButtonVariant, string | null> = {
    primary: 'solid',
    secondary: null,
    soft: 'soft',
    outline: 'outline',
    ghost: 'quiet',
    danger: 'destructive',
    'danger-soft': 'danger-soft',
  };
  const expectedSize: Record<ButtonSize, string | null> = { xs: 'xs', sm: 'sm', md: null, lg: 'lg' };
  for (const variant of variants)
    for (const size of sizes) {
      const button = screen.getByRole('button', { name: `${variant} ${size}` });
      expect(button).toHaveAttribute('data-slot', 'button');
      expect(button.getAttribute('data-variant')).toBe(expectedVariant[variant]);
      expect(button.getAttribute('data-size')).toBe(expectedSize[size]);
    }
});

test('buttonClass maps variant, size, and block onto canonical utility classes', () => {
  expect(buttonClass({ variant: 'primary' }).split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-button-primary']));
  expect(buttonClass({ variant: 'secondary' }).split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-button-secondary']));
  expect(buttonClass({ variant: 'danger' }).split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-button-danger']));
  expect(buttonClass({ variant: 'ghost' }).split(' ')).not.toContain('ui-button-secondary');
  expect(buttonClass({ size: 'lg', block: true, className: 'x' })).toMatch(/ui-button-lg.*ui-button-block.*x/);
  expect(buttonClass({ size: 'md' })).not.toMatch(/ui-button-md/);
});

test('a button is a plain button unless it says it submits', () => {
  render(
    <form>
      <Button>Cancel</Button>
      <Button type="submit" variant="primary">
        Save
      </Button>
    </form>,
  );
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
});

test('loading says so, keeps the focus, and refuses the press and the submission it would make', () => {
  const pressed = vi.fn();
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const { rerender } = render(
    <form onSubmit={(e) => submitted(e.nativeEvent)}>
      <Button type="submit" variant="primary" loading loadingLabel="Saving…" onClick={pressed}>
        Save
      </Button>
    </form>,
  );
  const button = screen.getByRole('button', { name: 'Saving…' });
  button.focus();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  expect(pressed).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
  rerender(
    <form onSubmit={(e) => submitted(e.nativeEvent)}>
      <Button type="submit" variant="primary" loadingLabel="Saving…" onClick={pressed}>
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
