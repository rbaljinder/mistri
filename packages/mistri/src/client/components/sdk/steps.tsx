/**
 * `<Steps command param steps>`: one command's form asked over several steps on a free-form page
 * (`@mistriwork/mistri/page`), drawn in the intake style a public form's steps already wear (FormSurface.tsx), with
 * the command's own inputs, labels and rules.
 *
 * One command runs, once, at the end. A step only checks what it asks: the browser's own reading of those inputs,
 * then the server's (`/api/commands/check`, the reader, `when`s and rules the run uses, nothing run), so a problem is
 * said on the step that asks it rather than after the last. The step is a param of the page, written in place
 * (replace, not push), so a reload or a pasted address opens the same step and the address never holds more than one
 * entry for a walk through the steps. What was typed is kept in this page's memory between steps, never in the
 * address and never in the browser's storage: an answer can be anything the command asks, a reference, a sum, a
 * reason, and a page is no place to leave one behind. A reload therefore starts blank, and a step whose earlier steps
 * do not hold yet opens the first of those instead, so an address never lands a person past a question they have not
 * answered.
 *
 * A part of its own (blocks.tsx), loaded when a page first draws one: it draws the platform's form, which a page's
 * own module must not reach (page.tsx).
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { state } from '@mistriwork/kit/client/core.js';
import type { AppCommandField } from '../../../shared/command.js';
import type { FormStep } from '../../../shared/formRules.js';
import type { CommandInputValue } from '../../commandState.js';
import { blankCommandValues, commandProblems, type CommandValues } from '../CommandFields.js';
import { FormSurface, formArrives, type Failure, type FormPresentation, type FormReceipt } from '../FormSurface.js';
import { UiPageContext, type UiCommandOutcome } from './context.js';
import { useAddressState, useCommandHandle, useViewer } from './hooks.js';
import { say } from '../../copy/components/components/sdk/steps.js';

/** One step: the inputs of the command it asks, in order, and the words it is drawn with. */
export interface StepsStep {
  /** The param's value while this step is open: `?step=amount`. */
  id: string;
  /** The short name: the progress bar's "Step 2 of 3: Amount". */
  label: string;
  /** The step's heading; absent, its label. */
  title?: string;
  /** One sentence under the heading. */
  lead?: string;
  /** The primary button's words on this step; absent, "Continue". The last step's is the command's label. */
  next?: string;
  /** The command's inputs this step asks. Each belongs to one step. */
  inputs: readonly string[];
}

export interface StepsProps {
  /** One of the page's `commands`. */
  command: string;
  /** One of the page's `params`: the step open now, by its id; absent, the first. */
  param: string;
  steps: readonly StepsStep[];
  /** The record the command runs on, for one an action offers; a command with no record names none. */
  record?: Readonly<Record<string, unknown>>;
  /** What is said once it has run; absent, "<label>: done." and what the command's own result said. */
  done?: { title?: string; description?: string };
  /** How the run ended, once it applied. */
  onDone?: (outcome: UiCommandOutcome) => void;
}

/* What was typed, by page, command, record and reader: kept while the page is open so a step drawn again, Back and
   forward, or a page left and come back to, finds its answers; dropped once the command has run. Bounded: a desk
   that opens many records keeps the latest. */
const drafts = new Map<string, CommandValues>();
const DRAFTS_MOST = 24;
function keep(key: string, values: CommandValues) {
  drafts.delete(key);
  drafts.set(key, values);
  if (drafts.size > DRAFTS_MOST) drafts.delete(drafts.keys().next().value!);
}

/** The values a set of fields holds, out of the whole draft. */
const only = (fields: readonly AppCommandField[], values: CommandValues): CommandValues =>
  Object.fromEntries(fields.flatMap((field) => (Object.hasOwn(values, field.name) ? [[field.name, values[field.name]]] : [])));

const CONTROLS = 'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)';

