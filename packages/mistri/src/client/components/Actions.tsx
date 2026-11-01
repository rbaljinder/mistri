/**
 * The app's own verbs for a record.
 *
 * Fixed edits use /api/update. Authored commands open their own form and
 * never enter the generic update or Undo path.
 * A verb with a `when` is shown only while the record satisfies it, which
 * is a question for the server; until it answers, the button is not
 * there, because a button that appears and then vanishes is worse than
 * one that arrives late.
 */
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, useId } from 'react';
import { Modal } from '@mistriwork/ui/Modal.js';
import { RecordKeys } from '@mistriwork/kit/client/components/recordKeys.js';
import { takesSingleKeys } from '@mistriwork/kit/client/components/RecordTrailNav.js';
import { Button } from '@mistriwork/ui/Button.js';
import { useMutation, useQueryClient, useQueries } from '@tanstack/react-query';
import { refreshAfterCommand } from '@mistriwork/kit/client/recordWriteRefresh.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { api, columnLabel, findTable, humanName, state, toast } from '@mistriwork/kit/client/core.js';
import { recordKey as checkedRecordKey } from '@mistriwork/kit/client/resourceRequests.js';
import { updateAttempts, updateOwnerKey, type UpdateOwner } from '@mistriwork/kit/client/updateAttempts.js';
import type { AppAction, AppCommandAction, AppUpdateAction } from '../../shared/app.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { commandOperations, type CommandOperation, type CommandOwner } from '../commandState.js';
import { readyCommand, sendCommand } from '../commandSend.js';
import { commandFieldsDeep } from '../../shared/command.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { useCommandAnswers } from '../commandAvailability.js';
import type { ActionBarProps, RecordActions } from '@mistriwork/kit/client/components/pageContext.js';
import { orderActions } from './actionOrder.js';
import { say } from '@mistriwork/kit/client/copy/record/components/Actions.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

/* A command's form is a dialog opened by a click: its chunk is fetched then, not with the first page. */
const CommandForm = onDemand(() => import('./CommandForm.js'), 'CommandForm', { quiet: true });

export type { ActionBarProps } from '@mistriwork/kit/client/components/pageContext.js';

/** What became of a verb the person ran: applied, or refused with the server's sentence. */
export type ActionOutcome = { status: 'done' | 'failed'; detail?: string };
/**
 * Who else is told when a verb drawn below this point has run, besides the
 * toast: the assistant's conversation, whose cards and tables draw the
 * record's own bar (AssistantPanel.tsx). The person's click, reported after
 * the fact; nothing here runs a verb.
 */
export const ActionOutcomes = createContext<
  ((report: { tableId: string; key: Record<string, unknown>; label: string; action: AppAction; outcome: ActionOutcome }) => void) | null
>(null);

/** How many verbs stay buttons on a wide screen before the rest fold into More. */
const INLINE = 3;

const said = (v: unknown, empty: string) => (v === null ? empty : String(v));
/** One key per condition on one record, shared by a button and the bar that decides whether to fold. */
const whenKey = (tableId: string, recordKey: Record<string, unknown>, when: string | undefined, queryScope?: number) => [
  'when',
  tableId,
  state.activeConnection,
  sessionIdentity().epoch,
  recordKey,
  when,
  ...(queryScope === undefined ? [] : [queryScope]),
];
const isCommand = (action: AppAction): action is AppCommandAction => action.command !== undefined;

/**
 * The values the record's own fixed edits can give `column` now: an edit
 * whose `set` is exactly that column, once its `when` holds — the board's
 * rule for a lane. It asks the bar's own questions under the bar's keys, so
 * nothing is asked twice. A command says nothing here: where it moves a
 * record is its code's to decide, not something the App declares.
 */
export function useReachable(
  tableId: string,
  recordKey: Record<string, unknown>,
  column: string | undefined,
  actions: RecordActions | undefined,
): ReadonlySet<string> {
  const moves =
    column && actions
      ? actions.list.filter(
          (action): action is AppUpdateAction =>
            !isCommand(action) &&
            Object.keys(action.set).length === 1 &&
            column in action.set &&
            (actions.canUpdate !== false || Boolean(actions.grantedActions?.includes(action.id))),
        )
      : [];
  const asked = [...new Set(moves.flatMap((action) => (action.when ? [action.when] : [])))];
  const answers = useQueries({
    queries: asked.map((when) => ({
      queryKey: whenKey(tableId, recordKey, when, actions?.queryScope),
      queryFn: () => actions!.matches(when),
    })),
  });
  const answered = new Map(asked.map((when, i) => [when, answers[i]?.data]));
  return new Set(moves.filter((action) => !action.when || answered.get(action.when) === true).map((action) => String(action.set[column!])));
}

