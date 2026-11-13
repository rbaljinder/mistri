/** The several-line box: the same frame as a TextField, a textarea in it. */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { TextArea } from './TextArea.js';

afterEach(cleanup);

function Typed(props: { problem?: string }) {
  const [value, set] = useState('');
  return <TextArea label="Notes" hint="What happened." value={value} onChange={set} problem={props.problem} rows={5} />;
}

test('the label names the box, typing reports the text across lines, and the box is the field control', async () => {
  const user = userEvent.setup();
  render(<Typed />);
  const box = screen.getByRole('textbox', { name: 'Notes' });
  expect(box.tagName).toBe('TEXTAREA');
  expect(box).toHaveClass('field-control');
  expect(box).toHaveAttribute('rows', '5');
  expect(box).toHaveAttribute('autocomplete', 'off');
  await user.type(box, 'one{Enter}two');
  expect(box).toHaveValue('one\ntwo');
});

test('a hint and a problem are wired in as they are on a TextField', () => {
  render(<Typed problem="Say more." />);
  const box = screen.getByRole('textbox', { name: 'Notes' });
  expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(box).toHaveAccessibleDescription('What happened. Say more.');
});
