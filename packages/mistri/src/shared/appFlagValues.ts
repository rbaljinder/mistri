/** Private evaluated presentation response. Never hydrate from SSR, persist in
 * browser storage or include assignment receipts in the public App manifest. */
export const APP_FLAG_VALUES_PATH = '/api/flags/evaluate';
export const EXPERIMENT_EXPOSURES_PATH = '/api/experiments/exposures';
export const EXPERIMENT_VISITOR_PATH = '/api/experiments/visitor';
export const EXPERIMENT_FORM_HEADER = 'x-mistri-experiment-form';
export const EXPERIMENT_ADDRESS_HEADER = 'x-mistri-experiment-address';
export interface ExperimentVisitorSelection {
  readonly form?: string;
  readonly address?: string;
}
export function isAssignmentReceipt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && /^ar1\.[A-Za-z0-9_-]{39,}$/.test(value);
}
type AppFlagJson = null | boolean | string | number | readonly AppFlagJson[] | { readonly [key: string]: AppFlagJson };
export type AppFlagValue = boolean | string | number | { readonly [key: string]: AppFlagJson };
export interface AppFlagValues {
  readonly values: Readonly<Record<string, AppFlagValue>>;
  readonly version: { readonly global: number | null; readonly tenant: number | null };
  readonly diagnostics?: readonly ('provider_error' | 'invalid_snapshot' | 'scope_mismatch' | 'invalid_context' | 'missing_identity')[];
  /** Opaque server-issued proof, only for the corresponding served decision.
   * Its presence grants no client assignment or reporting authority. */
  readonly assignmentReceipts?: Readonly<Record<string, string>>;
}
export interface AppFlagReader<V = Readonly<Record<string, AppFlagValue>>> {
  readonly ready: boolean;
  /** An absent/unready value throws. A flag never grants access. */
  get<K extends Extract<keyof V, string>>(key: K): V[K];
}

/** Small transport validator, independent of the private catalog/evaluator. */
export function captureAppFlagValues(input: unknown): AppFlagValues {
  const fail = (): never => {
    throw new Error('Invalid evaluated flag values.');
  };
  let nodes = 0;
  const copy = (value: unknown, depth: number): AppFlagJson => {
    if (++nodes > 32768 || depth > 12) return fail();
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length <= 4096 ? value : fail();
    if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : fail();
    if (!value || typeof value !== 'object') return fail();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const keys = Reflect.ownKeys(value).filter((key) => !array || key !== 'length');
    if (keys.length > 256 || (array && keys.length !== value.length)) return fail();
    const entries = keys.map((key, i) => {
      if (
        typeof key !== 'string' ||
        key.length > 4096 ||
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        (array && key !== String(i))
      )
        return fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) return fail();
      return [key, copy(descriptor.value, depth + 1)] as const;
    });
    return Object.freeze(array ? entries.map(([, item]) => item) : Object.fromEntries(entries));
  };
  const object = (value: AppFlagJson | undefined): Record<string, AppFlagJson> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, AppFlagJson>;
  };
  const raw = object(copy(input, 0));
  if (Object.keys(raw).some((key) => !['values', 'version', 'diagnostics', 'assignmentReceipts'].includes(key))) return fail();
  const values = object(raw.values),
    version = object(raw.version);
  if (
    Object.keys(version).length !== 2 ||
    !['global', 'tenant'].every(
      (key) =>
        Object.hasOwn(version, key) &&
        (version[key] === null || (typeof version[key] === 'number' && Number.isSafeInteger(version[key]) && version[key] >= 0)),
    )
  )
    return fail();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key) || value === null || Array.isArray(value)) return fail();
  }
  if (Object.hasOwn(raw, 'assignmentReceipts')) {
    for (const [key, receipt] of Object.entries(object(raw.assignmentReceipts))) {
      if (!Object.hasOwn(values, key) || !isAssignmentReceipt(receipt)) return fail();
    }
  }
  if (
    Object.hasOwn(raw, 'diagnostics') &&
    (!Array.isArray(raw.diagnostics) ||
      raw.diagnostics.length > 5 ||
      new Set(raw.diagnostics).size !== raw.diagnostics.length ||
      raw.diagnostics.some(
        (item) =>
          typeof item !== 'string' ||
          !['provider_error', 'invalid_snapshot', 'scope_mismatch', 'invalid_context', 'missing_identity'].includes(item),
      ))
  )
    return fail();
  return raw as unknown as AppFlagValues;
}
