import { useEffect, useRef, useState } from 'react';
import { shell } from '../shellMode.js';
import { safeFieldErrors, type FieldError } from '../fieldErrors.js';
import { say } from '../copy/forms/components/useRecordInsert.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

export interface InsertResult {
  key: Record<string, unknown>;
  outcome?: 'applied';
  row?: Record<string, unknown>;
  /** The journal entry this creation made, for the confirmation's Undo. */
  undoId?: unknown;
}

interface InsertFailure {
  errors: Array<{ message: string; field?: string; fields?: readonly { field: string; message: string }[] }>;
  outcome?: 'rejected' | 'unknown';
}

type InsertFieldError = FieldError;

export type InsertResponse = InsertResult | InsertFailure;

/** A refusal before sending a write, such as an obsolete form's connection. */
export class InsertRefusal extends Error {}

type Phase = 'idle' | 'pending' | 'uncertain' | 'succeeded';
const UNCONFIRMED = say('creationWasNotConfirmed');

/** One attempt at a time; an unacknowledged insert is never automatically retried. */
/** What a New form sends beside the row: the tags it carries, as keys of the tag table (tagLists.ts). */
export interface InsertExtra {
  tags?: string[];
  /** The record's lines, by child table: each row's values, inserted with it (FormLines.tsx). */
  lines?: Record<string, Array<{ values: Record<string, string | null> }>>;
}

export function useRecordInsert(
  insert: (values: Record<string, unknown>, extra?: InsertExtra) => Promise<InsertResponse>,
  onAdded: (result: InsertResult) => void,
  onPendingChange?: (pending: boolean) => void,
) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState('');
  const [fieldErrors, setFieldErrors] = useState<InsertFieldError[]>([]);
  const locked = useRef(false);
  const alive = useRef(true);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timeout.current);
    };
  }, []);
  useEffect(() => {
    if (phase !== 'pending' && phase !== 'uncertain') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    addHostListener(window, 'beforeunload', warn);
    return () => removeHostListener(window, 'beforeunload', warn);
  }, [phase]);

  const submit = async (values: Record<string, unknown>, extra?: InsertExtra) => {
    if (locked.current || !alive.current) return;
    locked.current = true;
    setProblem('');
    setFieldErrors([]);
    setPhase('pending');
    onPendingChange?.(true);
    const tracked = shell().mutations.start('insert');
    timeout.current = setTimeout(() => {
      shell().mutations.unknown(tracked);
      if (!alive.current) return;
      setPhase('uncertain');
      setProblem(say('theRequestMayStill', { problem: UNCONFIRMED }));
      onPendingChange?.(false);
    }, 30_000);

    let result: InsertResponse;
    try {
      result = await (extra ? insert(values, extra) : insert(values));
    } catch (error) {
      // These HTTP responses reject the request before the insert is executed.
      const status = (error as { status?: number } | null)?.status;
      const outcome = (error as { outcome?: string } | null)?.outcome;
      const refused =
        outcome !== 'unknown' &&
        (error instanceof InsertRefusal ||
          outcome === 'rejected' ||
          outcome === 'not_applied' ||
          (outcome === undefined && [400, 401, 403, 404, 409, 422, 501].includes(status ?? 0)));
      if (refused) shell().mutations.settle(tracked);
      else shell().mutations.unknown(tracked);
      if (!alive.current) return;
      locked.current = !refused;
      setPhase(refused ? 'idle' : 'uncertain');
      const detail = error instanceof Error ? error.message : String(error);
      setProblem(refused ? detail : `${UNCONFIRMED} ${detail}`);
      return;
    } finally {
      clearTimeout(timeout.current);
      if (alive.current) onPendingChange?.(false);
    }
    if (result && typeof result === 'object' && 'errors' in result) {
      const message =
        Array.isArray(result.errors) && typeof result.errors[0]?.message === 'string'
          ? result.errors[0].message
          : say('theServerReturnedAnInvalid');
      const rejected = Array.isArray(result.errors) && typeof result.errors[0]?.message === 'string' && result.outcome === 'rejected';
      const mapped = rejected ? safeFieldErrors(result.errors) : [];
      if (rejected) shell().mutations.settle(tracked);
      else shell().mutations.unknown(tracked);
      if (!alive.current) return;
      locked.current = !rejected;
      setPhase(rejected ? 'idle' : 'uncertain');
      // Keep the server's safe envelope available to the form. The form may
      // map some fields and must retain this summary for unknown targets.
      setProblem(rejected ? message : `${UNCONFIRMED} ${message}`);
      setFieldErrors(mapped);
      return;
    }
    if (result && typeof result === 'object' && 'outcome' in result && result.outcome !== undefined && result.outcome !== 'applied') {
      shell().mutations.unknown(tracked);
      if (!alive.current) return;
      setPhase('uncertain');
      setProblem(UNCONFIRMED);
      return;
    }
    if (
      !result ||
      typeof result !== 'object' ||
      !('key' in result) ||
      !result.key ||
      typeof result.key !== 'object' ||
      Array.isArray(result.key)
    ) {
      shell().mutations.unknown(tracked);
      if (!alive.current) return;
      setPhase('uncertain');
      setProblem(say('theServerDidNotReturn', { problem: UNCONFIRMED }));
      return;
    }
    shell().mutations.settle(tracked);
    if (!alive.current) return;
    setPhase('succeeded');
    setProblem('');
    try {
      onAdded(result);
    } catch {
      setProblem(say('theRowWasAdded'));
    }
  };
  return {
    submit,
    phase,
    problem,
    fieldErrors,
    clearProblem: () => {
      setProblem('');
      setFieldErrors([]);
    },
    locked: phase !== 'idle',
  };
}
