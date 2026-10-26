import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { allowMutationExit } from '../../../../kit/src/client/core.js';
import { SavedFormSurface, sayInput, type SavedFormPresentation } from './SavedFormSurface.js';

const form: SavedFormPresentation = {
  id: 'apply',
  label: 'Apply for financing',
  submitLabel: 'Submit application',
  done: { title: 'Application received' },
  input: [
    { name: 'first_name', label: 'First name', type: 'text', required: true },
    { name: 'city', label: 'City', type: 'text', required: true },
    {
      name: 'term',
      label: 'Term',
      type: 'choice',
      required: true,
      options: [
        { value: 36, label: '36 months' },
        { value: 48, label: '48 months' },
      ],
    },
    { name: 'consent', label: 'These details are true', type: 'boolean' },
  ],
  steps: [
    { id: 'about-you', label: 'About you', fields: ['first_name'] },
    { id: 'address', label: 'Address', fields: ['city', 'term'] },
  ],
  save: { submit: ['consent'] },
};

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});
/** The server's side: a resume, each step and the submit, answered by path. */
function server(resumed: string[] = []) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/resume')) return answer(200, { saved: resumed });
    if (url.includes('/steps/')) return answer(200, { saved: url.split('/').pop() });
    return answer(200, { reference: 'APP-7K2M-QX4T-9BRD', receipt: { id: 'r1', status: 'applied' } });
  });
}
const storage = { local: vi.fn(), session: vi.fn(), idb: vi.fn() };
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  storage.local = vi.spyOn(Storage.prototype, 'setItem') as never;
  if (globalThis.indexedDB) storage.idb = vi.spyOn(globalThis.indexedDB, 'open') as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const unloadBlocked = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

async function fillAndReview() {
  await waitFor(() => expect(screen.getByLabelText('First name (required)')).toBeInTheDocument());
  expect(unloadBlocked()).toBe(false);
  fireEvent.change(screen.getByLabelText('First name (required)'), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('City (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('City (required)'), { target: { value: 'London' } });
  fireEvent.click(screen.getByRole('radio', { name: '48 months' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
}

test('each step is saved on Continue and the review is drawn from memory; nothing reaches storage or the address', async () => {
  server();
  const before = window.location.href;
  render(<SavedFormSurface form={form} appName="Ignition" />);
  expect(screen.getByText(/We don’t show your details back to you; keep this tab open/)).toBeInTheDocument();
  await fillAndReview();
  // What was sent is what the review reads, from this page's memory.
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.getByText('London')).toBeInTheDocument();
  expect(screen.getByText('48 months')).toBeInTheDocument();
  const posted = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body)).input]);
  expect(posted).toEqual([
    ['/api/forms/apply/resume', undefined],
    ['/api/forms/apply/steps/about-you', { first_name: 'Ada' }],
    ['/api/forms/apply/steps/address', { city: 'London', term: 48 }],
  ]);
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  expect(screen.getByText('APP-7K2M-QX4T-9BRD')).toBeInTheDocument();
  // The done screen is the receipt alone.
  expect(screen.queryByText('Ada')).toBeNull();
  expect(JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)).input).toEqual({ consent: true });
  expect(storage.local).not.toHaveBeenCalled();
  expect(storage.idb).not.toHaveBeenCalled();
  expect(Object.keys(localStorage)).toEqual([]);
  expect(Object.keys(sessionStorage)).toEqual([]);
  expect(window.location.href).toBe(before);
  expect(document.cookie).toBe('');
});

