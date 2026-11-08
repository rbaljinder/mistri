/**
 * `<Steps>`: a command's form over several steps on a free-form page. The step is the page's param, so the test reads
 * the address beside the form; an address that moves by itself (Back and forward, a pasted link) is a button on the
 * page that writes the param as the browser would.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fixtures, renderPage } from './testing.js';
import { definePage, Steps, useAddressState } from './page.js';
import type { UiCommandOutcome } from './context.js';

afterEach(cleanup);

const DATA = fixtures({ lease: [{ id: 4, unit: '2B' }] });

const STEPS = [
  { id: 'what', label: 'What', title: 'What is it for?', inputs: ['kind', 'description'] },
  { id: 'amount', label: 'Amount', inputs: ['amount'] },
  { id: 'when', label: 'When', inputs: ['note'] },
] as const;

function Address() {
  const [step, setStep] = useAddressState('step');
  return (
    <>
      <output aria-label="address">{step ?? 'none'}</output>
      <button type="button" onClick={() => setStep('when')}>
        Forward to when
      </button>
      <button type="button" onClick={() => setStep('what')}>
        Back to what
      </button>
    </>
  );
}

const page = definePage({
  label: 'Add a charge',
  reads: ['lease'],
  commands: ['addCharge'],
  params: { step: ['what', 'amount', 'when'] },
  component: () => (
    <>
      <Steps command="addCharge" param="step" steps={STEPS} />
      <Address />
    </>
  ),
});

/* What was typed is kept for the page while it is open, by reader: each test reads as someone new. */
let readers = 0;

function serve(
  options: {
    address?: Record<string, string>;
    outcome?: UiCommandOutcome;
    check?: (names: readonly string[]) => Record<string, string>;
    /** The same reader as the last drawing: what they typed there is still kept. */
    again?: boolean;
  } = {},
) {
  const checked: (readonly string[])[] = [];
  const announced: { text: string; tone: 'ok' | 'error' }[] = [];
  const view = renderPage(page, {
    announced,
    data: DATA,
    viewer: { signedIn: true, account: `reader-${options.again ? readers : ++readers}` },
    ...(options.address ? { address: options.address } : {}),
    commands: {
      addCharge: {
        label: 'Add charge',
        input: {
          kind: { type: 'text', required: true },
          description: { type: 'text' },
          amount: { type: 'number', required: true, min: 1 },
          note: { type: 'text' },
        },
        ...(options.outcome ? { outcome: options.outcome } : {}),
        check: (_input, names) => {
          checked.push(names);
          return options.check?.(names);
        },
      },
    },
  });
  return Object.assign(view, { checked, announced });
}

const address = () => screen.getByLabelText('address').textContent;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

