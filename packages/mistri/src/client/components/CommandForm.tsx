/**
 * A record action's command form: the modal that prepares the record — its
 * revision, and the starting values the command serves — draws the
 * command's inputs through CommandFields, and submits once under a request
 * key the operation store keeps, for one record or a queue's selection.
 */
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppCommandAction } from '../../shared/app.js';
import { api, state } from '@mistriwork/kit/client/core.js';
import { commandOperations, type CommandOperation, type CommandOwner } from '../commandState.js';
import { countedLabel, prepareBulkCommand, type PreparedTarget } from '@mistriwork/kit/client/bulkActions.js';
import { commandFieldsDeep, commandKeyText, recordColumnsIn, type AppCommandField } from '../../shared/command.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import {
  CommandFields,
  asksDraftLogic,
  blankCommandValues,
  draftLogic,
  readsRecord,
  commandInput,
  prefilledCommandValues,
  type CommandQuestions,
  type CommandValues,
} from './CommandFields.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/forms/components/CommandForm.js';
import { liveKeyText, registerEditing, releaseEditNotice, useEditNotice } from '@mistriwork/kit/client/liveState.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';

const LiveEditNotice = onDemand(() => import('@mistriwork/kit/client/components/LiveNotices.js'), 'LiveEditNotice', { quiet: true });

/** One record prepared: the revision the form submits, and its starting values when the command serves them. */
/* The pickers that read the record (`record.id` in their query), each waiting (null) until prepare binds it. */
const waitingPickers = (fields: readonly AppCommandField[]): Record<string, null> =>
  Object.fromEntries(
    [...commandFieldsDeep(fields)].flatMap(({ field, path }) =>
      field.type === 'reference' && field.query && recordColumnsIn(field.query).length ? [[path, null]] : [],
    ),
  );

/* The fields a prepared record is asked. A `when` that reads the record waits for prepare: left out where the
   record's part never holds, a plain field where it always does, and otherwise the draft's part prepare left to
   judge as it is typed. A `when` over the draft alone is the form's own to judge (commandDraft.ts). */
function asked(
  input: readonly AppCommandField[],
  record: { withheld?: string[]; when?: Record<string, string> } | undefined,
): readonly AppCommandField[] {
  if (!input.some((field) => field.type !== 'group' && field.type !== 'lines' && field.when !== undefined && readsRecord(field.when)))
    return input;
  return input.flatMap((field): AppCommandField[] => {
    if (field.type === 'group' || field.type === 'lines' || field.when === undefined || !readsRecord(field.when)) return [field];
    if (!record || record.withheld?.includes(field.name)) return [];
    const { when: _when, ...plain } = field;
    const left = record.when?.[field.name];
    return [(left === undefined ? plain : { ...plain, when: left }) as AppCommandField];
  });
}

interface PreparedRecord {
  expectedVersion: number;
  initial?: Record<string, unknown>;
  /** Pickers that read the record (`record.id` in their query), bound to it: by declared path, null for none. */
  choices?: Record<string, string | null>;
  /** The inputs this record is not asked: their `when` does not hold of it. */
  withheld?: string[];
  /** What is left of a record-reading `when` to judge over the draft, by input. */
  when?: Record<string, string>;
  /** The questions defined in rows this record is asked, by input name (`field.defined`). */
  questions?: CommandQuestions;
  /** The count of applied commands when this prepare was asked (commandOperations.appliedOn). */
  seen: number;
}
/* The same count for a group's prepare, whose answer is a Map. */
const groupSeen = new WeakMap<Map<string, PreparedTarget>, number>();

/** The table a command acts on, as live sync's notice names it (its noun, its history). */
const liveTable = (id: string): TableMeta =>
  (state.schema?.tables?.find((table: TableMeta) => table.id === id) as TableMeta | undefined) ??
  ({ id, name: id, columns: [] } as unknown as TableMeta);

/** One record of a group, as the host names it. */
interface CommandTarget {
  key: Record<string, unknown>;
  label: string;
}

