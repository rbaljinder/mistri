import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FormSurface, formArrives, type FormPresentation, type FormReceipt } from './FormSurface.js';
import { maskedLast4, sayInput } from './reviewValues.js';

const intake: FormPresentation = {
  id: 'apply',
  label: 'Pre-qualify',
  style: 'intake',
  note: { text: 'Your information is stored securely' },
  submitLabel: 'Submit',
  // The sensitive box is the controls' (their own tests); here an address fills it, so these walk the form's own page.
  prefillable: ['ssn'],
  input: [
    { name: 'first_name', label: 'First name', type: 'text', required: true, maxLength: 60 },
    { name: 'last_name', label: 'Last name', type: 'text', required: true, maxLength: 60 },
    { name: 'nickname', label: 'Nickname', type: 'text', required: false, maxLength: 60 },
    { name: 'ssn', label: 'Social security number', type: 'text', required: true, mask: '000-00-0000', sensitive: { keep: 'last4' } },
  ],
  steps: [
    {
      id: 'name',
      label: 'Name',
      title: "What's your name?",
      lead: 'As on your ID.',
      fields: ['first_name', 'last_name'],
      rows: [['first_name', 'last_name']],
    },
    { id: 'nick', label: 'Nickname', fields: ['nickname'], skip: 'Skip' },
    { id: 'identity', label: 'Identity', title: 'Verify your identity', next: 'Review', fields: ['ssn'] },
  ],
};
const receipt: FormReceipt = { reference: 'PQ-1', receipt: { id: 'r1', status: 'applied' } };

afterEach(cleanup);

const next = async (name: string, then: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
  await waitFor(() => expect(screen.getByRole('progressbar', { name: new RegExp(then) })).toBeInTheDocument());
};

test('an intake form has no eyebrow or form heading, its step title is the h1 and its note stands over the bar', async () => {
  // The stepper and the intake sheets are parts loaded on demand; a public page has them before the form mounts.
  await formArrives(intake);
  const { container } = render(<FormSurface form={intake} appName="Harbor" submit={vi.fn()} />);
  expect(container.querySelector('.eyebrow')).toBeNull();
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: "What's your name?" })).toBeInTheDocument();
  expect(screen.getByText('Your information is stored securely')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Pre-qualify' })).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Step 1 of 4: Name' })).toBeInTheDocument();
});

test("a form's description is said once, on its first step under the title, never over the bar on every step", async () => {
  const described = { ...intake, description: 'It takes about three minutes.' };
  const { container } = render(<FormSurface form={described} appName="Harbor" submit={vi.fn()} />);
  const said = () => screen.queryAllByText('It takes about three minutes.');
  expect(said()).toHaveLength(1);
  // Inside the step, after its heading: not above the progress bar.
  const panel = container.querySelector('.multi-step-panel') as HTMLElement;
  expect(within(panel).getByText('It takes about three minutes.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Mara' } });
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: 'Alder' } });
  await next('Continue', 'Step 2 of 4: Nickname');
  expect(said()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Step 1 of 4: Name' })).toBeInTheDocument());
  expect(said()).toHaveLength(1);
});

test("a stepper's description is its first step's too; a one-page form keeps it under its heading", () => {
  const stepper = { ...intake, style: undefined, description: 'It takes about three minutes.' };
  const { unmount } = render(<FormSurface form={stepper} appName="Harbor" submit={vi.fn()} />);
  expect(screen.getAllByText('It takes about three minutes.')).toHaveLength(1);
  unmount();
  render(<FormSurface form={{ ...stepper, steps: undefined }} appName="Harbor" submit={vi.fn()} />);
  expect(screen.getAllByText('It takes about three minutes.')).toHaveLength(1);
});

test('a row draws its fields side by side', () => {
  const { container } = render(<FormSurface form={intake} appName="Harbor" submit={vi.fn()} />);
  const row = container.querySelector('.form-columns') as HTMLElement;
  expect(row).toBeTruthy();
  expect(within(row).getByLabelText('First name (required)')).toBeInTheDocument();
  expect(within(row).getByLabelText('Last name (required)')).toBeInTheDocument();
});

