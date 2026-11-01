/**
 * A command form, drawn: one form running one command. The same surface
 * draws a public form — the whole page, in the App's name and dress, for
 * anyone — and a signed-in form, a room of the App with its menu beside
 * it; what differs is who submits (the `submit` the host passes) and,
 * signed in, the reference inputs a directory may fill. With steps it is a
 * stepper, each step checked by the same rules before it is left — a step
 * may name a group, which is then a section of that step; without, one
 * page. Either way the whole is submitted once under a submission key held
 * in memory: a retry after a lost answer replays the same receipt, and
 * nothing typed is ever written to browser storage.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppCommandField } from '../../shared/command.js';
import type { FormStep, FormStyle } from '../../shared/formRules.js';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import type { CommandInputValue } from '../commandState.js';
import type { DraftRule } from '../../shared/commandDraft.js';
import {
  CommandFields,
  CommandLive,
  asksDraftLogic,
  blankCommandValues,
  commandInput,
  commandPathLabel,
  commandProblems,
  draftHidden,
  draftLogic,
  prefilledCommandValues,
  type CommandQuestions,
  type CommandValues,
} from './CommandFields.js';
import { commandFieldAt } from '../../shared/commandInput.js';
import { COMMAND_REFUSAL_MESSAGES, type CommandRefusalCode } from '../../shared/commandRefusals.js';
import { onDemand, useArrived } from '@mistriwork/kit/client/components/onDemand.js';
import { Button } from '@mistriwork/ui/Button.js';
import { armLeaveGuard } from './formLeaveGuard.js';
import { IntakeNote } from './IntakeNote.js';
import { answered, maskedLast4, sensitiveText, stepSaid } from './reviewValues.js';
import './FormSurface.css';
import { ReviewValue } from './ReviewValue.js';
import { say } from '../copy/forms/components/FormSurface.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import type { ChallengeWidget, FormGuard, GuardHandle } from './PublicGuard.js';

/* The stepper, its parts and the intake style's sheets are a chunk fetched for a form with steps, never by a public
   page whose form has none (the landing, sign-in, a one-page form). A step's row of fields stands in Columns, which
   comes with the stepper, so a step is never drawn without it. Neither is imported here: what a part loaded on
   demand uses of a module the first page reaches is drawn into the first page's chunk. */
const stepping = () => import('@mistriwork/kit/client/components/MultiStepForm.js');
const Columns = onDemand(() => import('@mistriwork/ui/FormParts.js'), 'Columns');
/* A public form's guard — its decoy and, where the App names one, its human check (PublicGuard.tsx) — fetched only
   by a public form, so neither a signed-in page nor a first paint carries it. */
export const PublicGuard = onDemand(() => import('./PublicGuard.js'), 'PublicGuard', { quiet: true });
const MultiStepForm = onDemand(() => Promise.all([stepping(), Columns.ready()]).then(([module]) => module), 'MultiStepForm');

/**
 * Everything a form asks beyond the fields every form has, fetched before it is first drawn, so a public form's
 * first frame is whole: the stepper (and the intake style's sheets) for a form with steps, the draft's logic for a
 * `when` or a rule, the live lines for a number that has them. A form asking none of these fetches nothing.
 */
export async function formArrives(
  form: Pick<FormPresentation, 'input' | 'steps' | 'style' | 'rules' | 'challenge' | 'components'>,
): Promise<void> {
  const fields = form.input ?? [];
  const lives = (list: readonly AppCommandField[]): boolean =>
    list.some(
      (field) => ((field.type === 'number' || field.type === 'money') && !!field.live) || (field.type === 'group' && lives(field.fields)),
    );
  await Promise.all([
    form.steps
      ? MultiStepForm.ready().then(() => (form.style === 'intake' ? stepping().then((module) => module.loadIntakeStyle()) : undefined))
      : undefined,
    asksDraftLogic(fields, form.rules) ? draftLogic.ready() : undefined,
    lives(fields) ? CommandLive.ready() : undefined,
    form.challenge ? PublicGuard.ready() : undefined,
    // The App's own input components it draws: where they are served, for the kit's slot; their code comes as drawn.
    form.components && Object.keys(form.components).length
      ? import('./sdk/publicInputs.js').then(({ installPublicInputs }) => installPublicInputs(form.components!))
      : undefined,
  ]).catch(() => {});
}

