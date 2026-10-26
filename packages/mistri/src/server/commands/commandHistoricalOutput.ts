/* Historical command output validation and detached result freezing.
 * Shared value rules only: receipt ownership and current authorization remain
 * with the executor or owner-verified recovery caller. */
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

/** Freeze only detached JSON, never validator/handler-owned objects. */
export function immutableCommandResult(json: string): unknown {
  const freeze = (value: unknown): unknown => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(JSON.parse(json));
}

/** Current trusted output validator must preserve the entire stored value.
 * Parsing gets an independent copy: projection or mutation cannot silently
 * rewrite history. No input/initial/lookup/handler callback runs here.
 * Journal ownership, raw storage bounds, authorization and public error mapping
 * belong to the caller; this helper is not receipt authenticity or admission. */
export function validateHistoricalCommandOutput(json: string, output: { parse(value: unknown): unknown }): unknown {
  const original = canonicalCommandJson(JSON.parse(json), 16384);
  const validated = canonicalCommandJson(output.parse(JSON.parse(original)), 16384);
  if (validated !== original) throw new Error();
  return immutableCommandResult(original);
}
