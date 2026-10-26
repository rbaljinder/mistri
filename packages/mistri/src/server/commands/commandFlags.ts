/** Trusted request data, never actor or command input. The host captures one
 * reader after admission and shares it across all consumers of that request. */
import { ExperimentExposurePending } from '../experiments/contracts.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isProxy } from 'node:util/types';
import {
  normalizeFlagCatalog,
  normalizeFlagDefinition,
  type FlagCatalog,
  type FlagEvaluation,
  type FlagValue,
} from '../../shared/appFlags.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from './businessCommands.js';

export interface CommandFlagGate {
  readonly flag: string;
  readonly is: boolean | string | number;
}
export interface CommandFlags {
  readonly get: (id: string) => FlagValue;
}
/** Trusted owner hook. Public actors have no assignment identity: their id
 * names the form, never a visitor. Only active-realm roles belong here. */
export type CaptureCommandFlags = (actor: BusinessCommandActor) => CommandFlags | undefined | Promise<CommandFlags | undefined>;

const catalogs = new WeakMap<CommandFlags, FlagCatalog>();
const recorders = new WeakMap<CommandFlags, (id: string) => Promise<void>>();
/** Why each flag has the value this reader holds, for a reader that reports it (@mistriwork/mistri/openfeature). */
const reasons = new WeakMap<CommandFlags, ReadonlyMap<string, FlagEvaluation['reason']>>();
/** The reader of the command attempt now running, so authored server code beside the handler reads the same decision. */
const running = new AsyncLocalStorage<CommandFlags>();
const unavailable: CommandFlags = Object.freeze({
  get(): never {
    throw new Error('Command flags are not configured.');
  },
});

/** Definition capture only. Catalog references are checked by the startup seam below. */
export function captureCommandFlagGate(input: unknown): CommandFlagGate {
  if (
    !input ||
    typeof input !== 'object' ||
    isProxy(input) ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error('Command enabledBy must be a plain object.');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('flag') || !keys.includes('is'))
    throw new Error('Command enabledBy requires exactly flag and is.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Command enabledBy requires own enumerable data properties.');
  }
  const { flag, is } = input as CommandFlagGate;
  if (
    typeof flag !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(flag) ||
    ['__proto__', 'prototype', 'constructor'].includes(flag)
  )
    throw new Error('Command enabledBy names an invalid flag.');
  if (!(typeof is === 'boolean' || (typeof is === 'string' && is.length <= 4096) || (typeof is === 'number' && Number.isFinite(is)))) {
    throw new Error('Command enabledBy is must be a finite scalar.');
  }
  return Object.freeze({ flag, is });
}

function checkGate(gate: CommandFlagGate, catalog: FlagCatalog): void {
  const declared = Object.hasOwn(catalog.flags, gate.flag) ? catalog.flags[gate.flag] : undefined;
  if (
    !declared ||
    declared.type === 'object' ||
    typeof gate.is !== declared.type ||
    (declared.type !== 'boolean' && !declared.variants?.some((value) => value === gate.is))
  ) {
    throw new Error(`Command enabledBy must name a declared boolean or scalar variant: ${gate.flag}.`);
  }
}

/** Startup integration seam: the caller supplies this deployment's catalog. */
export function validateCommandFlagGates(registry: BusinessCommandRegistry, input: FlagCatalog): void {
  const catalog = normalizeFlagCatalog(input);
  for (const command of Object.values(registry)) if (command.enabledBy) checkGate(command.enabledBy, catalog);
}

/** Issue immutable values from an already captured host snapshot (including a
 * composed request). Evaluation is not exposure. No provider I/O occurs here. */
