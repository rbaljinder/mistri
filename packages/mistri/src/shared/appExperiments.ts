/** Closed, immutable experiment declarations shared by authoring and runtime registration. */
import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';
import { flagValuesEqual, normalizeFlagSnapshot, type FlagCatalog, type FlagValue } from './appFlags.js';

/** The declared epoch uses AN2's existing bounded statistical contract. */
export const EXPERIMENT_DECLARATION_LIMITS = Object.freeze({ arms: 16, guardrails: 16 });

/** Code-declared immutable epoch. Runtime controls reference this declaration. */
export interface ExperimentDeclaration {
  readonly version: string;
  readonly unit: 'subject' | 'visitor';
  readonly control: FlagValue;
  readonly startsAt: string;
  readonly endsAt: string;
  /** `'48 hours'`: how long after a subject's first exposure a conversion counts. */
  readonly conversionWindow: string;
  /** `'24 hours'`: how long after the end a late delivery is still taken. */
  readonly deliveryGrace: string;
  readonly eligibility: {
    readonly rollout?: number;
    /** Declared audience names; a unit in any of them may enter. Who is
     * eligible is said only by audiences, the same ones flag rules name. */
    readonly audiences?: readonly string[];
  };
  /** Two to sixteen arms, covering all of the flag's declared variants. */
  readonly allocation: readonly { readonly value: FlagValue; readonly weight: number }[];
  readonly primary: { readonly conversion: string };
  /** When present, one to sixteen binary guardrails. */
  readonly guardrails?: readonly { readonly conversion: string; readonly maxIncrease: number }[];
}

/** Capture without invoking getters or retaining mutable authored references. */
export function captureFlagDeclaration(input: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 20) throw new Error('Flag declaration exceeds its size limit.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= 4096) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Flag declarations require plain JSON data.');
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw new Error('Flag declarations require plain JSON data.');
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (keys.length > 256 || (array && keys.length !== value.length)) throw new Error('Invalid flag declaration collection.');
    ancestors.add(value);
    const entries = keys.map((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== 'string' ||
        key.length > 128 ||
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        (array && key !== String(index))
      )
        throw new Error('Flag declarations require own enumerable data fields.');
      return [key, copy(descriptor.value, depth + 1)] as const;
    });
    ancestors.delete(value);
    return Object.freeze(array ? entries.map(([, item]) => item) : Object.fromEntries(entries));
  };
  return copy(input, 0);
}

export function flagDeclarationObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a flag declaration object.');
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown flag declaration field.');
  return value as Record<string, unknown>;
}
export function flagDeclarationName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    throw new Error('Invalid flag declaration identifier.');
  return value;
}

export function normalizeExperimentDeclarations(input: unknown, catalog: FlagCatalog): Readonly<Record<string, ExperimentDeclaration>> {
  const declarations = flagDeclarationObject(captureFlagDeclaration(input));
  for (const [id, value] of Object.entries(declarations)) {
    flagDeclarationName(id);
    if (!Object.hasOwn(catalog.flags, id)) throw new Error(`Experiment "${id}" names an undeclared flag.`);
    const raw = flagDeclarationObject(value, [
      'version',
      'unit',
      'control',
      'startsAt',
      'endsAt',
      'conversionWindow',
      'deliveryGrace',
      'eligibility',
      'allocation',
      'primary',
      'guardrails',
    ]);
    flagDeclarationName(raw.version);
    if (raw.unit !== 'subject' && raw.unit !== 'visitor') throw new Error('Experiment unit must be subject or visitor.');
    for (const key of ['startsAt', 'endsAt'] as const) {
      const date = raw[key];
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString() !== date
      )
        throw new Error('Experiment dates must be UTC ISO timestamps.');
    }
    if ((raw.startsAt as string) >= (raw.endsAt as string)) throw new Error('Experiment endsAt must follow startsAt.');
    for (const key of ['conversionWindow', 'deliveryGrace'] as const) {
      const ms = parseDuration(raw[key]);
      if (ms === undefined || (key === 'conversionWindow' && !ms) || !Number.isFinite(Date.parse(raw.endsAt as string) + ms)) {
        throw new Error(`Experiment ${key} is ${DURATION_WORDS}${key === 'conversionWindow' ? ', above zero' : ''}.`);
      }
    }
    const retired = ['roles', 'tenants'].find(
      (key) => raw.eligibility && typeof raw.eligibility === 'object' && Object.hasOwn(raw.eligibility, key),
    );
    if (retired)
      throw new Error(
        `Experiment "${id}" eligibility names ${retired} through an audience: declare one with ${retired} and list it in eligibility.audiences. [experiment-eligibility-audiences-only]`,
      );
    const eligibility = flagDeclarationObject(raw.eligibility, ['audiences', 'rollout']);
    const { rollout, ...target } = eligibility;
    const definition = catalog.flags[id];
    if (!definition.variants?.some((variant) => flagValuesEqual(variant, raw.control as FlagValue)))
      throw new Error('Experiment control must be a declared variant.');
    if (!Array.isArray(raw.allocation) || raw.allocation.length < 2 || raw.allocation.length > EXPERIMENT_DECLARATION_LIMITS.arms) {
      throw new Error('Experiment allocation must have two to sixteen arms.');
    }
    // Reuse the evaluator's exact variant, weight, targeting and percentage rules.
    normalizeFlagSnapshot(
      {
        appId: 'declaration',
        environment: 'declaration',
        tenantId: null,
        revision: 0,
        overrides: {
          [id]: {
            experiment: { version: raw.version, weights: raw.allocation },
            ...(Object.hasOwn(eligibility, 'rollout') ? { rollout } : {}),
            ...(Object.keys(target).length ? { rules: [{ ...target, value: raw.control }] } : {}),
          },
        },
      },
      catalog,
    );
    const primary = flagDeclarationObject(raw.primary, ['conversion']);
    flagDeclarationName(primary.conversion);
    const seen = new Set([primary.conversion]);
    if (Object.hasOwn(raw, 'guardrails')) {
      if (!Array.isArray(raw.guardrails) || !raw.guardrails.length || raw.guardrails.length > EXPERIMENT_DECLARATION_LIMITS.guardrails)
        throw new Error('Experiment guardrails must have one to sixteen entries.');
      for (const value of raw.guardrails) {
        const guardrail = flagDeclarationObject(value, ['conversion', 'maxIncrease']);
        flagDeclarationName(guardrail.conversion);
        if (seen.has(guardrail.conversion)) throw new Error('Duplicate experiment conversion.');
        seen.add(guardrail.conversion);
        if (typeof guardrail.maxIncrease !== 'number' || guardrail.maxIncrease < 0 || guardrail.maxIncrease > 1)
          throw new Error('Experiment maxIncrease must be between 0 and 1.');
      }
    }
  }
  return declarations as unknown as Readonly<Record<string, ExperimentDeclaration>>;
}
