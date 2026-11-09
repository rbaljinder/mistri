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
import type { AppUpdateAction } from '../../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppCommandField, AppFormCommandReference } from '../../../shared/command.js';
import { findTable, go, pageView, primaryKey, state, toast } from '@mistriwork/kit/client/core.js';
import { mayRunAny } from '@mistriwork/kit/client/actionGrants.js';
import { applyBulk, bulkKey, matchingKeys } from '@mistriwork/kit/client/bulkActions.js';
import { confirmFor } from '@mistriwork/kit/client/prompt.js';
import { expectedValues, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { commandOperations, type CommandOperation, type CommandOwner } from '../../commandState.js';
import { prepareCommand, sendCommand } from '../../commandSend.js';
import { heldReview, holdReview, reviewFresh, reviewOwner, staleReview } from '../../commandReviews.js';
import { checkCommandStep } from '../commandStepCheck.js';
import { commandAvailable, useCommandAvailability } from '../../commandAvailability.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { pageBridge, registerCommandHost } from '@mistriwork/kit/client/uiBridge.js';
import { formAt, formPageId, type ServedForm as RoomForm } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppPayloadApp } from '../../../shared/appPayload.js';

/** A signed-in form as the App serves it: the whole form, which the kit's room type reads only part of. */
type ServedForm = RoomForm<AppPayloadApp>;
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { commandInput, prefilledCommandValues, readyToJudge, refusedFields, type CommandValues } from '../CommandFields.js';
import { mount, queryClient } from '@mistriwork/kit/client/components/mount.js';
import type {
  UiChoice,
  UiCommandHandle,
  UiCommandOptions,
  UiCommandOutcome,
  UiCommandRef,
  UiCommandReview,
  UiFormHandle,
  UiFormOutcome,
  UiFormState,
} from './context.js';
import type { FormReceipt } from '../FormSurface.js';
import type { FormOutcome } from '../FormRoom.js';
import { say } from '../../copy/components/components/sdk/commands.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

const CommandForm = onDemand(() => import('../CommandForm.js'), 'CommandForm', { quiet: true });

