/**
 * A form asked over several steps: the stepper (the step's name over its fields) or the intake style (the step's
 * title and lead large, one question at a time, and a sticky bar of Back and the primary), drawn on a page or in a
 * dialog. Either says where the reader is the one way, a thin bar with "Step n of m" beside it; a page wide enough
 * keeps the steps beside the form as well, a list to go back by with what each step said under it. It owns only the
 * cursor and the move between steps; the host owns the draft, its checks and its submission, and says whether a step
 * may be left.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FormStep, FormStyle } from '@mistriwork/engine/shared/formValues.js';
import { Button } from '@mistriwork/ui/Button.js';
import { ActionBar, ProgressBar, StepHeader } from '@mistriwork/ui/FormParts.js';
/* The progress bar, the step header and the action bar wear @mistriwork/ui's form rules, which arrive with this chunk. */
import { say } from '../copy/forms/components/MultiStepForm.js';

const MAX_RENDERED_STEPS = 16;
/* The intake style's sheets (intakeStyle.ts), fetched the first time a form wears it. Until they are here the form
   draws nothing rather than an undressed frame that would move as they land. */
let intakeStyled = false;
let intakeStyling: Promise<void> | undefined;
/** Fetch the intake style's sheets; resolves once they apply. A host that knows it draws the style asks first. */
export function loadIntakeStyle(): Promise<void> {
  intakeStyling ??= import('./intakeStyle.js').then(() => {
    intakeStyled = true;
  });
  return intakeStyling;
}
// Inputs whose Enter is their own: a box toggled, a button pressed, a file chosen.
const ENTER_KEEPS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image']);

type MultiStepDirection = 'next' | 'previous';

interface MultiStepFormProps<Field extends string = string> {
  /** The already parsed, finite AppForm.steps declaration. */
  steps: readonly FormStep<Field>[];
  /** Keep draft ownership and persistence in the surrounding form lifecycle. */
  children: (step: FormStep<Field>, index: number) => ReactNode;
  /** Optional controlled position; otherwise the host owns only the cursor. */
  step?: number;
  initialStep?: number;
  /** Called after a step transition has been accepted. */
  onStepChange?: (index: number, step: FormStep<Field>) => void;
  /** Existing form validation belongs here; false or a rejected promise blocks Next. */
  validateStep?: (step: FormStep<Field>, direction: MultiStepDirection) => boolean | Promise<boolean>;
  /** Called on the final step after its validation succeeds. */
  onComplete?: () => void | Promise<void>;
  nextLabel?: string;
  previousLabel?: string;
  completeLabel?: string;
  className?: string;
  /** Drawn first in the step's row of actions: a host's way out (Cancel), so it stands beside Back and Next. */
  leading?: ReactNode;
  /** The host's own line — a refusal that is about no field on this step — drawn above the actions, with the step's. */
  said?: ReactNode;
  /** `stepper` (the default): numbered steps over the fields. `intake`: a progress bar, the step's title large, one
      question at a time and a sticky bar of actions (docs/design.md, "Intake"). */
  style?: FormStyle;
  /** Intake: the quiet line over the progress bar (its icon and words), drawn by the host. */
  note?: ReactNode;
  /** Intake: whether every field of the step is empty, so the primary says `step.skip` instead of its usual words. */
  isStepEmpty?: (step: FormStep<Field>) => boolean;
  /** Where the form is drawn: in the page (the default) or in a dialog, whose title is the step's — the heading is
      an h2 and the actions stay in the flow, at the dialog's foot, beside the host's `leading` (a host with one keeps
      them in the flow too). A page also draws the steps beside the form where it is wide enough; a dialog never. */
  presentation?: 'page' | 'dialog';
  /** A page's steps beside the form: what a step already answered said in a line under its name (the host's words,
      from its draft), or nothing. Asked with the step being answered, so a host says nothing on its review. */
  summarize?: (step: FormStep<Field>, active: FormStep<Field>) => string | undefined;
}

/* The steps beside a page's form mark a step done with the chrome's check (chromeIcons.ts, regular weight). */
const CHECK = 'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z';

function safeIndex(index: number | undefined, length: number): number {
  if (!Number.isSafeInteger(index)) return 0;
  return Math.max(0, Math.min(index as number, length - 1));
}

/**
 * A progression shell for the bounded AppForm.steps contract.
 *
 * This component deliberately does not own field values or persistence. The
 * surrounding New/command/business form supplies those through children and
 * validateStep, so moving between steps cannot create a second write path.
 */