describe('Steps', () => {
  test('each step says where it is, the next one writes the param, and its heading takes the focus', async () => {
    const view = serve();
    expect(await heading('What is it for?')).toBeInTheDocument();
    // Under the page's own h1: the step's title is an h2, and Steps draws no h1 of its own.
    expect(screen.getByRole('heading', { name: 'What is it for?', level: 2 })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 1 })).toEqual([]);
    expect(screen.getByRole('progressbar', { name: 'Step 1 of 3: What' })).toBeInTheDocument();
    expect(address()).toBe('none');
    // Not a word from the server on the first draw: nothing has moved.
    expect(screen.queryByText('Step 1 of 3: What', { selector: '[aria-live]' })).toBeNull();

    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const amount = await heading('Amount');
    expect(screen.getByRole('progressbar', { name: 'Step 2 of 3: Amount' })).toBeInTheDocument();
    await waitFor(() => expect(amount).toHaveFocus());
    expect(address()).toBe('amount');
    expect(screen.getByText('Step 2 of 3: Amount', { selector: '[aria-live]' })).toBeInTheDocument();
    // Continue ran nothing: the server was asked to check the step's own inputs, and no command was sent.
    expect(view.checked).toEqual([['kind', 'description']]);
    expect(view.commands).toEqual([]);
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  test('a step that does not hold stays, with its problem, and the address does not move', async () => {
    const view = serve();
    await heading('What is it for?');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByLabelText(/^Kind/)).toHaveAttribute('aria-invalid', 'true'));
    expect(address()).toBe('none');
    expect(view.checked).toEqual([]);
  });

  test("the server's check of a step holds it there", async () => {
    serve({ check: (names): Record<string, string> => (names.includes('kind') ? { kind: 'No such kind of charge.' } : {}) });
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Parking');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('No such kind of charge.')).toBeInTheDocument();
    expect(address()).toBe('none');
  });

  test('Back and forward move the step, and what was typed is still there', async () => {
    serve();
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Amount');
    await userEvent.type(screen.getByRole('spinbutton', { name: /^Amount/ }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('When');
    expect(address()).toBe('when');

    await userEvent.click(screen.getByRole('button', { name: 'Back to what' }));
    expect(await heading('What is it for?')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Kind/)).toHaveValue('Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Forward to when' }));
    expect(await heading('When')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Step 3 of 3: When' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('Amount')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /^Amount/ })).toHaveValue(40);
  });

  test('an address past a step that does not hold opens that step instead, and says so in the address', async () => {
    serve({ address: { step: 'when' } });
    expect(await heading('What is it for?')).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe('none'));
    expect(screen.queryByRole('heading', { name: 'When' })).toBeNull();
  });

  test('a page left and come back to finds what was typed, and an address past it opens the first step not answered', async () => {
    serve();
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Amount');
    cleanup();
    serve({ again: true, address: { step: 'when' } });
    expect(await heading('Amount')).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe('amount'));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('What is it for?')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Kind/)).toHaveValue('Late fee');
  });

  test('a step no step has opens the first', async () => {
    serve({ address: { step: 'nowhere' } });
    expect(await heading('What is it for?')).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe('none'));
  });

  test("the last step's button is the command's, and it runs the command once with every step's answers", async () => {
    const view = serve();
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Amount');
    await userEvent.type(screen.getByRole('spinbutton', { name: /^Amount/ }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('When');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(await screen.findByRole('heading', { name: 'Add charge: done.', level: 2 })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 1 })).toEqual([]);
    expect(view.commands).toHaveLength(1);
    expect(view.commands[0]).toMatchObject({ command: 'addCharge', mode: 'run', input: { kind: 'Late fee', amount: 40 } });
    await waitFor(() => expect(address()).toBe('none'));
  });

  test('a refusal about an input on an earlier step opens that step, says so once, and focuses the input', async () => {
    const view = serve({ outcome: { status: 'refused', message: 'Not added.', fields: { kind: 'Late fees are off for this lease.' } } });
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Amount');
    await userEvent.type(screen.getByRole('spinbutton', { name: /^Amount/ }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('When');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));

    expect(await heading('What is it for?')).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe('none'));
    const kind = screen.getByLabelText(/^Kind/);
    await waitFor(() => expect(kind).toHaveFocus());
    expect(kind).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Late fees are off for this lease. Step 1 of 3: What.', { selector: '[aria-live]' })).toBeInTheDocument();
    // Said by the step it opens, and not again by a toast over it.
    expect(view.announced).toEqual([]);
  });

  test("a refusal no step holds is said on the form's own line, and only there", async () => {
    const view = serve({ outcome: { status: 'refused', message: 'The books for this month are closed.' } });
    await heading('What is it for?');
    await userEvent.type(screen.getByLabelText(/^Kind/), 'Late fee');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('Amount');
    await userEvent.type(screen.getByRole('spinbutton', { name: /^Amount/ }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('When');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The books for this month are closed.');
    expect(screen.getAllByText('The books for this month are closed.')).toHaveLength(1);
    expect(view.announced).toEqual([]);
  });

  test('a reader who may not run the command is shown nothing', async () => {
    renderPage(page, { data: DATA, viewer: { signedIn: true, account: 'pat' } });
    await screen.findByLabelText('address');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
