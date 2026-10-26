import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormStep } from '../../../../mistri/src/shared/formRules.js';
import { MultiStepForm } from './MultiStepForm.js';

const steps: FormStep[] = [
  { id: 'identity', label: 'Identity', fields: ['name'] },
  { id: 'details', label: 'Details', fields: ['email'] },
];

function view(props: Partial<React.ComponentProps<typeof MultiStepForm>> = {}) {
  return render(
    <MultiStepForm steps={steps} {...props}>
      {(step) => <div data-testid="step-fields">{step.fields.join(', ')}</div>}
    </MultiStepForm>,
  );
}

describe('MultiStepForm', () => {
  afterEach(cleanup);

  it('renders one step, exposes progress, and advances only through the existing validator seam', async () => {
    const validate = vi.fn(() => true);
    const changed = vi.fn();
    view({ validateStep: validate, onStepChange: changed });
    expect(screen.getByRole('heading', { name: 'Identity' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByTestId('step-fields')).toHaveTextContent('name');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy());
    expect(validate).toHaveBeenCalledWith(steps[0], 'next');
    expect(changed).toHaveBeenCalledWith(1, steps[1]);
  });

  it('presses the primary on Enter in a typed answer, and leaves Enter to a checkbox, a box of lines and an open list', async () => {
    const validate = vi.fn(() => true);
    const completed = vi.fn();
    render(
      <MultiStepForm steps={steps} validateStep={validate} onComplete={completed}>
        {(step) => (
          <>
            <input aria-label={step.fields[0]} />
            <input type="checkbox" aria-label="agree" />
            <textarea aria-label="notes" />
            <input role="combobox" aria-expanded="true" aria-label="pick" />
          </>
        )}
      </MultiStepForm>,
    );
    for (const name of ['agree', 'notes', 'pick']) fireEvent.keyDown(screen.getByLabelText(name), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('name'), { key: 'Enter', shiftKey: true });
    expect(validate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('name'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy());
    fireEvent.keyDown(screen.getByLabelText('email'), { key: 'Enter' });
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
  });

  it('keeps the current step and reports a rejected validation without persistence or navigation', async () => {
    const validate = vi.fn(() => false);
    view({ validateStep: validate });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Review this step'));
    expect(screen.getByRole('heading', { name: 'Identity' })).toBeTruthy();
    expect(screen.getByTestId('step-fields')).toHaveTextContent('name');
  });

  it('keeps the focus on Continue while it checks, and sends it to the field to fix when the step is refused', async () => {
    let answer!: (ok: boolean) => void;
    const validate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    // The focus goes to the field that says it is invalid, not to the fieldset around it.
    render(
      <MultiStepForm steps={steps} validateStep={validate}>
        {() => (
          <fieldset>
            <label>
              Name
              <input required aria-invalid="true" />
            </label>
          </fieldset>
        )}
      </MultiStepForm>,
    );
    const next = screen.getByRole('button', { name: 'Continue' });
    next.focus();
    fireEvent.click(next);
    // Busy, not disabled: a disabled button would drop the focus it holds.
    const checking = screen.getByRole('button', { name: 'Checking…' });
    expect(checking).toHaveAttribute('aria-disabled', 'true');
    expect(checking).not.toBeDisabled();
    expect(checking).toHaveFocus();
    fireEvent.click(checking);
    expect(validate).toHaveBeenCalledTimes(1);
    answer(false);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    // The field that says it is invalid is the one place it is said: the step's line stays empty.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("says the step's own line when no field on it holds the problem, and draws the host's line above the actions", async () => {
    render(
      <MultiStepForm steps={steps} validateStep={() => false} said={<p role="status">Saved elsewhere</p>}>
        {() => (
          <fieldset>
            <label>
              Name
              <input />
            </label>
          </fieldset>
        )}
      </MultiStepForm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Review this step'));
    expect(screen.getByRole('alert')).toHaveFocus();
    const host = screen.getByRole('status');
    expect(host.compareDocumentPosition(screen.getByRole('button', { name: 'Continue' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('moves back without validating and submits once on the final step', async () => {
    const validate = vi.fn(() => true);
    const complete = vi.fn(async () => {});
    view({ validateStep: validate, onComplete: complete });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Identity' })).toBeTruthy());
    expect(validate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it('supports controlled position and does not allow skipping ahead', () => {
    const { rerender } = view({ step: 0 });
    expect(screen.getByRole('heading', { name: 'Identity' })).toBeTruthy();
    // A step ahead is its name in the list, no way to it.
    expect(screen.queryByRole('button', { name: /Details/ })).toBeNull();
    rerender(
      <MultiStepForm steps={steps} step={1}>
        {(step) => <div>{step.label}</div>}
      </MultiStepForm>,
    );
    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
  });

  it("lists a page's steps beside it: a step done is a way back with what it said, the one in hand is current, one ahead is quiet", async () => {
    const summarize = vi.fn((step: FormStep) => (step.id === 'identity' ? 'Avery Stone' : undefined));
    view({ summarize });
    const list = screen.getByRole('navigation', { name: 'Form steps' });
    expect(list.querySelector('[aria-current="step"]')).toHaveTextContent('Identity');
    expect(list.querySelectorAll('button')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy());
    const back = screen.getByRole('button', { name: /^Identity\W+done$/ });
    expect(list.querySelector('[aria-current="step"]')).toHaveTextContent('Details');
    expect(screen.getByText('Avery Stone')).toBeTruthy();
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Identity' })).toBeTruthy());
  });

  it('draws no list of steps in a dialog, only the bar and its count', () => {
    view({ presentation: 'dialog' });
    expect(screen.queryByRole('navigation', { name: 'Form steps' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Step 1 of 2: Identity' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });
});

describe('MultiStepForm, the intake style', () => {
  afterEach(cleanup);
  const intake: FormStep[] = [
    { id: 'email', label: 'Email', fields: ['email'], title: "Let's start with your email.", lead: 'We write only about this.' },
    { id: 'vehicle', label: 'Vehicle', fields: ['make'], skip: 'Skip' },
    { id: 'income', label: 'Income', fields: ['pay'], next: 'Review' },
    { id: 'consent', label: 'Consent', fields: ['ok'] },
  ];
  const draw = (props: Partial<React.ComponentProps<typeof MultiStepForm>> = {}) =>
    render(
      <MultiStepForm steps={intake} style="intake" completeLabel="Submit" {...props}>
        {(step) => <div data-testid="fields">{step.fields.join(', ')}</div>}
      </MultiStepForm>,
    );
  const press = async (name: string) => {
    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(screen.getByRole('button', { name })).toBeTruthy());
  };

  it('draws a progress bar named by the step, the step title as the h1 and the lead under it, and no numbered tabs', () => {
    draw({ note: <p className="intake-note">Stored securely</p> });
    const bar = screen.getByRole('progressbar', { name: 'Step 1 of 4: Email' });
    expect(bar).toHaveAttribute('aria-valuemin', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
    expect(screen.getByRole('heading', { level: 1, name: "Let's start with your email." })).toBeTruthy();
    expect(screen.getByText('We write only about this.')).toBeTruthy();
    expect(screen.getByText('Stored securely')).toBeTruthy();
    // The list of steps beside a page holds no way ahead.
    expect(screen.getByRole('navigation', { name: 'Form steps' }).querySelectorAll('button')).toHaveLength(0);
    // The note stands above the bar.
    expect(screen.getByText('Stored securely').compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps a sticky bar with a primary and no Back on the first step, a Back beside it after', async () => {
    const { container } = draw();
    const bar = container.querySelector('.intake-actions');
    expect(bar).toBeTruthy();
    expect(bar).toContainElement(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await press('Continue');
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Step 2 of 4: Vehicle' })).toBeTruthy());
    expect(bar).toContainElement(screen.getByRole('button', { name: 'Back' }));
    // The title falls back to the label.
    expect(screen.getByRole('heading', { level: 1, name: 'Vehicle' })).toBeTruthy();
  });

  it("says the step's own words, Skip while it is empty, and the form's submit on the last step", async () => {
    let empty = true;
    const { rerender } = draw({ isStepEmpty: () => empty });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => screen.getByRole('progressbar', { name: 'Step 2 of 4: Vehicle' }));
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    empty = false;
    rerender(
      <MultiStepForm steps={intake} style="intake" completeLabel="Submit" isStepEmpty={() => empty}>
        {(step) => <div>{step.fields.join(', ')}</div>}
      </MultiStepForm>,
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => screen.getByRole('progressbar', { name: 'Step 3 of 4: Income' }));
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => screen.getByRole('progressbar', { name: 'Step 4 of 4: Consent' }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('skips only when the step is empty: a step with an answer says its usual words', async () => {
    draw({ isStepEmpty: (step) => step.id !== 'vehicle' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => screen.getByRole('progressbar', { name: 'Step 2 of 4: Vehicle' }));
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('draws the title as an h2 in a dialog and keeps the actions in the flow', () => {
    const { container } = draw({ presentation: 'dialog' });
    expect(screen.getByRole('heading', { level: 2, name: "Let's start with your email." })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(container.querySelector('.intake-actions')).toBeNull();
    expect(container.querySelector('.multi-step-actions')).toBeTruthy();
  });

  it('moves the focus without scrolling when a step is refused, and scrolls a step that starts above the view to its top', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const into = vi.fn();
    HTMLElement.prototype.scrollIntoView = into;
    const { container } = draw({ validateStep: (step) => step.id !== 'email' || false });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Review this step'));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focus.mock.calls.every(([options]) => (options as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    focus.mockRestore();
    // The next step, when the form's top is above the view, is scrolled to on the block axis only.
    vi.spyOn(container.querySelector('section')!, 'getBoundingClientRect').mockReturnValue({ top: -200 } as DOMRect);
    cleanup();
    const second = render(
      <MultiStepForm steps={intake} style="intake">
        {() => <div />}
      </MultiStepForm>,
    );
    vi.spyOn(second.container.querySelector('section')!, 'getBoundingClientRect').mockReturnValue({ top: -200 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(into).toHaveBeenCalledWith({ block: 'start', inline: 'nearest', behavior: 'instant' }));
  });

  it('keeps the stepper showing labels, never titles, under the same bar as the intake', () => {
    render(<MultiStepForm steps={intake}>{() => <div />}</MultiStepForm>);
    expect(screen.getByRole('heading', { level: 2, name: 'Email' })).toBeTruthy();
    expect(screen.queryByText("Let's start with your email.")).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Step 1 of 4: Email' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
