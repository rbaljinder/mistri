/**
 * A signed-in command form as a room of the App: the form the payload
 * served under its view key — served only to a role granted its command —
 * drawn in the content pane with the App's menu beside it, and submitted
 * through the signed-in command route under the visitor's own session and
 * grant, never as the public. The envelope names no record: a form's
 * command creates its rows, so the key is empty and the revision zero.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, currentEntry, renderCrumbs, state } from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import type { CommandInputValue } from '../commandState.js';
import { formAt, type ServedForm as RoomForm } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';

/** A signed-in form as the App serves it: the whole form, which the kit's room type reads only part of. */
type ServedForm = RoomForm<AppPayloadApp>;
import { FormSurface, type FormPresentation, type FormReceipt } from './FormSurface.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { draftTransport } from './draftFormApi.js';
import type { SavedFormPresentation } from './SavedFormSurface.js';
import type { CommandQuestions } from './CommandFields.js';
import type { PageEntry } from '@mistriwork/kit/client/components/pageModel.js';
import { say } from '../copy/forms/components/FormRoom.js';
import type { UiCommandOutcome } from './sdk/context.js';

/** How a submission this form sent ended, for the component that opened it: never `closed`, which is the caller's word for nothing sent. */
export type FormOutcome = Exclude<UiCommandOutcome, { status: 'closed' }>;

/* The saved form is a part of its own, fetched when a form that saves each step is drawn: no first paint needs it. */
const SavedFormSurface = onDemand(() => import('./SavedFormSurface.js'), 'SavedFormSurface');

/** A signed-in form saved on every step: its draft belongs to the person (`save.owner`). */
const savesDraft = (form: ServedForm) => (form as { save?: { owner?: string } }).save?.owner !== undefined;

/** A saved form asks each step's command's inputs on its step and the submit's own on the review (formHttp.ts presentForm does the same for a public one). */
function savedPresentation(form: ServedForm): SavedFormPresentation {
  const steps = (form.steps ?? []) as unknown as Array<{ command?: { input?: FormPresentation['input'] } }>;
  return {
    ...formPresentation(form),
    input: [...steps.flatMap((step) => step.command?.input ?? []), ...form.command.input],
    steps: form.steps ?? [],
    save: { submit: form.command.input.map((field) => field.name) },
  };
}

/** The signed-in submission: the ordinary command envelope, naming no record. */
async function submitSignedInForm(
  connection: string | null | undefined,
  form: Pick<ServedForm, 'command'>,
  submission: string,
  input: CommandInputValue,
): Promise<{ receipt: FormReceipt; result: unknown }> {
  const answer = (await api('/api/commands/execute', {
    command: form.command.id,
    commandVersion: form.command.version,
    key: {},
    expectedVersion: 0,
    idempotencyKey: submission,
    input,
    ...ownedBy(connection),
  })) as { receiptId: string; status: string; result?: unknown };
  const reference = answer.result && typeof answer.result === 'object' ? (answer.result as { reference?: unknown }).reference : undefined;
  /* What the handler said it did ("Posted 55 rent charges for October 2026."): the page is the only place a person who
     ran it learns whether it did anything, and "Received" alone cannot tell a run that posted from one that found nothing to. */
  const said = answer.result && typeof answer.result === 'object' ? (answer.result as { message?: unknown }).message : undefined;
  return {
    result: answer.result,
    receipt: {
      ...(typeof reference === 'string' && reference.trim() ? { reference } : {}),
      ...(typeof said === 'string' && said.trim() ? { message: said.trim() } : {}),
      receipt: { id: answer.receiptId, status: answer.status },
    },
  };
}

/** What the surface draws of a served form: its words, inputs and steps. */
export function formPresentation(form: ServedForm): FormPresentation {
  return {
    id: form.id,
    label: form.label,
    input: form.command.input,
    ...(form.description === undefined ? {} : { description: form.description }),
    ...(form.steps === undefined ? {} : { steps: form.steps }),
    ...(form.style === undefined ? {} : { style: form.style }),
    ...(form.note === undefined ? {} : { note: form.note }),
    ...(form.review === false ? { review: false as const } : {}),
    ...(form.submitLabel === undefined ? {} : { submitLabel: form.submitLabel }),
    ...(form.done === undefined ? {} : { done: form.done }),
    ...((form as { inputs?: FormPresentation['inputs'] }).inputs
      ? { inputs: (form as { inputs?: FormPresentation['inputs'] }).inputs }
      : {}),
  };
}

export function FormRoom({ entry }: { entry: PageEntry }) {
  const app = activeApp();
  const form = app ? formAt(app, entry.pageId) : undefined;
  useEffect(() => {
    /* A form reached by pasted link painted its crumb before this room
       could say its name. Same correction the dashboard makes. */
    if (form && currentEntry() === entry && entry.label !== form.label) {
      entry.label = form.label;
      renderCrumbs();
    }
  }, [form, entry]);
  if (!app || !form) return <p className="note">{say('noFormCalledInThisApp', { pageId: entry.pageId })}</p>;
  return <FormBody form={form} appName={app.name} />;
}