export type { CommandValues } from './CommandFields.js';

/** What the surface draws: a form's words, the inputs it asks, and its steps when it has them. */
export interface FormPresentation {
  id: string;
  label: string;
  description?: string;
  input: AppCommandField[];
  steps?: FormStep[];
  /** How the steps are drawn: the stepper (the default) or the intake style. */
  style?: FormStyle;
  /** Intake: the quiet line over the progress bar. */
  note?: { icon?: AppIconName; text: string };
  /** Intake: `false` leaves the review out; absent, the last page reviews every answer, editable. */
  review?: false;
  submitLabel?: string;
  done?: { title?: string; description?: string };
  /** The inputs a link's address may start filled. */
  prefillable?: string[];
  /** The inputs drawn by the App's own input components, by the form (`inputs`); a field may name its own (`input`). */
  inputs?: Readonly<Record<string, { id: string }>>;
  /** A public form: where each input component it draws is served (http/formRoutes.ts), loaded as it is drawn. */
  components?: Readonly<Record<string, { href: string; css?: string }>>;
  /** Saved on every step (SavedFormSurface.tsx): the inputs the submit itself asks, on the review. */
  save?: { submit: string[] };
  /** The command's rules over the draft: each is said at its field on the step that asks the last field it names. */
  rules?: readonly DraftRule[];
  /** A public form's human check (`auth.challenge`): the provider's widget, drawn in its slot (PublicGuard.tsx). */
  challenge?: ChallengeWidget;
}
/** What a submission answers: the handler's reference when it gave one, and the receipt. */
export interface FormReceipt {
  reference?: string;
  /** What the command's own result said it did, where it said one: shown in place of the form's static description. */
  message?: string;
  receipt: { id: string; status: string };
}
type SubmitForm = (submission: string, input: CommandInputValue, guard?: FormGuard) => Promise<FormReceipt>;

