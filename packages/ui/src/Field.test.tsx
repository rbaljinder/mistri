/** The Field primitive: the label, hint and problem wired into the control, so no form joins them by hand. */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Field, type FieldControlProps } from './Field.js';
import { Dropdown } from './Dropdown.js';

afterEach(cleanup);

test('the label names the control; the hint describes it', () => {
  render(
    <Field label="Project name" hint="Shown to everyone on the team.">
      <input className="field-control" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Project name' });
  expect(input).toHaveAccessibleDescription('Shown to everyone on the team.');
  expect(input).not.toHaveAttribute('aria-invalid');
});

test('a problem marks the control invalid and joins its description, after the hint', () => {
  const { rerender } = render(
    <Field label="Email" hint="The one you sign in with." problem="Enter an email address, like name@example.com.">
      <input className="field-control" aria-describedby="elsewhere" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Email' });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  // The control's own description is kept, the field's joined to it.
  expect(input.getAttribute('aria-describedby')!.split(' ')[0]).toBe('elsewhere');
  expect(input).toHaveAccessibleDescription('The one you sign in with. Enter an email address, like name@example.com.');
  rerender(
    <Field label="Email" hint="The one you sign in with.">
      <input className="field-control" />
    </Field>,
  );
  expect(input).not.toHaveAttribute('aria-invalid');
  expect(input).toHaveAccessibleDescription('The one you sign in with.');
});

test('required says so to assistive technology, and its star is not part of the name', () => {
  const { container } = render(
    <Field label="Name" required>
      <input className="field-control" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Name' });
  expect(input).toHaveAttribute('aria-required', 'true');
  // The field says it too, for the stylesheet's mark.
  expect(container.querySelector('[data-slot="field"]')).toHaveAttribute('data-required');
  expect(screen.getByLabelText('Name')).toBe(input);
});

test('the optional word stands beside the label of a field that is not required, and the label keeps its name', () => {
  const { container } = render(
    <>
      <Field label="Phone" optional="(optional)">
        <input className="field-control" />
      </Field>
      <Field label="Name" required optional="(optional)">
        <input className="field-control" />
      </Field>
    </>,
  );
  const words = container.querySelectorAll('[data-slot="field-optional"]');
  expect(words).toHaveLength(1);
  expect(words[0]).toHaveTextContent('(optional)');
  expect(words[0]!.closest('label')).toBeNull();
  // The name is the label's alone, and aria-required is untouched either way.
  expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-required');
  expect(screen.getByLabelText('Name')).toHaveAttribute('aria-required', 'true');
});

test('a control of several parts takes the wiring through a function', () => {
  let handed: FieldControlProps | undefined;
  render(
    <Field label="Team" problem="Choose a team.">
      {(control) =>
        (handed = control) && (
          <Dropdown
            id={control.id}
            ariaLabel="Team"
            ariaInvalid={control['aria-invalid']}
            ariaDescribedBy={control['aria-describedby']}
            value="design"
            onValueChange={() => {}}
            items={[{ value: 'design', label: 'Design' }]}
          />
        )
      }
    </Field>,
  );
  const trigger = screen.getByRole('button', { name: /^Team\b/ });
  // The label's `for` reaches the listbox's button: the id is the one the field handed over.
  expect(trigger).toHaveAttribute('id', handed!.id);
  expect(trigger).toHaveAttribute('aria-invalid', 'true');
  expect(trigger).toHaveAccessibleDescription('Choose a team.');
});

test('a group names its control by the caption rather than a <label>', () => {
  render(
    <Field label="Equipment" group>
      {(control) => (
        <div role="radiogroup" aria-labelledby={control['aria-labelledby']}>
          <label>
            <input type="radio" name="e" />
            Laptop
          </label>
        </div>
      )}
    </Field>,
  );
  expect(screen.getByRole('radiogroup', { name: 'Equipment' })).toBeInTheDocument();
  expect(document.querySelector('label[data-slot="field-label"]')).toBeNull();
});

test('a short answer says its kind, for the form to size and row it by the data; text says none', () => {
  const { container } = render(
    <>
      <Field label="Seats" kind="number">
        <input className="field-control" />
      </Field>
      <Field label="Starts" kind="datetime">
        <input className="field-control" />
      </Field>
      <Field label="Title">
        <input className="field-control" />
      </Field>
    </>,
  );
  // Said as `data-answer`: `data-kind` is the stylesheet's word for which shape of a slot this is.
  const fields = [...container.querySelectorAll('[data-slot="field"]')];
  expect(fields.map((field) => field.getAttribute('data-answer'))).toEqual(['number', 'datetime', null]);
});

test('a check field draws the box and its words in one row, the words naming the box', () => {
  const { container } = render(
    <Field label="I accept the terms" check>
      <input type="checkbox" />
    </Field>,
  );
  const row = container.querySelector('[data-slot="field-check-row"]')!;
  const box = screen.getByRole('checkbox', { name: 'I accept the terms' });
  const label = row.querySelector('[data-slot="field-label"]')!;
  // Both are the row's own children, the box first, so the stylesheet lines them up on one row.
  expect(row.children[0]).toBe(box);
  expect(row.children[1]).toBe(label);
  expect(container.querySelector('[data-slot="field"]')).toHaveAttribute('data-kind', 'check');
});