test('the last page sums up every step, opens a step in place with Change, shows a sensitive answer as its last four, and asks it again', async () => {
  const submit = vi.fn(async () => receipt);
  render(<FormSurface form={intake} appName="Harbor" submit={submit} prefill="ssn=123456789" />);
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Mara' } });
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: 'Alder' } });
  await next('Continue', 'Step 2 of 4: Nickname');
  // Nothing typed here and the step may be skipped: the primary says so.
  expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  await next('Skip', 'Step 3 of 4: Identity');
  await next('Review', 'Step 4 of 4: Review');
  expect(screen.getByRole('heading', { level: 1, name: 'Review your answers' })).toBeInTheDocument();
  // Every step again as a labelled section, its answers summed up.
  for (const label of ['Name', 'Nickname', 'Identity']) expect(screen.getByRole('heading', { level: 2, name: label })).toBeInTheDocument();
  expect(screen.getByText('Mara')).toBeInTheDocument();
  expect(screen.queryByLabelText('First name (required)')).toBeNull();
  expect(screen.getByText('•••-••-6789')).toBeInTheDocument();
  expect(screen.queryByText(/123-45/)).toBeNull();
  // Change opens a step's fields in place, live; then ask for the sensitive answer again.
  fireEvent.click(screen.getByRole('button', { name: 'Change Name' }));
  expect(screen.getByLabelText('First name (required)')).toHaveValue('Mara');
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Maren' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change Identity' }));
  expect(screen.getByText('•••-••-6789')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change Social security number' }));
  expect(screen.queryByText('•••-••-6789')).toBeNull();
  // Cleared: the answer is asked again, and the form does not go on without it.
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Social security number is required.')).toBeInTheDocument());
  expect(submit).not.toHaveBeenCalled();
});

test('the review holds the submit until what it shows is right', async () => {
  const submit = vi.fn(async () => receipt);
  render(
    <FormSurface
      form={{ ...intake, steps: [intake.steps![0], { ...intake.steps![1], fields: ['nickname'] }], input: intake.input.slice(0, 3) }}
      appName="Harbor"
      submit={submit}
    />,
  );
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Mara' } });
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: 'Alder' } });
  await next('Continue', 'Step 2 of 3: Nickname');
  await next('Skip', 'Step 3 of 3: Review');
  fireEvent.click(screen.getByRole('button', { name: 'Change Name' }));
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Last name is required.')).toBeVisible());
  expect(submit).not.toHaveBeenCalled();
});

test('review: false leaves the review out and submits from the last step', async () => {
  const submit = vi.fn(async () => receipt);
  render(<FormSurface form={{ ...intake, review: false }} appName="Harbor" submit={submit} prefill="ssn=123456789" />);
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Mara' } });
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: 'Alder' } });
  await next('Continue', 'Step 2 of 3: Nickname');
  await next('Skip', 'Step 3 of 3: Identity');
  expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
});

