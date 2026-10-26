import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormStatusSurface, type StatusFormPresentation } from './FormStatusSurface.js';

const form = (link?: StatusFormPresentation['save']['link']): StatusFormPresentation => ({
  id: 'apply',
  label: 'Apply for financing',
  input: [],
  save: {
    submit: ['consent'],
    statusCheck: {
      confirm: [
        { name: 'last_name', label: 'Last name' },
        { name: 'ssn_last4', label: 'Last four of your SSN' },
      ],
    },
    ...(link ? { link } : {}),
  },
});
const REFUSED = 'We could not find an application with those details. Check them and try again.';
const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});
const RIGHT = { receipt: 'APP-7K2M-QX4T-9BRD', confirm: { last_name: 'Lovelace', ssn_last4: '1234' } };
/** The server: the right details answer a state, anything else the one refusal; `signedIn` decides who the account routes see. */
function server(signedIn: boolean, mine: unknown[] = []) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/mine'))
      return signedIn ? answer(200, { applications: mine }) : answer(401, { code: 'unauthenticated', message: 'Sign in.' });
    const right = JSON.stringify(body) === JSON.stringify(RIGHT);
    if (url.endsWith('/status'))
      return right ? answer(200, { status: { status: 'In review' } }) : answer(404, { code: 'not_found', message: REFUSED });
    if (url.endsWith('/link'))
      return right
        ? answer(200, { linked: { reference: RIGHT.receipt }, status: { status: 'In review' } })
        : answer(404, { code: 'not_found', message: REFUSED });
    throw new Error(`unexpected ${url}`);
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const failure = () => document.querySelector('.form-page-failure')!;
function fill(details: typeof RIGHT) {
  type('Reference', details.receipt);
  type('Last name', details.confirm.last_name);
  type('Last four of your SSN', details.confirm.ssn_last4);
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
}

test('the right details answer the state; any wrong one reads alike, marks no field and keeps what was typed', async () => {
  server(false);
  render(<FormStatusSurface form={form()} appName="Ignition" />);
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  // A blank field is said beside it: that knows nothing of any application.
  expect(await screen.findByText('Enter your reference.')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();

  const said: string[] = [];
  for (const wrong of [
    { ...RIGHT, receipt: 'APP-0000-0000-0000' },
    { ...RIGHT, confirm: { ...RIGHT.confirm, last_name: 'Byron' } },
    { ...RIGHT, confirm: { ...RIGHT.confirm, ssn_last4: '4321' } },
  ]) {
    fill(wrong);
    await waitFor(() => expect(failure()).not.toHaveAttribute('hidden'));
    said.push(failure().textContent ?? '');
    // Nothing points at the detail that was wrong.
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe(wrong.confirm.last_name);
  }
  expect(new Set(said)).toEqual(new Set([REFUSED]));

  fill(RIGHT);
  expect(await screen.findByText('In review')).toBeInTheDocument();
  expect(failure()).toHaveAttribute('hidden');
  // A state, never an input: nothing typed is drawn outside its own field.
  expect(document.body.textContent).not.toContain('Lovelace');
  expect(screen.queryByRole('button', { name: 'Add to my account' })).toBeNull();
});

test("signed in, a form that links through the check adds it to the account and lists the account's own", async () => {
  server(true, [{ reference: 'APP-AAAA-BBBB-CCCC', status: { status: 'Received' } }]);
  render(<FormStatusSurface form={form({ statusCheck: true })} appName="Ignition" />);
  expect(await screen.findByRole('heading', { name: 'Your applications' })).toBeInTheDocument();
  expect(screen.getByText('APP-AAAA-BBBB-CCCC')).toBeInTheDocument();
  fill(RIGHT);
  fireEvent.click(await screen.findByRole('button', { name: 'Add to my account' }));
  expect(await screen.findByText(`${RIGHT.receipt} is now in your account.`)).toBeInTheDocument();
  const link = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/link'))!;
  // The same details again, from memory; the account is the session's, never the page's to say.
  expect(JSON.parse(String((link[1] as RequestInit).body))).toEqual(RIGHT);
});

test("signed out, the check offers the App's sign-in instead of the link", async () => {
  server(false);
  const onSignIn = vi.fn();
  render(<FormStatusSurface form={form({ statusCheck: true, sameDevice: true })} appName="Ignition" onSignIn={onSignIn} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fill(RIGHT);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  expect(onSignIn).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Add to my account' })).toBeNull();
});

test('a step-up emails a code and opens the declared details with it; a wrong code is said and nothing opens', async () => {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/status')) return answer(200, { status: { status: 'In review' } });
    if (url.endsWith('/stepup') && body.code === undefined) return answer(200, { sent: true });
    if (url.endsWith('/stepup'))
      return body.code === '246810'
        ? answer(200, { status: { status: 'In review' }, details: { first_name: 'Ada' } })
        : answer(404, { code: 'code_refused', message: 'That code is not right.' });
    throw new Error(`unexpected ${url}`);
  });
  const stepped = form();
  stepped.save.statusCheck.stepUp = true;
  render(<FormStatusSurface form={stepped} appName="Ignition" />);
  fill(RIGHT);
  fireEvent.click(await screen.findByRole('button', { name: 'Email me a code' }));
  const code = await screen.findByLabelText(/Code from the email/);
  fireEvent.change(code, { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  expect(await screen.findByText('That code is not right.')).toBeInTheDocument();
  expect(screen.queryByText('Ada')).toBeNull();
  fireEvent.change(code, { target: { value: '246810' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  expect(await screen.findByText('Ada')).toBeInTheDocument();
  // The details were asked again with the code: the code alone opens nothing.
  const last = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  expect(last).toEqual({ ...RIGHT, code: '246810' });
});

test('signed in with a verified email, an application found by it is offered and added only by its Yes', async () => {
  let linked = false;
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/mine'))
      return answer(200, { applications: linked ? [{ reference: 'APP-1', status: { status: 'In review' } }] : [] });
    if (url.endsWith('/found') && body.reference === undefined) return answer(200, { linked: [], found: linked ? [] : ['APP-1'] });
    if (url.endsWith('/found')) {
      linked = true;
      return answer(200, { linked: { reference: body.reference } });
    }
    throw new Error(`unexpected ${url}`);
  });
  render(<FormStatusSurface form={form({ statusCheck: true, email: {} })} appName="Ignition" />);
  expect(
    await screen.findByRole('heading', { name: 'We found 1 application submitted with this email — is this yours?' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Yes, it’s mine' }));
  expect(await screen.findByText(/Added to your account, submitted with your email: APP-1/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your applications' })).toBeInTheDocument());
  expect(
    fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/found') && JSON.parse(String(init.body)).reference === 'APP-1'),
  ).toBe(true);
});
