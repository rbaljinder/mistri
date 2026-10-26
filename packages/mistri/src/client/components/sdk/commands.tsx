/**
 * The page's side of `useCommand`: a command a component names, found among
 * the App's own actions for this reader, run through the one command
 * pipeline the action bar uses (commandState.ts) and opened in its own form
 * (CommandForm.tsx). Nothing here is a write of its own: a run is prepared
 * for the record's revision, sent once under a request key and refused in
 * the server's words; an unconfirmed one is handed to the form, whose Check
 * result and Retry are the only ways on.
 *
 * Registered on the page's bridge when loaded (with the list and queue
 * code, useBulkSelection.tsx), never imported by the SDK's host: it draws
 * the command form, whose fields may be components, which the host loads.
 *
 * Found through an action because an action is where the App offers a
 * command to a reader: its label, its inputs as the form draws them, and
 * whether this reader is served it at all (`grantedCommands`). A command no
 * action offers is reached through the signed-in form that does, if one
 * does: it names no record (`targets: 'none'`), so it is sent as its form
 * sends it, with an empty key. A granted command that names no record and
 * that no form runs is served by name (`formCommands`), and its
 * form is drawn from its own inputs. A command on a record that no action
 * offers is not one a component can reach; one only a component runs is an
 * action with `header: false`, offered in no menu.
 */
import { createElement } from 'react';
import type { AppCommandAction } from '../../../shared/app.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppCommandField, AppFormCommandReference } from '../../../shared/command.js';
import { api, findTable, go, pageView, primaryKey, state, toast } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { commandOperations, type CommandOperation, type CommandOwner } from '../../commandState.js';
import { sendCommand } from '../../commandSend.js';
import { commandAvailable, useCommandAvailability } from '../../commandAvailability.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { pageBridge, registerCommandHost } from '@mistriwork/kit/client/uiBridge.js';
import { formAt, formPageId, type ServedForm as RoomForm } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppPayloadApp } from '../../../shared/appPayload.js';

/** A signed-in form as the App serves it: the whole form, which the kit's room type reads only part of. */
type ServedForm = RoomForm<AppPayloadApp>;
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { commandInput, prefilledCommandValues } from '../CommandFields.js';
import { mount, queryClient } from '@mistriwork/kit/client/components/mount.js';
import type { UiChoice, UiCommandHandle, UiCommandOptions, UiCommandOutcome, UiCommandRef } from './context.js';
import { say } from '../../copy/components/components/sdk/commands.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

const CommandForm = onDemand(() => import('../CommandForm.js'), 'CommandForm', { quiet: true });

interface ServedApp {
  resources?: Record<string, { actions?: Array<{ label: string; command?: unknown }> }>;
  grantedCommands?: string[];
  formCommands?: Record<string, AppFormCommandReference>;
}

/** The action that offers this command, for this reader: the first whose command it is. */
export function actionOf(id: UiCommandRef): AppCommandAction | undefined {
  const app = pageBridge.activeApp() as ServedApp | null;
  for (const resource of Object.values(app?.resources ?? {})) {
    for (const action of resource.actions ?? []) {
      const command = action.command as AppCommandAction['command'] | undefined;
      if (command?.id === id) return action as AppCommandAction;
    }
  }
  return undefined;
}

/** The signed-in form this reader is served over this command, where no action offers it. */
function formOf(id: UiCommandRef): { form: ServedForm; appName: string } | undefined {
  const app = pageBridge.activeApp() as (ServedApp & { name?: string; views?: Record<string, { command?: { id?: unknown } }> }) | null;
  for (const [view, served] of Object.entries(app?.views ?? {})) {
    if (served.command?.id !== id) continue;
    const form = formAt(app as unknown as AppPayloadApp, formPageId(view));
    if (form && !form.error) return { form, appName: app?.name ?? '' };
  }
  return undefined;
}

/* A granted command that names no record and that no form runs: its own form, drawn from its inputs, under
   its name — or the word the component gives it. */
function unformedOf(id: UiCommandRef): { form: ServedForm; appName: string } | undefined {
  const app = pageBridge.activeApp() as (ServedApp & { name?: string }) | null;
  const command = app?.formCommands && Object.hasOwn(app.formCommands, id) ? app.formCommands[id] : undefined;
  return command && { form: { id, label: humanName(id), command } as ServedForm, appName: app?.name ?? '' };
}

/* A served form under the word the component gives it, where it gives one. */
const labelled = (served: { form: ServedForm; appName: string }, options?: UiCommandOptions) =>
  options?.label ? { ...served, form: { ...served.form, label: options.label } } : served;

/**
 * A form's command run as its form's submit would: checked by the form's own
 * rules (an incomplete or invalid input opens the form instead, filled with
 * it), then sent once, with no record and so nothing to prepare. A refusal
 * is said in the server's words.
 */
