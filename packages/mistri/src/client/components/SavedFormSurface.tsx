/**
 * A public form saved on every step, drawn. Each Next saves the step into the
 * App's own tables (savedFormApi.ts); the last step is the review, and the
 * submit finishes the application.
 *
 * The server never answers back what was typed — not the earlier steps, not
 * with the cookie — so the review is drawn from this page's memory alone:
 * each step's answers as they were sent, held in React state and nowhere
 * else. No storage API, no address, no cache ever holds them. After a reload
 * the server still has the saved steps and the page no longer has their
 * values: the review says so ("Saved — not shown for your privacy"), offers
 * Change to enter them again, and still lets the applicant submit.
 *
 * While anything is held or saved and not yet submitted, leaving is guarded:
 * the platform's own exit guard in the App, the browser's prompt outside it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AppCommandField } from '../../shared/command.js';
import type { FormStep } from '../../shared/formRules.js';
import {
  CommandFields,
  blankCommandValues,
  commandInput,
  commandProblems,
  prefilledCommandValues,
  type CommandValues,
} from './CommandFields.js';
import { PHONE_QUERY, useMediaQuery } from '@mistriwork/kit/client/components/useMediaQuery.js';
import { MultiStepForm } from '@mistriwork/kit/client/components/MultiStepForm.js';
import { Button, ButtonLink } from '@mistriwork/ui/Button.js';
import {
  drawsField,
  formRefusal,
  PublicGuard,
  shownOnReview,
  submitPublicForm,
  type FormPresentation,
  type FormReceipt,
} from './FormSurface.js';
import type { GuardHandle } from './PublicGuard.js';
import {
  answerClaim,
  confirmEmailProof,
  intakeAddress,
  saveStep,
  savedSteps,
  sendEmailProof,
  type SavedFormFailure,
} from './savedFormApi.js';
import { armLeaveGuard } from './formLeaveGuard.js';
import type { DraftTransport } from './draftFormApi.js';
import { Field } from '@mistriwork/ui/Field.js';
import { IntakeNote } from './IntakeNote.js';
import { appWord } from '@mistriwork/kit/client/messages.js';
import { say } from '../copy/forms/components/SavedFormSurface.js';

export { sayInput } from './reviewValues.js';
import './FormSurface.css';
import { ReviewValue } from './ReviewValue.js';

/** A saved form's presentation: its steps, which inputs the submit itself asks on the review, and what follows it. */
export type SavedFormPresentation = FormPresentation & {
  steps: FormStep[];
  save: { submit: string[]; statusCheck?: unknown; link?: { sameDevice?: true; statusCheck?: true; email?: { prove?: string } } };
};

const REVIEW = '#review';
const PRIVATE = say('savedNotShownForYourPrivacy');
const GONE = say('thisApplicationCanNoLonger');

/** Whether the step's answers are all still blank: a saved step left as it is keeps what the server has. */
function untouched(fields: readonly AppCommandField[], values: CommandValues): boolean {
  return fields.every((field) => {
    const value = values[field.name];
    if (field.type === 'group')
      return Array.isArray(value) ? value.length === 0 : !value || untouched(field.fields, value as CommandValues);
    return value === undefined || value === '' || value === false;
  });
}

/**
 * On the review, optional: prove the address typed is the applicant's with a
 * code sent to it. An account with that email then finds the application and
 * adds it without asking (formLink.ts); unproved, it asks first.
 */
