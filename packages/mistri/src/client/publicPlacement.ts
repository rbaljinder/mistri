/** Loaded only after a named public GET carries placement. Answers never leave
 * memory; recovery metadata cannot choose the destination of a request. */
import type { PublicFormPlacement } from '../shared/publicPlacement.js';
import type { CommandInputValue } from './commandState.js';
import type { loadPublicForm } from './publicForm.js';
import type { CommandValues, FormReceipt } from './components/FormSurface.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { say } from './copy/forms/publicPlacement.js';
import { say as sayForm } from './copy/forms/components/FormSurface.js';

export type PreparedPublicForm = NonNullable<Awaited<ReturnType<typeof loadPublicForm>>>;
type Phase = 'ready' | 'pending' | 'unknown' | 'applied';
interface State {
  phase: Phase;
  receipt?: FormReceipt;
  message?: string;
}
interface RecoveryRecord {
  form: string;
  placement: PublicFormPlacement;
}
const MAX_RECORDS = 8;
const operations = new WeakMap<PreparedPublicForm, PublicPlacementOperation>();
const retained = new Map<string, PublicPlacementOperation>();
const owner = (app: string, form: string) => JSON.stringify([window.location.origin, served('/'), app, form]);
const storageKey = (app: string) => `mistri:public-placement:${encodeURIComponent(app)}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function placementShape(value: unknown): value is PublicFormPlacement {
  if (!object(value) || !exact(value, ['version', 'binding', 'submission', 'expiresAt', 'recoverUntil', 'recoveryUrl'])) return false;
  const date = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  return (
    value.version === 1 &&
    typeof value.binding === 'string' &&
    value.binding.length > 0 &&
    value.binding.length <= 4096 &&
    /^[A-Za-z0-9_.-]+$/.test(value.binding) &&
    typeof value.submission === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(value.submission) &&
    date(value.expiresAt) &&
    date(value.recoverUntil) &&
    Date.parse(value.expiresAt) <= Date.parse(value.recoverUntil) &&
    typeof value.recoveryUrl === 'string' &&
    value.recoveryUrl.length <= 2048
  );
}

/** Only a fresh server response establishes canonical origin. Its exact path
 * must also match this page's independently served mount and named form. */
function trustedRecoveryUrl(placement: PublicFormPlacement, form: string): string {
  try {
    const url = new URL(placement.recoveryUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== served(`/api/forms/${encodeURIComponent(form)}/receipt`) ||
      url.href !== placement.recoveryUrl
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error(say('placementUnavailable'));
  }
}

function writeRecords(app: string, records: RecoveryRecord[]): void {
  try {
    if (records.length) sessionStorage.setItem(storageKey(app), JSON.stringify(records.slice(-MAX_RECORDS)));
    else sessionStorage.removeItem(storageKey(app));
  } catch {
    /* Memory still owns this attempt when storage is unavailable. */
  }
}

function readRecords(app: string): RecoveryRecord[] {
  let records: RecoveryRecord[] = [];
  try {
    const raw = sessionStorage.getItem(storageKey(app));
    const value: unknown = raw && raw.length <= 65_536 ? JSON.parse(raw) : [];
    if (Array.isArray(value) && value.length <= MAX_RECORDS) {
      records = value.filter(
        (record): record is RecoveryRecord =>
          object(record) &&
          exact(record, ['form', 'placement']) &&
          typeof record.form === 'string' &&
          record.form.length > 0 &&
          record.form.length <= 200 &&
          placementShape(record.placement) &&
          Date.parse(record.placement.recoverUntil) > Date.now(),
      );
    }
  } catch {
    /* Malformed or disabled storage supplies no authority. */
  }
  writeRecords(app, records);
  return records;
}

function receipt(value: unknown): FormReceipt | undefined {
  if (
    !object(value) ||
    !object(value.receipt) ||
    value.receipt.status !== 'applied' ||
    typeof value.receipt.id !== 'string' ||
    !value.receipt.id ||
    value.receipt.id.length > 256 ||
    (value.reference !== undefined && (typeof value.reference !== 'string' || value.reference.length > 64))
  )
    return;
  return {
    ...(typeof value.reference === 'string' ? { reference: value.reference } : {}),
    receipt: { id: value.receipt.id, status: 'applied' },
  };
}

export class PublicPlacementOperation {
  private state: State;
  private listeners = new Set<() => void>();
  private input?: CommandInputValue;
  private uncertain: boolean;
  private readonly key: string;
  private readonly executeUrl: string;
  readonly placement: PublicFormPlacement;
  values?: CommandValues;

  constructor(
    readonly prepared: PreparedPublicForm,
    restored?: PublicFormPlacement,
  ) {
    if (!placementShape(prepared.placement) || prepared.form.save) throw new Error(say('placementUnavailable'));
    const expected = trustedRecoveryUrl(prepared.placement, prepared.form.id);
    // A stored URL is compared to fresh trusted configuration, never to its own origin.
    if (restored && (!placementShape(restored) || restored.recoveryUrl !== expected)) throw new Error(say('placementRecoveryUnavailable'));
    this.placement = Object.freeze({ ...(restored ?? prepared.placement), recoveryUrl: expected });
    this.prepared = { ...prepared, placement: this.placement };
    this.key = owner(prepared.app.id, prepared.form.id);
    this.executeUrl = new URL(served(`/api/forms/${encodeURIComponent(prepared.form.id)}`), window.location.origin).href;
    this.uncertain = !!restored;
    this.state = restored ? { phase: 'unknown', message: say('placementRestored') } : { phase: 'ready' };
    if (restored) retained.set(this.key, this);
  }

  snapshot = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: State): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private remember(): void {
    retained.set(this.key, this);
    const records = readRecords(this.prepared.app.id).filter((record) => record.form !== this.prepared.form.id);
    records.push({ form: this.prepared.form.id, placement: this.placement });
    writeRecords(this.prepared.app.id, records);
  }
  private resolve(): void {
    if (retained.get(this.key) === this) retained.delete(this.key);
    writeRecords(
      this.prepared.app.id,
      readRecords(this.prepared.app.id).filter((record) => record.placement.submission !== this.placement.submission),
    );
  }
  private applied(found: FormReceipt): FormReceipt {
    this.resolve();
    this.input = undefined;
    this.values = undefined;
    this.update({ phase: 'applied', receipt: found });
    return found;
  }
  capture = (values: CommandValues): void => {
    if (this.state.phase === 'ready') this.values = structuredClone(values);
  };
  canRetry = (): boolean => !!this.input && Date.now() < Date.parse(this.placement.expiresAt);
  canRecover = (): boolean => Date.now() < Date.parse(this.placement.recoverUntil);

  send = async (_submission: string, input: CommandInputValue): Promise<FormReceipt> => {
    if (this.state.phase !== 'ready') throw new Error(say('placementUnknown'));
    if (retained.has(this.key) && retained.get(this.key) !== this) throw new Error(say('placementAlreadyPending'));
    if (Date.now() >= Date.parse(this.placement.expiresAt)) throw new Error(say('placementNewForm'));
    this.input = structuredClone(input);
    return this.execute();
  };
  retry = async (): Promise<void> => {
    if (this.state.phase !== 'unknown' || !this.canRetry()) return;
    try {
      await this.execute();
    } catch {
      /* The operation's state says why. */
    }
  };
  private async execute(): Promise<FormReceipt> {
    this.remember();
    this.update({ ...this.state, phase: 'pending' });
    try {
      const res = await fetch(this.executeUrl, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: this.input,
          submission: this.placement.submission,
          placement: { version: 1, binding: this.placement.binding },
        }),
      });
      const data: unknown = await res.json();
      const found = res.ok ? receipt(data) : undefined;
      if (found) return this.applied(found);
      // A later refusal cannot settle an earlier unanswered execution. Only a
      // first, explicit not-applied answer may reopen editing under this key.
      if (!this.uncertain && !res.ok && object(data) && data.outcome === 'not_applied') {
        this.resolve();
        this.input = undefined;
        this.update({ phase: 'ready' });
        const placementRefusal = typeof data.code === 'string' && data.code.startsWith('placement_');
        throw Object.assign(
          new Error(placementRefusal ? say('placementNewForm') : String(data.message || data.error || sayForm('refusedUnavailable'))),
          {
            status: res.status,
            code: data.code,
            field: data.field,
            retryAfter: Number(res.headers.get('retry-after') ?? data.retryAfter),
            definitive: true,
          },
        );
      }
      throw new Error();
    } catch (error) {
      if (object(error) && error.definitive === true) throw error;
      this.uncertain = true;
      this.update({ phase: 'unknown', message: say('placementUnknown') });
      throw new Error(say('placementUnknown'));
    }
  }

  check = async (): Promise<void> => {
    if (this.state.phase !== 'unknown') return;
    if (!this.canRecover()) {
      this.update({ phase: 'unknown', message: say('placementRecoveryExpired') });
      return;
    }
    this.update({ ...this.state, phase: 'pending' });
    try {
      const res = await fetch(this.placement.recoveryUrl, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submission: this.placement.submission, placement: { version: 1, binding: this.placement.binding } }),
      });
      const data: unknown = await res.json();
      const found = res.ok ? receipt(data) : undefined;
      if (found) {
        this.applied(found);
        return;
      }
      this.update({
        phase: 'unknown',
        message: res.ok && object(data) && data.status === 'not_found' ? say('placementNotFound') : say('placementRecoveryUnavailable'),
      });
    } catch {
      this.update({ phase: 'unknown', message: say('placementRecoveryUnavailable') });
    }
  };
}

/** Memory-held attempts are returned before another GET can rotate their binding. */
export function retainedPublicForm(form: string, app?: string): PreparedPublicForm | undefined {
  return app ? retained.get(owner(app, form))?.prepared : undefined;
}

export function preparePublicPlacement(prepared: PreparedPublicForm): PreparedPublicForm {
  const existing = retainedPublicForm(prepared.form.id, prepared.app.id);
  if (existing) return existing;
  if (!operations.has(prepared)) {
    const record = readRecords(prepared.app.id).find((record) => record.form === prepared.form.id);
    const operation = new PublicPlacementOperation(prepared, record?.placement);
    operations.set(prepared, operation);
    operations.set(operation.prepared, operation);
  }
  return operations.get(prepared)!.prepared;
}

/** Both public entry points draw the same retained operation, without owning it. */
export function publicPlacementOperation(prepared: PreparedPublicForm): PublicPlacementOperation {
  return operations.get(preparePublicPlacement(prepared))!;
}
