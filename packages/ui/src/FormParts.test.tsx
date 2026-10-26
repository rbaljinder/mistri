import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ActionBar, Columns, HelpTip, ProgressBar, ReviewList, StepHeader } from './FormParts.js';

afterEach(cleanup);

test('a tip opens on the button, describes it, and closes on Escape with the focus kept', async () => {
  const user = userEvent.setup();
  render(<HelpTip text="We use this to size an offer." label="More information" />);
  const button = screen.getByRole('button', { name: 'More information' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  await user.click(button);
  const tip = screen.getByRole('tooltip');
  expect(button).toHaveAccessibleDescription('We use this to size an offer.');
  expect(tip).toHaveTextContent('We use this to size an offer.');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(button).toHaveFocus();
});

test('a press elsewhere closes the tip; a lent picture replaces the i', async () => {
  const user = userEvent.setup();
  render(
    <>
      <HelpTip text="Tip" label="Info" icon={<svg data-testid="own" />} />
      <p>elsewhere</p>
    </>,
  );
  expect(screen.getByTestId('own')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Info' }));
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  await user.click(screen.getByText('elsewhere'));
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('the progress bar is a progressbar with its range, or hidden when decorative', () => {
  const { rerender } = render(<ProgressBar value={3} max={12} label="Step 3 of 12" />);
  const bar = screen.getByRole('progressbar', { name: 'Step 3 of 12' });
  expect(bar).toHaveAttribute('aria-valuenow', '3');
  expect(bar).toHaveAttribute('aria-valuemax', '12');
  expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
  rerender(<ProgressBar value={3} max={12} decorative />);
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('a step header is one h1 with its lead and a decorative mark', () => {
  render(<StepHeader title="Income" lead="Tell us what you earn." mark={<i data-testid="mark" />} />);
  expect(screen.getByRole('heading', { level: 1, name: 'Income' })).toBeInTheDocument();
  expect(screen.getByText('Tell us what you earn.')).toBeInTheDocument();
  expect(screen.getByTestId('mark').parentElement).toHaveAttribute('aria-hidden', 'true');
});

test('the action bar runs Back and the primary, and a busy primary refuses a second press', async () => {
  const user = userEvent.setup();
  const back = vi.fn();
  const next = vi.fn();
  const { rerender } = render(<ActionBar back={{ label: 'Back', onClick: back }} primary={{ label: 'Continue', onClick: next }} />);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(back).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
  rerender(<ActionBar primary={{ label: 'Continue', onClick: next, busy: true, busyLabel: 'Sending…' }} />);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Sending…' }));
  expect(next).toHaveBeenCalledTimes(1);
});

test('a disabled primary cannot be pressed', async () => {
  const user = userEvent.setup();
  const next = vi.fn();
  render(<ActionBar primary={{ label: 'Continue', onClick: next, disabled: true }} />);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(next).not.toHaveBeenCalled();
});

test('columns carry their template and a review is one labelled group', () => {
  render(
    <>
      <Columns cols="1fr 1.8fr">
        <span>a</span>
        <span>b</span>
      </Columns>
      <ReviewList label="Your answers">
        <span>c</span>
      </ReviewList>
    </>,
  );
  expect(document.querySelector('.form-columns')).toHaveStyle({ '--form-columns': '1fr 1.8fr' });
  expect(screen.getByRole('group', { name: 'Your answers' })).toBeInTheDocument();
});
