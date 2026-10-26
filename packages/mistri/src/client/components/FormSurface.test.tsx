import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { userEvent } from '@testing-library/user-event';
import { formArrives, formRefusal, FormSurface, submitPublicForm, type FormPresentation } from './FormSurface.js';

const form: FormPresentation = {
  id: 'finance',
  label: 'Apply for financing',
  description: 'A demonstration form.',
  submitLabel: 'Send application',
  done: { title: 'Application received', description: 'Keep this reference.' },
  input: [
    { name: 'applicant_name', label: 'Full name', type: 'text', required: true, maxLength: 120 },
    { name: 'applicant_phone', label: 'Phone', type: 'text', maxLength: 40 },
    { name: 'requested_amount', label: 'Amount', type: 'number', required: true, min: 1, help: 'In dollars.' },
    { name: 'agree', label: 'Agree', type: 'boolean' },
  ],
  steps: [
    { id: 'about-you', label: 'About you', fields: ['applicant_name', 'applicant_phone'] },
    { id: 'the-loan', label: 'The loan', fields: ['requested_amount', 'agree'] },
  ],
};
const publicSubmit = (submission: string, input: Parameters<typeof submitPublicForm>[2]) => submitPublicForm('finance', submission, input);

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
});

test('draws one step at a time, keeps a failed step with its field message, and submits once with a memory-held key', async () => {
  fetchMock.mockResolvedValueOnce(answer(200, { reference: 'INT-2026-123456', receipt: { id: 'r1', status: 'applied' } }));
  // The stepper is a part loaded on demand; a public page has it before the form mounts (publicForm.js).
  await formArrives(form);
  render(<FormSurface form={form} appName="Ignition" submit={publicSubmit} />);
  expect(screen.getByRole('heading', { name: 'Apply for financing' })).toBeInTheDocument();
  expect(screen.getByText('A demonstration form.')).toBeInTheDocument();
  expect(screen.getByLabelText('Full name (required)')).toBeInTheDocument();
  expect(screen.queryByLabelText('Amount (required)')).toBeNull();
  // The empty required field holds the step.
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByText('Full name is required.')).toBeVisible());
  // Said once, beside the field: the step's own line is for what no field holds.
  expect(screen.queryByText('Review this step before continuing.')).toBeNull();
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toHaveFocus());
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Mara Alder' } });
  expect(screen.queryByText('Full name is required.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Amount (required)')).toBeInTheDocument());
  expect(screen.getByText('In dollars.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Amount (required)'), { target: { value: '21000' } });
  fireEvent.click(screen.getByLabelText('Agree'));
  fireEvent.click(screen.getByRole('button', { name: 'Send application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  expect(screen.getByText('INT-2026-123456')).toBeInTheDocument();
  expect(screen.getByText('Keep this reference.')).toBeInTheDocument();
  // A public applicant is not offered a second application.
  expect(screen.queryByRole('button', { name: 'Fill in another' })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/forms/finance');
  const body = JSON.parse(String(init.body));
  expect(body.input).toEqual({ applicant_name: 'Mara Alder', requested_amount: 21000, agree: true });
  expect(body.submission).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(localStorage)).toEqual([]);
});

test("a refusal of a field on screen is said beside it alone, in a person's words, above the actions; a 429 says how long to wait", async () => {
  fetchMock
    .mockResolvedValueOnce(answer(400, { code: 'invalid_input', message: 'The command input is invalid.', field: 'requested_amount' }))
    .mockResolvedValueOnce(answer(429, { code: 'rate_limited', error: 'Too many requests.', retryAfter: 42 }, { 'retry-after': '42' }));
  render(<FormSurface form={form} appName="Ignition" submit={publicSubmit} />);
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Mara' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Amount (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Amount (required)'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send application' }));
  await waitFor(() => expect(screen.getByText('This answer was not accepted. Check it and try again.')).toBeVisible());
  expect(screen.getAllByText(/answer was not accepted/)).toHaveLength(1);
  expect(screen.queryByText(/command input/)).toBeNull();
  await waitFor(() => expect(screen.getByLabelText('Amount (required)')).toHaveFocus());
  expect(screen.getByLabelText('Amount (required)')).toHaveAccessibleDescription(/answer was not accepted/);
  expect(screen.queryByRole('heading', { name: 'Application received' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send application' }));
  await waitFor(() => expect(screen.getByText('Too many submissions from this address. Try again in 42 seconds.')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('Too many submissions from this address. Try again in 42 seconds.')).toHaveFocus());
  // The form's own line stands above the actions, where the eye is before it presses.
  const line = screen.getByText('Too many submissions from this address. Try again in 42 seconds.');
  expect(
    line.compareDocumentPosition(screen.getByRole('button', { name: 'Send application' })) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The same key on every attempt: a retry replays, never applies twice.
  const keys = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).submission);
  expect(new Set(keys).size).toBe(1);
});

test('without steps the form is one page; a receipt with no reference still says done, and "Fill in another" starts a new key', async () => {
  const submit = vi.fn().mockResolvedValue({ receipt: { id: 'r1', status: 'applied' } });
  const note: FormPresentation = {
    id: 'log-call',
    label: 'Log a call',
    input: [
      { name: 'subject', label: 'Subject', type: 'text', required: true },
      { name: 'minutes', label: 'Minutes', type: 'number', min: 1 },
    ],
  };
  render(<FormSurface form={note} appName="Compass" submit={submit} again />);
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  expect(screen.getByLabelText('Minutes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Subject is required.')).toBeVisible());
  await waitFor(() => expect(screen.getByLabelText('Subject (required)')).toHaveFocus());
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Subject (required)'), { target: { value: 'Renewal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Received' })).toHaveFocus());
  expect(screen.queryByText('Your reference')).toBeNull();
  expect(submit.mock.calls[0][1]).toEqual({ subject: 'Renewal' });
  fireEvent.click(screen.getByRole('button', { name: 'Fill in another' }));
  expect(screen.getByLabelText('Subject (required)')).toHaveValue('');
  await waitFor(() => expect(screen.getByLabelText('Subject (required)')).toHaveFocus());
  fireEvent.change(screen.getByLabelText('Subject (required)'), { target: { value: 'Follow-up' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][0]).not.toBe(submit.mock.calls[0][0]);
});

test("formRefusal says the platform's fixed refusals in a person's words, a handler's own as written, and names the field when away from it", () => {
  const invalid = { code: 'invalid_input', status: 400, message: 'The command input is invalid.' };
  // The form's own rules say it where they find it; the name is not said twice.
  expect(formRefusal({ ...invalid, field: 'applicant_name' }, form.input, { applicant_name: '' })).toEqual({
    field: 'applicant_name',
    beside: 'Full name is required.',
    alone: 'Full name is required.',
  });
  // A box the handler would not take is asked to be checked; away from it, the line says which.
  expect(formRefusal({ ...invalid, field: 'agree' }, form.input, { agree: false })).toEqual({
    field: 'agree',
    beside: 'Check this box to continue.',
    alone: 'Agree: Check this box to continue.',
  });
  expect(formRefusal({ ...invalid, field: 'agree' }, form.input, { agree: true }).beside).toBe(
    'This answer was not accepted. Check it and try again.',
  );
  expect(formRefusal({ ...invalid, field: 'applicant_phone' }, form.input, {}).beside).toBe(
    'This answer was not accepted. Check it and try again.',
  );
  // A handler's own sentence stands; the platform's fixed one does not.
  expect(
    formRefusal(
      { code: 'duplicate_record', status: 409, message: 'That phone number already has an application.', field: 'applicant_phone' },
      form.input,
    ).alone,
  ).toBe('Phone: That phone number already has an application.');
  expect(
    formRefusal({ code: 'ineligible_state', status: 409, message: 'This record is not eligible for this command.' }, form.input).alone,
  ).toBe('This can’t be sent as it stands. Check your answers and try again.');
  expect(
    formRefusal(
      { code: 'temporarily_unavailable', status: 503, message: 'The command could not be completed. Retry with the same request key.' },
      form.input,
    ).alone,
  ).not.toMatch(/command|request key/);
  expect(formRefusal({ message: 'x', field: 'unknown' }, form.input).alone).toBe('x');
  expect(formRefusal({ message: 'x', status: 429, retryAfter: 7 }, form.input).alone).toBe(
    'Too many submissions from this address. Try again in 7 seconds.',
  );
});

test('a lost connection is said as one, never as the browser\'s "Failed to fetch"', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(submitPublicForm('finance', 'k', {})).rejects.toThrow('The form could not be sent. Check your connection and try again.');
});

test('legacy native intake keeps its via selector, credentials, and exact two-member envelope', async () => {
  fetchMock.mockResolvedValueOnce(answer(200, { reference: 'NATIVE-1', receipt: { id: 'r1', status: 'applied' } }));
  await submitPublicForm('join', 'legacy-submission', { agree: true }, 'native address');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/forms/join?via=native%20address',
    expect.objectContaining({
      credentials: 'same-origin',
      body: JSON.stringify({ input: { agree: true }, submission: 'legacy-submission' }),
    }),
  );
});

test('a box that must be checked sits beside its label, and unchecked it is caught here, said once, before anything is sent', async () => {
  const consent: FormPresentation = {
    id: 'join',
    label: 'Join',
    input: [
      { name: 'agree', label: 'I have read the rules', type: 'boolean', required: true, accept: true },
      { name: 'news', label: 'Send me news', type: 'boolean', required: true },
    ],
  };
  const submit = vi.fn(async (_submission: string, _input: unknown) => ({ receipt: { id: 'r1', status: 'applied' } }));
  render(<FormSurface form={consent} appName="Workshop" submit={submit} />);
  const box = screen.getByRole('checkbox', { name: 'I have read the rules (required)' });
  // The label is beside the box, after it, and checks it.
  const label = box.closest('.form-field')!.querySelector('label')!;
  expect(box.parentElement).toBe(label.parentElement);
  expect(box.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // A yes-or-no that may be left as no is not called required.
  expect(screen.getByRole('checkbox', { name: 'Send me news' })).not.toBeRequired();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Check this box to continue.')).toBeVisible());
  expect(screen.getAllByText('Check this box to continue.')).toHaveLength(1);
  await waitFor(() => expect(box).toHaveFocus());
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(label);
  expect(box).toBeChecked();
  expect(screen.queryByText('Check this box to continue.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][1]).toEqual({ agree: true, news: false });
});

test('pending submission retains button focus, ignores a second submit, and a server refusal focuses its field', async () => {
  let reject!: (error: Error) => void;
  const submit = vi.fn(
    () =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const simple: FormPresentation = {
    id: 'note',
    label: 'Add note',
    input: [{ name: 'subject', label: 'Subject', type: 'text', required: true }],
  };
  render(<FormSurface form={simple} appName="Desk" submit={submit} />);
  fireEvent.change(screen.getByLabelText('Subject (required)'), { target: { value: 'Follow-up' } });
  const button = screen.getByRole('button', { name: 'Submit' });
  button.focus();
  fireEvent.click(button);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(button);
  expect(submit).toHaveBeenCalledTimes(1);
  reject(Object.assign(new Error('Choose another subject.'), { field: 'subject' }));
  await waitFor(() => expect(screen.getByLabelText('Subject (required)')).toHaveFocus());
  expect(button).not.toHaveAttribute('aria-disabled');
});

test('a page ends its receipt in a quiet way back to the App; over another page, Done goes back instead', async () => {
  const note: FormPresentation = {
    id: 'note',
    label: 'Leave a note',
    input: [{ name: 'text', label: 'Note', type: 'text', required: true }],
  };
  const submit = vi.fn(async () => ({ receipt: { id: 'r1', status: 'applied' } }));
  render(<FormSurface form={note} appName="Example Home Energy" submit={submit} homeHref="/" />);
  fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  const back = await screen.findByRole('link', { name: 'Back to Example Home Energy' });
  expect(back).toHaveAttribute('href', '/');
  // A link, never a second button beside the receipt.
  expect(screen.queryByRole('button', { name: /Back to/ })).toBeNull();
  cleanup();
  render(<FormSurface form={note} appName="Example Home Energy" submit={submit} homeHref="/" onDismiss={() => {}} />);
  fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await screen.findByRole('button', { name: 'Done' });
  expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
});

test('over the page a component opened it from: Cancel goes back before a submit, Done after one, and no second entry is offered', async () => {
  const join: FormPresentation = {
    id: 'join',
    label: 'Join Commons',
    submitLabel: 'Join',
    done: { title: 'Welcome to Commons' },
    input: [{ name: 'handle', label: 'Handle', type: 'text', required: true, maxLength: 24 }],
  };
  const dismissed = vi.fn();
  const submit = vi.fn(async () => ({ receipt: { id: 'r1', status: 'applied' } }));
  render(<FormSurface form={join} appName="Commons" submit={submit} again={false} onDismiss={dismissed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dismissed).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Handle (required)'), { target: { value: 'newcomer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Welcome to Commons' })).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Fill in another' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(dismissed).toHaveBeenCalledTimes(2);
});

test('a public form with steps reviews every answer from memory before its one submit, and guards leaving until it is sent', async () => {
  fetchMock.mockResolvedValueOnce(answer(200, { reference: 'IGN-7K2M-QX4T-9BRD', receipt: { id: 'r1', status: 'applied' } }));
  const leaving = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  render(<FormSurface form={form} appName="Ignition" submit={publicSubmit} review />);
  expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  expect(leaving()).toBe(false);
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Mara Alder' } });
  expect(leaving()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Amount (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Amount (required)'), { target: { value: '21000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  expect(screen.getByText('Mara Alder')).toBeInTheDocument();
  expect(screen.getByText('21000')).toBeInTheDocument();
  // Change goes back to the step with its answers still there.
  fireEvent.click(screen.getByRole('button', { name: 'Change About you' }));
  await waitFor(() => expect(screen.getByLabelText('Full name (required)')).toHaveValue('Mara Alder'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  // The receipt paints before the passive effect removes the leave guard.
  await waitFor(() => expect(leaving()).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(Object.keys(localStorage)).toEqual([]);
});

test("a page's steps say what each one said beside the form; the review leaves out what was not answered and says nothing twice", async () => {
  render(<FormSurface form={form} appName="Ignition" submit={publicSubmit} review />);
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Mara Alder' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Amount (required)')).toBeInTheDocument());
  const steps = screen.getByRole('navigation', { name: 'Form steps' });
  // The step done: a way back, and its answer; the phone left empty is not said.
  expect(steps.querySelector('.is-done .multi-step-list-said')).toHaveTextContent(/^Mara Alder$/);
  expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('The loan');
  fireEvent.change(screen.getByLabelText('Amount (required)'), { target: { value: '21000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  // On the review the answers are the page itself: the steps beside it are names alone.
  expect(steps.querySelectorAll('.multi-step-list-said')).toHaveLength(0);
  // An optional question left empty is not on the review; a required one is, and Change stands by its heading.
  expect(screen.queryByText('Phone')).toBeNull();
  expect(screen.getByText('Full name')).toBeInTheDocument();
  const change = screen.getByRole('button', { name: 'Change About you' });
  expect(change.previousElementSibling).toHaveTextContent('About you');
});

test('an input named `title` keeps its own label: the form heading and every field id stay unique', () => {
  const titled: FormPresentation = {
    id: 'announce',
    label: 'New announcement',
    submitLabel: 'Publish',
    done: { title: 'Published', description: 'Done.' },
    input: [
      { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 120 },
      { name: 'done', label: 'Done by', type: 'text', maxLength: 40 },
    ],
  };
  const { container } = render(<FormSurface form={titled} appName="Desk" submit={publicSubmit} />);
  const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(screen.getByRole('region', { name: 'New announcement' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Title/ })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Done by/ })).toBeInTheDocument();
});

test("a public form's reference input is drawn as a picker over what the App opens to its visitor, and only with a visitor to read as", async () => {
  const picking: FormPresentation = {
    id: 'viewing',
    label: 'Book a viewing',
    done: { title: 'Booked' },
    input: [{ name: 'unit', label: 'Home', type: 'reference', from: 'unit', by: 'id', labelColumn: 'title', required: true }],
  };
  render(<FormSurface form={picking} appName="Lintel" submit={publicSubmit} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  cleanup();
  fetchMock.mockResolvedValue(answer(200, { rows: [{ id: 3, title: 'Garden flat' }] }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FormSurface form={picking} appName="Lintel" submit={publicSubmit} visitor={{ app: 'lintel' }} />
    </QueryClientProvider>,
  );
  const box = await screen.findByRole('combobox', { name: 'Home (required)' });
  await userEvent.type(box, 'Gar');
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/run\?app=lintel$/), expect.objectContaining({ method: 'POST' })),
  );
});
