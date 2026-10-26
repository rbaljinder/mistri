/**
 * A selection of loaded records and the bulk actions offered for exactly
 * those keys — shared by the queue (a listbox) and the grid (a checkbox in
 * each row's host), so the two are one contract: the exact keys of loaded
 * records, never "everything matching"; a fixed update written per record
 * through `applyBulk`, each answered on its own; a bulk command sent once
 * for the group through its form.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expectedValues, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppAction, AppCommandAction, AppUpdateAction } from '@mistriwork/engine/schema/model.js';
import { commandFieldsDeep, commandKeyText } from '@mistriwork/engine/shared/commandWire.js';
import { columnLabel, findTable, state, writeAllowed } from '../core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { onDemand, useArrived } from './onDemand.js';
import type { CountedMessage } from './CountedLabel.js';
import { messageLanguage, servedLanguage } from '../messages.js';
import { grantedActionIds } from '../actionGrants.js';
import {
  applyBulk,
  bulkCommandSummary,
  bulkKey,
  bulkSummary,
  countedLabel,
  matchingKeys,
  BULK_LIMIT,
  type BulkRecordOutcome,
  type BulkResult,
  type BulkTarget,
} from '../bulkActions.js';
import { sessionIdentity, subscribeSessionIdentity } from '../sessionIdentity.js';
import { updateAttempts } from '../updateAttempts.js';
import { shell, type BulkCommandOperation, type BulkCommandOwner } from '../shellMode.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { formatLocale, formatNumber } from '../locale.js';
import { resourceOf } from './appRooms.js';
import { pluralOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { say } from '../copy/lists/components/useBulkSelection.js';

/* A selection's App commands are the shell's (shellMode.ts `bulkCommands`): where it has none, a list offers none, and
   these stand in so the hooks below are asked the same way in either shell. */
const NO_RUNS = { subscribe: () => () => {}, version: () => 0, unresolvedGroups: (): BulkCommandOperation[] => [] };
const NO_ANSWERS: boolean[] = [];
const noAvailability = () => NO_ANSWERS;

/* "Set field…" draws its own dialog, fetched the first time it is chosen. */
const SetFieldDialog = onDemand(() => import('./SetFieldDialog.js'), 'SetFieldDialog', { quiet: true });
const Counted = onDemand(() => import('./CountedLabel.js'), 'CountedLabel', { quiet: true });

/**
 * An action's label for the selection. One whose App message counts (server
 * appMessages.ts countedLabels) is said by the formatter, loaded the first
 * time a selection of several needs it, the words for one record standing in
 * meanwhile; any other is counted as English counts it (countedLabel), or not
 * at all.
 */
function ActionLabel({ action, count, noun }: { action: AppAction; count: number; noun?: { one: string; many: string } }) {
  const message = (action as { counted?: CountedMessage }).counted;
  const wanted = Boolean(message) && count > 1;
  const here = useArrived(Counted, wanted);
  if (message && wanted && here)
    return <Counted message={message} count={count} locale={servedLanguage() ?? formatLocale() ?? messageLanguage()} />;
  return <>{!message && noun ? countedLabel(action.label, count, noun) : action.label}</>;
}

/** A record the selection can name: its bulk key, its key, what it is called, its row. */
export interface BulkRecord extends BulkTarget {
  id: string;
  row: Record<string, unknown>;
}
interface Run {
  label: string;
  done: number;
  total: number;
}
interface Asking {
  action: AppUpdateAction;
  count: number;
  skipped: number;
  answer: (yes: boolean) => void;
}
/** `summary` replaces the per-record sentence for a group's single outcome. */
interface Reported {
  label: string;
  result: BulkResult;
  summary?: string;
}
/** A bulk command's form: the records it names, in list order. */
interface CommandRun {
  action: AppCommandAction;
  targets: BulkTarget[];
  epoch: number;
}

const said = (v: unknown) => (v === null ? 'null' : String(v));
/* What the resource's records are called: its noun, else its table's name
   as a person says it, made plural by rule unless it already reads so. */
function nounOf(table: TableMeta): { one: string; many: string } {
  const app = shell().app();
  const authored = app?.resources ? resourceOf(app, table.id)?.noun : undefined;
  if (authored) return authored;
  const one = recordNoun(undefined, table.name);
  return { one, many: /[^s]s$/i.test(one) ? one : pluralOf(one) };
}
const setSummary = (action: AppUpdateAction) =>
  Object.entries(action.set)
    .map(([c, v]) => `${c} → ${said(v)}`)
    .join(', ');