async function runFormCommand(
  served: { form: ServedForm; appName: string },
  input: Readonly<Record<string, unknown>> | undefined,
): Promise<UiCommandOutcome> {
  const fields = served.form.command.input;
  let values: Record<string, unknown>;
  try {
    values = commandInput(fields, prefilledCommandValues(fields, input ?? {}));
  } catch {
    return openFormCommand(served, input);
  }
  try {
    // As the form's own submit sends it (FormRoom.tsx): no record, so no key and no version to expect.
    const connection = state.activeConnection ?? '';
    const sent = (await api('/api/commands/execute', {
      command: served.form.command.id,
      commandVersion: served.form.command.version,
      key: {},
      expectedVersion: 0,
      idempotencyKey: crypto.randomUUID(),
      input: values,
      ...ownedBy(connection),
    })) as { result?: unknown } | null;
    void queryClient.invalidateQueries();
    return { status: 'applied', ...(sent?.result !== undefined ? { output: sent.result } : {}) };
  } catch (error) {
    const message = (error as Error).message || say('isNotSomethingYouCanDo', { label: served.form.label });
    toast(message, 'error');
    return { status: 'refused', message };
  }
}

/** The form itself over the page, filled with what was given; it settles as closed, its own Done saying what it sent. */
async function openFormCommand(
  served: { form: ServedForm; appName: string },
  input: Readonly<Record<string, unknown>> | undefined,
): Promise<UiCommandOutcome> {
  const prefill = Object.fromEntries(
    Object.entries(input ?? {}).filter(
      (entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  );
  const { SignedInFormDialog } = await import('../SignedInFormDialog.js');
  return new Promise((resolve) => {
    const host = document.createElement('div');
    portalRoot().append(host);
    const query = new URLSearchParams(Object.entries(prefill).map(([name, value]) => [name, String(value)])).toString();
    const take = mount(
      host,
      createElement(SignedInFormDialog, {
        form: served.form,
        appName: served.appName,
        prefill: query,
        onClose: () => {
          take();
          host.remove();
          resolve({ status: 'closed' });
        },
      }),
    );
  });
}

/** The record's key, as the command's target names it: its primary key columns, each a string or a safe integer. */
function keyFor(action: AppCommandAction, record: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const table = findTable(action.command.target);
  const columns = table ? (primaryKey(table) as string[]) : Object.keys(record);
  const key: Record<string, string | number> = {};
  for (const column of columns) {
    const value = record[column];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) key[column] = value;
    else throw new Error(say('theRecordHanded', { label: action.label, column }));
  }
  return key;
}

const ownerFor = (action: AppCommandAction, key: Record<string, unknown>): CommandOwner => ({
  connection: state.activeConnection ?? '',
  target: action.command.target,
  command: action.command.id,
  commandVersion: action.command.version,
  key,
});

/** How an operation the pipeline settled ended, for the component that ran it. */
function outcomeOf(operation: CommandOperation | undefined): UiCommandOutcome {
  // The command's own words, when its output said any, go back with it: a caller with no form to say them in says them.
  // So does the output itself: a component acts on what it made (the ticket it opened) by its id, not by looking it up.
  if (operation?.phase === 'success')
    return {
      status: 'applied',
      ...(operation.said ? { message: operation.said } : {}),
      ...(operation.output !== undefined ? { output: operation.output } : {}),
    };
  if (operation?.phase === 'error') return { status: 'refused', message: operation.message };
  return { status: 'closed' };
}

/** The platform's own form over the page, resolved when it closes. */
function openForm(
  action: AppCommandAction,
  key: Record<string, unknown>,
  input: Readonly<Record<string, unknown>> | undefined,
  options: UiCommandOptions = {},
): Promise<UiCommandOutcome> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'custom-command-host';
    portalRoot().append(host);
    let take = () => {};
    let leave = () => {};
    const close = (settled?: CommandOperation) => {
      leave();
      take();
      host.remove();
      resolve(outcomeOf(settled));
    };
    /* The form belongs to the session it opened under and draws nothing once the tab's session is taken again (a
       tenant context chosen again after a cut request): it could never close, and the run waited on it for good — a
       composer said Sending… with no word. It lets go instead, saying what is not known. */
    const opened = sessionIdentity();
    // Held now: a new session forgets every operation before this hears of it (commandState.ts).
    const owned = commandOperations.get(ownerFor(action, key));
    leave = subscribeSessionIdentity(() => {
      if (sessionIdentity() === opened) return;
      if (owned?.phase === 'pending' || owned?.phase === 'unknown')
        toast(say('notConfirmed', { label: options.label || action.label }), 'error');
      close();
    });
    take = mount(
      host,
      createElement(CommandForm, {
        action,
        owner: ownerFor(action, key),
        label: options.label ?? '',
        initial: input,
        headless: true,
        onClose: close,
        onDone: () => {
          void queryClient.invalidateQueries();
        },
      }),
    );
  });
}