function EmailProof({ form, typed }: { form: string; typed: string }) {
  const id = useId();
  const [email, setEmail] = useState(typed);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setFailure('');
    try {
      await work();
    } catch (error) {
      setFailure((error as SavedFormFailure).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="form-proof" aria-labelledby={`${id}-proof`}>
      <h3 id={`${id}-proof`}>{say('confirmYourEmail')}</h3>
      {done ? (
        <p role="status">{say('isConfirmedAnAccount', { email: email.trim() })}</p>
      ) : (
        <>
          <p>{say('optionalWeEmailACode')}</p>
          <Field label={say('common.email')}>
            <input
              className="field-control"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
                setSent(false);
              }}
            />
          </Field>
          {sent && (
            <Field label={say('codeFromTheEmail')}>
              <input
                className="field-control"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.currentTarget.value)}
              />
            </Field>
          )}
          <div className="form-claim-actions">
            {sent && (
              <Button
                intent="secondary"
                size="compact"
                busy={pending}
                onClick={() =>
                  void run(async () => {
                    await confirmEmailProof(form, email.trim(), code.trim());
                    setDone(true);
                  })
                }
              >
                {say('confirm')}
              </Button>
            )}
            <Button
              intent={sent ? 'quiet' : 'secondary'}
              size="compact"
              busy={pending && !sent}
              onClick={() =>
                void run(async () => {
                  await sendEmailProof(form, email.trim());
                  setSent(true);
                  setCode('');
                })
              }
            >
              {sent ? say('sendAnotherCode') : say('emailMeACode')}
            </Button>
          </div>
        </>
      )}
      <p className="form-page-failure" role="alert" hidden={!failure}>
        {failure}
      </p>
    </section>
  );
}

