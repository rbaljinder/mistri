/**
 * A signed-in command form as a room of the App: the form the payload
 * served under its view key — served only to a role granted its command —
 * drawn in the content pane with the App's menu beside it, and submitted
 * through the signed-in command route under the visitor's own session and
 * grant, never as the public. The envelope names no record: a form's
 * command creates its rows, so the key is empty and the revision zero.
 */
import { useEffect, useSyncExternalStore } from 'react';
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
import type { CommandQuestions } from './CommandFields.js';
import type { PageEntry } from '@mistriwork/kit/client/components/pageModel.js';
import { say } from '../copy/forms/components/FormRoom.js';

/** The signed-in submission: the ordinary command envelope, naming no record. */
async function submitSignedInForm(
  connection: string | null | undefined,
  form: Pick<ServedForm, 'command'>,
  submission: string,
  input: CommandInputValue,
): Promise<FormReceipt> {
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
  return {
    ...(typeof reference === 'string' && reference.trim() ? { reference } : {}),
    receipt: { id: answer.receiptId, status: answer.status },
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
  onDismiss,
}: {
  form: ServedForm;
  appName: string;
  /** Where it starts, as a query string, when it is not drawn at its own address. */
  prefill?: string;
  /** Drawn over a page: back to it, from Cancel or from Done once received. */
  onDismiss?: () => void;
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
  if (form.error) return <p className="note">{form.error}</p>;
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
      identityEpoch={identity.epoch}
      {...(prepared.data ? { initial: prepared.data.initial } : {})}
      {...(prepared.data?.questions ? { questions: prepared.data.questions } : {})}
      {...(prefill === undefined ? {} : { prefill })}
      {...(onDismiss ? { onDismiss } : {})}
      checkStep={(_step, input, names) => checkSignedInStep(connection, form, names, input)}
      submit={async (submission, input) => {
        const receipt = await submitSignedInForm(connection, form, submission, input);
        // What the form created shows in every list that reads it.
        void client.invalidateQueries();
        return receipt;
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