export async function submitPublicForm(
  id: string,
  submission: string,
  input: CommandInputValue,
  via?: string,
  guard: FormGuard = {},
): Promise<FormReceipt> {
  // `via` is the intake address the page was published with (a tenant App's);
  // the server alone decides what it means, and an ordinary App ignores it.
  let res: Response;
  try {
    res = await fetchServer(`/api/forms/${encodeURIComponent(id)}${via ? `?via=${encodeURIComponent(via)}` : ''}`, {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', ...(guard.challenge ? { 'x-mistri-challenge': guard.challenge } : {}) },
      body: JSON.stringify({ input, submission, ...(guard.trap ? { trap: guard.trap } : {}) }),
    });
  } catch {
    // No answer at all: "Failed to fetch", or the timeout's abort, is the browser's sentence, not the visitor's.
    throw new Error(say('couldNotReach'));
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* the status is the answer */
  }
  if (res.ok && typeof data.reference === 'string') return data as unknown as FormReceipt;
  const retryAfter = Number(res.headers.get('retry-after') ?? data.retryAfter);
  throw Object.assign(new Error(String(data.message || data.error || say('theFormCouldNotBeSubmitted', { status: res.status }))), {
    status: res.status,
    code: typeof data.code === 'string' ? data.code : undefined,
    field: typeof data.field === 'string' ? data.field : undefined,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}

interface Failure {
  message: string;
  code?: string;
  field?: string;
  retryAfter?: number;
  status?: number;
}

/* The platform's fixed refusals, in a visitor's words. Those are written for
   an integrator reading the API ("The command input is invalid."); a form is
   read by the person filling it in. A code whose fixed words already read so
   (sign in, the account changed) keeps them; a handler's own reason is never
   replaced — it is the one sentence written for this reader. */
const REFUSED: Partial<Record<CommandRefusalCode, () => string>> = {
  invalid_input: () => say('refusedInvalidInput'),
  command_version_mismatch: () => say('refusedVersion'),
  not_found: () => say('refusedNotFound'),
  ineligible_state: () => say('refusedIneligible'),
  forbidden: () => say('refusedForbidden'),
  idempotency_conflict: () => say('refusedKeyReused'),
  duplicate_record: () => say('refusedDuplicate'),
  stale_record: () => say('refusedStale'),
  cancelled: () => say('refusedCancelled'),
  temporarily_unavailable: () => say('refusedUnavailable'),
  row_locked: () => say('refusedLocked'),
  invalid_result: () => say('refusedUnavailable'),
};

/** What a refusal says, twice over: `beside` its field when there is one, and `alone` on the form's own line, naming where. */
interface FormRefusal {
  field?: string;
  beside: string;
  alone: string;
}

/**
 * What the person reads for a refusal. A field the server names is said as
 * the form's own rules say it, where they find the same problem — the server
 * read it by the same rules; where they do not (the handler's own check), a
 * box left unchecked is asked to be checked, and any other answer to be
 * looked at again. Away from its field the sentence says where the field is:
 * its label, its section and row. A wait is said as a wait, a dropped
 * connection as one, never the browser's words for it.
 */
export function formRefusal(failure: Failure, fields: readonly AppCommandField[], values: CommandValues = {}): FormRefusal {
  if (failure.status === 429) {
    const said = say('tooManySubmissionsFromThisAddress', { retryAfter: failure.retryAfter ?? 60 });
    return { beside: said, alone: said };
  }
  const code = failure.code as CommandRefusalCode | undefined;
  const fixed = code !== undefined && Object.hasOwn(COMMAND_REFUSAL_MESSAGES, code) && failure.message === COMMAND_REFUSAL_MESSAGES[code];
  const where = failure.field ? commandPathLabel(fields, failure.field) : undefined;
  if (failure.field && where) {
    const names = new Set(fields.map((field) => field.name));
    const own = commandProblems(fields, Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name))))[failure.field];
    const field = commandFieldAt(fields, failure.field);
    const unchecked = field?.type === 'boolean' && field.as !== 'buttons' && values[failure.field] !== true;
    const beside = own ?? (!fixed ? failure.message : unchecked ? say('checkThisBoxTo') : say('thisAnswerWasNot'));
    // A sentence that already names its field is not prefixed with the name again.
    return { field: failure.field, beside, alone: field && beside.includes(field.label) ? beside : `${where}: ${beside}` };
  }
  const said = fixed ? (REFUSED[code]?.() ?? failure.message) : failure.message;
  return { beside: said, alone: said };
}

