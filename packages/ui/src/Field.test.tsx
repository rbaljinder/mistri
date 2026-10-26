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
  expect(container.querySelector('.form-field')).toHaveClass('is-required');
  expect(screen.getByLabelText('Name')).toBe(input);
});

test('the optional word stands beside the label of a field that is not required, and the label keeps its name', () => {
  const { container } = render(
    <>
      <Field label="Phone" optionalWord="(optional)">
        <input className="field-control" />
      </Field>
      <Field label="Name" required optionalWord="(optional)">
        <input className="field-control" />
      </Field>
    </>,
  );
  const words = container.querySelectorAll('.form-field-optional-word');
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
            onChange={() => {}}
            items={[{ value: 'design', label: 'Design' }]}
          />
        )
      }
    </Field>,
  );
  const trigger = screen.getByRole('button', { name: 'Team' });
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
  expect(document.querySelector('label.form-field-label')).toBeNull();
});
