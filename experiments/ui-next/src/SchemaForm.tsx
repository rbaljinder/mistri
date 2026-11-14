import { type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { Button } from './Button';
import { CheckCardsField, YesNoField } from './choices';
import { ReviewList, StepHeader } from './display';
import {
  ActionBar,
  ChoiceField,
  DateField,
  MoneyField,
  NumberField,
  type Option,
  SelectField,
  SensitiveField,
  SwitchField,
  TextAreaField,
  TextField,
} from './fields';
import { type FormAnswers, FormProblems, type FormRefusal } from './Form';
import { MaskedField } from './MaskedField';
import { type MaskName, masks } from './masks';
import { TimeField } from './time';
import { words } from './words';

/* A form drawn from a description of it. A page that asks six questions should not have to write six fields, the
   rule for which of them show, the step they are on, what is checked when, and where the keyboard goes: it says
   what it asks, and this is the rest.

   - Each question is one of the library's fields, by its `kind`.
   - A question may depend on an answer (`when`). One that is not asked is not checked and is not sent.
   - Questions may be in steps. A step is checked when the reader leaves it forward, never before, and Back never
     loses what was answered. Arriving on a step puts the keyboard on its name, so the step is read out.
   - With `review`, the last thing before sending is every answer, each with the way back to change it.
   - Whatever takes the answers may refuse some: the form goes to the step of the first one refused and puts the
     keyboard on it. */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'date'
  | 'time'
  | 'select'
  | 'choice'
  | 'yesno'
  | 'checks'
  | 'switch'
  | 'masked'
  | 'sensitive';

export type FieldSpec = {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: ReactNode;
  tip?: ReactNode;
  /* For `select`, `choice` and `checks`. */
  options?: Option[];
  /* For `masked`. */
  mask?: MaskName;
  maxLength?: number;
  /* For `number` and `money` (numbers) and for `date` (days, as `YYYY-MM-DD`). */
  min?: number | string;
  max?: number | string;
  /* The most that may be ticked, for `checks`. */
  most?: number;
  /* What it starts as. Several values of `checks` are joined by commas. */
  initial?: string;
  /* Whether it is asked, given the answers so far. Asked always when left out. */
  when?: (answers: FormAnswers) => boolean;
  /* A rule of the page's own: what is wrong with the answer, or nothing. */
  check?: (answer: string, answers: FormAnswers) => string | undefined;
};

export type FormStep = { id: string; title: string; lead?: ReactNode; fields: FieldSpec[] };

export type SchemaFormProps = {
  label: string;
  /* The questions, in one step or several. */
  fields?: FieldSpec[];
  steps?: FormStep[];
  /* Shows every answer, each with the way back to it, before anything is sent. */
  review?: boolean;
  /* Takes the answers. Returns nothing when they were taken, or what was refused. */
  submit: (answers: FormAnswers) => Promise<FormRefusal | undefined | void> | FormRefusal | undefined | void;
  /* What the last button says. */
  send?: string;
  /* Hears whether anything has been answered: what a sheet's `unsaved` wants. */
  onTouchedChange?: (touched: boolean) => void;
};

const asked = (spec: FieldSpec, answers: FormAnswers): boolean => spec.when?.(answers) ?? true;

/* What an answer reads as, for the review: an option's own words, a yes or a no, a secret kept. */
function said(spec: FieldSpec, answer: string | undefined): ReactNode {
  if (!answer) return '—';
  const named = (value: string) => spec.options?.find((option) => option.value === value)?.label ?? value;
  switch (spec.kind) {
    case 'select':
    case 'choice':
      return named(answer);
    case 'checks':
      return answer.split(',').map(named).join(', ');
    case 'yesno':
      return answer === 'yes' ? words.yes : words.no;
    case 'switch':
      return answer === 'on' ? words.yes : words.no;
    case 'sensitive':
      return '•'.repeat(Math.min(answer.length, 8));
    // What was kept is said back the way it was typed: a phone in its brackets, money as money, a day as a day.
    case 'masked':
      return masks[spec.mask ?? 'digits'].format(answer);
    case 'money':
      return Number(answer).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    case 'number':
      return Number(answer).toLocaleString();
    case 'date':
      return new Date(`${answer}T00:00`).toLocaleDateString(undefined, { dateStyle: 'long' });
    default:
      return answer;
  }
}

function wrong(spec: FieldSpec, answers: FormAnswers): string | undefined {
  const answer = answers[spec.name]?.trim() ?? '';
  if (!answer || (spec.kind === 'switch' && answer !== 'on')) {
    if (spec.required) return `${spec.label} is needed.`;
    if (!answer) return undefined;
  }
  if (spec.kind === 'number' || spec.kind === 'money') {
    const amount = Number(answer);
    if (Number.isNaN(amount)) return `${spec.label} is a number.`;
    if (typeof spec.min === 'number' && amount < spec.min) return `No less than ${spec.min}.`;
    if (typeof spec.max === 'number' && amount > spec.max) return `No more than ${spec.max}.`;
  }
  return spec.check?.(answer, answers);
}

function Question({ spec, answer, problem }: { spec: FieldSpec; answer: string | undefined; problem: string | undefined }) {
  const common = { label: spec.label, name: spec.name, hint: spec.hint, tip: spec.tip, required: spec.required, error: problem };
  const number = answer === undefined || answer === '' ? undefined : Number(answer);
  switch (spec.kind) {
    case 'textarea':
      return <TextAreaField {...common} defaultValue={answer} maxLength={spec.maxLength} />;
    case 'number':
      return (
        <NumberField
          {...common}
          defaultValue={number}
          min={Number(spec.min ?? NaN) || undefined}
          max={Number(spec.max ?? NaN) || undefined}
        />
      );
    case 'money':
      return <MoneyField {...common} defaultValue={number} />;
    case 'date':
      return (
        <DateField
          {...common}
          defaultValue={answer}
          min={typeof spec.min === 'string' ? spec.min : undefined}
          max={typeof spec.max === 'string' ? spec.max : undefined}
        />
      );
    case 'time':
      return <TimeField {...common} defaultValue={answer} />;
    case 'select':
      return <SelectField {...common} options={spec.options ?? []} defaultValue={answer} placeholder="Choose" />;
    case 'choice':
      return <ChoiceField {...common} options={spec.options ?? []} defaultValue={answer} />;
    case 'yesno':
      return <YesNoField {...common} defaultValue={answer === 'yes' ? true : answer === 'no' ? false : null} />;
    case 'checks':
      return <CheckCardsField {...common} options={spec.options ?? []} defaultValue={answer ? answer.split(',') : []} max={spec.most} />;
    case 'switch':
      return <SwitchField label={spec.label} name={spec.name} hint={spec.hint} defaultChecked={answer === 'on'} />;
    case 'masked':
      return <MaskedField {...common} mask={spec.mask ?? 'digits'} defaultValue={answer} />;
    case 'sensitive':
      return <SensitiveField {...common} defaultValue={answer} />;
    default:
      return <TextField {...common} defaultValue={answer} maxLength={spec.maxLength} />;
  }
}

export function SchemaForm({ label, fields, steps, review, submit, send = 'Send', onTouchedChange }: SchemaFormProps) {
  const pages: FormStep[] = steps ?? [{ id: 'all', title: label, fields: fields ?? [] }];
  const every = pages.flatMap((page) => page.fields);
  const form = useRef<HTMLFormElement>(null);
  const [answers, setAnswers] = useState<FormAnswers>(() =>
    Object.fromEntries(every.flatMap((spec) => (spec.initial === undefined ? [] : [[spec.name, spec.initial]]))),
  );
  /* The step shown: a page of questions, or the review after the last of them. */
  const [at, setAt] = useState(0);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reviewing = review === true && at === pages.length;
  const page = pages[Math.min(at, pages.length - 1)]!;

  /* What the form holds now: what was answered on other steps, with this step's fields read off the page. Several
     values under one name (ticked cards) are joined by commas; a field that is on the page and sends nothing (a
     switch that is off, cards with none ticked) is an answer of nothing, not one left over from before. */
  const read = useCallback((): FormAnswers => {
    const next = { ...answers };
    if (!form.current) return next;
    const sent = new FormData(form.current);
    for (const spec of page.fields) {
      if (!form.current.querySelector(`[name="${CSS.escape(spec.name)}"]`)) continue;
      const values = sent.getAll(spec.name).filter((value): value is string => typeof value === 'string');
      next[spec.name] = values.join(',');
    }
    return next;
  }, [answers, page]);

  const focus = useCallback((name: string) => {
    const named = form.current?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`);
    const field = named?.closest('[data-slot="field"]');
    const target =
      named?.matches('input:not([type="hidden"]), textarea') && !named.hasAttribute('hidden')
        ? named
        : field?.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([hidden]), textarea, [role="combobox"], [role="radio"], [role="checkbox"], button',
          );
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }, []);

  /* The problems of the questions a step asks, given every answer. */
  const check = (step: FormStep, held: FormAnswers): Record<string, string> =>
    Object.fromEntries(
      step.fields
        .filter((spec) => asked(spec, held))
        .flatMap((spec) => {
          const problem = wrong(spec, held);
          return problem ? [[spec.name, problem]] : [];
        }),
    );

  const refuse = (found: Record<string, string>, said?: string) => {
    setProblems(found);
    setMessage(said);
    const first = every.find((spec) => found[spec.name]);
    if (!first) return;
    const where = pages.findIndex((step) => step.fields.includes(first));
    if (where >= 0 && where !== at) setAt(where);
    requestAnimationFrame(() => requestAnimationFrame(() => focus(first.name)));
  };

  const forward = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const held = read();
    setAnswers(held);
    if (!reviewing) {
      const found = check(page, held);
      if (Object.keys(found).length) return refuse(found);
      setProblems({});
      setMessage(undefined);
      if (at < pages.length - 1 || review) return setAt(at + 1);
    }
    // Only what was asked is sent: an answer to a question that is no longer asked is not an answer.
    const sent = Object.fromEntries(every.filter((spec) => asked(spec, held)).map((spec) => [spec.name, held[spec.name] ?? '']));
    setBusy(true);
    void Promise.resolve()
      .then(() => submit(sent))
      .then(
        (refusal) => {
          if (refusal && (refusal.message || Object.keys(refusal.fields ?? {}).length)) refuse({ ...refusal.fields }, refusal.message);
          else onTouchedChange?.(false);
        },
        (thrown: unknown) => refuse({}, thrown instanceof Error ? thrown.message : 'It could not be sent. Try again.'),
      )
      .finally(() => setBusy(false));
  };

  /* A change re-reads the page, so a question that depends on this answer comes or goes at once, and takes the
     changed field's problem away. */
  const changed = (event: FormEvent<HTMLFormElement>) => {
    onTouchedChange?.(true);
    setAnswers(read());
    const name =
      (event.target as Element).getAttribute('name') ??
      (event.target as Element).closest('[data-slot="field"]')?.querySelector('[name]')?.getAttribute('name');
    if (name && problems[name]) setProblems(({ [name]: _gone, ...rest }) => rest);
  };

  const stepped = pages.length > 1 || review === true;
  const total = pages.length + (review ? 1 : 0);
  const shown = page.fields.filter((spec) => asked(spec, answers));

  return (
    <form
      ref={form}
      data-slot="form"
      data-kind="schema"
      aria-label={label}
      aria-busy={busy || undefined}
      noValidate
      onSubmit={forward}
      onInput={changed}
      onChange={changed}
    >
      {stepped && (
        <StepHeader
          arrive
          step={at + 1}
          of={total}
          title={reviewing ? 'Check your answers' : page.title}
          lead={reviewing ? 'Nothing is sent until you press the button. Each answer can still be changed.' : page.lead}
        />
      )}
      <FormProblems hold={{ problems, message, focus }} labels={Object.fromEntries(every.map((spec) => [spec.name, spec.label]))} />
      {reviewing ? (
        <ReviewList
          label="Your answers"
          items={every
            .filter((spec) => asked(spec, answers))
            .map((spec) => ({
              label: spec.label,
              value: said(spec, answers[spec.name]),
              onChange: () => setAt(pages.findIndex((step) => step.fields.includes(spec))),
            }))}
        />
      ) : (
        // Keyed by the step, so a field of one step is never taken for the field at the same place in the next.
        <div data-slot="form-step" key={page.id}>
          {shown.map((spec) => (
            <Question key={spec.name} spec={spec} answer={answers[spec.name]} problem={problems[spec.name]} />
          ))}
        </div>
      )}
      <ActionBar>
        {stepped && at > 0 && (
          <Button
            intent="quiet"
            onClick={() => {
              setAnswers(read());
              setProblems({});
              setAt(at - 1);
            }}
          >
            Back
          </Button>
        )}
        <Button intent="primary" type="submit" busy={busy}>
          {reviewing || (!review && at === pages.length - 1) ? send : 'Continue'}
        </Button>
      </ActionBar>
    </form>
  );
}