export function ActionBar({
  tableId,
  actions,
  recordKey,
  label,
  matches,
  queryScope,
  onDone,
  canUpdate = true,
  grantedCommands = [],
  grantedActions = [],
  isCurrent: hostIsCurrent,
  compact = false,
  menuTail,
  menuOnly,
  destructive,
  primary,
  only,
  quiet = false,
}: ActionBarProps) {
  type Submission = {
    action: AppUpdateAction;
    owner: UpdateOwner;
    values: AppUpdateAction['set'];
    current: () => boolean;
    done: () => void;
  };
  const [asking, setAsking] = useState<Submission | null>(null);
  const [reasoning, setReasoning] = useState<Submission | null>(null);
  const [sending, setSending] = useState(false);
  const [commandForm, setCommandForm] = useState<{ action: AppCommandAction; owner: CommandOwner; epoch: number } | null>(null);
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(commandOperations.subscribe, commandOperations.version, commandOperations.version);
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  const owner: UpdateOwner = { connection: state.activeConnection ?? null, table: tableId, key: recordKey };
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const ownerText = updateOwnerKey(owner);
  const lifetime = useMemo(() => ({ identity, hostIsCurrent }), [identity, hostIsCurrent, ownerText, queryScope]);
  const activeLifetime = useRef(lifetime);
  activeLifetime.current = lifetime;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = (submitted: UpdateOwner) => {
    try {
      return (
        mounted.current &&
        activeLifetime.current === lifetime &&
        identity === sessionIdentity() &&
        identity.mode !== 'locked' &&
        identity.mode !== 'unknown' &&
        submitted.connection === (state.activeConnection ?? null) &&
        updateOwnerKey(submitted) === updateOwnerKey(currentOwner.current) &&
        (hostIsCurrent === undefined || hostIsCurrent() === true)
      );
    } catch {
      return false;
    }
  };
  const client = useQueryClient();
  const tell = useContext(ActionOutcomes);
  const told = (action: AppAction, key: Record<string, unknown>, outcome: ActionOutcome) =>
    tell?.({ tableId, key: { ...key }, label, action, outcome });
  const write = useMutation({
    retry: false,
    mutationFn: async ({ action, owner: submitted, values, current, done }: Submission) => {
      if (!current()) return undefined;
      const key = checkedRecordKey(submitted.key);
      const outcome = await updateAttempts.run(submitted, values, () => {
        if (!current()) throw Object.assign(new Error(say('thisActionBelongsToAPrevious')), { outcome: 'not_applied' });
        return api('/api/update', { ...ownedBy(submitted.connection), table: submitted.table, key, values });
      });
      return { action, submitted, outcome, current, done };
    },
    onSuccess: (result) => {
      if (!result || !result.current()) return;
      const { action, outcome, done } = result;
      if (outcome.kind !== 'applied') {
        if (outcome.kind !== 'uncertain') {
          toast(outcome.message, 'error');
          told(action, result.submitted.key, { status: 'failed', detail: outcome.message });
        }
        return;
      }
      told(action, result.submitted.key, { status: 'done' });
      toast(say('actionDone', { label: action.label }), 'ok');
      void client.invalidateQueries({ queryKey: ['when', tableId] });
      try {
        if (result.current()) done();
      } catch {
        toast(say('wasAppliedButTheRecord', { label: action.label }), 'error');
      }
    },
    onError: (err: Error, submitted) => {
      if (!submitted.current()) return;
      toast(err.message, 'error');
      told(submitted.action, submitted.owner.key, { status: 'failed', detail: err.message });
    },
  });

  const commandOwner = (action: AppCommandAction): CommandOwner => ({
    connection: state.activeConnection ?? '',
    target: action.command.target,
    command: action.command.id,
    commandVersion: action.command.version,
    key: { ...recordKey },
  });
  const allowedCommand = (action: AppCommandAction) =>
    identity.mode === 'authenticated' &&
    identity.appId === state.activeConnection &&
    grantedCommands.includes(action.command.id) &&
    action.command.target === tableId &&
    Boolean(findTable(tableId)) &&
    // Every type the form draws; a reference, at any depth, only over a resource this person reads.
    [...commandFieldsDeep(action.command.input)].every(({ field }) => field.type !== 'reference' || Boolean(findTable(field.from)));
  /* A fixed action is offered where the reader writes the table, or where a
     role of theirs runs this one without write (the server judges it again). */
  const allowedUpdate = (action: AppUpdateAction) => canUpdate || grantedActions.includes(action.id);
  const visible = actions.filter((action) => (isCommand(action) ? allowedCommand(action) : allowedUpdate(action)));
  /* `header: false` is an action the App runs from its own place: not drawn here, nor asked about, and still
     resumed below when its form was left open, since it is still the record's. */
  const drawable = visible.filter((action) => action.header !== false);
  const checkedCommands = drawable.filter(isCommand);
  const { available: availability, asking: askingCommands } = useCommandAnswers(
    checkedCommands.map((action) => ({ command: action.command.id, commandVersion: action.command.version, key: recordKey })),
    isCurrent(owner),
    lifetime,
  );
  // By id, not identity: a verb said in its state's words (below) is a copy of the one asked about.
  const availableCommand = (action: AppCommandAction) =>
    availability[checkedCommands.findIndex((checked) => checked.id === action.id)] === true;
  // Navigation can unmount a page; reopening the same record resumes its exact operation. One a component sent through
  // `run` is its caller's to resolve, and opens its own form if its answer never arrives.
  const resumable = (action: AppCommandAction) => {
    const operation = commandOperations.get(commandOwner(action));
    return Boolean(operation && !operation.headless);
  };
  const resumed = visible.find((action): action is AppCommandAction => isCommand(action) && resumable(action));
  const form =
    commandForm?.epoch === identity.epoch &&
    commandForm.owner.connection === state.activeConnection &&
    updateOwnerKey({ connection: commandForm.owner.connection, table: commandForm.owner.target, key: commandForm.owner.key }) ===
      updateOwnerKey(owner)
      ? commandForm
      : resumed
        ? { action: resumed, owner: commandOwner(resumed), epoch: identity.epoch }
        : null;
  const operation = form && commandOperations.get(form.owner);
  /* What a command on this record changed, asked again once its receipt lands (recordWriteRefresh.ts, G173). */
  const refreshCommanded = () =>
    refreshAfterCommand(client, {
      connection: owner.connection ?? '',
      table: tableId,
      key: recordKey,
      ...(queryScope === undefined ? {} : { queryScope }),
    });
  /* A command that asks nothing runs on one click, as a fixed verb does, and a notice says it ran: a
     dialog with only a submit in it asked a question nobody had. `confirm` asks first, in its form. An answer that
     never arrived opens the form, which says so and offers to check, as after its own submit. */
  const runAtOnce = async (action: AppCommandAction) => {
    const submitted = commandOwner(action);
    const surface = { ...owner, key: { ...owner.key } };
    setSending(true);
    const sent = await sendCommand(
      action,
      submitted,
      {},
      {
        headless: true,
        current: () => isCurrent(surface),
        refresh: () => {
          if (isCurrent(surface)) refreshCommanded();
        },
      },
    );
    if (mounted.current) setSending(false);
    if ('refused' in sent) {
      toast(sent.refused, 'error');
      told(action, submitted.key, { status: 'failed', detail: sent.refused });
      return;
    }
    const { operation } = sent;
    if (operation.phase === 'success' || operation.phase === 'error') {
      commandOperations.forget(submitted);
      if (operation.phase === 'error') {
        toast(operation.message, 'error');
        told(action, submitted.key, { status: 'failed', detail: operation.message });
        return;
      }
      // The command's own words when it said any ("Order #2461 is packed at SEC"), as its form would have said them.
      toast(operation.said ?? say('actionDone', { label: action.label }), 'ok');
      told(action, submitted.key, { status: 'done' });
      if (isCurrent(surface)) onDone();
      return;
    }
    if (isCurrent(surface)) setCommandForm({ action, owner: submitted, epoch: identity.epoch });
  };
  /* A command that runs on one click has its revision asked as the pointer or focus comes to its button, so the click
     sends only the execute (commandSend.ts readyCommand). */
  const atOnce = (action: AppAction): action is AppCommandAction =>
    isCommand(action) &&
    !action.command.input.length &&
    !action.confirm &&
    allowedCommand(action) &&
    availableCommand(action) &&
    !commandOperations.get(commandOwner(action));
  const ready = (action: AppAction) => {
    if (isCurrent(owner) && !busy && atOnce(action)) readyCommand(commandOwner(action));
  };
  const run = (action: AppAction) => {
    if (!isCurrent(owner)) return;
    if (isCommand(action)) {
      if (!allowedCommand(action) || !availableCommand(action)) return;
      if (atOnce(action)) void runAtOnce(action);
      else setCommandForm({ action, owner: commandOwner(action), epoch: identity.epoch });
      return;
    }
    if (!allowedUpdate(action)) return;
    if (updateAttempts.get(owner)) return;
    const submitted = { ...owner, key: { ...owner.key } };
    const submission = { action, owner: submitted, values: action.set, current: () => isCurrent(submitted), done: onDone };
    /* A reason is data, and a confirmation a promise to the author: both asked in every mode. An App has no Undo
       (its writes go through the writer pool), so a confirmed verb that wrote on one click could not be taken back. */
    if (action.reason) setReasoning(submission);
    else if (action.confirm) setAsking(submission);
    else write.mutate(submission);
  };

  /* Which actions are shown, asked once here with the same keys each button
     asks with, so a phone's menu knows before it draws whether it has one
     item or several, and nothing is asked twice: one question per distinct
     condition. An action without one asks nothing — a disabled placeholder
     for each shared one key, which React Query reported as duplicates. */
  /* A machine's verb that says itself differently by state ("Move to Proposal") asks which state the record is in
     the same way: one condition per label, answered with the rest. */
  const asked = [
    ...new Set(
      drawable.flatMap((action) => (isCommand(action) ? (action.labels ?? []).map((said) => said.when) : action.when ? [action.when] : [])),
    ),
  ];
  const conditions = useQueries({
    queries: asked.map((when) => ({
      queryKey: whenKey(tableId, recordKey, when, queryScope),
      queryFn: () => matches(when),
    })),
  });
  const answered = new Map(asked.map((when, i) => [when, conditions[i]?.data]));
  // Command availability already checks its current target/when on the
  // server; do not add a second per-row visibility HTTP request here.
  /* A verb with per-state labels waits for its label, so it never arrives in one set of words and changes to another. */
  const said = (action: AppAction): AppAction => {
    if (!isCommand(action) || !action.labels) return action;
    const label = action.labels.find((candidate) => answered.get(candidate.when) === true)?.label;
    return label === undefined || label === action.label ? action : { ...action, label };
  };
  const available = drawable
    .filter((action) =>
      isCommand(action)
        ? availableCommand(action) && (action.labels ?? []).every((candidate) => answered.get(candidate.when) !== undefined)
        : !action.when || answered.get(action.when) === true,
    )
    .map(said);
  /* One filled verb, the forward one; the destructive last and quiet (actionOrder.ts). Without a
     reading of what is destructive — a list's row menu — the author's order, the first filled. */
  const arranged = destructive
    ? orderActions(available, destructive, primary)
    : available.map((action, i) => ({ action, intent: i === 0 ? ('primary' as const) : ('secondary' as const) }));
  /* A header's `actions` lead in the order the author named them, the filled one first; whatever it does not name
     follows, and is More's however few there are. */
  const named = only
    ? arranged.filter(({ action }) => only.includes(action.id)).sort((a, b) => only.indexOf(a.action.id) - only.indexOf(b.action.id))
    : undefined;
  const ordered = named
    ? [
        ...(() => {
          const lead = named.find(({ intent }) => intent === 'primary');
          if (lead) return [lead, ...named.filter((entry) => entry !== lead)];
          /* The verb the record most needs next is not among the ones named: the first of those named that
             takes nothing away is filled, so a header with verbs always has its one filled button. */
          const first = named.find(({ intent }) => intent !== 'quiet');
          return first ? [{ ...first, intent: 'primary' as const }, ...named.filter((entry) => entry !== first)] : named;
        })(),
        ...arranged.filter((entry) => !named.includes(entry)),
      ]
    : arranged;
  const shown = ordered.map(({ action }) => action);
  const intentOf = new Map(ordered.map(({ action, intent }) => [action, quiet ? ('secondary' as const) : intent]));
  const busy = write.isPending || Boolean(updateAttempts.get(owner)) || sending;
  /* A split view's keys: shown beside the verb they run, and run through this bar as a click is. */
  const keys = useContext(RecordKeys);
  const keyOf = (action: AppAction) => Object.entries(keys).find(([, id]) => id === action.id)?.[0];
  const pressed = useRef<(key: string) => void>(() => {});
  pressed.current = (key) => {
    const action = shown.find((candidate) => keys[key] === candidate.id);
    if (action && !busy) run(action);
  };
  useEffect(() => {
    if (!Object.keys(keys).length) return;
    const onKey = (event: KeyboardEvent) => {
      if (!Object.hasOwn(keys, event.key) || !takesSingleKeys(event)) return;
      event.preventDefault();
      pressed.current(event.key);
    };
    addHostListener(document, 'keydown', onKey);
    return () => removeHostListener(document, 'keydown', onKey);
  }, [keys]);
  /* The usual next step is filled and first; a few more stay one tap away
     as quiet buttons, and the rest — Delete always last — are one menu. A
     phone keeps one button, so the bar never wraps under the name. */
  const inline = menuOnly ? [] : shown.slice(0, compact ? 1 : named ? named.length : INLINE);
  const folded = shown.slice(inline.length);
  /* While the record's verbs are still being asked about, the first one's
     place is held, unseen: on a phone the bar is a row of its own under the
     name, and its arriving pushed every section down a line
     (test/built-client-vitals.mjs). */
  const unanswered = askingCommands || conditions.some((condition) => condition.isPending);
  const hold = !menuOnly && !inline.length && unanswered && drawable.length > 0;

  return (
    <>
      {hold && (
        <Button className="page-action" aria-hidden="true" tabIndex={-1} style={{ visibility: 'hidden' }}>
          {drawable[0].label}
        </Button>
      )}
      {inline.map((action) => (
        <ActionButton
          key={action.label}
          action={action}
          intent={intentOf.get(action) ?? 'secondary'}
          busy={busy}
          hint={keyOf(action)}
          onReady={() => ready(action)}
          onClick={() => run(action)}
        />
      ))}
      {menuOnly && (
        <DropMenu
          className="row-actions-menu"
          triggerClassName="ghost row-actions-trigger"
          triggerTitle={say('common.actions', { label: menuOnly.label })}
          triggerLabel={say('common.actions', { label: menuOnly.label })}
          label="⋯"
          popupClassName="page-actions-popup"
          align="end"
          open={menuOnly.open}
          onOpenChange={menuOnly.onOpenChange}
        >
          {folded.map((action) => (
            <DropItem
              key={action.label}
              className={destructive?.(action) ? 'page-actions-item is-danger' : 'page-actions-item'}
              disabled={busy}
              onClick={() => run(action)}
            >
              {action.label}
            </DropItem>
          ))}
          {/* Conditions still being asked, or none that hold: said, not an empty box. */}
          {!folded.length && (
            <DropItem className="page-actions-item" disabled onClick={() => {}}>
              {conditions.some((condition) => condition.isPending) ? say('common.checking') : say('nothingToDoForThisRecord')}
            </DropItem>
          )}
        </DropMenu>
      )}
      {!menuOnly && (folded.length > 0 || menuTail) && (
        <DropMenu
          className="page-actions-menu"
          triggerClassName="ghost page-action"
          triggerTitle={say('moreActionsForThisRecord')}
          // "More" alone is the app menu's name; this one says whose it is.
          triggerLabel={say('moreActions')}
          label={say('common.more')}
          popupClassName="page-actions-popup"
          align="end"
        >
          {folded.map((action) => (
            <DropItem
              key={action.label}
              className={destructive?.(action) ? 'page-actions-item is-danger' : 'page-actions-item'}
              disabled={busy}
              onClick={() => run(action)}
            >
              {action.label}
              {keyOf(action) && <kbd className="key-hint">{keyOf(action)!.toUpperCase()}</kbd>}
            </DropItem>
          ))}
          {menuTail}
        </DropMenu>
      )}
      {form && (
        <CommandForm
          key={`${form.epoch}:${form.owner.command}:${JSON.stringify(form.owner.key)}`}
          action={operation?.action ?? form.action}
          owner={operation?.owner ?? form.owner}
          label={label}
          isCurrent={hostIsCurrent}
          onApplied={refreshCommanded}
          onClose={(closed?: CommandOperation) => {
            if (!isCurrent(owner)) return;
            setCommandForm(null);
            if (closed?.phase === 'error') told(form.action, form.owner.key, { status: 'failed', detail: closed.message });
          }}
          onDone={() => {
            if (!isCurrent(owner)) return;
            told(form.action, form.owner.key, { status: 'done' });
            onDone();
          }}
        />
      )}
      {asking && (
        <Confirm
          tableId={tableId}
          action={asking.action}
          label={label}
          onAnswer={(yes) => {
            setAsking(null);
            if (yes && asking.current()) write.mutate(asking);
          }}
        />
      )}
      {reasoning && (
        <ReasonForm
          action={reasoning.action}
          label={label}
          onAnswer={(reason) => {
            setReasoning(null);
            if (reason !== null && reasoning.current() && reasoning.action.reason) {
              write.mutate({ ...reasoning, values: { ...reasoning.action.set, [reasoning.action.reason]: reason } });
            }
          }}
        />
      )}
    </>
  );
}