export function createCommandFlags(
  input: FlagCatalog,
  snapshot: { readonly evaluate: (id: string) => FlagEvaluation },
  assertCurrent: () => void = () => {},
  recordUse?: (id: string) => Promise<void>,
): CommandFlags {
  assertCurrent();
  const catalog = normalizeFlagCatalog(input);
  const values = new Map<string, FlagValue>(),
    why = new Map<string, FlagEvaluation['reason']>();
  for (const [id, declared] of Object.entries(catalog.flags)) {
    const evaluated = snapshot.evaluate(id),
      value = evaluated.value;
    why.set(id, evaluated.reason);
    // Capture object values too, so hooks cannot mutate another hook's decision.
    values.set(id, normalizeFlagDefinition({ type: declared.type, owner: declared.owner, default: value }).default);
  }
  const reader: CommandFlags = Object.freeze({
    get(id: string): FlagValue {
      assertCurrent();
      if (!values.has(id)) throw new Error('Undeclared command flag.');
      return values.get(id)!;
    },
  });
  catalogs.set(reader, catalog);
  reasons.set(reader, why);
  if (recordUse) recorders.set(reader, recordUse);
  return reader;
}

/** Structural lookalikes supplied through other channels have no authority. */
export function commandFlagsReader(reader?: CommandFlags): CommandFlags {
  return reader && catalogs.has(reader) ? reader : unavailable;
}

export function commandFlagEnabled(command: { readonly enabledBy?: CommandFlagGate }, reader?: CommandFlags): boolean {
  if (!command.enabledBy) return true;
  const catalog = reader && catalogs.get(reader);
  if (!catalog) return false;
  try {
    checkGate(command.enabledBy, catalog);
  } catch {
    return false;
  }
  return reader!.get(command.enabledBy.flag) === command.enabledBy.is;
}

/** Only the admitted handler consumes flags. Preparation and availability use
 * the passive reader. Enrollment must persist before the handler transaction
 * can commit. Only delivery failures backed by that obligation are tolerated. */
export async function executeWithCommandFlags<T>(
  reader: CommandFlags,
  gate: CommandFlagGate | undefined,
  run: (flags: CommandFlags) => Promise<T>,
): Promise<T> {
  const record = recorders.get(reader);
  if (!record) return running.run(reader, () => run(reader));
  let active = true;
  const used = new Map<string, Promise<void>>();
  const execution: CommandFlags = Object.freeze({
    get(id: string) {
      if (!active) throw new Error('Command flag execution retired.');
      const value = reader.get(id);
      if (!used.has(id)) {
        // Install rejection handling immediately, while preserving a final drain.
        const pending = Promise.resolve().then(() => record(id));
        used.set(id, pending);
        void pending.catch(() => {});
      }
      return value;
    },
  });
  catalogs.set(execution, catalogs.get(reader)!);
  if (reasons.has(reader)) reasons.set(execution, reasons.get(reader)!);
  let handler: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    if (gate) execution.get(gate.flag);
    handler = { ok: true, value: await running.run(execution, () => run(execution)) };
  } catch (error) {
    handler = { ok: false, error };
  }
  active = false;
  const outcomes = await Promise.allSettled(used.values());
  const failure = outcomes.find((result) => result.status === 'rejected' && !(result.reason instanceof ExperimentExposurePending));
  if (failure?.status === 'rejected') throw failure.reason;
  if (!handler.ok) throw handler.error;
  return handler.value;
}

/** What the running command attempt holds for one flag, or why it holds nothing. Reading counts as use, exactly as `ctx.flags.get` does. */
type ActiveCommandFlag =
  | { readonly status: 'none' }
  | { readonly status: 'unknown' }
  | {
      readonly status: 'ok';
      readonly type: 'boolean' | 'string' | 'number' | 'object';
      readonly value: FlagValue;
      readonly reason: FlagEvaluation['reason'];
    };
export function activeCommandFlag(id: string): ActiveCommandFlag {
  const reader = running.getStore(),
    catalog = reader && catalogs.get(reader);
  if (!reader || !catalog) return { status: 'none' };
  if (!Object.hasOwn(catalog.flags, id)) return { status: 'unknown' };
  const value = reader.get(id);
  return { status: 'ok', type: catalog.flags[id].type, value, reason: reasons.get(reader)?.get(id) ?? 'default' };
}
