/** The file picker of a form: named by its label, its hint and problem described, and the chosen file handed up. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { FileField } from './FileField.js';

afterEach(cleanup);

function Picker({ onPick = () => {} }: { onPick?: (file: File | null) => void }) {
  const [file, set] = useState<File | null>(null);
  return (
    <>
      <FileField
        label="Contacts"
        hint="A CSV."
        accept=".csv"
        value={file}
        onChange={(f) => {
          onPick(f);
          set(f);
        }}
      />
      <button type="button" onClick={() => set(null)}>
        Clear
      </button>
    </>
  );
}

test('the input is named by the label, takes the accept list and is described by the hint', () => {
  render(<Picker />);
  const input = screen.getByLabelText('Contacts');
  expect(input).toHaveAttribute('type', 'file');
  expect(input).toHaveAttribute('accept', '.csv');
  expect(input).toHaveClass('field-control');
  expect(input).toHaveAccessibleDescription('A CSV.');
});

test('the chosen File is handed up, and setting the value to null clears the input', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<Picker onPick={pick} />);
  const input = screen.getByLabelText<HTMLInputElement>('Contacts');
  const file = new File(['a,b\n1,2'], 'people.csv', { type: 'text/csv' });
  await user.upload(input, file);
  expect(pick).toHaveBeenLastCalledWith(file);
  expect(input.files?.[0]).toBe(file);
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(input.files).toHaveLength(0);
});

test('a problem marks it invalid and joins its description; disabled is the input’s own', () => {
  render(<FileField label="Contacts" value={null} onChange={() => {}} problem="Choose a file." disabled />);
  const input = screen.getByLabelText('Contacts');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription('Choose a file.');
  expect(input).toBeDisabled();
});