const STALE_TRIES = 3;

/**
 * Send it with this input, as the form's submit would: prepared for the
 * record's revision, checked by the form's own rules (an incomplete or
 * invalid input opens the form instead, filled with it), sent once. A
 * refusal is said in the server's words, as the action bar says one; an
 * answer that did not arrive is the form's to resolve.
 */
async function runCommand(
  action: AppCommandAction,
  key: Record<string, string | number>,
  input: Readonly<Record<string, unknown>> | undefined,
  options: UiCommandOptions,
): Promise<UiCommandOutcome> {
  const fields = action.command.input;
  let values: Record<string, unknown>;
  try {
    values = commandInput(fields, prefilledCommandValues(fields, input ?? {}));
  } catch {
    return openForm(action, key, input, options);
  }
  const owner = ownerFor(action, key);
  const before = commandOperations.get(owner);
  if (before?.phase === 'pending' || before?.phase === 'unknown') return openForm(action, key, input, options);
  if (before) commandOperations.forget(owner);
  /* The record is prepared here, not shown: a change another person made between this prepare and the send (live
     sync keeps a busy record changing) refused a reply nobody had judged against either revision. Prepared again and
     sent again, a few times: the refusal was definite, so nothing ran twice. */
  let sent: Awaited<ReturnType<typeof sendCommand>>;
  for (let tries = 1; ; tries++) {
    sent = await sendCommand(action, owner, values, {
      headless: true,
      refresh: () => {
        void queryClient.invalidateQueries();
      },
    });
    if ('refused' in sent || sent.operation.phase !== 'error' || sent.operation.code !== 'stale_record' || tries === STALE_TRIES) break;
    commandOperations.forget(owner);
  }
  if ('refused' in sent) {
    const message = sent.refused || say('isNotAvailableOnThisRecord', { label: action.label });
    toast(message, 'error');
    return { status: 'refused', message };
  }
  const { operation } = sent;
  if (operation.phase === 'unknown' || operation.phase === 'pending') return openForm(action, key, input, options);
  const outcome = outcomeOf(operation);
  commandOperations.forget(owner);
  if (outcome.status === 'refused') toast(outcome.message, 'error');
  return outcome;
}

/* A public form over the page, fetched the first time a component opens one: it draws command fields too. */
async function openPublicForm(view: string, prefill: Readonly<Record<string, string | number>>, appId?: string): Promise<void> {
  const { FormDialog } = await import('../FormDialog.js');
  const host = document.createElement('div');
  portalRoot().append(host);
  const query = new URLSearchParams(Object.entries(prefill).map(([name, value]) => [name, String(value)])).toString();
  const take = mount(
    host,
    createElement(FormDialog, {
      view,
      appId,
      prefill: query,
      onClose: () => {
        take();
        host.remove();
      },
    }),
  );
}

/* A signed-in form over the page, fetched the first time a component opens one; Cancel, Done or Escape
   leave the reader where they were, and what the submit changed is read again there. */
async function openSignedInForm(form: ServedForm, appName: string, prefill: Readonly<Record<string, string | number>>): Promise<void> {
  const { SignedInFormDialog } = await import('../SignedInFormDialog.js');
  const host = document.createElement('div');
  portalRoot().append(host);
  const query = new URLSearchParams(Object.entries(prefill).map(([name, value]) => [name, String(value)])).toString();
  const take = mount(
    host,
    createElement(SignedInFormDialog, {
      form,
      appName,
      prefill: query,
      onClose: () => {
        take();
        host.remove();
      },
    }),
  );
}

/* One of the App's forms, over the page the component is on: a signed-in form the reader is served, as its
   room draws it, and a public form, which the App serves at its own address and never in its views, from
   there — each with its prefillable inputs filled. A signed-in form without its room's form (not served to
   this reader) is its room, which says so. */
function openViewForm(view: string, prefill: Readonly<Record<string, string | number>>): void {
  const app = pageBridge.activeApp() as (ServedApp & { id?: string; name?: string; views?: Record<string, { command?: unknown }> }) | null;
  if (app?.views && Object.hasOwn(app.views, view) && app.views[view].command) {
    const form = formAt(app as unknown as AppPayloadApp, formPageId(view));
    if (form && !form.error) {
      void openSignedInForm(form, app.name ?? '', prefill);
      return;
    }
    go(pageView(formPageId(view)));
    return;
  }
  void openPublicForm(view, prefill, app?.id);
}