/** The form itself, for its room, for a home that names it, and over the page a component opened it from (FormDialog.tsx). */
export function FormBody({
  form,
  appName,
  prefill,
  initial,
  onDismiss,
  onOutcome,
}: {
  form: ServedForm;
  appName: string;
  /** Where it starts, as a query string, when it is not drawn at its own address. */
  prefill?: string;
  /** Where it starts, as a component gave it: every input, over what the command prepared. */
  initial?: Readonly<Record<string, unknown>>;
  /** Drawn over a page: back to it, from Cancel or from Done once received. */
  onDismiss?: () => void;
  /** Told how each submission ended, so a component that opened the form can resolve with it once the form closes. */
  onOutcome?: (outcome: FormOutcome) => void;
}) {
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  const client = useQueryClient();
  const connection = state.activeConnection as string | null;
  /* A command that starts its form (`initial()`, `default: me`) is prepared as the form opens, over no
     record: the key is empty, as its submission's is, and one that asks questions defined in rows
     reads them (G40). The form waits for it, so nothing the reader types is overwritten when it lands. */
  const prepares = !form.error && form.command.prepares === true;
  const prepared = useQuery({
    queryKey: ['form-prepare', identity.epoch, connection, form.command.id, form.command.version],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    enabled: prepares,
    queryFn: async (): Promise<{ initial: Record<string, unknown>; questions?: CommandQuestions }> => {
      const result = await api('/api/commands/prepare', {
        ...ownedBy(connection),
        command: form.command.id,
        commandVersion: form.command.version,
        key: {},
      });
      const initial = result?.initial && typeof result.initial === 'object' && !Array.isArray(result.initial) ? result.initial : {};
      // Its questions defined in rows, as the server read them for this reader.
      const questions = result?.defined && typeof result.defined === 'object' ? (result.defined as CommandQuestions) : undefined;
      return { initial, ...(questions ? { questions } : {}) };
    },
  });
  const draft = useMemo(() => {
    if (!savesDraft(form)) return undefined;
    const transport = draftTransport(connection, form as unknown as Parameters<typeof draftTransport>[1]);
    return {
      ...transport,
      async submit(key: string, input: CommandInputValue, version: string) {
        const receipt = await transport.submit(key, input, version);
        // What the form created shows in every list that reads it.
        void client.invalidateQueries();
        onOutcome?.({ status: 'applied' });
        return receipt;
      },
    };
    // `onOutcome` is the opener's callback and is read when the submit lands, not a reason to read the draft again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, connection, client]);
  if (form.error) return <p className="note">{form.error}</p>;
  if (draft) {
    return (
      <SavedFormSurface
        key={form.id}
        form={savedPresentation(form)}
        appName={appName}
        draft={draft}
        {...(onDismiss ? { onDismiss } : {})}
      />
    );
  }
  if (prepares && prepared.error) return <p className="note">{prepared.error.message}</p>;
  if (prepares && !prepared.data) return <p className="note" aria-busy="true" />;
  return (
    <FormSurface
      key={form.id}
      form={formPresentation(form)}
      appName={appName}
      again={!onDismiss}
      inDialog={Boolean(onDismiss)}
      connection={connection ?? undefined}
      held={{ command: form.command.id, ...(connection ? { connection } : {}) }}
      identityEpoch={identity.epoch}
      {...(prepared.data || initial ? { initial: { ...prepared.data?.initial, ...initial } } : {})}
      {...(prepared.data?.questions ? { questions: prepared.data.questions } : {})}
      {...(prefill === undefined ? {} : { prefill })}
      {...(onDismiss ? { onDismiss } : {})}
      checkStep={(_step, input, names) => checkSignedInStep(connection, form, names, input)}
      submit={async (submission, input) => {
        /* Said once per send. An answer that never said whether it ran is `unknown`, and its `check` sends the same
           submission again: the server answers a run it already has with its receipt, so it never runs twice. */
        const attempt = async (): Promise<{ outcome: FormOutcome; receipt?: FormReceipt; error?: unknown }> => {
          try {
            const sent = await submitSignedInForm(connection, form, submission, input);
            // What the form created shows in every list that reads it.
            void client.invalidateQueries();
            return {
              receipt: sent.receipt,
              outcome: { status: 'applied', ...(sent.result !== undefined ? { output: sent.result } : {}) },
            };
          } catch (error) {
            const failure = error as Error & { outcome?: unknown };
            if (failure.outcome === 'not_applied') return { error, outcome: { status: 'refused', message: failure.message } };
            const check = async () => (await attempt()).outcome;
            return { error, outcome: { status: 'unknown', message: say('notConfirmed', { label: form.label }), check } };
          }
        };
        const sent = await attempt();
        onOutcome?.(sent.outcome);
        if (sent.receipt) return sent.receipt;
        throw sent.error;
      }}
    />
  );
}

/**
 * A signed-in form's step checked by the server (`/api/commands/check`): the same reader, `when`s and rules the run
 * uses, over the fields asked so far, nothing run. A check that cannot be asked — a host with none (a tenant's, a
 * row policy's), the budget spent, offline — is no word: the step goes on and the submission is judged whole.
 */
async function checkSignedInStep(
  connection: string | null,
  form: ServedForm,
  names: readonly string[],
  input: unknown,
): Promise<Record<string, string> | undefined> {
  try {
    const result = (await api(COMMAND_ROUTES.check, {
      ...ownedBy(connection),
      command: form.command.id,
      commandVersion: form.command.version,
      fields: [...names],
      input,
    })) as { problems?: unknown } | undefined;
    const problems = result?.problems && typeof result.problems === 'object' ? (result.problems as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(problems).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return undefined;
  }
}
