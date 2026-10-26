import {
  captureSessionIdentity,
  sessionIdentity,
  subscribeSessionIdentity,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import type { AppCommandAction } from '../shared/app.js';
import { BULK_LIMIT, commandKeyText } from '../shared/command.js';
import { tenantMutationState, type TenantMutationAttempt } from './tenantMutationState.js';
import { say } from './copy/forms/commandState.js';

/** One input's value as a form holds it; several choices are a list of option values. */
export type CommandValue = string | number | boolean | readonly (string | number)[];
/** An input as the server takes it: values, objects for groups, lists of rows for repeating groups. */
export type CommandInputValue = Readonly<Record<string, unknown>>;
/** One target (`key`, `expectedVersion`) or, for a `targets: 'many'` command, an ordered list. */
interface CommandEnvelope {
  command: string;
  commandVersion: number;
  key?: Record<string, string | number>;
  expectedVersion?: number;
  keys?: ReadonlyArray<Record<string, string | number>>;
  expectedVersions?: readonly number[];
  idempotencyKey: string;
  input: CommandInputValue;
}
export interface CommandOwner {
  connection: string;
  target: string;
  command: string;
  commandVersion: number;
  key: Record<string, unknown>;
  /** A group: every selected record, in order. `key` is then empty. */
  keys?: Array<Record<string, unknown>>;
  /** What each of `keys` is called, so a resumed group still names its records. Not identity. */
  labels?: string[];
}
export interface CommandOperation {
  readonly identity: SessionIdentitySnapshot;
  readonly owner: CommandOwner;
  readonly envelope: CommandEnvelope;
  readonly action?: AppCommandAction;
  phase: 'pending' | 'success' | 'error' | 'unknown';
  message: string;
  /** The command's own words for what it did, when its output said any: a command run on one click has no form to
      say them in, so its notice does (components/Actions.tsx). */
  said?: string;
  /** What the command's handler returned (the receipt's `result`), handed to a component that ran it (`useCommand`). */
  output?: unknown;
  code?: string;
  /** The one record of a group the refusal named, when it named one. */
  refusedKey?: Record<string, unknown>;
  /** The input the refusal is about, by its path, when it named one: the form says it beside that field. */
  field?: string;
  /** Once delivery is uncertain, a later missing receipt/refusal cannot prove rollback. */
  uncertain: boolean;
  /** Sent by a component's `run`, or from the form its `open` holds: its caller resolves it, so a record's action bar
      must not draw its form while it is in flight (a composer's reply would show twice). */
  headless?: boolean;
}

// A new manifest version must not open a second operation over an unresolved submission.
const keyPairs = (key: Record<string, unknown>) =>
  Object.keys(key)
    .sort()
    .map((column) => [column, String(key[column])]);
const ownerKey = (owner: CommandOwner) =>
  JSON.stringify([owner.connection, owner.target, owner.command, owner.keys ? owner.keys.map(keyPairs) : keyPairs(owner.key)]);
const operations = new Map<string, CommandOperation>();
/* When a command last applied to each record, as a count of applied commands:
   an open form prepared before that number moved holds a revision it knows
   is old (CommandForm prepares again before it lets a submit through). */
const recordKey = (connection: string, target: string, key: Record<string, unknown>) => JSON.stringify([connection, target, keyPairs(key)]);
const appliedTo = new Map<string, number>();
let applied = 0;
const tracked = new WeakMap<CommandOperation, TenantMutationAttempt>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
subscribeSessionIdentity(() => {
  operations.clear();
  appliedTo.clear();
  changed();
});

export const commandOperations = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  version: () => revision,
  /** The count of applied commands at the last one that applied to any of these records (0: none has). */
  appliedOn(connection: string, target: string, keys: ReadonlyArray<Record<string, unknown>>): number {
    return Math.max(0, ...keys.map((key) => appliedTo.get(recordKey(connection, target, key)) ?? 0));
  },
  get(owner: CommandOwner): CommandOperation | undefined {
    return operations.get(ownerKey(owner));
  },
  /** Group submissions on this list that are still pending or unconfirmed: a queue reopens their form. */
  unresolvedGroups(connection: string, target: string): CommandOperation[] {
    return [...operations.values()].filter(
      (operation) =>
        operation.owner.keys &&
        operation.owner.connection === connection &&
        operation.owner.target === target &&
        (operation.phase === 'pending' || operation.phase === 'unknown'),
    );
  },
  forget(owner: CommandOwner) {
    const operation = operations.get(ownerKey(owner));
    if (operation?.phase === 'pending' || operation?.phase === 'unknown') return;
    operations.delete(ownerKey(owner));
    changed();
  },
  /** A group owner takes one prepared revision per key, aligned with `owner.keys`. */
  start(
    owner: CommandOwner,
    expectedVersion: number | readonly number[],
    input: CommandInputValue,
    action?: AppCommandAction,
    headless = false,
  ): CommandOperation {
    const identity = captureSessionIdentity();
    if (identity.mode !== 'authenticated' || identity.appId !== owner.connection) throw new Error(say('signInAgainBefore'));
    const previous = operations.get(ownerKey(owner));
    if (previous) return previous;
    const checked = (raw: Record<string, unknown>) => {
      const key: Record<string, string | number> = {};
      for (const [column, value] of Object.entries(raw)) {
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
          throw new Error(say('thisRecordHasAnUnsupported'));
        key[column] = value;
      }
      if (!Object.keys(key).length) throw new Error(say('refreshThisRecordBefore'));
      return Object.freeze(key);
    };
    const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    let targets: Pick<CommandEnvelope, 'key' | 'expectedVersion' | 'keys' | 'expectedVersions'>;
    if (owner.keys) {
      const versions = Array.isArray(expectedVersion) ? [...(expectedVersion as readonly number[])] : [];
      const keys = owner.keys.map(checked);
      if (
        !keys.length ||
        keys.length > BULK_LIMIT ||
        versions.length !== keys.length ||
        !versions.every(revision) ||
        new Set(keys.map(commandKeyText)).size !== keys.length
      )
        throw new Error(say('refreshTheseRecordsBefore'));
      targets = { keys: Object.freeze(keys), expectedVersions: Object.freeze(versions) };
    } else {
      const key = checked(owner.key);
      if (!revision(expectedVersion)) throw new Error(say('refreshThisRecordBefore'));
      targets = { key, expectedVersion };
    }
    const envelope: CommandEnvelope = Object.freeze({
      command: owner.command,
      commandVersion: owner.commandVersion,
      ...targets,
      idempotencyKey: crypto.randomUUID(),
      input: frozenCopy(input) as CommandInputValue,
    });
    const presentation: AppCommandAction | undefined = action && JSON.parse(JSON.stringify(action));
    if (presentation) {
      presentation.command.input.forEach(Object.freeze);
      Object.freeze(presentation.command.input);
      Object.freeze(presentation.command);
      Object.freeze(presentation);
    }
    const operation: CommandOperation = {
      identity,
      envelope,
      action: presentation,
      owner: Object.freeze(
        envelope.keys
          ? { ...owner, key: {}, keys: [...envelope.keys], labels: owner.labels && [...owner.labels] }
          : { ...owner, key: envelope.key! },
      ),
      phase: 'pending',
      message: say('common.submitting'),
      uncertain: false,
      ...(headless ? { headless } : {}),
    };
    operations.set(ownerKey(owner), operation);
    changed();
    return operation;
  },
  async send(
    operation: CommandOperation,
    endpoint: 'execute' | 'status',
    request: (path: string, envelope: CommandEnvelope) => Promise<unknown>,
    onApplied: () => void,
  ): Promise<void> {
    const current = () => sessionIdentity() === operation.identity && operations.get(ownerKey(operation.owner)) === operation;
    if (!current() || operation.phase === 'success' || operation.phase === 'error') return;
    // The caller dispatches the initial pending operation once; retries only follow a settled unknown.
    if (inFlight.has(operation)) return;
    if (!tracked.has(operation)) {
      const attempt = tenantMutationState.start('command', operation.identity);
      if (attempt) tracked.set(operation, attempt);
    }
    inFlight.add(operation);
    operation.phase = 'pending';
    operation.message = endpoint === 'status' ? say('checkingResult') : say('common.submitting');
    changed();
    try {
      const value = await request(`/api/commands/${endpoint}`, operation.envelope);
      if (!current()) return;
      const data = value as Record<string, unknown> | null;
      // A group's receipt must name every key, in the order sent; one key is matched as before.
      const envelope = operation.envelope;
      const named = envelope.keys
        ? Array.isArray(data?.keys) &&
          data.keys.length === envelope.keys.length &&
          envelope.keys.every((key, index) => sameKey((data.keys as unknown[])[index], key))
        : sameKey(data?.key, envelope.key!);
      if (
        (data?.outcome === undefined || data.outcome === 'applied') &&
        data?.status === 'applied' &&
        data.command === operation.envelope.command &&
        data.commandVersion === operation.envelope.commandVersion &&
        data.resource === operation.owner.target &&
        typeof data.receiptId === 'string' &&
        named
      ) {
        tenantMutationState.settle(tracked.get(operation));
        /* The command's own words for what it did — its output's `message`,
           "Payment scheduled. It shows as pending until it posts" — else a plain one. */
        const said = (data.result as { message?: unknown } | null | undefined)?.message;
        operation.phase = 'success';
        if (data.result !== undefined) operation.output = data.result;
        if (typeof said === 'string' && said.trim()) operation.said = said.trim();
        operation.message = operation.said ?? say('completed');
        applied++;
        for (const key of envelope.keys ?? [envelope.key!])
          appliedTo.set(recordKey(operation.owner.connection, operation.owner.target, key), applied);
        changed();
        try {
          onApplied();
        } catch {
          operation.message = say('completedCloseAndRefresh');
          changed();
        }
        return;
      }
      settleFailure(operation, data, endpoint);
    } catch (error) {
      if (!current()) return;
      settleFailure(operation, error, endpoint);
    } finally {
      inFlight.delete(operation);
    }
  },
};

