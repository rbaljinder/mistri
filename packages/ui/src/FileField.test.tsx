/** The file picker of a form: named by its label, its hint and problem described, and the chosen file handed up. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { FileField } from './FileField.js';
import type { ChangeDetails } from './changeDetails.js';

afterEach(cleanup);

function Picker({ onPick = () => {} }: { onPick?: (file: File | null, details: ChangeDetails) => void }) {
  const [file, set] = useState<File | null>(null);
  return (
    <>
      <FileField
        label="Contacts"
        hint="A CSV."
        accept=".csv"
        value={file}
        onChange={(f, details) => {
          onPick(f, details);
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
  expect(input).toHaveClass('field-file-input');
  expect(input).toHaveAccessibleDescription('A CSV.');
});

test('the chosen File is handed up, and setting the value to null clears the input', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<Picker onPick={pick} />);
  const input = screen.getByLabelText<HTMLInputElement>('Contacts');
  const file = new File(['a,b\n1,2'], 'people.csv', { type: 'text/csv' });
  await user.upload(input, file);
  expect(pick).toHaveBeenLastCalledWith(file, expect.objectContaining({ reason: 'file-pick' }));
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

test('with `multiple` the whole choice is handed up as a list, and an empty list clears the input', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  function Many() {
    const [files, set] = useState<File[]>([]);
    return (
      <>
        <FileField
          label="Exports"
          multiple
          value={files}
          onChange={(next, details) => {
            pick(next, details);
            set(next);
          }}
        />
        <button type="button" onClick={() => set([])}>
          Clear
        </button>
      </>
    );
  }
  render(<Many />);
  const input = screen.getByLabelText<HTMLInputElement>('Exports');
  expect(input).toHaveAttribute('multiple');
  const a = new File(['1'], 'a.csv', { type: 'text/csv' });
  const b = new File(['2'], 'b.csv', { type: 'text/csv' });
  await user.upload(input, [a, b]);
  expect(pick).toHaveBeenLastCalledWith([a, b], expect.anything());
  expect(input.files).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(input.files).toHaveLength(0);
});

test('without `multiple` the input takes one file', () => {
  render(<FileField label="Contacts" value={null} onChange={() => {}} />);
  expect(screen.getByLabelText('Contacts')).not.toHaveAttribute('multiple');
});

test('it is drawn with the kit button and the chosen names, not the browser’s own button and words', async () => {
  const user = userEvent.setup();
  const { container } = render(<Picker />);
  const button = container.querySelector<HTMLButtonElement>('.field-file-button')!;
  expect(button).toHaveClass('btn', 'btn-secondary');
  expect(button).toHaveTextContent('Choose file');
  // Out of the tab order and the tree: the input is the one control for the keyboard and for assistive technology.
  expect(button).toHaveAttribute('tabindex', '-1');
  expect(button).toHaveAttribute('aria-hidden', 'true');
  const names = container.querySelector('.field-file-names')!;
  expect(names).toHaveTextContent('No file chosen');
  await user.upload(screen.getByLabelText('Contacts'), new File(['a'], 'people.csv', { type: 'text/csv' }));
  expect(names).toHaveTextContent('people.csv');
  expect(names).not.toHaveClass('is-none');
});

test('the button opens the file dialog through the input', async () => {
  const user = userEvent.setup();
  const { container } = render(<Picker />);
  const open = vi.spyOn(screen.getByLabelText<HTMLInputElement>('Contacts'), 'click');
  await user.click(container.querySelector('.field-file-button')!);
  expect(open).toHaveBeenCalledOnce();
});

test('the input stays in the tab order, so a keyboard reader reaches the field', async () => {
  const user = userEvent.setup();
  render(<Picker />);
  await user.tab();
  expect(screen.getByLabelText('Contacts')).toHaveFocus();
});

test('the words are the caller’s to say, for another language', () => {
  const { container } = render(
    <FileField label="Exports" multiple value={[]} onChange={() => {}} chooseLabel="Elegir archivos" noneLabel="Ninguno" />,
  );
  expect(container.querySelector('.field-file-button')).toHaveTextContent('Elegir archivos');
  expect(container.querySelector('.field-file-names')).toHaveTextContent('Ninguno');
});

test('several chosen files are named together', async () => {
  const user = userEvent.setup();
  function Many() {
    const [files, set] = useState<File[]>([]);
    return <FileField label="Exports" multiple value={files} onChange={set} />;
  }
  const { container } = render(<Many />);
  expect(container.querySelector('.field-file-button')).toHaveTextContent('Choose files');
  await user.upload(screen.getByLabelText('Exports'), [new File(['1'], 'a.csv'), new File(['2'], 'b.csv')]);
  expect(container.querySelector('.field-file-names')).toHaveTextContent('a.csv, b.csv');
});