test('the leave guard is armed once a step is saved, and released on submit', async () => {
  server();
  render(<SavedFormSurface form={form} appName="Ignition" />);
  await waitFor(() => expect(screen.getByLabelText('First name (required)')).toBeInTheDocument());
  expect(allowMutationExit()).toBe(true);
  await fillAndReview();
  expect(unloadBlocked()).toBe(true);
  // The platform's own exit guard refuses every in-App way out.
  expect(allowMutationExit()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  // Released by the effect that follows the done screen's render, which a loaded runner can draw first.
  await waitFor(() => expect(unloadBlocked()).toBe(false));
  expect(allowMutationExit()).toBe(true);
});

test('after a reload the saved steps read as saved and not shown; Change re-enters one, and submit needs no re-entry', async () => {
  server(['about-you', 'address']);
  render(<SavedFormSurface form={form} appName="Ignition" />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  expect(screen.getByText(/Your application is saved/)).toBeInTheDocument();
  expect(screen.getAllByText('Saved — not shown for your privacy')).toHaveLength(2);
  expect(unloadBlocked()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Change Address' }));
  await waitFor(() => expect(screen.getByLabelText('City (required)')).toHaveValue(''));
  fireEvent.change(screen.getByLabelText('City (required)'), { target: { value: 'Paris' } });
  fireEvent.click(screen.getByRole('radio', { name: '36 months' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByText('Paris')).toBeInTheDocument());
  expect(screen.getAllByText('Saved — not shown for your privacy')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/steps/')).map(([url]) => url)).toEqual([
    '/api/forms/apply/steps/address',
  ]);
});

test('a draft the server no longer has starts again from the first step, saying so', async () => {
  server(['about-you']);
  render(<SavedFormSurface form={form} appName="Ignition" />);
  await waitFor(() => expect(screen.getByLabelText('City (required)')).toBeInTheDocument());
  fetchMock.mockImplementation(async () =>
    answer(404, { code: 'not_found', message: 'This application can no longer be continued. Start a new one.' }),
  );
  fireEvent.change(screen.getByLabelText('City (required)'), { target: { value: 'Paris' } });
  fireEvent.click(screen.getByRole('radio', { name: '36 months' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('First name (required)')).toBeInTheDocument());
  expect(screen.getByText(/started again from the first step/)).toBeInTheDocument();
  // The leave guard is disarmed by an effect cleanup, which can land a tick after the first step paints.
  await waitFor(() => expect(unloadBlocked()).toBe(false));
});

test('a linkable form\'s done screen offers an account and a way to check; "This is a shared device" burns the claim', async () => {
  server(['about-you', 'address']);
  const linkable = { ...form, save: { ...form.save, statusCheck: {}, link: { sameDevice: true as const } } };
  render(<SavedFormSurface form={linkable} appName="Ignition" base="/ignition/form/apply" />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('These details are true'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
  expect(screen.getByRole('link', { name: 'Create an account to track this' })).toHaveAttribute(
    'href',
    '/ignition/form/apply/claim?account=new',
  );
  expect(screen.getByRole('link', { name: 'Sign in to add it' })).toHaveAttribute('href', '/ignition/form/apply/claim');
  expect(screen.getByRole('link', { name: 'Check its status' })).toHaveAttribute('href', '/ignition/form/apply/status');
  fetchMock.mockImplementation(async () => answer(200, { claim: null }));
  fireEvent.click(screen.getByRole('button', { name: 'This is a shared device' }));
  await waitFor(() => expect(screen.getByText(/can no longer add the application to an account/)).toBeInTheDocument());
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  expect([url, JSON.parse(String((init as RequestInit).body))]).toEqual(['/api/forms/apply/claim', { answer: 'no' }]);
  expect(screen.queryByRole('link', { name: 'Sign in to add it' })).toBeNull();
});

test('the review says a value in words', () => {
  expect(sayInput(form.input[2], 48)).toBe('48 months');
  expect(sayInput(form.input[3], false)).toBe('No');
  expect(
    sayInput({ name: 'rows', label: 'Rows', type: 'group', repeat: { max: 2 }, fields: [{ name: 'name', label: 'Name', type: 'text' }] }, [
      { name: 'A' },
      { name: 'B' },
    ]),
  ).toBe('A; B');
  expect(sayInput(form.input[0], '')).toBe('—');
});

test('the review offers to prove the address typed, with a code, and says it is confirmed; nothing about it is kept', async () => {
  const proving: SavedFormPresentation = {
    ...form,
    input: [{ name: 'email', label: 'Email', type: 'text', required: true }, form.input[3]],
    steps: [{ id: 'about-you', label: 'About you', fields: ['email'] }],
    save: { submit: ['consent'], link: { email: { prove: 'email' } } },
  };
  const asked: unknown[] = [];
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/resume')) return answer(200, { saved: [] });
    if (url.includes('/steps/')) return answer(200, { saved: 'about-you' });
    if (url.endsWith('/verify-email')) {
      const body = JSON.parse(String(init.body));
      asked.push(body);
      return body.code === undefined ? answer(200, { sent: true }) : answer(200, { verified: true });
    }
    throw new Error(`unexpected ${url}`);
  });
  render(<SavedFormSurface form={proving} appName="Ignition" />);
  await waitFor(() => expect(screen.getByLabelText('Email (required)')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Email (required)'), { target: { value: 'ada@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirm your email' })).toBeInTheDocument());
  // The address the applicant typed, from this page's memory.
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
  fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '135790' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText(/ada@example\.test is confirmed/)).toBeInTheDocument();
  expect(asked).toEqual([{ email: 'ada@example.test' }, { email: 'ada@example.test', code: '135790' }]);
  expect(Object.keys(localStorage)).toEqual([]);
});

test("a tenant's intake address rides on every step, the resume and the submit, as the page was published", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/resume')) return answer(200, { saved: [] });
    if (url.includes('/steps/')) return answer(200, { saved: url.split('?')[0].split('/').pop() });
    return answer(200, { reference: 'IGN-7K2M-QX4T-9BRD', receipt: { id: 'r1', status: 'applied' } });
  });
  window.history.replaceState(null, '', '/ignition/form/apply?via=north-intake-AAAAAAAAAAAAAAAA');
  try {
    render(<SavedFormSurface form={form} appName="Ignition" />);
    await fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Application received' })).toBeInTheDocument());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/forms/apply/resume?via=north-intake-AAAAAAAAAAAAAAAA',
      '/api/forms/apply/steps/about-you?via=north-intake-AAAAAAAAAAAAAAAA',
      '/api/forms/apply/steps/address?via=north-intake-AAAAAAAAAAAAAAAA',
      '/api/forms/apply?via=north-intake-AAAAAAAAAAAAAAAA',
    ]);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

test("on the review, a box that must be checked is caught here and said once, beside it; a refusal about it from the server is too, in a person's words", async () => {
  const consent: SavedFormPresentation = {
    ...form,
    input: [
      ...form.input.filter((field) => field.name !== 'consent'),
      { name: 'consent', label: 'These details are true', type: 'boolean', required: true, accept: true },
    ],
  };
  server();
  render(<SavedFormSurface form={consent} appName="Workshop" />);
  await fillAndReview();
  const box = screen.getByRole('checkbox', { name: 'These details are true (required)' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByText('Check this box to continue.')).toBeVisible());
  expect(screen.getAllByText('Check this box to continue.')).toHaveLength(1);
  await waitFor(() => expect(box).toHaveFocus());
  expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/forms/apply')).toBe(false);

  // The handler's own check, refused by code and field: beside the box, never "The command input is invalid", never twice.
  fetchMock.mockImplementation(async () =>
    answer(400, { code: 'invalid_input', message: 'The command input is invalid.', field: 'consent' }),
  );
  fireEvent.click(screen.getByText('These details are true'));
  expect(box).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(box).toHaveAttribute('aria-invalid', 'true'));
  expect(screen.queryByText(/command input/)).toBeNull();
  expect(screen.getAllByText('This answer was not accepted. Check it and try again.')).toHaveLength(1);
  expect(box).toHaveAccessibleDescription('This answer was not accepted. Check it and try again.');
});

test("a refusal about no field on screen is the form's one line, above the actions, naming where", async () => {
  server();
  render(<SavedFormSurface form={form} appName="Workshop" />);
  await fillAndReview();
  fetchMock.mockImplementation(async () =>
    answer(503, { code: 'temporarily_unavailable', message: 'The command could not be completed. Retry with the same request key.' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  const line = await screen.findByText('It could not be sent just now. Try again in a moment; it will not be sent twice.');
  await waitFor(() => expect(line).toHaveFocus());
  expect(
    line.compareDocumentPosition(screen.getByRole('button', { name: 'Submit application' })) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // A field on an earlier step is named by its label on the review.
  fetchMock.mockImplementation(async () => answer(400, { code: 'invalid_input', message: 'The command input is invalid.', field: 'city' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
  await waitFor(() => expect(screen.getByText('City: This answer was not accepted. Check it and try again.')).toBeVisible());
});
