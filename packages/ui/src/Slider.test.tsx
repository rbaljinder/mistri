import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Slider } from './Slider.js';

afterEach(cleanup);

function Budget({ format }: { format?: (n: number) => string }) {
  const [value, set] = useState(400);
  return <Slider label="Monthly budget" min={150} max={1000} step={10} value={value} onChange={set} format={format} />;
}

test('the native range is named by the label, says its value in words, and reads out in the box', () => {
  render(<Budget format={(n) => `$${n}`} />);
  const range = screen.getByRole('slider', { name: 'Monthly budget' });
  expect(range).toHaveAttribute('aria-valuetext', '$400');
  expect(range).toHaveAttribute('min', '150');
  expect(document.querySelector('.field-readout')).toHaveTextContent('$400');
  expect(document.querySelector('.field-range-ends')).toHaveTextContent('$150$1000');
  expect(range).toHaveStyle({ '--range-share': '29.41176470588235%' });
});

test('numbers are grouped by default, a change reports a number, and it is the native range', () => {
  render(<Budget />);
  const range = screen.getByRole('slider') as HTMLInputElement;
  fireEvent.change(range, { target: { value: '1000' } });
  expect(range.value).toBe('1000');
  expect(document.querySelector('.field-readout')).toHaveTextContent('1,000');
  // The arrows, Home and End are the native range's: the control adds no key handling of its own.
  expect(range.type).toBe('range');
  range.focus();
  expect(range).toHaveFocus();
});