const isUpdate = (action: AppAction): action is AppUpdateAction => action.command === undefined;
const isCommand = (action: AppAction): action is AppCommandAction => action.command !== undefined;
const tally = (outcomes: BulkRecordOutcome[], stopped = false): BulkResult => {
  const counts: BulkResult['counts'] = { applied: 0, rejected: 0, uncertain: 0, blocked: 0, skipped: 0 };
  for (const outcome of outcomes) counts[outcome.kind]++;
  return { outcomes, counts, stopped };
};

/** The bulk updates and commands this reader may run over the resource now. */
export function offeredBulk(
  table: TableMeta,
  actions: AppAction[],
  interactive: boolean,
  identity = sessionIdentity(),
  connection: string | null = state.activeConnection ?? null,
  editable: readonly string[] = [],
) {
  const writable = () => {
    const current = findTable(table.id) as TableMeta | undefined;
    return (
      interactive &&
      writeAllowed(table.id) &&
      Boolean(current) &&
      !current!.isView &&
      !table.isView &&
      Boolean(state.connections?.some((c) => c.id === connection && c.writable))
    );
  };
  const columnWritable = (action: AppUpdateAction) => {
    const current = findTable(table.id) as TableMeta | undefined;
    return Object.keys(action.set).every((name) => {
      const column = current?.columns.find((c) => c.name === name);
      return column && !column.primaryKey && column.writable !== false;
    });
  };
  /* Or a fixed action a role of this reader runs without write: the server
     admits it per record as that action and nothing else. */
  const granted = (action: AppUpdateAction) =>
    interactive &&
    grantedActionIds(shell().app(), table.id).includes(action.id) &&
    !table.isView &&
    Boolean(findTable(table.id)) &&
    Boolean(state.connections?.some((c) => c.id === connection && c.writable));
  const bulk = actions
    .filter(isUpdate)
    .filter((action) => action.bulk === true && ((writable() && columnWritable(action)) || granted(action)));
  /* A command needs its own grant, not generic write: the manager who may
     assign cannot edit the application, and that is the point. */
  const grantedCommands = shell().app()?.grantedCommands ?? [];
  const commandAllowed = (action: AppCommandAction) =>
    interactive &&
    action.bulk === true &&
    action.command.targets === 'many' &&
    identity.mode === 'authenticated' &&
    identity.appId === connection &&
    grantedCommands.includes(action.command.id) &&
    action.command.target === table.id &&
    Boolean(findTable(table.id)) &&
    // Every type the form draws; a reference, at any depth, only over a resource this person reads.
    [...commandFieldsDeep(action.command.input)].every(({ field }) => field.type !== 'reference' || Boolean(findTable(field.from)));
  const commands = shell().slots.bulkCommands ? actions.filter(isCommand).filter(commandAllowed) : [];
  /* "Set field…" writes one of the list's editable columns, under the same
     gate as a fixed update: each still a writable column of this reader's. */
  const fields = writable() ? editable.filter((name) => columnWritable({ id: `set:${name}`, label: name, set: { [name]: null } })) : [];
  return { bulk, commands, fields };
}