interface ServedApp {
  resources?: Record<string, { actions?: Array<{ id?: string; label: string; command?: unknown }> }>;
  grantedCommands?: string[];
  grantedActions?: Record<string, string[]>;
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

/** The resource whose actions hold this one: the table its records are rows of. */
function resourceOffering(action: AppCommandAction): string | undefined {
  const app = pageBridge.activeApp() as ServedApp | null;
  return Object.entries(app?.resources ?? {}).find(([, resource]) => (resource.actions as unknown[] | undefined)?.includes(action))?.[0];
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

/* A form's command run as its form's submit would (formCommandRun.ts): fetched as the handle is made, so the App's
   first paint does not carry it. */
const formRun = () => import('./formCommandRun.js');

/**
 * The form itself over the page, filled with what was given. It settles when the form closes, with how the last
 * submission ended (applied with the command's output, refused in the server's words, or not known, whose `check`
 * asks again under the same key); `closed` only when nothing was sent. A form the session is taken from lets go as
 * `openForm` does: it could never close, and the run would wait on it for good.
 */
async function openFormCommand(
  served: { form: ServedForm; appName: string },
  input: Readonly<Record<string, unknown>> | undefined,
): Promise<UiCommandOutcome> {
  const { SignedInFormDialog } = await import('../SignedInFormDialog.js');
  return new Promise((resolve) => {
    const host = document.createElement('div');
    portalRoot().append(host);
    let take = () => {};
    let leave = () => {};
    let last: UiCommandOutcome = { status: 'closed' };
    const close = () => {
      leave();
      take();
      host.remove();
      resolve(last);
    };
    const opened = sessionIdentity();
    leave = subscribeSessionIdentity(() => {
      if (sessionIdentity() === opened) return;
      if (last.status === 'unknown') toast(say('notConfirmed', { label: served.form.label }), 'error');
      close();
    });
    take = mount(
      host,
      createElement(SignedInFormDialog, {
        form: served.form,
        appName: served.appName,
        // Every field the component gave, as typed values: not an address, which only a `prefillable` field reads.
        ...(input ? { initial: input } : {}),
        onOutcome: (outcome) => {
          last = outcome;
        },
        onClose: close,
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
function outcomeOf(operation: CommandOperation | undefined, fields?: Readonly<Record<string, string>>): UiCommandOutcome {
  // The command's own words, when its output said any, go back with it: a caller with no form to say them in says them.
  // So does the output itself: a component acts on what it made (the ticket it opened) by its id, not by looking it up.
  if (operation?.phase === 'success')
    return {
      status: 'applied',
      ...(operation.said ? { message: operation.said } : {}),
      output: operation.output,
    };
  if (operation?.phase === 'error') return { status: 'refused', message: operation.message, ...(fields ? { fields } : {}) };
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

const reviewOf = (token: string, values: Readonly<Record<string, unknown>>): UiCommandReview =>
  Object.freeze({
    token,
    values: Object.freeze({ ...values }),
    get fresh() {
      return reviewFresh(token);
    },
  });

/**
 * What a review shows before the person confirms: the record prepared at its revision now, the values the command
 * starts from with `input` over them, held under a token (commandReviews.ts) that pins the run to that revision.
 */
async function prepareReview(
  action: AppCommandAction,
  key: Record<string, string | number>,
  input: Readonly<Record<string, unknown>> | undefined,
): Promise<UiCommandReview | Extract<UiCommandOutcome, { status: 'refused' }>> {
  const owner = ownerFor(action, key);
  let prepared: Awaited<ReturnType<typeof prepareCommand>>;
  try {
    prepared = await prepareCommand(owner);
  } catch (error) {
    return { status: 'refused', message: (error as Error).message || say('isNotAvailableOnThisRecord', { label: action.label }) };
  }
  const token = holdReview(
    reviewOwner(owner.connection, owner.command, owner.commandVersion, key),
    action.command.target,
    key,
    prepared.expectedVersion,
  );
  return reviewOf(token, { ...prepared.initial, ...input });
}

/* A review that cannot be run as it was shown: the page shows it again, so nothing is sent. */
function staleRefusal(action: AppCommandAction, options: UiCommandOptions): UiCommandOutcome {
  const message = say('reviewStale', { label: options.label || action.label });
  if (!options.quiet) toast(message, 'error');
  return { status: 'refused', code: 'stale', message };
}

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
  const judging = readyToJudge(fields);
  if (judging) await judging;
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
  /* A run the person confirmed from a review is sent for that revision alone, never prepared again (D6): a record
     that moved since is refused `stale` and shown again, where a plain run below quietly prepares once more. */
  const review = options.review && heldReview(options.review.token);
  if (options.review) {
    if (!review?.fresh || review.owner !== reviewOwner(owner.connection, owner.command, owner.commandVersion, key))
      return staleRefusal(action, options);
  }
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
      ...(review ? { pinned: review.expectedVersion } : {}),
    });
    if (review) break;
    if ('refused' in sent || sent.operation.phase !== 'error' || sent.operation.code !== 'stale_record' || tries === STALE_TRIES) break;
    commandOperations.forget(owner);
  }
  if ('refused' in sent) {
    const message = sent.refused || say('isNotAvailableOnThisRecord', { label: action.label });
    if (!options.quiet) toast(message, 'error');
    return { status: 'refused', message };
  }
  const { operation } = sent;
  if (operation.phase === 'unknown' || operation.phase === 'pending') return openForm(action, key, input, options);
  // A review is spent once it ran, and moot once the server found its record moved.
  if (options.review) staleReview(options.review.token);
  if (review && operation.phase === 'error' && operation.code === 'stale_record') {
    commandOperations.forget(owner);
    return staleRefusal(action, options);
  }
  const outcome = outcomeOf(operation, refusedFields(operation.field, operation.message, fields, values as CommandValues));
  commandOperations.forget(owner);
  if (outcome.status === 'refused' && !options.quiet) toast(outcome.message, 'error');
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

/* A saved form's draft, through the transport its own layout uses (draftFormApi.ts): fetched where a page reads one,
   so an App's first paint does not carry it. */
const drafts = () => import('../draftFormApi.js');
const savesDraft = (form: ServedForm) => (form as { save?: { owner?: string } }).save?.owner !== undefined;
/* The submit's key, held while a submit is not known to have landed (SavedFormSurface's REVIEW). */
const SUBMIT = '#review';

/**
 * A form view a page declares, as `page.useForm` holds it: the form its room draws, over the page, on the same draft
 * and under the same keys as that layout, so what the page says of the draft is what the form resumes. A form this
 * reader is not served (or a public form, which has no session draft) opens as `openForm` opens it.
 */
function formHandle(view: string): UiFormHandle {
  const served = () => {
    const app = pageBridge.activeApp() as (ServedApp & { name?: string; views?: Record<string, { command?: unknown }> }) | null;
    if (!app?.views || !Object.hasOwn(app.views, view) || !app.views[view].command) return undefined;
    const form = formAt(app as unknown as AppPayloadApp, formPageId(view));
    return form && !form.error ? { form, appName: app.name ?? '' } : undefined;
  };
  const transport = async (form: ServedForm) => {
    if (!savesDraft(form)) return undefined;
    const { draftTransport } = await drafts();
    return draftTransport(state.activeConnection as string | null, form as unknown as Parameters<typeof draftTransport>[1]);
  };
  const stepsOf = (form: ServedForm) =>
    ((form as { steps?: Array<{ id: string; label?: unknown }> }).steps ?? []).map((step) => ({
      id: step.id,
      label: typeof step.label === 'string' ? step.label : humanName(step.id),
    }));
  /* How the form ended, once it closed: its receipt where a saved form landed, the outcome its submit said, else what
     the draft holds now — a submit still unconfirmed, the steps saved part way, or nothing. */
  const settle = async (form: ServedForm, receipt: FormReceipt | undefined, last: FormOutcome | undefined): Promise<UiFormOutcome> => {
    const said = receipt?.message ? { message: receipt.message } : {};
    if (receipt?.reference) return { status: 'received', reference: receipt.reference, ...said };
    if (receipt && receipt.receipt.status !== 'applied')
      return { status: 'processing', message: receipt.message ?? say('formProcessing', { label: form.label }) };
    if (receipt) return { status: 'done', ...said };
    if (last?.status === 'applied') return { status: 'done', ...(last.message ? { message: last.message } : {}) };
    if (last?.status === 'unknown') return { status: 'processing', message: last.message };
    const draft = await transport(form);
    if (draft?.holds(SUBMIT)) return { status: 'processing', message: say('notConfirmed', { label: form.label }) };
    const summary = draft ? await draft.resume().catch(() => null) : null;
    return summary?.saved.length ? { status: 'saved', saved: summary.saved } : { status: 'closed' };
  };
  return {
    async state(): Promise<UiFormState> {
      const found = served();
      if (!found) return { label: humanName(view), granted: false, steps: [], draft: null, pending: false };
      const steps = stepsOf(found.form);
      const draft = await transport(found.form);
      const summary = draft ? await draft.resume() : null;
      return {
        label: found.form.label,
        granted: true,
        steps,
        // Where the form opens, as its layout decides: the step today's rules reopen, else the first not saved; null at the review.
        draft: summary
          ? {
              saved: summary.saved,
              step: summary.reopen ?? steps.find((step) => !summary.saved.includes(step.id))?.id ?? null,
              expiresAt: summary.expiresAt ?? null,
            }
          : null,
        pending: Boolean(draft?.holds(SUBMIT)),
      };
    },
    async open(input, { at } = {}) {
      const found = served();
      if (!found) {
        openViewForm(view, {});
        return { status: 'closed' };
      }
      const { SignedInFormDialog } = await import('../SignedInFormDialog.js');
      let receipt: FormReceipt | undefined;
      let last: FormOutcome | undefined;
      const closed = new Promise<void>((resolve) => {
        const host = document.createElement('div');
        portalRoot().append(host);
        let take = () => {};
        let leave = () => {};
        const close = () => {
          leave();
          take();
          host.remove();
          resolve();
        };
        // A form the session is taken from lets go, as `useCommand(...).open` does: it could never close.
        const opened = sessionIdentity();
        leave = subscribeSessionIdentity(() => {
          if (sessionIdentity() !== opened) close();
        });
        take = mount(
          host,
          createElement(SignedInFormDialog, {
            form: found.form,
            appName: found.appName,
            ...(input ? { initial: input } : {}),
            ...(at === undefined ? {} : { at }),
            onOutcome: (outcome) => {
              last = outcome;
            },
            onReceipt: (landed) => {
              receipt = landed;
            },
            onClose: close,
          }),
        );
      });
      await closed;
      return settle(found.form, receipt, last);
    },
    async startOver() {
      const found = served();
      const draft = found && (await transport(found.form));
      // A submit sent and not known to have landed keeps its draft, as the form's own Start over does.
      if (!draft || draft.holds(SUBMIT) || !(await draft.resume())) return false;
      await draft.discard();
      draft.clearKeys();
      // The page's reads of the draft (`useForm`) read it again.
      void queryClient.invalidateQueries({ queryKey: ['mistri-ui'] });
      // A free-form page's loader may read the draft too (CustomSection.tsx).
      void queryClient.invalidateQueries({ queryKey: ['mistri-page', 'load'] });
      return true;
    },
  };
}

/** The choices an input of `input` offers as served: a choice's options — a table's rows where they were served with
    it — or undefined for a field that offers none, or none yet. */
function servedChoices(input: readonly AppCommandField[] | undefined, name: string): readonly UiChoice[] | undefined {
  const field = input?.find((each) => each.name === name);
  if (!field || (field.type !== 'choice' && field.type !== 'choices') || !field.options.length) return undefined;
  return field.options.map((option) => ({ value: option.value, label: option.label }));
}

/** One input of `input` as it was served, a group's own fields left to their group. */
function servedInput(input: readonly AppCommandField[] | undefined, name: string): AppCommandField | undefined {
  return input?.find((each) => each.name === name);
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
    // A public door names no record: there is no revision to pin, and its run is judged as it lands.
    prepare: async () => ({ status: 'refused', message: say('reviewNotOffered', { label: humanName(id) }) }),
    choices: (field) => servedChoices(reference.input, field),
    input: (name) => servedInput(reference.input, name),
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
    const refuse = (options?: UiCommandOptions): Promise<UiCommandOutcome> => {
      const message = identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: served.form.label }) : say('signInToDo');
      if (!options?.quiet) toast(message, 'error');
      return Promise.resolve({ status: 'refused', message });
    };
    if (granted) void formRun();
    // No record to ask about: granted is available, and the record a caller hands in is not read.
    return {
      label: served.form.label,
      granted,
      available: async () => granted,
      run: (_record, input, options) =>
        granted
          ? formRun().then(({ runFormCommand }) => runFormCommand(labelled(served, options), input, options, openFormCommand))
          : refuse(options),
      open: (_record, input, options) => (granted ? openFormCommand(labelled(served, options), input) : refuse(options)),
      /* No record, so no revision to go stale: the review is what will be sent, and a run with it runs as any other. */
      prepare: async (_record, input) =>
        granted
          ? reviewOf(holdReview(reviewOwner(state.activeConnection ?? '', ref, served.form.command.version, {}), '', {}, 0), input ?? {})
          : {
              status: 'refused',
              message: identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: served.form.label }) : say('signInToDo'),
            },
      choices: (field) => servedChoices(served.form.command.input, field),
      input: (name) => servedInput(served.form.command.input, name),
      check: async (input, names) =>
        granted ? checkCommandStep(state.activeConnection ?? null, served.form.command, names, input) : undefined,
    };
  }
  const granted =
    Boolean(action) &&
    identity.mode === 'authenticated' &&
    ((pageBridge.activeApp() as ServedApp | null)?.grantedCommands ?? []).includes(action!.command.id);
  const refuse = (options?: UiCommandOptions): Promise<UiCommandOutcome> => {
    const message =
      identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: action?.label ?? say('this') }) : say('signInToDo');
    if (!options?.quiet) toast(message, 'error');
    return Promise.resolve({ status: 'refused', message });
  };
  return {
    label: action?.label ?? ref,
    granted,
    resource: action ? resourceOffering(action) : undefined,
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
    run: (record, input, options = {}) => (granted ? runCommand(action!, keyFor(action!, record), input, options) : refuse(options)),
    open: (record, input, options = {}) => (granted ? openForm(action!, keyFor(action!, record), input, options) : refuse(options)),
    prepare: async (record, input) => {
      if (!granted)
        return {
          status: 'refused',
          message:
            identity.mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label: action?.label ?? say('this') }) : say('signInToDo'),
        };
      return prepareReview(action!, keyFor(action!, record), input);
    },
    choices: (field) => servedChoices(action?.command.input, field),
    input: (name) => servedInput(action?.command.input, name),
    check: async (input, names) => (granted ? checkCommandStep(state.activeConnection ?? null, action!.command, names, input) : undefined),
  };
}