/** A detached, deeply frozen copy: a retry re-sends exactly what was sent, groups and rows included. */
function frozenCopy(value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  const freeze = (node: unknown): unknown => {
    if (node && typeof node === 'object') {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(copy);
}

const inFlight = new WeakSet<CommandOperation>();
function sameKey(value: unknown, expected: CommandEnvelope['key']): boolean {
  if (!expected || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    Object.keys(key).length === Object.keys(expected).length &&
    Object.entries(expected).every(([column, id]) => String(key[column]) === String(id))
  );
}
function settleFailure(operation: CommandOperation, value: unknown, endpoint: 'execute' | 'status') {
  const failure = value as { code?: unknown; message?: unknown; outcome?: unknown; key?: unknown; field?: unknown } | null;
  const refused =
    failure?.key &&
    typeof failure.key === 'object' &&
    !Array.isArray(failure.key) &&
    operation.envelope.keys?.find((key) => commandKeyText(key) === commandKeyText(failure.key));
  operation.refusedKey = refused ? { ...refused } : undefined;
  // Local transport refusals carry a definite outcome and message, but need
  // not invent a server diagnostic code for a request that was never sent.
  const rejected =
    endpoint === 'execute' && !operation.uncertain && failure?.outcome === 'not_applied' && typeof failure.message === 'string';
  operation.phase = rejected ? 'error' : 'unknown';
  if (rejected) tenantMutationState.settle(tracked.get(operation));
  else tenantMutationState.unknown(tracked.get(operation));
  operation.code = typeof failure?.code === 'string' ? failure.code : undefined;
  operation.field = rejected && typeof failure?.field === 'string' ? failure.field : undefined;
  operation.uncertain ||= !rejected;
  operation.message = rejected ? (failure!.message as string) : say('theResultIsNotYet');
  changed();
}