export function useBulkSelection({
  table,
  keyed,
  actions = [],
  interactive = true,
  editable = [],
}: {
  table: TableMeta;
  keyed: BulkRecord[];
  actions?: AppAction[];
  interactive?: boolean;
  /** The list's editable columns, offered to the selection as "Set field…". */
  editable?: readonly string[];
}) {
  const client = useQueryClient();
  const commanding = shell().slots.bulkCommands;
  const commandOperations = commanding?.operations ?? NO_RUNS;
  const useCommandAvailability = commanding?.useAvailability ?? noAvailability;
  const CommandForm = commanding?.Form;
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  useSyncExternalStore(commandOperations.subscribe, commandOperations.version, commandOperations.version);
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  const [selected, setSelected] = useState<string[]>([]);
  const [capped, setCapped] = useState(false);
  const [running, setRunning] = useState<Run | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [reported, setReported] = useState<Reported | null>(null);
  const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  /* Where a closing command form sends focus. The dialog resolves it while it
     unmounts, before anything mounted in the same commit has a ref, so the
     report region is always in the tree (hidden until it has a report) and
     this points at it only when the close produces one; a Cancel with nothing
     sent leaves it empty, and focus goes back to the toolbar button. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const connection = state.activeConnection ?? null;
  const byId = new Map(keyed.map((record) => [record.id, record]));
  // A record that left the list leaves the selection; one that returns is not re-selected.
  const present = keyed.map((record) => record.id).join('\n');
  useEffect(() => {
    const ids = new Set(present.split('\n'));
    setSelected((current) => (current.every((id) => ids.has(id)) ? current : current.filter((id) => ids.has(id))));
  }, [present]);
  const selection = useMemo(() => selected.filter((id) => byId.has(id)), [selected, present]);

  const { bulk, commands, fields } = offeredBulk(table, actions, interactive, identity, connection, editable);
  const [setting, setSetting] = useState(false);
  const selectedRecords = keyed.filter((record) => selection.includes(record.id));
  const availability = useCommandAvailability(
    commands.flatMap((action) =>
      selectedRecords.map((record) => ({
        command: action.command.id,
        commandVersion: action.command.version,
        key: record.key,
      })),
    ),
    interactive,
  );
  const availableCommands = commands.filter(
    (_action, index) =>
      selectedRecords.length > 0 &&
      selectedRecords.every((_record, offset) => availability[index * selectedRecords.length + offset] === true),
  );

  // Navigation can unmount the queue; coming back resumes an unconfirmed group.
  const resumed = commandRun
    ? undefined
    : commandOperations
        .unresolvedGroups(connection ?? '', table.id)
        .find((operation) => operation.identity === identity && operation.action && operation.owner.keys);
  const commandForm: CommandRun | null =
    commandRun && commandRun.epoch === identity.epoch
      ? commandRun
      : resumed
        ? {
            action: resumed.action!,
            epoch: identity.epoch,
            targets: resumed.owner.keys!.map((key, index) => ({ key, label: resumed.owner.labels?.[index] ?? commandKeyText(key) })),
          }
        : null;
  const groupOwner = (run: CommandRun): BulkCommandOwner => ({
    connection: connection ?? '',
    target: run.action.command.target,
    command: run.action.command.id,
    commandVersion: run.action.command.version,
    key: {},
    keys: run.targets.map((target) => ({ ...target.key })),
    labels: run.targets.map((target) => target.label),
  });
  const formEpoch = commandForm?.epoch;
  const formCurrent = useCallback(
    () => alive.current && sessionIdentity().epoch === formEpoch && (state.activeConnection ?? null) === connection,
    [formEpoch, connection],
  );

  const change = (keys: string[]) => {
    const over = keys.length > BULK_LIMIT;
    setCapped(over);
    setSelected(over ? keys.slice(0, BULK_LIMIT) : keys);
  };
  const clear = () => {
    setSelected([]);
    setCapped(false);
    setReported(null);
  };

  const run = (action: AppUpdateAction) => (bulk.includes(action) ? write(action) : Promise.resolve());
  /* "Set field…": one value for one column, written per record exactly as a
     fixed update is — the dialog that chose it was the confirmation. */
  const setField = (column: string, value: string | null) => {
    setSetting(false);
    if (!fields.includes(column)) return Promise.resolve();
    return write({
      id: `set:${column}`,
      label: say('setColumn', { column: columnLabel(table.id, column) ?? humanName(column) }),
      set: { [column]: value },
    });
  };
  const write = async (action: AppUpdateAction) => {
    if (running || commandForm) return;
    const targets = keyed.filter((record) => selection.includes(record.id));
    if (!targets.length) return;
    const epoch = sessionIdentity().epoch;
    const current = () => alive.current && sessionIdentity().epoch === epoch && (state.activeConnection ?? null) === connection;
    setReported(null);
    setRunning({ label: action.label, done: 0, total: targets.length });
    const matching = await matchingKeys(
      table,
      targets.map((record) => record.key),
      action.when,
      connection,
    );
    if (!current()) {
      if (alive.current) setRunning(null);
      return;
    }
    const applicable = targets.filter((record) => matching.has(record.id));
    const skipped = new Map(
      targets
        .filter((record) => !matching.has(record.id))
        .map((record): [string, BulkRecordOutcome] => [
          record.id,
          { key: record.key, label: record.label, kind: 'skipped', message: say('doesNotMatchNow', { when: action.when ?? '' }) },
        ]),
    );
    // Nothing to write needs no permission; the report says why.
    if (action.confirm && applicable.length) {
      const yes = await new Promise<boolean>((answer) => setAsking({ action, count: applicable.length, skipped: skipped.size, answer }));
      if (alive.current) setAsking(null);
      if (!yes || !current()) {
        if (alive.current) setRunning(null);
        return;
      }
    }
    const applied = await applyBulk(
      { connection, table: table.id },
      action.set,
      applicable.map(({ key, label, row }) => {
        const expected = expectedValues(table, action.set, row);
        return { key, label, ...(expected ? { expected } : {}) };
      }),
      current,
      (done, total) => {
        if (alive.current) setRunning({ label: action.label, done, total });
      },
    );
    if (!alive.current) return;
    setRunning(null);
    const written = new Map(applied.outcomes.map((outcome) => [bulkKey(table, outcome.key), outcome]));
    const result = tally(
      targets.map((record) => written.get(record.id) ?? skipped.get(record.id)!),
      applied.stopped,
    );
    setReported({ label: action.label, result });
    if (result.counts.applied && current()) {
      void shell().undo.refresh();
      void client.invalidateQueries({ queryKey: ['run', connection] });
      void client.invalidateQueries({ queryKey: ['count', connection] });
      void client.invalidateQueries({ queryKey: ['when', table.id] });
    }
  };

  /* A bulk command prepares, asks and sends inside the command form. Its
     records are the selection at the press, in list order; the form may
     only narrow them (Deselect ineligible), never widen them. */
  const openCommand = (action: AppCommandAction) => {
    if (running || commandForm || !availableCommands.includes(action)) return;
    const targets = keyed.filter((record) => selection.includes(record.id)).map(({ key, label }) => ({ key, label }));
    if (!targets.length) return;
    setReported(null);
    setCommandRun({ action, targets, epoch: identity.epoch });
  };
  const deselect = (keys: Array<Record<string, unknown>>) => {
    const drop = new Set(keys.map(commandKeyText));
    setSelected((current) =>
      current.filter((id) => {
        const record = byId.get(id);
        return !record || !drop.has(commandKeyText(record.key));
      }),
    );
    setCommandRun((current) => {
      if (!current) return current;
      const targets = current.targets.filter((target) => !drop.has(commandKeyText(target.key)));
      return targets.length ? { ...current, targets } : null;
    });
  };
  // One outcome for the group; an unconfirmed one keeps the form open instead.
  const closeCommand = (settled?: BulkCommandOperation) => {
    const finished = commandForm;
    setCommandRun(null);
    returnFocus.current = null;
    if (!finished || !settled || !alive.current) return;
    if (settled.phase === 'success' || settled.phase === 'error') returnFocus.current = resultRef.current;
    const count = settled.owner.keys?.length ?? finished.targets.length;
    if (settled.phase === 'success') {
      setReported({
        label: finished.action.label,
        summary: bulkCommandSummary(finished.action.label, count, 'applied'),
        result: tally(finished.targets.map((target) => ({ ...target, kind: 'applied', message: '' }))),
      });
    } else if (settled.phase === 'error') {
      const named =
        settled.refusedKey && finished.targets.find((target) => commandKeyText(target.key) === commandKeyText(settled.refusedKey));
      const message = `${settled.message}${named ? ` (${named.label})` : ''}`;
      setReported({
        label: finished.action.label,
        summary: bulkCommandSummary(finished.action.label, count, 'rejected', message),
        result: tally(finished.targets.map((target) => ({ ...target, kind: 'rejected', message }))),
      });
    }
  };
  // The report is the answer to the press; a reader hears it where they are.
  // After a command form the dialog hands focus here itself (`returnFocus`),
  // once the page behind it is no longer inert.
  useEffect(() => {
    if (reported) resultRef.current?.focus();
  }, [reported]);

  const failed = reported && (reported.result.counts.rejected > 0 || reported.result.counts.uncertain > 0);
  const busy = Boolean(running) || Boolean(commandForm);
  const bar = (
    <>
      {/* Nothing until something is chosen: a row of disabled verbs and "0
        selected" above every list was a bar of things that could not be done. */}
      {(bulk.length > 0 || commands.length > 0 || fields.length > 0) && (selection.length > 0 || running) && (
        <div role="toolbar" aria-label={say('selectedRecords')} className="queue-bulk" aria-busy={Boolean(running)}>
          <span className="queue-count">{say('selected', { selectionCount: selection.length })}</span>
          {fields.length > 0 && (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setReported(null);
                setSetting(true);
              }}
            >
              {say('setField')}
            </button>
          )}
          {bulk.map((action) => (
            <button
              key={action.label}
              type="button"
              className="ghost"
              title={setSummary(action)}
              disabled={busy}
              onClick={() => {
                void run(action);
              }}
            >
              <ActionLabel action={action} count={selection.length} />
            </button>
          ))}
          {availableCommands.map((action) => (
            <button
              key={`command:${action.command.id}:${action.label}`}
              type="button"
              className="ghost"
              title={say('oneRequestForTheWhole')}
              disabled={busy}
              onClick={() => openCommand(action)}
            >
              <ActionLabel action={action} count={selection.length} noun={nounOf(table)} />
            </button>
          ))}
          <button type="button" className="ghost queue-clear" disabled={Boolean(running)} onClick={clear}>
            {say('clearSelection')}
          </button>
          {running && (
            <span className="queue-progress" role="status">
              {say('applying', { done: running.done, total: running.total })}
            </span>
          )}
        </div>
      )}
      {capped && (
        <p className="queue-status" role="status">
          {say('selectionIsLimitedToRecords', { max: BULK_LIMIT })}
        </p>
      )}
      {/* Dismiss stands beside the report, not in it: the report is where a
        closing command form sends focus, and a dialog sends it to the first
        control inside its target when there is one. */}
      <div className="queue-report">
        <div className="queue-result" role={failed ? 'alert' : 'status'} tabIndex={-1} ref={resultRef} hidden={!reported}>
          {reported && <p>{reported.summary ?? bulkSummary(reported.label, reported.result)}</p>}
          {reported && !reported.summary && reported.result.outcomes.some((outcome) => outcome.kind !== 'applied') && (
            <ul>
              {reported.result.outcomes
                .filter((outcome) => outcome.kind !== 'applied')
                .map((outcome) => (
                  <li key={bulkKey(table, outcome.key)}>
                    {outcome.label}: {outcome.message}
                  </li>
                ))}
            </ul>
          )}
        </div>
        {reported && !running && (
          <button type="button" className="ghost queue-dismiss" onClick={clear}>
            {say('common.dismiss')}
          </button>
        )}
      </div>
    </>
  );
  const dialogs = (
    <>
      {setting && (
        <SetFieldDialog
          table={table}
          columns={fields}
          count={selection.length}
          row={selectedRecords[0]?.row}
          onApply={(column, value) => {
            void setField(column, value);
          }}
          onClose={() => setSetting(false)}
        />
      )}
      {asking && (
        <Confirm
          asking={asking}
          onAnswer={(yes) => {
            setAsking(null);
            asking.answer(yes);
          }}
        />
      )}
      {commandForm && CommandForm && (
        <CommandForm
          key={`${commandForm.epoch}:${commandForm.action.command.id}`}
          action={commandForm.action}
          owner={groupOwner(commandForm)}
          targets={commandForm.targets}
          onDeselect={deselect}
          noun={nounOf(table)}
          label={say('countSelectedRecords', { count: commandForm.targets.length })}
          onClose={closeCommand}
          onDone={() => {}}
          isCurrent={formCurrent}
          finalFocus={returnFocus}
        />
      )}
    </>
  );
  return { offered: bulk.length > 0 || commands.length > 0 || fields.length > 0, selection, change, clear, byId, bar, dialogs };
}

/** Ask before writing the selection, in the page's own dialog. */
function Confirm({ asking, onAnswer }: { asking: Asking; onAnswer: (yes: boolean) => void }) {
  const { action, count, skipped } = asking;
  const answered = useRef(false);
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(yes);
  };
  return (
    <Modal className="confirm action-confirm" aria-label={`${action.label}?`} onClose={() => answer(false)}>
      <h2>{action.label}?</h2>
      <p>
        {say('applyToSelectedRecords', { count })}
        {skipped ? say('willBeSkipped', { skipped: formatNumber(skipped) }) : ''}.
      </p>
      <p>
        <strong>{setSummary(action)}</strong>
      </p>
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