/** A verb as a button: whether it is shown was asked once, by the bar. */
function ActionButton({
  action,
  intent,
  busy,
  hint,
  onReady,
  onClick,
}: {
  action: AppAction;
  intent: 'primary' | 'secondary' | 'quiet';
  busy: boolean;
  hint?: string;
  onReady?: () => void;
  onClick: () => void;
}) {
  return (
    <Button
      intent={intent}
      className="page-action"
      disabled={busy}
      title={
        action.command
          ? action.label
          : Object.entries(action.set)
              .map(([c, v]) => `${c} → ${said(typeof v === 'string' && v.startsWith('=') ? v.slice(1) : v, 'null')}`)
              .join(', ')
      }
      onClick={onClick}
      onPointerEnter={onReady}
      onFocus={onReady}
      {...(hint ? { 'aria-keyshortcuts': hint.toUpperCase() } : {})}
    >
      {action.label}
      {hint && <kbd className="key-hint">{hint.toUpperCase()}</kbd>}
    </Button>
  );
}

/** Ask before writing, in the page's own dialog. */
function Confirm({
  tableId,
  action,
  label,
  onAnswer,
}: {
  tableId: string;
  action: AppUpdateAction;
  label: string;
  onAnswer: (yes: boolean) => void;
}) {
  const table = findTable(tableId) as TableMeta | undefined;
  const answered = useRef(false);
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(yes);
  };
  return (
    <Modal className="confirm action-confirm" ariaLabel={`${action.label}?`} onClose={() => answer(false)}>
      <h2>{action.label}?</h2>
      <p>{label}</p>
      <table className="confirm-diff">
        <tbody>
          {Object.entries(action.set).map(([column, value]) => (
            <tr key={column}>
              <th scope="row" title={column}>
                {columnLabel(tableId, column) ?? humanName(column)}
              </th>
              {/* An expression the server works out as it writes ('=today + 14 days') is said as written. */}
              <td>
                {typeof value === 'string' && value.startsWith('=') ? (
                  value.slice(1)
                ) : (
                  <Value
                    tableId={tableId}
                    col={
                      table?.columns.find((col) => col.name === column) ?? { name: column, type: 'TEXT', nullable: true, primaryKey: false }
                    }
                    value={value}
                    compact
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="confirm-actions">
        <Button intent="secondary" onClick={() => answer(false)}>
          {say('common.cancel')}
        </Button>
        <Button intent="primary" onClick={() => answer(true)}>
          {action.label}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * An action that moves a record for a reason asks for it first, in the page's
 * own dialog. The note is written with the change, in the same update, so the
 * server can hold the move to it (appTransitions).
 */
export function ReasonForm({
  action,
  label,
  onAnswer,
}: {
  action: AppUpdateAction;
  label: string;
  onAnswer: (reason: string | null) => void;
}) {
  const [text, setText] = useState('');
  const answered = useRef(false);
  const field = useId();
  const answer = (reason: string | null) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(reason);
  };
  return (
    <Modal
      className="confirm action-confirm action-reason"
      ariaLabel={say('labelReason', { label: action.label })}
      onClose={() => answer(null)}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) answer(text.trim());
        }}
      >
        <h2>{action.label}</h2>
        <p>
          {label ? say('sayWhyFor', { label }) : say('sayWhy')}
          {say('theReasonIsKept')}
        </p>
        <label className="action-reason-label" htmlFor={field}>
          {say('reason')}
        </label>
        <textarea
          id={field}
          className="action-reason-text"
          value={text}
          required
          rows={3}
          autoFocus
          onChange={(event) => setText(event.target.value)}
        />
        <div className="confirm-actions">
          <Button intent="secondary" onClick={() => answer(null)}>
            {say('common.cancel')}
          </Button>
          <Button intent="primary" type="submit" disabled={!text.trim()}>
            {action.label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