/** The choices an input of `input` offers as served: a choice's options — a table's rows where they were served with
    it — or undefined for a field that offers none, or none yet. */
function servedChoices(input: readonly AppCommandField[] | undefined, name: string): readonly UiChoice[] | undefined {
  const field = input?.find((each) => each.name === name);
  if (!field || (field.type !== 'choice' && field.type !== 'choices') || !field.options.length) return undefined;
  return field.options.map((option) => ({ value: option.value, label: option.label }));
}

/* A public page's command, its module fetched as the handle is made (publicPageCommand.ts): the App's first paint does
   not carry the door, and the page's ticket is still asked at once, so it has aged by the time a person submits. */
function publicPageHandle(page: string, id: string, reference: AppFormCommandReference): UiCommandHandle {
  const door = import('./publicPageCommand.js').then(({ publicPageCommand }) => publicPageCommand(page, id, reference));
  return {
    label: humanName(id),
    granted: true,
    available: async () => true,
    run: (record, input, options) => door.then((handle) => handle.run(record, input, options)),
    open: (record, input, options) => door.then((handle) => handle.open(record, input, options)),
    choices: (field) => servedChoices(reference.input, field),
  };
}

/** The command a component named, as this reader is served it; on a public page, a public command it names runs
    through the page's own door (publicPageCommand.ts), whoever is signed in. */
export function commandHandle(ref: UiCommandRef, page?: string): UiCommandHandle {
  const publicCommands = (pageBridge.activeApp() as { publicCommands?: Record<string, AppFormCommandReference> } | null)?.publicCommands;
  if (page !== undefined && publicCommands && Object.hasOwn(publicCommands, ref)) return publicPageHandle(page, ref, publicCommands[ref]);
  const action = actionOf(ref);
  const identity = sessionIdentity();
  const served = action ? undefined : (formOf(ref) ?? unformedOf(ref));
  if (served) {
    const granted =
      identity.mode === 'authenticated' && ((pageBridge.activeApp() as ServedApp | null)?.grantedCommands ?? []).includes(ref);
    const refuse = (): Promise<UiCommandOutcome> => {
      const message = identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: served.form.label }) : say('signInToDo');
      toast(message, 'error');
      return Promise.resolve({ status: 'refused', message });
    };
    // No record to ask about: granted is available, and the record a caller hands in is not read.
    return {
      label: served.form.label,
      granted,
      available: async () => granted,
      run: (_record, input, options) => (granted ? runFormCommand(labelled(served, options), input) : refuse()),
      open: (_record, input, options) => (granted ? openFormCommand(labelled(served, options), input) : refuse()),
      choices: (field) => servedChoices(served.form.command.input, field),
    };
  }
  const granted =
    Boolean(action) &&
    identity.mode === 'authenticated' &&
    ((pageBridge.activeApp() as ServedApp | null)?.grantedCommands ?? []).includes(action!.command.id);
  const refuse = (): Promise<UiCommandOutcome> => {
    const message =
      identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: action?.label ?? say('this') }) : say('signInToDo');
    toast(message, 'error');
    return Promise.resolve({ status: 'refused', message });
  };
  return {
    label: action?.label ?? ref,
    granted,
    available: async (record) => {
      if (!granted) return false;
      try {
        return await commandAvailable({
          command: action!.command.id,
          commandVersion: action!.command.version,
          key: keyFor(action!, record),
        });
      } catch {
        return false;
      }
    },
    run: (record, input, options = {}) => (granted ? runCommand(action!, keyFor(action!, record), input, options) : refuse()),
    open: (record, input, options = {}) => (granted ? openForm(action!, keyFor(action!, record), input, options) : refuse()),
    choices: (field) => servedChoices(action?.command.input, field),
  };
}

/**
 * A command the App names outside any action (a tag picker's add and remove,
 * G58), run on one record as an action's button would, if this reader is
 * granted it; undefined when it is not, so the caller draws nothing to press.
 */
export function recordCommand(
  command: AppCommandAction['command'],
  label: string,
): ((key: Record<string, string | number>, input: Readonly<Record<string, unknown>>) => Promise<UiCommandOutcome>) | undefined {
  const granted =
    sessionIdentity().mode === 'authenticated' &&
    ((pageBridge.activeApp() as ServedApp | null)?.grantedCommands ?? []).includes(command.id);
  if (!granted) return undefined;
  const action = { id: command.id, label, command } as AppCommandAction;
  return (key, input) => runCommand(action, key, input, {});
}

/** A selection's commands in the kit's lists (shellMode.ts `bulkCommands`): the same pipeline and form, sent once for the group. */
export const bulkCommands = { operations: commandOperations, useAvailability: useCommandAvailability, Form: CommandForm };

registerCommandHost({ command: commandHandle, openForm: openViewForm });