test("the server's word on a step marks its field and holds the step", async () => {
  const checkStep = vi.fn(async (id: string) => (id === 'name' ? { last_name: 'We could not accept that name.' } : undefined));
  render(<FormSurface form={intake} appName="Harbor" submit={vi.fn()} checkStep={checkStep} />);
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Mara' } });
  fireEvent.change(screen.getByLabelText('Last name (required)'), { target: { value: 'Alder' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByText('We could not accept that name.')).toBeVisible());
  expect(checkStep).toHaveBeenCalledWith('name', { first_name: 'Mara', last_name: 'Alder' }, ['first_name', 'last_name']);
  expect(screen.getByRole('progressbar', { name: 'Step 1 of 4: Name' })).toBeInTheDocument();
});

test("a stepper's read-only review says a sensitive answer as its last four, never in full", () => {
  const field = intake.input[3];
  expect(sayInput(field, '123456789')).toBe('•••-••-6789');
  expect(maskedLast4('123456789')).toBe('•••••6789');
  expect(maskedLast4('1234')).toBe('••••');
  expect(maskedLast4('12', '000-00-0000')).toBe('••');
});

test('the intake style marks a box left holding an answer its rules take; never while typing, never a wrong one', async () => {
  const contact: FormPresentation = {
    ...intake,
    input: [
      { name: 'email', label: 'Email', type: 'text', format: 'email', required: true, maxLength: 120 },
      { name: 'zip', label: 'Zip', type: 'text', required: true, pattern: '[0-9]{5}' },
    ],
    steps: [{ id: 'contact', label: 'Contact', fields: ['email', 'zip'] }],
  };
  await formArrives(contact);
  const { container } = render(<FormSurface form={contact} appName="Harbor" submit={vi.fn()} />);
  const email = await screen.findByRole('textbox', { name: /^Email/ });
  const markOf = (box: HTMLElement) => box.closest('.field-box')?.querySelector('.field-mark') ?? null;
  // The room for the mark is the box's from the start, so its arriving moves no text.
  expect(email.closest('.field-box.has-mark')).not.toBeNull();
  fireEvent.change(email, { target: { value: 'ada@example.test' } });
  expect(markOf(email)).toBeNull();
  fireEvent.blur(email);
  await waitFor(() => expect(markOf(email)).not.toBeNull());
  expect(markOf(email)).toHaveAttribute('aria-hidden', 'true');
  const zip = screen.getByRole('textbox', { name: /^Zip/ });
  fireEvent.change(zip, { target: { value: '123' } });
  fireEvent.blur(zip);
  expect(markOf(zip)).toBeNull();
  fireEvent.change(zip, { target: { value: '30024' } });
  await waitFor(() => expect(markOf(zip)).not.toBeNull());
  // An answer taken back takes its mark with it.
  fireEvent.change(email, { target: { value: '' } });
  await waitFor(() => expect(markOf(email)).toBeNull());
  expect(container.querySelectorAll('.field-mark')).toHaveLength(1);
});

test('an amount and a text typed through its mask are marked too; a sensitive value keeps its show button there', async () => {
  const money: FormPresentation = {
    ...intake,
    prefillable: [],
    input: [
      { name: 'phone', label: 'Phone', type: 'text', required: true, mask: '000-000-0000' },
      { name: 'down', label: 'Down payment', type: 'money', required: true } as FormPresentation['input'][number],
      { name: 'ssn', label: 'Social security number', type: 'text', required: true, mask: '000-00-0000', sensitive: { keep: 'last4' } },
    ],
    steps: [{ id: 'money', label: 'Money', fields: ['phone', 'down', 'ssn'] }],
  };
  await formArrives(money);
  const { container } = render(<FormSurface form={money} appName="Harbor" submit={vi.fn()} />);
  const phone = await screen.findByRole('textbox', { name: /^Phone/ });
  const down = await screen.findByRole('textbox', { name: /^Down payment/ });
  const markOf = (box: HTMLElement) => box.closest('.field-box')?.querySelector('.field-mark') ?? null;
  expect(phone.closest('.field-box.has-mark')).not.toBeNull();
  expect(down.closest('.field-box.has-mark')).not.toBeNull();
  fireEvent.change(phone, { target: { value: '6786786781' } });
  fireEvent.change(down, { target: { value: '2500' } });
  expect(container.querySelectorAll('.field-mark')).toHaveLength(0);
  fireEvent.blur(phone);
  fireEvent.blur(down);
  await waitFor(() => expect(container.querySelectorAll('.field-mark')).toHaveLength(2));
  expect(markOf(phone)).not.toBeNull();
  expect(markOf(down)).not.toBeNull();
  expect(container.querySelector('input[type="password"]')?.closest('.has-mark')).toBeNull();
  // An amount reads grouped once typed, and the digits alone while it is typed again.
  expect(down).toHaveValue('2,500');
  fireEvent.focus(down);
  expect(down).toHaveValue('2500');
});

test('a consent beside its statement: the paragraph is drawn once, the label names the box but is not drawn beside it', async () => {
  const words = 'I consent to customer care text messages at the number above. Reply STOP to end them.';
  const consent: FormPresentation = {
    ...intake,
    prefillable: [],
    input: [
      { name: 'texts', label: 'Text messages', type: 'boolean', statement: words },
      { name: 'terms', label: 'Terms', type: 'boolean', required: true, accept: true, statement: words },
    ],
    steps: [{ id: 'consent', label: 'Consent', fields: ['texts', 'terms'] }],
  };
  await formArrives(consent);
  const { container } = render(<FormSurface form={consent} appName="Harbor" submit={vi.fn()} />);
  const texts = await screen.findByRole('checkbox', { name: 'Text messages' });
  expect(screen.getByRole('checkbox', { name: /^Terms/ })).toBeRequired();
  expect(texts).not.toBeRequired();
  expect(screen.getAllByText(words)).toHaveLength(2);
  expect(container.querySelector('.form-field-check-row')).toBeNull();
  for (const label of container.querySelectorAll('label.form-field-label')) expect(label).toHaveClass('form-field-label-hidden');
  fireEvent.click(texts);
  expect(texts).toBeChecked();
});

test('an amount on a slider is a slider, read in the currency, with its two ends under the track', async () => {
  const budget: FormPresentation = {
    ...intake,
    prefillable: [],
    input: [
      {
        name: 'monthly',
        label: 'Monthly payment',
        type: 'money',
        as: 'slider',
        min: 150,
        max: 1000,
        step: 10,
      } as FormPresentation['input'][number],
    ],
    steps: [{ id: 'budget', label: 'Budget', fields: ['monthly'] }],
  };
  await formArrives(budget);
  const { container } = render(<FormSurface form={budget} appName="Harbor" submit={vi.fn()} />);
  const slider = await screen.findByRole('slider', { name: /^Monthly payment/ });
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.change(slider, { target: { value: '500' } });
  await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', '$500'));
  expect(container.querySelector('.field-readout')).toHaveTextContent('$500');
  expect(container.querySelector('.intake-slider-ends')).toHaveTextContent('$150$1,000');
  expect(container.querySelector('.has-mark')).toBeNull();
});

test('the stepper style keeps no valid check', async () => {
  const stepper: FormPresentation = { ...intake, style: undefined, note: undefined };
  await formArrives(stepper);
  const { container } = render(<FormSurface form={stepper} appName="Harbor" submit={vi.fn()} />);
  await screen.findByRole('textbox', { name: /^First name/ });
  expect(container.querySelector('.field-box')).toBeNull();
});