export function Steps({ command, param, steps, record, done, onDone }: StepsProps) {
  const viewer = useViewer();
  const handle = useCommandHandle(command, viewer);
  const page = useContext(UiPageContext);
  const [raw, setRaw] = useAddressState(param);
  /* Steps written inline are a new array on every draw: what they say is what keeps the form the same. */
  const said = JSON.stringify(steps);
  const ids = steps.map((step) => step.id);
  const fields = useMemo<AppCommandField[]>(() => {
    if (!steps.length) throw new Error(say('noSteps', { command }));
    if (!handle.granted) return [];
    return [...new Set(steps.flatMap((step) => step.inputs))].map((name) => {
      const field = handle.input?.(name);
      if (!field) throw new Error(say('noSuchInput', { command, name }));
      return field;
    });
  }, [handle, said]); // eslint-disable-line react-hooks/exhaustive-deps
  const form = useMemo<FormPresentation>(() => {
    const formSteps: FormStep[] = steps.map((step) => ({
      id: step.id,
      label: step.label,
      fields: [...step.inputs],
      ...(step.title === undefined ? {} : { title: step.title }),
      ...(step.lead === undefined ? {} : { lead: step.lead }),
      ...(step.next === undefined ? {} : { next: step.next }),
    }));
    return {
      id: `steps-${command}`,
      label: handle.label,
      input: fields,
      steps: formSteps,
      // The intake style without its review: the last step's button runs the command, under the command's own name.
      style: 'intake',
      review: false,
      submitLabel: handle.label,
      done: { title: say('done', { label: handle.label }), ...done },
    };
  }, [fields, handle.label, command, said, done?.title, done?.description]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The stepper and its sheets arrive before the first draw, so the step opens whole rather than shifting in. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!handle.granted) return;
    let live = true;
    void formArrives(form).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [form, handle.granted]);

  const draftKey = `${page?.view ?? ''}\0${command}\0${JSON.stringify(record ?? {})}\0${viewer.account ?? ''}`;
  const asked = raw === undefined ? 0 : Math.max(0, ids.indexOf(raw));
  /* The step drawn: the one asked, unless an earlier step does not hold by what was typed — a pasted address, a
     reload, a draft that was sent — when it is the first of those. Worked out as it is drawn, so a later step is
     never shown before the one it moves back to. */
  const shown = useMemo(() => {
    if (!ready) return asked;
    const values = drafts.get(draftKey) ?? blankCommandValues(fields);
    const byName = new Map(fields.map((field) => [field.name, field]));
    for (let index = 0; index < asked; index++) {
      const own = steps[index].inputs.flatMap((name) => byName.get(name) ?? []);
      if (Object.keys(commandProblems(own, only(own, values), undefined, { whole: { fields, values } })).length) return index;
    }
    return asked;
  }, [asked, ready, draftKey, fields, said]); // eslint-disable-line react-hooks/exhaustive-deps
  const want = shown === 0 ? undefined : ids[shown];
  /* The address says the step drawn: a step moved back to, an id no step has, or the first step named, is written
     over in place. */
  useEffect(() => {
    if (ready && raw !== want) setRaw(want);
  }, [ready, raw, want]); // eslint-disable-line react-hooks/exhaustive-deps

  /* A move between steps is said, "Step 2 of 3: Amount", and the new step's heading takes the focus; a move made by a
     refusal says the refusal and where it is, and its field takes the focus instead. The first draw moves nothing. */
  const root = useRef<HTMLDivElement>(null);
  const refused = useRef<string | undefined>(undefined);
  const finished = useRef(false);
  const [spoken, setSpoken] = useState('');
  const drawn = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const before = drawn.current;
    drawn.current = shown;
    if (before === undefined || before === shown || finished.current) return;
    const step = steps[shown];
    const where = { step: shown + 1, count: steps.length, label: step.label };
    const refusal = refused.current;
    refused.current = undefined;
    setSpoken(refusal ? say('refusedOnStep', { problem: refusal, ...where }) : say('stepNamed', where));
    const invalid = refusal ? root.current?.querySelector<HTMLElement>('[aria-invalid="true"]') : undefined;
    const field = invalid?.matches(CONTROLS) ? invalid : invalid?.querySelector<HTMLElement>(CONTROLS);
    // preventScroll: the stepper brings a new step to its top on the block axis alone (docs/design.md, rule 10).
    (field ?? root.current?.querySelector<HTMLElement>('.step-title'))?.focus({ preventScroll: true });
  }, [shown, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!handle.granted) return null;
  if (!ready) return <section className="form-page" data-style="intake" aria-busy="true" />;

  const submit = async (submission: string, input: CommandInputValue): Promise<FormReceipt> => {
    /* Quiet: the form says a refusal, beside its field, on its own line or on the step it opens, so a toast would have it
       read out twice. */
    const outcome = await handle.run(record ?? {}, input as Readonly<Record<string, unknown>>, { attempt: submission, quiet: true });
    if (outcome.status === 'applied') {
      finished.current = true;
      drafts.delete(draftKey);
      setRaw(undefined);
      onDone?.(outcome);
      return { ...(outcome.message ? { message: outcome.message } : {}), receipt: { id: submission, status: 'applied' } };
    }
    if (outcome.status === 'refused') {
      /* A refusal naming inputs is said at the earliest step's: that is where the person goes to put it right. */
      const named = Object.keys(outcome.fields ?? {});
      const field = steps.flatMap((step) => step.inputs).flatMap((name) => named.filter((path) => path.split(/[.[]/)[0] === name))[0];
      throw {
        message: field ? outcome.fields![field] : outcome.message,
        status: 422,
        ...(field ? { field } : {}),
      } satisfies Failure;
    }
    // Not known: the form offers a check, which sends the same submission again and is answered from what was kept.
    if (outcome.status === 'unknown') throw { message: outcome.message } satisfies Failure;
    throw { message: say('notSent'), status: 400 } satisfies Failure;
  };

  return (
    <div ref={root} className="page-steps">
      <FormSurface
        key={draftKey}
        form={form}
        appName=""
        // Under the page's own h1: the step's title and the receipt's are its h2s.
        headingLevel={2}
        {...(state.activeConnection ? { connection: state.activeConnection } : {})}
        submit={submit}
        checkStep={async (_step, input, names) => handle.check?.(input as Readonly<Record<string, unknown>>, names)}
        cursor={{
          step: shown,
          onStep: (index, refusal) => {
            refused.current = refusal;
            setRaw(index === 0 ? undefined : ids[index]);
          },
        }}
        draft={{
          ...(drafts.has(draftKey) ? { values: drafts.get(draftKey)! } : {}),
          keep: (values) => keep(draftKey, values),
        }}
      />
      <p className="visually-hidden" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}