export function MultiStepForm<Field extends string = string>({
  steps,
  children,
  step,
  initialStep = 0,
  onStepChange,
  validateStep,
  onComplete,
  nextLabel,
  previousLabel = say('common.back'),
  completeLabel = say('common.save'),
  className = '',
  leading,
  said: hostSaid,
  style = 'stepper',
  note,
  isStepEmpty,
  presentation = 'page',
  summarize,
}: MultiStepFormProps<Field>) {
  const id = useId();
  const boundedSteps = steps.slice(0, MAX_RENDERED_STEPS);
  const controlled = step !== undefined;
  const [styled, setStyled] = useState(() => style !== 'intake' || intakeStyled);
  useEffect(() => {
    if (styled) return;
    let live = true;
    void loadIntakeStyle().then(() => live && setStyled(true));
    return () => {
      live = false;
    };
  }, [styled]);
  const [ownedStep, setOwnedStep] = useState(() => safeIndex(initialStep, boundedSteps.length));
  const current = safeIndex(controlled ? step : ownedStep, boundedSteps.length);
  const [problem, setProblem] = useState('');
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  /* A step that will not go on sends the focus to what needs fixing — the
     first field that says it is invalid, else the step's problem — once the
     owner has drawn its problems. */
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const [refused, setRefused] = useState(0);
  useLayoutEffect(() => {
    if (!refused) return;
    // Controls only: a fieldset holding an invalid field is `:invalid` itself, and takes no focus.
    const invalid = panel.current?.querySelector<HTMLElement>('[aria-invalid="true"], :is(input, select, textarea):invalid');
    /* A field that says what is wrong with it is the one place that is said:
       the step's line is for a refusal no field on the step holds. Cleared
       before paint, so it never shows beside the field's own sentence. */
    if (panel.current?.querySelector('[aria-invalid="true"]')) setProblem('');
    // preventScroll: a focus that scrolls takes the page sideways toward the stepper (docs/design.md, rule 10).
    (invalid ?? said.current)?.focus({ preventScroll: true });
  }, [refused]);
  /* A new step starts at its top (rule 9), by an explicit block-axis scroll: the browser's own, after a focus, moved
     the inline axis too. */
  const arrived = useRef(current);
  useLayoutEffect(() => {
    if (arrived.current === current) return;
    arrived.current = current;
    const top = root.current?.getBoundingClientRect().top ?? 0;
    if (top < 0 || top > window.innerHeight) root.current?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'instant' });
  }, [current]);

  if (!boundedSteps.length) return null;
  const active = boundedSteps[current];
  const titleId = `${id}-title`;
  const panelId = `${id}-panel`;

  const move = async (direction: MultiStepDirection) => {
    if (pending) return;
    const target = direction === 'next' ? current + 1 : current - 1;
    if (target < 0 || target >= boundedSteps.length) return;
    setPending(true);
    setProblem('');
    try {
      // Going back only changes presentation. The owning form keeps its draft;
      // validation is required when leaving a step toward completion.
      if (direction === 'next' && validateStep && !(await validateStep(active, direction))) {
        if (mounted.current) {
          setProblem(say('reviewThisStepBefore'));
          setRefused((n) => n + 1);
        }
        return;
      }
      if (!mounted.current) return;
      if (!controlled) setOwnedStep(target);
      onStepChange?.(target, boundedSteps[target]);
    } catch {
      if (mounted.current) setProblem(say('thisStepCouldNotBeValidated'));
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const complete = async () => {
    if (pending) return;
    setPending(true);
    setProblem('');
    try {
      if (validateStep && !(await validateStep(active, 'next'))) {
        if (mounted.current) {
          setProblem(say('reviewThisStepBefore'));
          setRefused((n) => n + 1);
        }
        return;
      }
      await onComplete?.();
    } catch {
      if (mounted.current) setProblem(say('thisFormCouldNotBeCompleted'));
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const revisit = (target: number) => {
    if (pending || target >= current) return;
    if (!controlled) setOwnedStep(target);
    setProblem('');
    onStepChange?.(target, boundedSteps[target]);
  };

  const intake = style === 'intake';
  // The intake style's sheets are on their way (loadIntakeStyle): an empty, busy section holds the place.
  if (!styled) return <section ref={root} className={`multi-step-form ${className}`.trim()} data-style="intake" aria-busy="true" />;
  const last = current === boundedSteps.length - 1;
  const inDialog = presentation === 'dialog';
  /* The primary's words: the form's own on the last step, "Skip" while the step is empty and may be skipped, else the
     step's own `next`, else Continue, in either style. A host may still name its own. */
  const primaryWords = last
    ? completeLabel
    : (nextLabel ?? (intake && active.skip && isStepEmpty?.(active) ? active.skip : (active.next ?? say('continue'))));
  const heading = active.title ?? active.label;
  /* Enter in a typed answer presses the primary, as it would submit a one-page form: the step is no <form>, so nothing
     else does. A list that is open (a combobox), a box of lines, a composition in progress and a modified key keep it. */
  const enter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || ENTER_KEEPS.has(target.type)) return;
    if (target.getAttribute('role') === 'combobox' || target.getAttribute('aria-expanded') === 'true') return;
    event.preventDefault();
    void (last ? complete() : move('next'));
  };
  /* The bar and its count beside it. The count is the bar's own name said again for the eye, so it is hidden from
     assistive technology, which hears the bar's. */
  const progressRow = (
    <div className="multi-step-progress">
      <ProgressBar
        min={1}
        value={current + 1}
        max={boundedSteps.length}
        label={say('progress', { step: current + 1, count: boundedSteps.length, label: active.label })}
      />
      <span className="multi-step-count" aria-hidden="true">
        {say('stepOf', { step: current + 1, count: boundedSteps.length })}
      </span>
    </div>
  );
  const panelNode = (
    <div id={panelId} ref={panel} className="multi-step-panel" role="group" aria-labelledby={titleId} onKeyDown={enter}>
      {children(active, current)}
    </div>
  );
  const problemNode = (
    <p ref={said} tabIndex={-1} className="multi-step-problem" role="alert" aria-live="polite" hidden={!problem}>
      {problem}
    </p>
  );
  /* A page's steps beside the form (drawn, and shown only where the page is wide enough, by structure.css, so the
     first frame is the same either way). A step done is a way back to it, with its check and what it said; the step
     being answered says so; a step ahead is its name, quiet, and no Tab stop. */
  const aside =
    presentation === 'page' ? (
      <aside className="multi-step-aside">
        <nav aria-label={say('formSteps')}>
          <ol className="multi-step-list">
            {boundedSteps.map((item, index) => {
              const said = index < current ? summarize?.(item, active) : undefined;
              const mark = (
                <span className="multi-step-mark" aria-hidden="true">
                  {index < current && (
                    <svg viewBox="0 0 256 256" width="10" height="10" focusable="false">
                      <path d={CHECK} fill="currentColor" />
                    </svg>
                  )}
                </span>
              );
              return (
                <li key={item.id} className={index < current ? 'is-done' : index === current ? 'is-current' : 'is-ahead'}>
                  {index < current ? (
                    <button type="button" className="multi-step-list-item" disabled={pending} onClick={() => revisit(index)}>
                      {mark}
                      <span className="multi-step-list-label">{item.label}</span>
                      <span className="visually-hidden">{say('stepDone')}</span>
                    </button>
                  ) : (
                    <span className="multi-step-list-item" {...(index === current ? { 'aria-current': 'step' as const } : {})}>
                      {mark}
                      <span className="multi-step-list-label">{item.label}</span>
                    </span>
                  )}
                  {said && <p className="multi-step-list-said">{said}</p>}
                </li>
              );
            })}
          </ol>
        </nav>
      </aside>
    ) : null;
  // A host with its own way out (Cancel) or a dialog keeps the actions in the flow, at its foot; a page's bar sticks.
  if (intake && !inDialog && !leading) {
    return (
      <section ref={root} className={`multi-step-form ${className}`.trim()} data-style="intake" aria-labelledby={titleId}>
        {aside}
        {note}
        <div className="intake-head">
          {progressRow}
          <StepHeader id={titleId} title={heading} {...(active.lead ? { lead: active.lead } : {})} />
        </div>
        {panelNode}
        {problemNode}
        {hostSaid}
        {/* Busy rather than disabled, as the stepper's: a disabled button drops the focus it holds. */}
        <ActionBar
          className="intake-actions"
          {...(current > 0 ? { back: { label: previousLabel, onClick: () => void move('previous') } } : {})}
          primary={{
            label: primaryWords,
            onClick: () => void (last ? complete() : move('next')),
            busy: pending,
            busyLabel: last ? say('common.saving') : say('common.checking'),
          }}
        />
      </section>
    );
  }
  return (
    <section
      ref={root}
      className={`multi-step-form ${className}`.trim()}
      {...(intake ? { 'data-style': 'intake' } : {})}
      aria-labelledby={titleId}
    >
      {aside}
      {intake ? (
        <>
          {note}
          <div className="intake-head">
            {progressRow}
            <StepHeader level={2} id={titleId} title={heading} {...(active.lead ? { lead: active.lead } : {})} />
          </div>
        </>
      ) : (
        /* The stepper says where the reader is as the intake does — the bar and its count — over the step's name. Its
           row of numbered tabs was a second way to say it, and ran off a phone at three names. */
        <div className="multi-step-heading">
          {progressRow}
          <h2 id={titleId}>{active.label}</h2>
        </div>
      )}
      {panelNode}
      {problemNode}
      {hostSaid}
      {/* The step's own button says it is busy rather than going disabled: a
        disabled button drops the focus it holds, and every Next pressed from
        the keyboard left the reader on the page itself. move and complete
        already refuse a second press while one is checking. On the first
        step there is nowhere to go back to, so Back is not drawn: drawn
        disabled it still read as a way back (N05). */}
      <div className="multi-step-actions form-actions">
        {leading}
        {current > 0 && (
          <Button intent="quiet" className="multi-step-back" disabled={pending} onClick={() => void move('previous')}>
            {previousLabel}
          </Button>
        )}
        {last ? (
          <Button intent="primary" busy={pending} busyLabel={say('common.saving')} onClick={() => void complete()}>
            {primaryWords}
          </Button>
        ) : (
          <Button intent="primary" busy={pending} busyLabel={say('common.checking')} onClick={() => void move('next')}>
            {primaryWords}
          </Button>
        )}
      </div>
    </section>
  );
}
