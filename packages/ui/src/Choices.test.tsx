/** Yes/No, cards, checkbox and consent: native radios and checkboxes under their faces, so the keyboard is the browser's. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { Checkbox, ChoiceCards, Consent, YesNo } from './Choices.js';

afterEach(cleanup);

function Question({ start = '' as 'yes' | 'no' | '' }) {
  const [value, set] = useState(start);
  return <YesNo label="Do you own a home?" value={value} onChange={set} yes="Yes" no="No" problem={value ? undefined : 'Answer this.'} />;
}

test('the question names a radiogroup of two radios', () => {
  render(<Question />);
  const group = screen.getByRole('radiogroup', { name: 'Do you own a home?' });
  expect(group).toHaveAttribute('aria-invalid', 'true');
  expect(group).toHaveAccessibleDescription('Answer this.');
  expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
});

test('choosing and the arrow keys move the answer, and the chosen face says so', async () => {
  const user = userEvent.setup();
  render(<Question />);
  await user.click(screen.getByRole('radio', { name: 'Yes' }));
  expect(screen.getByRole('radio', { name: 'Yes' })).toBeChecked();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio', { name: 'No' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'No' }).closest('label')).toHaveClass('is-on');
  expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-invalid');
});

const kinds = [
  { value: 'car', label: 'Car', icon: <svg data-testid="car" /> },
  { value: 'truck', label: 'Truck' },
  { value: 'none', label: 'None of these' },
];

test('single cards are a radiogroup; one choice replaces the last', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function One() {
    const [value, set] = useState<string[]>([]);
    return (
      <ChoiceCards
        label="Vehicle"
        labelHidden
        options={kinds}
        value={value}
        onChange={(v) => {
          change(v);
          set(v);
        }}
      />
    );
  }
  render(<One />);
  expect(screen.getByRole('radiogroup', { name: 'Vehicle' })).toBeInTheDocument();
  expect(screen.getByTestId('car').parentElement).toHaveAttribute('aria-hidden', 'true');
  await user.click(screen.getByRole('radio', { name: 'Car' }));
  await user.click(screen.getByRole('radio', { name: 'Truck' }));
  expect(change).toHaveBeenLastCalledWith(['truck']);
});

test('several cards are a group of checkboxes; the exclusive card clears the rest and is cleared by them', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function Many() {
    const [value, set] = useState<string[]>([]);
    return (
      <ChoiceCards
        label="Vehicles"
        multiple
        exclusive="none"
        options={kinds}
        value={value}
        onChange={(v) => {
          change(v);
          set(v);
        }}
      />
    );
  }
  render(<Many />);
  expect(screen.getByRole('group', { name: 'Vehicles' })).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Truck' }));
  await user.click(screen.getByRole('checkbox', { name: 'Car' }));
  expect(change).toHaveBeenLastCalledWith(['car', 'truck']);
  await user.click(screen.getByRole('checkbox', { name: 'None of these' }));
  expect(change).toHaveBeenLastCalledWith(['none']);
  await user.click(screen.getByRole('checkbox', { name: 'Car' }));
  expect(change).toHaveBeenLastCalledWith(['car']);
});

test('a checkbox is named by its text, which is a click target, and Space toggles it', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function Agree() {
    const [on, set] = useState(false);
    return (
      <Checkbox
        label="Email me updates"
        checked={on}
        onChange={(v) => {
          change(v);
          set(v);
        }}
      />
    );
  }
  render(<Agree />);
  await user.click(screen.getByText('Email me updates'));
  expect(change).toHaveBeenLastCalledWith(true);
  screen.getByRole('checkbox', { name: 'Email me updates' }).focus();
  await user.keyboard(' ');
  expect(change).toHaveBeenLastCalledWith(false);
});

test('a consent is a checkbox whose long paragraph is the label, in its own class, with a problem in its description', () => {
  render(<Consent label="I agree to the terms and the privacy notice." checked={false} onChange={() => {}} problem="Required." />);
  const box = screen.getByRole('checkbox', { name: 'I agree to the terms and the privacy notice.' });
  expect(box).toHaveAccessibleDescription('Required.');
  expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(document.querySelector('.form-field-consent')).toBeInTheDocument();
});

test('several cards are one Tab stop: the arrows move, Space toggles, and each says aria-checked', async () => {
  const user = userEvent.setup();
  function Many() {
    const [value, set] = useState<string[]>(['truck']);
    return <ChoiceCards label="Vehicles" multiple exclusive="none" options={kinds} value={value} onChange={set} />;
  }
  render(<Many />);
  const boxes = screen.getAllByRole('checkbox');
  // The Tab stop starts on the first card that is on.
  expect(boxes.map((box) => box.tabIndex)).toEqual([-1, 0, -1]);
  expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  await user.tab();
  expect(boxes[1]).toHaveFocus();
  await user.keyboard('{ArrowLeft} ');
  expect(boxes[0]).toHaveFocus();
  expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false']);
  await user.keyboard('{ArrowRight}{ArrowRight} ');
  expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
});