/** The top-level names a set of fields draws: whether a refusal's field is on screen is whether its root is one. */
export const drawsField = (fields: readonly AppCommandField[], path: string | undefined): boolean =>
  path !== undefined && fields.some((field) => field.name === path.split(/[.[]/)[0]);

/**
 * Where a form starts: blank, or — from a link that fills some in, as a car's
 * page does (`?stock_ref=FC-1049`) — those inputs set. Only the inputs the
 * form names `prefillable` are read, and only as typed text: the command
 * checks them as it checks anything typed, and the reader sees them and may
 * change them. Anything else in the address is ignored, and a form that
 * names none starts blank whatever its address says.
 */
export function startingValues(
  fields: readonly AppCommandField[],
  allowed: readonly string[] = [],
  search = typeof window === 'undefined' ? '' : window.location.search,
  initial: Readonly<Record<string, unknown>> = {},
): CommandValues {
  const params = new URLSearchParams(search);
  // What the server prepared starts the form; the address's own words stand over it.
  const given: Record<string, unknown> = { ...initial };
  for (const field of fields) {
    if (!allowed.includes(field.name) || field.type === 'group' || field.type === 'boolean') continue;
    const value = params.get(field.name);
    if (value !== null && value.length <= 4000) given[field.name] = value;
  }
  return Object.keys(given).length ? prefilledCommandValues(fields, given) : blankCommandValues(fields);
}

/** The top-level field a path belongs to: `trade_ins[1].stock` is `trade_ins`'s. */
const rootOf = (path: string) => path.split(/[.[]/)[0];

const REVIEW = '#review';

/** A review lists what was answered, and what had to be: a question that could be left empty and was is left out. */
export const shownOnReview = (field: AppCommandField, value: unknown) => answered(value) || ('required' in field && !!field.required);

export function FormSurface({
  form,
  appName,
  submit,
  connection,
  visitor,
  identityEpoch = 0,
  again = false,
  prefill,
  initial,
  questions,
  onDismiss,
  homeHref,
  review = false,
  attempt,
  inDialog = false,
  checkStep,
}: {
  form: FormPresentation;
  appName: string;
  submit: SubmitForm;
  /** Optional placed-operation owner, loaded only by a placed public form. */
  attempt?: {
    submission: string;
    values?: CommandValues;
    receipt?: FormReceipt;
    locked: boolean;
    recovery?: ReactNode;
    capture(values: CommandValues): void;
  };
  /** A public form with steps: a last step reviewing every answer from this page's memory, and leaving guarded until it is sent.
      An intake form decides this itself (its own `review`, on unless it says false), signed in or not. */
  review?: boolean;
  /** Drawn in a dialog: the step's title is the dialog's heading and the actions stay at its foot. */
  inDialog?: boolean;
  /** The server's word on the steps so far, asked once the page's own check of a step passes: field path → what is
      wrong with it. A step with a problem marks its fields and does not go on. */
  checkStep?: (stepId: string, input: CommandInputValue, names: readonly string[]) => Promise<Record<string, string> | undefined>;
  /** Where the form starts, as a query string. The form's own page reads the
      address it was opened at; a form drawn over a record (FormDialog) is
      handed the same string instead, so both routes start the same way. */
  prefill?: string;
  /** A signed-in form's prepared starting values (`initial()`, `default: me`), under the address's own. */
  initial?: Readonly<Record<string, unknown>>;
  /** A signed-in form's questions defined in rows, as its prepare read them (`field.defined`). */
  questions?: CommandQuestions;
  /** Signed in: the connection a reference input's choices are read from. */
  connection?: string;
  /** A public form's App (and its intake address), where a reference input's choices are read signed out. */
  visitor?: { app: string; via?: string };
  identityEpoch?: number;
  /** Offer the form again after a receipt: a signed-in desk's next entry, never a public applicant's second application. */
  again?: boolean;
  /** Drawn in a dialog over the page the reader came from: Cancel beside the submit, and Done once received, each back to it. */
  onDismiss?: () => void;
  /** A public page's way back once received: the App's home, said as a quiet "Back to <App>" under the receipt. */
  homeHref?: string;
}) {
  const id = useId();
  const fields = form.input;
  /* A rule is judged in the browser once the draft's logic is here (CommandFields.tsx); a `when` waits in CommandFields. */
  useArrived(draftLogic, !!form.rules?.length);
  const byName = useMemo(() => new Map(fields.map((field) => [field.name, field])), [fields]);
  const [values, setValues] = useState<CommandValues>(
    () => attempt?.values ?? startingValues(fields, form.prefillable, attempt?.locked ? '' : prefill, initial),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  /* A public form's guard (PublicGuard.tsx), held while it is drawn. */
  const guarded = useRef<GuardHandle | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [submittedReceipt, setReceipt] = useState<FormReceipt | null>(null);
  const receipt = attempt?.receipt ?? submittedReceipt;
  const surface = useRef<HTMLElement>(null);
  const focusIntent = useRef<'invalid' | 'first' | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const requestFocus = (intent: 'invalid' | 'first') => {
    focusIntent.current = intent;
    setFocusRequest((before) => before + 1);
  };
  useEffect(() => {
    if (pending) return;
    const root = surface.current;
    if (receipt) {
      root?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
      return;
    }
    const intent = attempt?.recovery ? 'invalid' : focusIntent.current;
    if (!intent) return;
    focusIntent.current = null;
    const controls = 'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)';
    const invalid = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target =
      intent === 'first'
        ? root?.querySelector('.command-fields')?.querySelector<HTMLElement>(controls)
        : invalid?.matches(controls)
          ? invalid
          : invalid?.querySelector<HTMLElement>(controls);
    // Off-step server errors still have a reachable summary; the stepper owns its own validation focus.
    // preventScroll: the focus must not move the page on its inline axis (rule 10); a step arrives at its top by its own scroll.
    (target ?? root?.querySelector<HTMLElement>('.form-page-failure:not([hidden])'))?.focus({ preventScroll: true });
  }, [focusRequest, receipt, pending, Boolean(attempt?.recovery)]);
  /* One key for one filling-in. A second click after a lost answer carries
     the same key, so the server answers with the same receipt instead of a
     second submission. In memory only. */
  const submission = useRef(attempt?.submission ?? crypto.randomUUID());
  const stepFields = (step: FormStep): AppCommandField[] => step.fields.flatMap((name) => byName.get(name) ?? []);
  const intake = form.style === 'intake' && !!form.steps;
  // An intake form decides its review itself; the stepper's is the public host's to ask for.
  const reviewing = !!form.steps && (intake ? form.review !== false : review);
  const steps = useMemo(
    () =>
      form.steps && reviewing
        ? [
            ...form.steps,
            intake
              ? { id: REVIEW, label: say('review'), fields: [], title: say('reviewTitle'), lead: say('reviewLead') }
              : { id: REVIEW, label: say('review'), fields: [] },
          ]
        : form.steps,
    [form.steps, reviewing, intake],
  );
  const [current, setCurrent] = useState(0);
  /* Once anything is typed, leaving asks first, until the receipt: what was
     typed lives in this page alone, and a reload loses it. */
  const holds = (field: AppCommandField | undefined, value: unknown): boolean =>
    field?.type === 'group'
      ? JSON.stringify(value) !== JSON.stringify(blankCommandValues([field])[field.name])
      : field?.type === 'lines'
        ? // A grid's blank line is where it starts; a line with anything in it is typed.
          Array.isArray(value) && value.some((row) => Object.values((row as { values?: object }).values ?? {}).some(Boolean))
        : value !== undefined && value !== null && value !== '' && value !== false && !(Array.isArray(value) && !value.length);
  const typed = reviewing && !receipt && Object.entries(values).some(([name, value]) => holds(byName.get(name), value));
  /* A sensitive answer on the review shows its last four; Change asks for it again. The names asked for again. */
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  /* The review's steps opened by their Change, to be answered again in place. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => (typed ? armLeaveGuard(() => setValues(blankCommandValues(fields))) : undefined), [typed]);

  /** Mark every problem in these fields, groups and rows included, and clear what they no longer have. */
  const check = (checked: readonly AppCommandField[]): boolean => {
    const names = new Set(checked.map((field) => field.name));
    const found = commandProblems(checked, Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name))), questions, {
      whole: { fields, values },
      ...(form.rules ? { rules: form.rules } : {}),
    });
    setProblems((before) => ({ ...Object.fromEntries(Object.entries(before).filter(([path]) => !names.has(rootOf(path)))), ...found }));
    if (!form.steps && Object.keys(found).length) requestFocus('invalid');
    return Object.keys(found).length === 0;
  };

  const change = (next: CommandValues, path: string) => {
    if (attempt?.locked) return;
    setValues(next);
    // A changed field, or a group whose rows moved, drops what was said about it and everything under it.
    setProblems((before) =>
      Object.fromEntries(
        Object.entries(before).filter(
          ([problem]) => problem !== path && !problem.startsWith(`${path}.`) && !problem.startsWith(`${path}[`),
        ),
      ),
    );
  };

  const complete = async () => {
    if (pending || attempt?.locked) return;
    setFailure('');
    let input: CommandInputValue;
    try {
      input = commandInput(fields, values, questions, form.rules ? { rules: form.rules } : {});
    } catch (error) {
      setFailure((error as Error).message);
      requestFocus('invalid');
      return;
    }
    setPending(true);
    attempt?.capture(values);
    try {
      /* Sent in the press's own turn unless a human check's token is still on its way (PublicGuard.tsx take): a form
         closed during its send has already sent. */
      const taken = guarded.current?.take() ?? {};
      const guard = taken instanceof Promise ? await taken : taken;
      setReceipt(await submit(submission.current, input, guard));
    } catch (error) {
      const refusal = formRefusal(error as Failure, fields, values);
      /* One place for each problem: beside its field when the field is on
         screen, else the form's own line, naming it. Kept on the field too,
         so a step opened to fix it shows it there. */
      const shown = drawsField(
        // An editable review draws every step's fields again, so a refusal is beside its field wherever the field is.
        steps && !(intake && reviewing) ? stepFields(steps[steps.length - 1]) : fields,
        refusal.field,
      );
      if (refusal.field) setProblems((before) => ({ ...before, [refusal.field!]: refusal.beside }));
      if (!shown) setFailure(refusal.alone);
      requestFocus('invalid');
    } finally {
      // A token is spent once: the widget is asked for a fresh one for the next send.
      guarded.current?.reset();
      setPending(false);
    }
  };

  const startAgain = () => {
    submission.current = crypto.randomUUID();
    // The next entry starts as the first did, from what the server prepared, and not from the address.
    setValues(initial ? startingValues(fields, [], '', initial) : blankCommandValues(fields));
    setProblems({});
    setFailure('');
    setReceipt(null);
    requestFocus('first');
  };

  if (receipt) {
    const message = receipt.message ?? form.done?.description ?? (receipt.reference ? say('keepThisReference') : undefined);
    return (
      <section ref={surface} className="form-page form-page-done" aria-labelledby={`${id}-done`}>
        {!intake && <p className="eyebrow">{appName}</p>}
        <h1 id={`${id}-done`} tabIndex={-1}>
          {form.done?.title ?? say('received')}
        </h1>
        {receipt.reference && (
          <>
            <p className="form-page-reference-label">{say('yourReference')}</p>
            <p className="form-page-reference">
              <strong>{receipt.reference}</strong>
            </p>
          </>
        )}
        {message && <p className="form-page-done-message">{message}</p>}
        {again && !attempt && form.input.length > 0 && (
          <p>
            <Button intent="secondary" onClick={startAgain}>
              {say('fillInAnother')}
            </Button>
          </p>
        )}
        {onDismiss && (
          <div className="form-actions">
            <Button intent="primary" onClick={onDismiss}>
              {say('common.done')}
            </Button>
          </div>
        )}
        {/* A page has nowhere to be dismissed to: the receipt ends in a quiet way back, never a dead end. */}
        {!onDismiss && homeHref && (
          <p className="form-page-done-home">
            <a href={homeHref}>{say('backToApp', { name: appName })}</a>
          </p>
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
      disabled={pending || attempt?.locked}
      identityEpoch={identityEpoch}
      isCurrent={() => true}
      onChange={change}
      presentation={intake ? 'intake' : 'stepper'}
      whole={{ fields, values }}
      inputs={form.inputs}
      {...(connection === undefined ? {} : { connection })}
      {...(visitor === undefined ? {} : { visitor })}
      {...(questions ? { questions } : {})}
    />
  );
  const submitLabel = form.submitLabel ?? say('submit');
  /** A step's fields as it draws them: a row side by side, the rest one to a line. On the review, a sensitive answer
      is its last four and a way to ask for it again. */
  const body = (step: FormStep, onReview = false) =>
    (step.rows ?? step.fields.map((name) => [name])).map((row, index) => {
      const cells = row.map((name) => {
        const field = byName.get(name);
        if (!field) return null;
        if (onReview && sensitiveText(field) && holds(field, values[name]) && !asked.has(name))
          return (
            <div key={name} className="intake-masked">
              <span className="intake-masked-label">{field.label}</span>
              <span className="intake-masked-line">
                <span className="intake-masked-value">{maskedLast4(String(values[name]), field.mask)}</span>
                <Button
                  intent="secondary"
                  size="compact"
                  disabled={pending}
                  aria-label={say('change', { label: field.label })}
                  onClick={() => {
                    change({ ...values, [name]: '' }, name);
                    setAsked((before) => new Set(before).add(name));
                  }}
                >
                  {say('changeStep')}
                </Button>
              </span>
            </div>
          );
        return <Fragment key={name}>{controls([field])}</Fragment>;
      });
      return cells.length > 1 ? <Columns key={index}>{cells}</Columns> : <Fragment key={index}>{cells}</Fragment>;
    });
  /** The intake style's review: every step's answers as a summary under its name, and a Change that opens that
      step's fields in place, live. A step holding a problem is open, so a refusal is drawn beside its field. */
  const editableReview = () => {
    const Heading = inDialog ? 'h3' : 'h2';
    const hiddenNow = draftHidden(fields, values);
    const troubled = (step: FormStep) =>
      stepFields(step).some((field) =>
        Object.keys(problems).some(
          (key) => problems[key] && (key === field.name || key.startsWith(`${field.name}.`) || key.startsWith(`${field.name}[`)),
        ),
      );
    return (
      <div className="intake-review">
        {(form.steps ?? []).map((step, index) => {
          const open = opened.has(step.id) || troubled(step);
          return (
            <section key={step.id} className="intake-review-section" aria-labelledby={`${id}-review-${index}`}>
              <div className="intake-review-head">
                <Heading id={`${id}-review-${index}`}>{step.label}</Heading>
                {!open && (
                  <Button
                    intent="quiet"
                    disabled={pending}
                    aria-label={say('change', { label: step.label })}
                    onClick={() => setOpened((before) => new Set(before).add(step.id))}
                  >
                    {say('changeStep')}
                  </Button>
                )}
              </div>
              {open ? (
                <fieldset className="command-fields" disabled={pending}>
                  {body(step, true)}
                </fieldset>
              ) : (
                <dl className="intake-summary">
                  {stepFields(step)
                    .filter((field) => !hiddenNow.has(field.name) && shownOnReview(field, values[field.name]))
                    .map((field) => (
                      <div key={field.name}>
                        <dt>{field.label}</dt>
                        <dd>
                          <ReviewValue field={field} value={values[field.name]} />
                        </dd>
                      </div>
                    ))}
                </dl>
              )}
            </section>
          );
        })}
      </div>
    );
  };
  /** Whether a step holds nothing yet, so its primary may say "Skip". */
  const stepEmpty = (step: FormStep) => step.id !== REVIEW && stepFields(step).every((field) => !holds(field, values[field.name]));
  /** The review: every answer as this page holds it, step by step, with a way back to each. */
  const answers = () => {
    // A question the answers hide is not on the review: it is not sent.
    const hiddenNow = draftHidden(fields, values);
    let said: Record<string, unknown> = values;
    try {
      said = commandInput(fields, values);
    } catch {
      /* each step was checked on its way here */
    }
    return (
      <div className="form-review">
        {(form.steps ?? []).map((step, index) => (
          <section key={step.id} aria-labelledby={`${id}-review-${index}`}>
            <div className="form-review-head">
              <h3 id={`${id}-review-${index}`}>{step.label}</h3>
              <Button intent="quiet" size="compact" onClick={() => setCurrent(index)} aria-label={say('change', { label: step.label })}>
                {say('changeStep')}
              </Button>
            </div>
            <dl>
              {stepFields(step)
                .filter((field) => !hiddenNow.has(field.name) && shownOnReview(field, said[field.name]))
                .map((field) => (
                  <div key={field.name}>
                    <dt>{field.label}</dt>
                    <dd>
                      <ReviewValue field={field} value={said[field.name]} />
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    );
  };
  /** A step is left when the page's own check of it passes and, where the host asks the server, the server's too. On the
      editable review every step's fields are judged again, wherever they were typed. */
  const validateStep = async (step: FormStep): Promise<boolean> => {
    if (step.id === REVIEW) return !intake || check(fields);
    if (!check(stepFields(step))) return false;
    // A public form asks its own step check (formRoutes.ts) unless the host gives another way to ask.
    const ask =
      checkStep ??
      (visitor
        ? // A part of its own, fetched the first time a step is left: a form without steps never asks it.
          async (stepId: string, input: CommandInputValue) =>
            (await import('./formStepCheck.js')).checkPublicFormStep(form.id, stepId, input, visitor.via)
        : undefined);
    if (!ask) return true;
    const upTo = (form.steps ?? []).slice(0, (form.steps ?? []).findIndex((item) => item.id === step.id) + 1);
    const soFar = upTo.flatMap(stepFields);
    const found = await ask(
      step.id,
      commandInput(soFar, values, questions, { whole: { fields, values } }),
      soFar.map((field) => field.name),
    );
    if (!found || !Object.keys(found).length) return true;
    setProblems((before) => ({ ...before, ...found }));
    return false;
  };
  /* A public form's guard: the decoy a script fills and a person never meets, and the human check's slot. */
  const guard = visitor ? <PublicGuard handle={guarded} {...(form.challenge ? { widget: form.challenge } : {})} /> : null;
  /* The form's own line — what is not about a field on screen — above the
     actions, where the eye is before it presses, never under them. */
  const description = form.description ? <p className="form-page-description">{form.description}</p> : null;
  const said = (
    <p className="form-page-failure" tabIndex={-1} role="alert" aria-live="assertive" hidden={!failure}>
      {failure}
    </p>
  );
  return (
    <section
      ref={surface}
      className="form-page"
      {...(intake ? { 'data-style': 'intake', 'aria-label': form.label } : { 'aria-labelledby': `${id}-title` })}
    >
      {/* An intake form has no heading of its own: the step's title is the room's h1 (the dialog's, in a dialog), the
          form's label is the trail's last step or the tab's title, and the App is the brand row's. */}
      {!intake && <p className="eyebrow">{appName}</p>}
      {!intake && <h1 id={`${id}-title`}>{form.label}</h1>}
      {/* Said once: over a one-page form, and on a stepped form's first step only, under its title — over the bar on
          every step it was the same paragraph read again at each, pushing each question down. */}
      {!steps && description}
      {attempt?.recovery ? (
        <>
          <fieldset className="command-fields" disabled>
            {controls(fields)}
          </fieldset>
          {attempt.recovery}
        </>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && !attempt?.locked && !form.steps && check(fields)) void complete();
          }}
        >
          {steps ? (
            <MultiStepForm
              steps={steps}
              className="form-page-steps"
              completeLabel={submitLabel}
              said={said}
              onStepChange={(index: number) => {
                setFailure('');
                if (reviewing) setCurrent(index);
              }}
              {...(reviewing ? { step: current } : {})}
              validateStep={validateStep}
              onComplete={complete}
              presentation={inDialog ? 'dialog' : 'page'}
              /* What each step said, beside a page's form; nothing on the review, which says it all. */
              summarize={(step: FormStep, active: FormStep) => {
                if (active.id === REVIEW) return undefined;
                // A question the answers hide is not asked, so it says nothing where the answers are read back.
                const hidden = draftHidden(fields, values);
                return stepSaid(
                  stepFields(step).filter((field) => !hidden.has(field.name)),
                  values,
                );
              }}
              {...(intake ? { style: 'intake' as const, note: <IntakeNote note={form.note} />, isStepEmpty: stepEmpty } : {})}
            >
              {(step, index) =>
                step.id === REVIEW ? (
                  intake ? (
                    editableReview()
                  ) : (
                    answers()
                  )
                ) : (
                  <>
                    {index === 0 && description}
                    <fieldset className="command-fields">{body(step)}</fieldset>
                  </>
                )
              }
            </MultiStepForm>
          ) : (
            <>
              <fieldset className="command-fields" disabled={pending}>
                {controls(fields)}
              </fieldset>
              {guard}
              {said}
              <div className="form-actions">
                <Button intent="primary" type="submit" busy={pending || attempt?.locked} busyLabel={say('common.submitting')}>
                  {submitLabel}
                </Button>
                {onDismiss && (
                  <Button intent="secondary" disabled={pending} onClick={onDismiss}>
                    {say('common.cancel')}
                  </Button>
                )}
              </div>
            </>
          )}
          {steps && guard}
        </form>
      )}
    </section>
  );
}