export function SavedFormSurface({
  form,
  appName,
  base,
  draft,
  onDismiss,
  at,
  language,
}: {
  form: SavedFormPresentation;
  /** The step a page asked to open at (`useForm(...).goTo`): honored only up to the first step not yet saved, so no step is skipped. */
  at?: string;
  /** Opened in a dialog (FormRoom): Cancel beside the steps and Done on the receipt close it, as FormSurface's do. */
  onDismiss?: () => void;
  /** A signed-in form's own server (draftFormApi.ts): the person's draft, found by who they are, instead of a cookie's. */
  draft?: DraftTransport;
  appName: string;
  /** The form's own address (`/{app}/form/{key}`): its status check and account pages are under it. */
  base?: string;
  /** The visitor's pick of language as it stands when a step or the submit is sent (publicForm.js `pickedLanguage`),
      which the form's requests name in their address, as its read does. Absent: none is named. */
  language?: () => string | undefined;
}) {
  const id = useId();
  /* A saved draft's note is one line on a phone, with Start over beside it: the page's room goes to the fields. */
  const phone = useMediaQuery(PHONE_QUERY);
  const byName = useMemo(() => new Map(form.input.map((field) => [field.name, field])), [form.input]);
  const fieldsOf = (names: readonly string[]) => names.flatMap((name) => byName.get(name) ?? []);
  const submitFields = fieldsOf(form.save.submit);
  const steps = useMemo(
    () => [
      ...form.steps,
      form.style === 'intake'
        ? { id: REVIEW, label: say('review'), fields: form.save.submit, title: say('reviewTitle'), lead: say('reviewLead') }
        : { id: REVIEW, label: say('review'), fields: form.save.submit },
    ],
    [form.steps, form.save.submit, form.style],
  );
  const intake = form.style === 'intake';
  const [values, setValues] = useState<CommandValues>(() => blankCommandValues(form.input));
  /** Each step's answers as they were saved, by step: memory only. */
  const [held, setHeld] = useState<Record<string, Record<string, unknown>>>({});
  /** The steps the server has, by id; null until the resume has answered. */
  const [saved, setSaved] = useState<string[] | null>(null);
  const [current, setCurrent] = useState(0);
  /** A step opened by Change on the review: its Next goes back to the review. */
  const [changing, setChanging] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [receipt, setReceipt] = useState<FormReceipt | null>(null);
  /** Counts refusals at the submit, which the stepper does not see: each sends the focus to what needs fixing. */
  const [refusedAt, setRefusedAt] = useState(0);
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!refusedAt) return;
    (
      page.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      page.current?.querySelector<HTMLElement>('.form-page-failure:not([hidden])')
    )?.focus();
  }, [refusedAt]);
  /** The done screen's "This is a shared device": the claim is burned, and said so. */
  const [shared, setShared] = useState<'no' | 'burning' | 'burned'>('no');
  /* One key per attempt at a step: a retry after a lost answer carries the
     same one, and the server replays rather than saving twice. */
  const keys = useRef(new Map<string, string>());
  /* The App's human check (PublicGuard.tsx): a fresh token for every step and the submit, each asked after an answer. */
  const guarded = useRef<GuardHandle | undefined>(undefined);
  const token = async () => (await guarded.current?.take())?.challenge;
  /** The draft's version the review was shown at: the submit carries it back, and one changed since is refused. */
  const [version, setVersion] = useState<string | null>(null);
  /** Counts reviews asked again after a refusal as stale. */
  const [reviewed, setReviewed] = useState(0);
  const keyFor = (step: string) => {
    // A signed-in form keeps the key in flight across a reload (draftFormApi.ts), so the server is asked, not written to twice.
    if (draft) return draft.keyFor(step);
    let key = keys.current.get(step);
    if (!key) keys.current.set(step, (key = crypto.randomUUID()));
    return key;
  };

  useEffect(() => {
    let live = true;
    const resumed = draft
      ? draft.resume().then((found) => ({ list: found?.saved ?? [], reopen: found?.reopen ?? null, answers: found?.values }))
      : savedSteps(form.id).then((list) => ({ list, reopen: null as string | null, answers: undefined }));
    resumed.then(
      ({ list, reopen, answers }) => {
        if (!live) return;
        // A signed-in draft comes back with what it holds: the steps start from it, and the review shows it all.
        if (answers && Object.keys(answers).length) {
          const prefilled = prefilledCommandValues(form.input, answers);
          const earlier: Record<string, Record<string, unknown>> = {};
          for (const step of form.steps) {
            const fields = fieldsOf(step.fields);
            if (!list.includes(step.id) || !fields.some((field) => Object.hasOwn(answers, field.name))) continue;
            try {
              earlier[step.id] = commandInput(fields, prefilled);
            } catch {
              // A step the saved answers no longer complete is asked again, not reviewed.
            }
          }
          setValues(prefilled);
          setHeld(earlier);
        }
        // What the server already has needs no retry: its keys are spent, and a changed step is a new attempt.
        if (draft) for (const id of list) draft.clearKey(id);
        setSaved(list);
        // Resumed: on at the step today's rules reopen, else the first not saved, or the review when all are.
        const reopened = reopen === null ? -1 : steps.findIndex((step) => step.id === reopen);
        const onward = list.length
          ? reopened >= 0
            ? reopened
            : Math.max(
                0,
                steps.findIndex((step) => step.id === REVIEW || !list.includes(step.id)),
              )
          : 0;
        const asked = at === undefined ? -1 : steps.findIndex((step) => step.id === at);
        setCurrent(asked >= 0 && asked <= onward ? asked : onward);
      },
      () => {
        if (live) setSaved([]);
      },
    );
    return () => {
      live = false;
    };
    // `at` is where the form opened, read once with the draft: a page asking again opens the form again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id, steps, draft]);

  const atReview = steps[current]?.id === REVIEW;
  useEffect(() => {
    if (!draft || !atReview || saved === null) return;
    let live = true;
    setVersion(null);
    draft.review().then(
      (hash) => {
        if (live) setVersion(hash);
      },
      (error: unknown) => {
        if (!live) return;
        // Gone is said as gone; anything else leaves Submit with no version to carry, and the person is told so.
        if ((error as SavedFormFailure).status === 404) refused(error, []);
        else setFailure(say('reviewNotRead'));
      },
    );
    return () => {
      live = false;
    };
    // `refused` reads this render's state only to say a failure; a review is asked on arrival and again after a stale refusal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, atReview, saved === null, reviewed]);

  const forget = () => {
    setHeld({});
    setValues(blankCommandValues(form.input));
  };
  const armed = !draft && !receipt && (Object.keys(held).length > 0 || (saved?.length ?? 0) > 0);
  // pagehide drops the answers the page holds: a page kept in the back-forward cache keeps none.
  useEffect(() => (armed ? armLeaveGuard(forget) : undefined), [armed]);

  const check = (fields: readonly AppCommandField[]): boolean => {
    const names = new Set(fields.map((field) => field.name));
    const found = commandProblems(fields, Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name))));
    setProblems((before) => ({
      ...Object.fromEntries(Object.entries(before).filter(([path]) => !names.has(path.split(/[.[]/)[0]))),
      ...found,
    }));
    return Object.keys(found).length === 0;
  };
  const change = (next: CommandValues, path: string) => {
    setValues(next);
    setProblems((before) =>
      Object.fromEntries(
        Object.entries(before).filter(
          ([problem]) => problem !== path && !problem.startsWith(`${path}.`) && !problem.startsWith(`${path}[`),
        ),
      ),
    );
  };
  const refused = (error: unknown, fields: readonly AppCommandField[]) => {
    const failed = error as SavedFormFailure;
    if (failed.gone) {
      // Forged, expired or finished: the server has nothing for this browser any more.
      keys.current.clear();
      draft?.clearKeys();
      forget();
      setSaved([]);
      setCurrent(0);
      setFailure(GONE);
      return;
    }
    if (draft && failed.code === 'stale_record') {
      // Changed on another tab or device since the review: nothing was submitted, and the review is read again.
      setFailure(say('draftChangedElsewhere'));
      setReviewed((before) => before + 1);
      setRefusedAt((before) => before + 1);
      return;
    }
    /* One place for each problem: a refusal about a field on this step is
       said beside it, and only there; anything else is the form's line. */
    const refusal = formRefusal(failed, form.input, values);
    if (refusal.field) setProblems((before) => ({ ...before, [refusal.field!]: refusal.beside }));
    if (!drawsField(fields, refusal.field)) setFailure(refusal.alone);
    setRefusedAt((before) => before + 1);
  };

  /** Next on a step: check it here, save it there, and hold what was sent for the review. */
  const leave = async (step: FormStep): Promise<boolean> => {
    if (step.id === REVIEW) return true;
    setFailure('');
    const fields = fieldsOf(step.fields);
    // A saved step whose answers this page no longer has, left blank: the server keeps what it has.
    if (saved?.includes(step.id) && !held[step.id] && untouched(fields, values)) return true;
    if (!check(fields)) return false;
    let input: Record<string, unknown>;
    try {
      input = commandInput(fields, values);
    } catch (error) {
      setFailure((error as Error).message);
      return false;
    }
    try {
      if (draft) await draft.step(step.id, keyFor(step.id), input);
      else await saveStep(form.id, step.id, keyFor(step.id), input, await token(), language?.());
    } catch (error) {
      refused(error, fields);
      return false;
    } finally {
      guarded.current?.reset();
    }
    keys.current.delete(step.id);
    draft?.clearKey(step.id);
    setHeld((before) => ({ ...before, [step.id]: input }));
    setSaved((before) => [...new Set([...(before ?? []), step.id])]);
    return true;
  };

  const complete = async () => {
    setFailure('');
    const missing = form.steps.findIndex((step) => !saved?.includes(step.id));
    if (missing >= 0) {
      setCurrent(missing);
      setFailure(say('saveThisStepBefore'));
      return;
    }
    if (!check(submitFields)) {
      setRefusedAt((before) => before + 1);
      return;
    }
    try {
      const input = commandInput(submitFields, values);
      let answer: FormReceipt;
      if (draft) {
        /* The review has not answered yet: there is no version to carry, so nothing is sent on a guess. The person is
           told, and the review is asked again, so the next Submit has one. */
        if (version === null) {
          setFailure(say('reviewNotReady'));
          setReviewed((before) => before + 1);
          return;
        }
        answer = await draft.submit(keyFor(REVIEW), input, version);
        draft.clearKeys();
      } else {
        const challenge = await token();
        answer = await submitPublicForm(form.id, keyFor(REVIEW), input, intakeAddress(), challenge ? { challenge } : {}, language?.());
      }
      // Received: the page lets go of every answer it held.
      keys.current.clear();
      forget();
      setReceipt(answer);
    } catch (error) {
      // Refused for certain: the key is spent on nothing, and the draft is no longer a submit in flight (Start over, `useForm`).
      if ((error as { outcome?: unknown }).outcome === 'not_applied') draft?.clearKey(REVIEW);
      refused(error, submitFields);
    } finally {
      guarded.current?.reset();
    }
  };

  if (receipt) {
    // The receipt and fixed words: nothing typed is shown back, here either.
    const message = receipt.message ?? form.done?.description ?? (receipt.reference ? say('keepThisReference') : undefined);
    return (
      <section className="form-page form-page-done" aria-labelledby={`${id}-done`}>
        <p className="eyebrow">{appName}</p>
        <h1 id={`${id}-done`} tabIndex={-1} ref={(node) => node?.focus()}>
          {form.done?.title ?? say('received')}
        </h1>
        {receipt.reference && (
          <>
            <p className="form-page-reference-label">{appWord('mistri.form.reference', say('yourReference'))}</p>
            <p className="form-page-reference">
              <strong>{receipt.reference}</strong>
            </p>
          </>
        )}
        {message && <p className="form-page-done-message">{message}</p>}
        {base && form.save.link?.sameDevice && (
          <section className="form-claim" aria-labelledby={`${id}-claim`}>
            <h2 id={`${id}-claim`}>{say('followItInAnAccount')}</h2>
            {shared === 'burned' ? (
              <p className="form-page-done-message" role="status">
                {say('thisBrowserCanNoLonger')}
              </p>
            ) : (
              <>
                <p className="form-page-done-message">{say('claimWindow')}</p>
                <div className="form-claim-actions">
                  <ButtonLink intent="primary" href={`${base}/claim?account=new`}>
                    {say('createAnAccountToTrack')}
                  </ButtonLink>
                  <ButtonLink intent="secondary" href={`${base}/claim`}>
                    {say('signInToAdd')}
                  </ButtonLink>
                </div>
                <Button
                  intent="quiet"
                  size="compact"
                  busy={shared === 'burning'}
                  onClick={() => {
                    setShared('burning');
                    // Burned whether or not the answer arrives: the next person here must not inherit it.
                    answerClaim(form.id, 'no').finally(() => setShared('burned'));
                  }}
                >
                  {say('thisIsAShared')}
                </Button>
              </>
            )}
          </section>
        )}
        {base && form.save.statusCheck !== undefined && (
          <p className="form-page-done-message">
            <a href={`${base}/status`}>{say('checkItsStatus')}</a> {say('anyTimeWithYourReference')}
          </p>
        )}
        {onDismiss && (
          <div className="form-actions">
            <Button intent="primary" onClick={onDismiss}>
              {say('common.done')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const controls = (list: readonly AppCommandField[]) => (
    <CommandFields
      fields={list}
      values={values}
      problems={problems}
      idPrefix={id}
      disabled={false}
      identityEpoch={0}
      isCurrent={() => true}
      onChange={change}
      inputs={form.inputs}
    />
  );
  const review = () => (
    <div className="form-review">
      {form.steps.map((step, index) => {
        const answers = held[step.id];
        return (
          <section key={step.id} aria-labelledby={`${id}-review-${index}`}>
            <div className="form-review-head">
              <h3 id={`${id}-review-${index}`}>{step.label}</h3>
              <Button
                intent="quiet"
                size="compact"
                onClick={() => {
                  setFailure('');
                  setChanging(true);
                  setCurrent(index);
                }}
                aria-label={say('change', { label: step.label })}
              >
                {say('changeStep')}
              </Button>
            </div>
            {answers ? (
              <dl>
                {fieldsOf(step.fields)
                  .filter((field) => shownOnReview(field, answers[field.name]))
                  .map((field) => (
                    <div key={field.name}>
                      <dt>{field.label}</dt>
                      <dd>
                        <ReviewValue field={field} value={answers[field.name]} />
                      </dd>
                    </div>
                  ))}
              </dl>
            ) : (
              <p>{saved?.includes(step.id) ? (draft ? say('savedEarlier') : PRIVATE) : say('notSavedYet')}</p>
            )}
          </section>
        );
      })}
      {form.save.link?.email?.prove && (
        <EmailProof
          form={form.id}
          typed={String(
            Object.values(held).find((answers) => typeof answers[form.save.link!.email!.prove!] === 'string')?.[
              form.save.link.email.prove
            ] ?? '',
          )}
        />
      )}
      {submitFields.length > 0 && <fieldset className="command-fields">{controls(submitFields)}</fieldset>}
    </div>
  );

  const resumed = (saved?.length ?? 0) > 0 && !Object.keys(held).length;
  return (
    <section
      ref={page}
      className="form-page"
      {...(intake ? { 'data-style': 'intake', 'aria-label': form.label } : { 'aria-labelledby': `${id}-title` })}
    >
      {!intake && <p className="eyebrow">{appName}</p>}
      {!intake && <h1 id={`${id}-title`}>{form.label}</h1>}
      {/* The description is the first step's alone (FormSurface's rule): over the bar it was read again on every step. */}
      {/* A signed-in draft is the person's own and is said only once there is one; the public note explains the privacy. */}
      {(!draft || (saved?.length ?? 0) > 0) && (
        <p className={draft && phone ? 'form-note form-note-compact' : 'form-note'}>
          {draft ? (
            phone ? (
              <span className="form-note-text">{say('yourDraftIsSavedShort')}</span>
            ) : (
              say('yourDraftIsSaved')
            )
          ) : resumed ? (
            say('yourApplicationIsSaved')
          ) : (
            say('eachStepIsSaved')
          )}
          {draft && (
            <>
              {' '}
              <Button
                intent="quiet"
                size="compact"
                onClick={() => {
                  /* A submit sent and not yet known to have landed keeps its draft: discarding it could lose what the
                     server has already taken. Submit again (the same key) to learn how it ended. */
                  if (draft.holds(REVIEW)) {
                    setFailure(say('submitNotSettled'));
                    return;
                  }
                  // One click, and the draft and its rows are gone: the first step again, blank.
                  void draft.discard().then(
                    () => {
                      draft.clearKeys();
                      forget();
                      setSaved([]);
                      setCurrent(0);
                      setChanging(false);
                      setFailure('');
                    },
                    (error: unknown) => setFailure((error as Error).message),
                  );
                }}
              >
                {say('startOver')}
              </Button>
            </>
          )}
        </p>
      )}
      {saved === null ? (
        <p className="form-page-description" role="status">
          {say('checkingForAnApplication')}
        </p>
      ) : (
        <form noValidate onSubmit={(event) => event.preventDefault()}>
          <PublicGuard handle={guarded} {...(form.challenge ? { widget: form.challenge } : {})} />
          <MultiStepForm
            steps={steps}
            step={current}
            className="form-page-steps"
            onStepChange={(index) => {
              const back = changing && index > current;
              setChanging(false);
              setFailure('');
              setCurrent(back ? steps.length - 1 : index);
            }}
            completeLabel={form.submitLabel ?? say('submit')}
            validateStep={(step) => leave(step)}
            onComplete={complete}
            {...(intake ? { style: 'intake' as const, note: <IntakeNote note={form.note} /> } : {})}
            said={
              <p className="form-page-failure" tabIndex={-1} role="alert" aria-live="assertive" hidden={!failure}>
                {failure}
              </p>
            }
          >
            {(step, index) =>
              step.id === REVIEW ? (
                review()
              ) : (
                <>
                  {index === 0 && form.description && <p className="form-page-description">{form.description}</p>}
                  <fieldset className="command-fields">{controls(fieldsOf(step.fields))}</fieldset>
                </>
              )
            }
          </MultiStepForm>
        </form>
      )}
      {/* The draft is kept as it stands: closing the dialog loses nothing a step has saved. */}
      {onDismiss && (
        <div className="form-actions">
          <Button intent="secondary" onClick={onDismiss}>
            {say('common.cancel')}
          </Button>
        </div>
      )}
    </section>
  );
}
