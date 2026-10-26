import { sessionIdentity, subscribeSessionIdentity } from './sessionIdentity.js';
import { historyToken, type HistoryToken } from './historyToken.js';
import { shell } from './shellMode.js';
import { safeFieldErrors, type FieldError } from './fieldErrors.js';
import { say } from './copy/shell/updateAttempts.js';
import { addHostListener } from './shellHost.js';

export interface UpdateOwner {
  connection: string | null;
  table: string;
  key: Record<string, unknown>;
}
type Values = Record<string, string | number | boolean | null>;
interface UpdateAttempt {
  phase: 'pending' | 'uncertain';
  values: Values;
  message: string;
  detail?: string;
}
/** A refusal may name the fields it is about — shape-checked, never trusted. */
type UpdateOutcome =
  | { kind: 'applied'; applied: Values; undoId?: HistoryToken }
  | { kind: 'rejected'; message: string; fields?: FieldError[] }
  | { kind: 'uncertain' | 'blocked'; message: string };

const UNCONFIRMED = say('updateNotConfirmedTheRecord');
export const updateOwnerKey = (owner: UpdateOwner): string =>
  JSON.stringify([
    owner.connection,
    owner.table,
    Object.keys(owner.key)
      .sort()
      .map((key) => [key, String(owner.key[key])]),
  ]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function acknowledgement(result: unknown, requested: Values): Values | undefined {
  if (!object(result) || result.affected !== 1 || !object(result.applied)) return;
  if (result.outcome !== undefined && result.outcome !== 'applied') return;
  const applied = result.applied;
  /* Every column asked for, written. The server may write more of its own in the same row — a state's stamp as
     the record enters it (`approved_at` beside `approved`), a machine's `since` — and says so in `applied`; those
     are the write's, not a different one's. */
  if (!Object.keys(requested).every((column) => Object.hasOwn(applied, column))) return;
  if (
    !Object.values(applied).every(
      (value) =>
        value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)),
    )
  )
    return;
  return applied as Values;
}

/** Tab-local attempt ownership outlives a record component, never the browser session. */
export function createUpdateAttempts(tenant = () => false) {
  const attempts = new Map<string, UpdateAttempt>();
  const listeners = new Set<() => void>();
  let version = 0;
  let generation = 0;
  const tell = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const get = (owner: UpdateOwner) => attempts.get(updateOwnerKey(owner));
  const run = async (owner: UpdateOwner, values: Values, send: () => Promise<unknown>): Promise<UpdateOutcome> => {
    const started = generation;
    const tenantAttempt = tenant();
    const key = updateOwnerKey(owner);
    if (attempts.has(key)) return { kind: 'blocked', message: get(owner)!.message || say('anUpdateIsAlready') };
    const proposed = { ...values };
    const tracked = tenantAttempt ? shell().mutations.start('update') : undefined;
    attempts.set(key, { phase: 'pending', values: proposed, message: '' });
    tell();
    const uncertain = (detail: string): UpdateOutcome => {
      shell().mutations.unknown(tracked);
      const message = UNCONFIRMED;
      if (started === generation) {
        attempts.set(key, { phase: 'uncertain', values: proposed, message, detail });
        tell();
      }
      return { kind: 'uncertain', message };
    };
    const rejected = (message: string, fields: FieldError[] = []): UpdateOutcome => {
      shell().mutations.settle(tracked);
      if (started === generation) {
        attempts.delete(key);
        tell();
      }
      return { kind: 'rejected', message, ...(fields.length ? { fields } : {}) };
    };
    const timer = setTimeout(() => uncertain(say('theRequestMayStill')), 30_000);
    let result: unknown;
    try {
      result = await send();
    } catch (error) {
      const status = object(error) ? error.status : undefined;
      const outcome = object(error) ? error.outcome : undefined;
      const message = error instanceof Error ? error.message : String(error);
      return outcome !== 'unknown' &&
        (outcome === 'rejected' ||
          outcome === 'not_applied' ||
          (!tenantAttempt && typeof status === 'number' && [400, 401, 403, 404, 409, 422, 501].includes(status)))
        ? rejected(message)
        : uncertain(message);
    } finally {
      clearTimeout(timer);
    }
    if (object(result) && Array.isArray(result.errors)) {
      const message = object(result.errors[0]) && typeof result.errors[0].message === 'string' ? result.errors[0].message : '';
      return message && result.outcome === 'rejected'
        ? rejected(message, safeFieldErrors(result.errors.filter(object) as unknown as Parameters<typeof safeFieldErrors>[0]))
        : uncertain(message);
    }
    const applied = acknowledgement(result, proposed);
    if (!applied) return uncertain(say('theServerDidNotAcknowledge'));
    shell().mutations.settle(tracked);
    if (started === generation) {
      attempts.delete(key);
      tell();
    }
    const undoId = object(result) ? historyToken(result.undoId, tenantAttempt) : undefined;
    return { kind: 'applied', applied, ...(undoId === undefined ? {} : { undoId }) };
  };
  return {
    get,
    run,
    reset: () => {
      generation++;
      attempts.clear();
      tell();
    },
    hasUnresolved: () => attempts.size > 0,
    version: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const updateAttempts = createUpdateAttempts(() => sessionIdentity().tenantRequired === true);
subscribeSessionIdentity(() => updateAttempts.reset());
addHostListener(window, 'beforeunload', (event) => {
  if (!updateAttempts.hasUnresolved()) return;
  event.preventDefault();
  event.returnValue = '';
});