/**
 * The fixed action by this id: the resource action that has it and runs no command, on one of the resources `reads`
 * names (any resource without them). Fixed is a machine's verb or `action(label, { set })`, the record page's own
 * button; a command's action is `actionOf`'s.
 */
function verbOf(id: UiCommandRef, reads?: readonly string[]): { table: string; action: AppUpdateAction } | undefined {
  const app = pageBridge.activeApp() as ServedApp | null;
  for (const [table, resource] of Object.entries(app?.resources ?? {})) {
    if (reads && !reads.includes(table)) continue;
    for (const action of resource.actions ?? []) {
      if (action.id === id && !action.command) return { table, action: action as AppUpdateAction };
    }
  }
  return undefined;
}

/**
 * A fixed action as a component holds it: the record page's button, found by `verbOf`, run on one record by its key.
 * `run` is the update every list's bulk bar sends (`applyBulk`), one record at a time through the ordinary update
 * route, whose gate judges it again: it never posts a command. What the browser can know is asked first so a click
 * is answered in words — the reader's grant (`mayRunAny`, which reads the writable connection and the role's
 * `actions`), the action's `when` for this record (a row whose state does not allow it is refused, not skipped, as a
 * list's bar skips) — and `confirm` asks before anything is sent.
 */
function actionHandle(id: UiCommandRef, reads?: readonly string[]): UiCommandHandle {
  const found = verbOf(id, reads);
  const app = pageBridge.activeApp() as ServedApp | null;
  const granted = Boolean(found) && mayRunAny(app, found!.table, [found!.action]);
  const label = found?.action.label ?? id;
  const refuse = (message: string, quiet = false): Promise<UiCommandOutcome> => {
    if (!quiet) toast(message, 'error');
    return Promise.resolve({ status: 'refused', message });
  };
  const refusedFor = (quiet = false) =>
    refuse(sessionIdentity().mode === 'authenticated' ? say('isNotSomethingYouCanDo', { label }) : say('signInToDo'), quiet);
  const keyOf = (table: TableMeta, record: Readonly<Record<string, unknown>>): Record<string, string | number> => {
    const key: Record<string, string | number> = {};
    for (const column of primaryKey(table) as string[]) {
      const value = record[column];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) key[column] = value;
      else throw new Error(say('theRecordHanded', { label, column }));
    }
    return key;
  };
  const matches = async (record: Readonly<Record<string, unknown>>): Promise<boolean> => {
    const table = findTable(found!.table) as TableMeta | undefined;
    if (!table) return false;
    return (await matchingKeys(table, [keyOf(table, record)], found!.action.when, state.activeConnection)).has(
      bulkKey(table, keyOf(table, record)),
    );
  };
  const run = async (
    record: Readonly<Record<string, unknown>>,
    input?: Readonly<Record<string, unknown>>,
    options: UiCommandOptions = {},
  ): Promise<UiCommandOutcome> => {
    if (!found || !granted) return refusedFor(options.quiet);
    const { table: tableId, action } = found;
    const table = findTable(tableId) as TableMeta | undefined;
    if (!table) return refusedFor(options.quiet);
    const key = keyOf(table, record);
    /* A reason is data the action asks for and writes with its set (a record never moves this way unexplained). */
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (action.reason && !reason) return refuse(say('asksAReason', { label }), options.quiet);
    if (!(await matches(record))) return refuse(say('isNotAvailableOnThisRecord', { label }), options.quiet);
    if (action.confirm && !(await confirmFor({ title: `${label}?`, body: say('confirmBody', { label }), confirmLabel: label })))
      return { status: 'closed' };
    const opened = sessionIdentity();
    const values = action.reason ? { ...action.set, [action.reason]: reason } : action.set;
    const expected = expectedValues(table, action.set, record as Record<string, unknown>);
    const result = await applyBulk(
      { connection: state.activeConnection ?? null, table: tableId },
      values,
      [{ key, label, ...(expected ? { expected } : {}) }],
      () => sessionIdentity() === opened,
    );
    const outcome = result.outcomes[0];
    if (outcome.kind === 'applied') {
      void queryClient.invalidateQueries();
      toast(options.done ?? say('actionDone', { label }), 'ok');
      return { status: 'applied' };
    }
    if (outcome.kind === 'uncertain') {
      if (!options.quiet) toast(outcome.message, 'error');
      const unknown: UiCommandOutcome = {
        status: 'unknown',
        message: outcome.message,
        check: async () => {
          await queryClient.invalidateQueries();
          return unknown;
        },
      };
      return unknown;
    }
    return refuse(outcome.message, options.quiet);
  };
  return {
    label,
    granted,
    resource: found?.table,
    available: async (record) => {
      if (!granted) return false;
      try {
        return await matches(record);
      } catch {
        return false;
      }
    },
    run: (record, input, options) => run(record, input, options),
    // A fixed action has no form of its own: opening it is running it, asking first as the record page does.
    open: (record, input, options) => run(record, input, options),
    // Its update carries the values it expects (`expectedValues`), which is the pin a review would add.
    prepare: async () => ({ status: 'refused', message: say('reviewNotOffered', { label }) }),
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

registerCommandHost({ command: commandHandle, action: actionHandle, openForm: openViewForm, form: formHandle });
