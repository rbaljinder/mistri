/**
 * A public form's guard, as a visitor's page draws it: the decoy a person never meets (hidden, out of the tab order,
 * under a name no autofill knows) and, where the App names a human check with a widget, the provider's script loaded
 * once and its widget drawn with the site key; the token it gives travels as the challenge header, once — after every
 * answer the widget is reset, and a retry waits for the fresh token. A signed-in form draws neither.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formArrives, FormSurface, submitPublicForm, type FormPresentation } from './FormSurface.js';

// A script is loaded once a page, so each test names its own.
let widget = { script: '', api: 'humanCheck', siteKey: 'site-key-1' };
let n = 0;
const form: FormPresentation = {
  id: 'ask',
  label: 'Ask a question',
  done: { title: 'Thanks' },
  input: [{ name: 'question', label: 'Question', type: 'text', required: true, maxLength: 200 }],
};
const submit = (submission: string, input: Parameters<typeof submitPublicForm>[2], guard?: Parameters<typeof submitPublicForm>[4]) =>
  submitPublicForm('ask', submission, input, undefined, guard);

const fetchMock = vi.fn();
const rendered: Array<{ element: HTMLElement; options: Record<string, unknown> }> = [];
const resets: unknown[] = [];
beforeEach(() => {
  widget = { ...widget, script: `https://challenges.example.test/api-${++n}.js?render=explicit` };
  fetchMock.mockReset();
  rendered.length = 0;
  resets.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('humanCheck', {
    render: (element: HTMLElement, options: Record<string, unknown>) => {
      rendered.push({ element, options });
      return 'widget-1';
    },
    reset: (id: unknown) => resets.push(id),
    remove: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body });

/* happy-dom runs no script: the provider's is kept from the document as it is appended and "loaded" by its own load
   handler, as a browser would call it. */
const appended: HTMLScriptElement[] = [];
beforeEach(() => {
  appended.length = 0;
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const node of nodes) if (node instanceof HTMLScriptElement) appended.push(node);
    append(...nodes.filter((node) => !(node instanceof HTMLScriptElement)));
  });
});
afterEach(() => vi.restoreAllMocks());

function loadProviderScript() {
  const scripts = appended.filter((script) => script.src === widget.script);
  expect(scripts).toHaveLength(1);
  scripts[0].onload?.(new Event('load'));
}

test('the widget is drawn with the site key, and its token is sent as the challenge header with no decoy', async () => {
  fetchMock.mockResolvedValueOnce(answer(200, { reference: 'ASK-1', receipt: { id: 'r1', status: 'applied' } }));
  const challenged = { ...form, challenge: widget };
  await formArrives(challenged);
  render(<FormSurface form={challenged} appName="Paints" submit={submit} visitor={{ app: 'paints' }} />);
  // The decoy is there for a script, out of a person's way.
  const decoy = document.querySelector<HTMLInputElement>('input[name="mx_hp_7f"]')!;
  expect(decoy.tabIndex).toBe(-1);
  expect(decoy.autocomplete).toBe('new-password');
  expect(decoy.closest('[aria-hidden="true"]')).not.toBeNull();
  loadProviderScript();
  await waitFor(() => expect(rendered).toHaveLength(1));
  expect(rendered[0].options.sitekey).toBe('site-key-1');
  (rendered[0].options.callback as (token: string) => void)('token-from-widget');
  fireEvent.change(screen.getByLabelText('Question (required)'), { target: { value: 'Is it open on Sunday?' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit|Send/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>)['x-mistri-challenge']).toBe('token-from-widget');
  expect(JSON.parse(String(init.body))).not.toHaveProperty('trap');
  expect(await screen.findByText('Thanks')).toBeInTheDocument();
});

test('a refusal resets the widget, and the fixed retry sends a fresh token under the same submission key', async () => {
  fetchMock
    .mockResolvedValueOnce(answer(422, { code: 'refused', field: 'question', error: 'Ask a longer question.' }))
    .mockResolvedValueOnce(answer(200, { reference: 'ASK-3', receipt: { id: 'r3', status: 'applied' } }));
  const challenged = { ...form, challenge: widget };
  await formArrives(challenged);
  render(<FormSurface form={challenged} appName="Paints" submit={submit} visitor={{ app: 'paints' }} />);
  loadProviderScript();
  await waitFor(() => expect(rendered).toHaveLength(1));
  const give = rendered[0].options.callback as (token: string) => void;
  give('token-1');
  fireEvent.change(screen.getByLabelText('Question (required)'), { target: { value: 'Hm?' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit|Send/ }));
  expect(await screen.findByText('Ask a longer question.')).toBeInTheDocument();
  expect(resets).toEqual(['widget-1']);
  fireEvent.change(screen.getByLabelText('Question (required)'), { target: { value: 'Is it open on Sunday?' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit|Send/ }));
  // The spent token is not sent again: the retry waits for the one the reset asked for.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  give('token-2');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [first, second] = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
  expect((first.headers as Record<string, string>)['x-mistri-challenge']).toBe('token-1');
  expect((second.headers as Record<string, string>)['x-mistri-challenge']).toBe('token-2');
  expect(JSON.parse(String(second.body)).submission).toBe(JSON.parse(String(first.body)).submission);
  expect(await screen.findByText('Thanks')).toBeInTheDocument();
});

test('a filled decoy rides with the submission; an expired token is not sent, the fresh one is', async () => {
  fetchMock.mockResolvedValueOnce(answer(200, { reference: 'ASK-2', receipt: { id: 'r2', status: 'applied' } }));
  const challenged = { ...form, challenge: widget };
  await formArrives(challenged);
  render(<FormSurface form={challenged} appName="Paints" submit={submit} visitor={{ app: 'paints' }} />);
  loadProviderScript();
  await waitFor(() => expect(rendered).toHaveLength(1));
  (rendered[0].options.callback as (token: string) => void)('soon-stale');
  (rendered[0].options['expired-callback'] as () => void)();
  fireEvent.change(document.querySelector('input[name="mx_hp_7f"]')!, { target: { value: 'https://spam.example.test' } });
  fireEvent.change(screen.getByLabelText('Question (required)'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit|Send/ }));
  (rendered[0].options.callback as (token: string) => void)('renewed');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>)['x-mistri-challenge']).toBe('renewed');
  expect(JSON.parse(String(init.body)).trap).toBe('https://spam.example.test');
});

test('a signed-in form draws no decoy and no widget', async () => {
  await formArrives({ ...form, challenge: widget });
  render(<FormSurface form={{ ...form, challenge: widget }} appName="Paints" submit={submit} />);
  expect(document.querySelector('input[name="mx_hp_7f"]')).toBeNull();
  expect(appended).toHaveLength(0);
});