export function CommandForm({
  action,
  owner,
  label,
  onClose,
  onDone,
  isCurrent,
  targets,
  onDeselect,
  finalFocus,
  noun,
  initial,
  headless,
  onApplied,
}: {
  action: AppCommandAction;
  owner: CommandOwner;
  label: string;
  /** Starting values a custom component handed over (useCommand's `open`), over the blank form and before the command's own. */
  initial?: Readonly<Record<string, unknown>>;
  /** Opened by a component's `open`, which holds this form and resolves it: the record's action bar must not draw its
      own copy over the same operation, and Done there would blank this one. */
  headless?: boolean;
  /** What a group's records are called, so its verb counts them: "Approve 2 timesheets". */
  noun?: { one: string; many: string };
  /** The form closed; a settled operation says how it ended (success or a definite refusal). */
  onClose: (settled?: CommandOperation) => void;
  onDone: () => void;
  /** The command landed: what to ask again. A record's bar asks its record (recordWriteRefresh.ts refreshAfterCommand);
      without it, every read is asked again, as a group's or an assistant's form does. */
  onApplied?: () => void;
  /** Supplemental host lifetime; retirement never forgets an operation. */
  isCurrent?: () => boolean;
  /** A group owner's records, aligned with `owner.keys`. */
  targets?: CommandTarget[];
  /** Drop these records from the group. The host owns the selection, and the form follows it. */
  onDeselect?: (keys: Array<Record<string, unknown>>) => void;
  /** Where the host wants focus when the form closes — its report of the outcome. */
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  // A group is one request for several records: every one commits or none does.
  const group = owner.keys !== undefined;
  const [identity] = useState(sessionIdentity);
  const currentIdentity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(commandOperations.subscribe, commandOperations.version, commandOperations.version);
  const operation = commandOperations.get(owner);
  const [values, setValues] = useState<CommandValues>(
    () =>
      (operation?.envelope.input as CommandValues | undefined) ??
      (initial ? prefilledCommandValues(action.command.input, initial) : blankCommandValues(action.command.input)),
  );
  /* The fields the person has changed since the form was (re)filled. The
     starting values arrive with `prepare`, which can answer after someone has
     already picked a code or typed a note: they fill every field but these,
     so neither the edits nor the starting values are lost (a box that starts
     checked stayed unchecked because one other field had been typed in). */
  const touched = useRef(new Set<string>());
  const [problem, setProblem] = useState('');
  /* A refusal that names one of the inputs — `refuse('Only $12.00 is left to refund', { field: 'amount' })` — is said
     beside that input, and the form lets go of the attempt so the answer can be changed and sent again: nothing ran. */
  const [beside, setBeside] = useState<Record<string, string> | undefined>(undefined);
  const refusedField =
    operation?.phase === 'error' &&
    operation.field &&
    action.command.input.some((field) => field.name === operation.field!.split(/[.[]/)[0])
      ? operation.field
      : undefined;
  useEffect(() => {
    if (!refusedField || !operation || !current()) return;
    setBeside({ [refusedField]: operation.message });
    commandOperations.forget(owner);
  });
  // The selection the form opened with is what it prepares; deselecting
  // narrows the request without asking the server again.
  const [preparedKeys] = useState(() => owner.keys?.map((key) => ({ ...key })));
  const client = useQueryClient();
  const id = useId();
  const ownerText = JSON.stringify([owner.connection, owner.target, owner.command, owner.commandVersion, owner.key, owner.keys]);
  /* Live sync (liveInvalidate.ts): once something is typed, the records the form acts on are not read over it — their
     fields, its prepared starting values — and a change to one is said in the status line instead. Untouched, the
     form still follows the record. Let go when the form closes, with the notice it raised: the next form starts
     clean, unless the record's own draft is still open over the same record and still owns it. */
  const recordText = owner.keys ? '' : liveKeyText(owner.key);
  const changedElsewhere = useEditNotice(owner.target, recordText);
  useEffect(() => {
    const release = registerEditing(() => {
      if (!touched.current.size || commandOperations.get(owner)) return undefined;
      const keys = owner.keys ?? (Object.keys(owner.key).length ? [owner.key] : []);
      return keys.map((key) => ({ table: owner.target, key }));
    });
    return () => {
      release();
      for (const key of owner.keys ?? [owner.key]) releaseEditNotice(owner.target, liveKeyText(key));
    };
  }, [ownerText]);
  const lifetime = useMemo(() => ({}), [ownerText, isCurrent]);
  const activeLifetime = useRef(lifetime);
  activeLifetime.current = lifetime;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /* Closed, and only waiting to be taken down. A component's form (useCommand's `open`) is unmounted a microtask after
     it closes (mount.tsx), so it draws once more with its refused operation forgotten — which re-enabled its prepare,
     whose answer, arriving after the unmount, failed as "no longer current" and stood in the cache as the answer a
     form opened again at once was handed: "The record could not be prepared". */
  const closed = useRef(false);
  const current = () => {
    try {
      return (
        mounted.current &&
        activeLifetime.current === lifetime &&
        sessionIdentity() === identity &&
        identity.mode === 'authenticated' &&
        state.activeConnection === owner.connection &&
        (isCurrent === undefined || isCurrent() === true)
      );
    } catch {
      return false;
    }
  };
  const prepared = useQuery({
    queryKey: ['command-prepare', identity.epoch, group ? { ...owner, keys: preparedKeys, labels: undefined } : owner],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    enabled: current() && !operation && !closed.current,
    /* Reading the signal lets a read nobody waits for any more be cancelled back to what it was, rather than settle as
       an error the next form of this record would be handed. */
    queryFn: async ({ signal }): Promise<PreparedRecord | Map<string, PreparedTarget>> => {
      if (!current() || signal.aborted) throw new Error(say('common.thisCommandFormIsNoLonger'));
      const seen = commandOperations.appliedOn(owner.connection, owner.target, preparedKeys ?? [owner.key]);
      // The draft's logic travels beside prepare, so the form is drawn whole once prepare answers (CommandFields.tsx).
      const logic = asksDraftLogic(action.command.input) ? draftLogic.ready() : undefined;
      if (group) {
        const keys = (preparedKeys ?? []).map((key) =>
          Object.fromEntries(
            Object.entries(key).filter(
              (entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number',
            ),
          ),
        );
        const result = await prepareBulkCommand(owner.connection, action, keys);
        if (!current()) throw new Error(say('theSessionChanged'));
        const statuses = new Map(result.map((target) => [commandKeyText(target.key), target]));
        groupSeen.set(statuses, seen);
        return statuses;
      }
      const result = await api('/api/commands/prepare', {
        ...ownedBy(owner.connection),
        command: owner.command,
        commandVersion: owner.commandVersion,
        key: owner.key,
      });
      await logic;
      if (!current()) throw new Error(say('theSessionChanged'));
      if (!Number.isSafeInteger(result.expectedVersion) || result.expectedVersion < 0)
        throw new Error(say('common.theRecordVersionIsUnavailable'));
      const initial =
        result.initial && typeof result.initial === 'object' && !Array.isArray(result.initial)
          ? (result.initial as Record<string, unknown>)
          : undefined;
      const choices = result.choices && typeof result.choices === 'object' ? (result.choices as Record<string, string | null>) : undefined;
      const withheld = Array.isArray(result.withheld) ? (result.withheld as unknown[]).filter((name) => typeof name === 'string') : [];
      const when =
        result.when && typeof result.when === 'object' && !Array.isArray(result.when)
          ? Object.fromEntries(Object.entries(result.when as Record<string, unknown>).filter(([, text]) => typeof text === 'string'))
          : undefined;
      const questions = result.defined && typeof result.defined === 'object' ? (result.defined as CommandQuestions) : undefined;
      return {
        expectedVersion: result.expectedVersion as number,
        ...(initial ? { initial } : {}),
        ...(choices ? { choices } : {}),
        ...(withheld.length ? { withheld } : {}),
        ...(when && Object.keys(when).length ? { when: when as Record<string, string> } : {}),
        ...(questions ? { questions } : {}),
        seen,
      };
    },
  });
  const record = prepared.data instanceof Map ? undefined : prepared.data;
  /* The inputs this record is asked: one asked only where its `when` holds waits for prepare to say,
     is left out where it does not, and is an ordinary field — required unless optional — where it does. */
  const fields = useMemo(() => asked(action.command.input, record), [action.command.input, record]);
  /* Another command applied to this record after this form prepared it: the
     revision it holds is one it knows is old, and submitting it could only
     be refused as stale. The form prepares again and holds its submit until
     that answer is in, rather than wait for whoever applied it to refresh
     the page's queries (which a busy server answers late, if at all). */
  const seen = prepared.data instanceof Map ? groupSeen.get(prepared.data) : record?.seen;
  const outdated =
    !operation && seen !== undefined && commandOperations.appliedOn(owner.connection, owner.target, preparedKeys ?? [owner.key]) > seen;
  const refetchPrepared = prepared.refetch;
  useEffect(() => {
    if (outdated && !prepared.isFetching && !prepared.isError) void refetchPrepared();
  }, [outdated, prepared.isFetching, prepared.isError, refetchPrepared]);
  /* The command's starting values, read with the revision this form will
     submit: laid over the blank form once per prepare, unless the person has
     already typed. "Refresh and review" prepares again and fills again, so
     what is reviewed is the record as it is now. */
  /* Filled while rendering, not in an effect after it: an effect let one
     frame commit with the revision ready and the fields still blank, and a
     quick submit sent the blank form ("Amount is required"). React renders
     again at once, before anything is drawn. */
  const [filledFrom, setFilledFrom] = useState<PreparedRecord | undefined>(undefined);
  if (record?.initial && !operation && filledFrom !== record) {
    setFilledFrom(record);
    // What a component handed over stands over the command's own starting values.
    const filled = prefilledCommandValues(action.command.input, { ...record.initial, ...initial });
    for (const name of touched.current) if (Object.hasOwn(values, name)) filled[name] = values[name];
    setValues(filled);
  }
  if (currentIdentity !== identity || !current()) return null;
  const pending = operation?.phase === 'pending';
  const unknown = operation?.phase === 'unknown';
  const success = operation?.phase === 'success';
  /* An action that keeps no receipt has nothing to check a lost answer by:
     the record is what says whether it ran, so the form lets go of it. */
  const untracked = action.untracked === true;
  const locked = pending || (unknown && !untracked);
  const listed: CommandTarget[] = targets ?? (owner.keys ?? []).map((key) => ({ key, label: commandKeyText(key) }));
  const statuses = prepared.data instanceof Map ? prepared.data : undefined;
  const ineligible = statuses ? listed.filter((target) => !statuses.get(commandKeyText(target.key))?.eligible) : [];
  const versions = (owner.keys ?? []).map((key) => statuses?.get(commandKeyText(key))?.expectedVersion ?? null);
  const ready =
    !outdated &&
    (group
      ? Boolean(statuses) && listed.length > 0 && !ineligible.length && versions.every((version) => version !== null)
      : typeof record?.expectedVersion === 'number');
  const send = (submitted: NonNullable<typeof operation>, endpoint: 'execute' | 'status') => {
    void commandOperations.send(
      submitted,
      endpoint,
      (path, envelope) => {
        if (path !== '/api/commands/execute' && path !== '/api/commands/status') throw new Error(say('common.invalidCommandPath'));
        if (!current()) throw Object.assign(new Error(say('common.thisCommandFormIsNoLonger')), { outcome: 'not_applied' });
        return api(path, { ...envelope, ...ownedBy(owner.connection) });
      },
      () => {
        if (current()) (onApplied ?? (() => void client.invalidateQueries()))();
      },
    );
  };
  const close = () => {
    // Read the real operation again: an old Cancel closure may predate dispatch.
    const live = commandOperations.get(owner);
    if (!current() || live !== operation || live?.phase === 'pending' || (live?.phase === 'unknown' && !untracked)) return;
    closed.current = true;
    commandOperations.forget(owner);
    onClose(live);
    if (success && current()) onDone();
  };
  const review = () => {
    const live = commandOperations.get(owner);
    if (!current() || live !== operation || live?.phase === 'pending' || (live?.phase === 'unknown' && !untracked)) return;
    commandOperations.forget(owner);
    setProblem('');
    touched.current = new Set();
    void prepared.refetch();
    void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'command-prepare' });
  };
  const refused = operation?.refusedKey && listed.find((target) => commandKeyText(target.key) === commandKeyText(operation.refusedKey));
  const count = say('common.records2', { count: listed.length });
  /* The verb follows the selection as it narrows: a group of two says so. A label the App's messages count
     (useBulkSelection.tsx ActionLabel) is not counted as English counts; the form's count line says how many. */
  const verb = group && noun && !(action as { counted?: unknown }).counted ? countedLabel(action.label, listed.length, noun) : action.label;
  const noticed = Boolean(changedElsewhere && !operation && !problem);
  const feedback =
    problem ||
    (unknown && untracked ? say('checkTheRecord') : '') ||
    (operation?.message && `${operation.message}${refused ? ` (${refused.label})` : ''}`) ||
    (prepared.isError
      ? say(group ? 'recordsCouldNotBePrepared' : 'recordCouldNotBePrepared')
      : prepared.isPending || outdated
        ? say(group ? 'readingTheCurrentVersions' : 'readingTheCurrentVersion')
        : group && ineligible.length
          ? say('deselectTheIneligibleRecords')
          : group
            ? say('readyToSubmit', { count })
            : say('readyToSubmitOne'));
  return (
    <Modal className="confirm command-form" ariaLabel={verb} onClose={close} closeDisabled={locked} finalFocus={finalFocus}>
      <h2>{verb}</h2>
      <p className="insert-lede">{label}</p>
      {group && ineligible.length > 0 && !operation && (
        <div className="command-ineligible" role="alert">
          <p>{ineligible.length === 1 ? say('oneIneligible') : say('manyIneligible', { count: ineligible.length })}</p>
          <ul>
            {ineligible.map((target) => (
              <li key={commandKeyText(target.key)}>{target.label}</li>
            ))}
          </ul>
          {onDeselect && (
            <Button
              intent="secondary"
              onClick={() => {
                if (current()) onDeselect(ineligible.map((target) => target.key));
              }}
            >
              {say('deselectIneligible')}
            </Button>
          )}
        </div>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!current() || operation || !ready || prepared.isFetching) return;
          try {
            const input = commandInput(fields, values, record?.questions);
            setProblem('');
            setBeside(undefined);
            send(
              commandOperations.start(owner, group ? (versions as number[]) : record!.expectedVersion, input, action, headless),
              'execute',
            );
          } catch (error) {
            setProblem((error as Error).message);
          }
        }}
      >
        <fieldset className="command-fields" disabled={Boolean(operation)}>
          <CommandFields
            fields={fields}
            values={values}
            idPrefix={id}
            disabled={Boolean(operation)}
            inputs={action.inputs}
            connection={owner.connection}
            {...(!owner.keys && Object.keys(owner.key).length ? { record: { table: owner.target, key: owner.key } } : {})}
            identityEpoch={identity.epoch}
            isCurrent={current}
            {...(beside ? { problems: beside } : {})}
            bound={record ? (record.choices ?? {}) : waitingPickers(action.command.input)}
            {...(record?.questions ? { questions: record.questions } : {})}
            onChange={(next, path) => {
              for (const field of action.command.input)
                if (JSON.stringify(next[field.name]) !== JSON.stringify(values[field.name])) touched.current.add(field.name);
              if (beside && path !== undefined && Object.hasOwn(beside, path)) setBeside(undefined);
              setValues(next);
            }}
          />
        </fieldset>
        <p
          className="command-feedback"
          data-phase={problem ? 'error' : (operation?.phase ?? (prepared.isError ? 'error' : 'ready'))}
          /* Drawn while it holds a change from elsewhere: a ready line is otherwise said to a screen reader only, and
             Keep editing has to be seen and pressed. */
          {...(noticed ? { 'data-live': '' } : {})}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {noticed ? <LiveEditNotice table={liveTable(owner.target)} recordKey={owner.key} place="inline" /> : feedback}
        </p>
        <div className="confirm-actions">
          <Button intent="secondary" disabled={locked} onClick={close}>
            {success ? say('common.done') : say('common.cancel')}
          </Button>
          {unknown && !untracked ? (
            <>
              <Button
                intent="secondary"
                onClick={() => {
                  if (current()) send(operation!, 'status');
                }}
              >
                {say('checkResult')}
              </Button>
              <Button
                intent="primary"
                onClick={() => {
                  if (current()) send(operation!, 'execute');
                }}
              >
                {say('retrySameSubmission')}
              </Button>
            </>
          ) : operation?.phase === 'error' || unknown || prepared.isError ? (
            <Button intent="primary" onClick={review}>
              {say('refreshAndReview')}
            </Button>
          ) : (
            !success && (
              <Button intent="primary" type="submit" disabled={pending || !ready || prepared.isFetching}>
                {pending ? say('common.submitting') : verb}
              </Button>
            )
          )}
        </div>
      </form>
    </Modal>
  );
}
