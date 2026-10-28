/**
 * A tenant reply's body as JSON, saying the captured data inside it once
 * (tenantHttp.ts sends every reply through it).
 */
import { isCapturedTenantData } from '@mistriwork/engine/server/evidence.js';

/* A page's boot says its catalog, its App and its pages — on a large App half a megabyte — and every boot said them
   again with JSON.stringify, the largest single cost of a request once they stopped being rebuilt: they are the same
   captured objects on every request of a lease's roles (tenantServedSchema.ts, tenantMetadata.ts), inside envelopes
   that are new each time. Captured data is frozen all the way down and nothing can change it (evidence.ts
   isCapturedTenantData), so the JSON of a captured object is kept with it, and a reply is said by walking it down
   to those: exactly as JSON.stringify says it — an object's own enumerable keys in order, a missing value left out
   (an array's said as null).

   The walk is bounded so that a reply with nothing kept costs what JSON.stringify costs: an envelope is walked a
   few levels down and a few dozen wide, and anything past that, or not plain data, is handed to JSON.stringify
   whole. Captured data is walked three levels into it, however wide — a catalog, its tables, each table — so a
   request's copy of a kept catalog (tenantServedSchema.ts bound), which shares all but a few of its tables, is
   said from theirs; below that each captured object's JSON is JSON.stringify's, kept with it. */
const capturedJson = new WeakMap<object, string>();
const ENVELOPE_DEPTH = 5,
  ENVELOPE_WIDTH = 64,
  CAPTURED_DEPTH = 3;
/** `inside` is how many levels into captured data `value` lies; 0 outside it. */
function jsonOf(value: unknown, depth: number, inside: number): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  /* Inside captured data a frozen object is part of it; bytes cannot be frozen, and are never kept. */
  const captured = inside > 0 ? Object.isFrozen(value) : isCapturedTenantData(value);
  const kept = captured ? capturedJson.get(value) : undefined;
  if (kept !== undefined) return kept;
  const below = captured ? inside + 1 : 0;
  const prototype = Object.getPrototypeOf(value);
  let json: string;
  if (
    (captured ? below > CAPTURED_DEPTH : depth >= ENVELOPE_DEPTH) ||
    (Array.isArray(value)
      ? prototype !== Array.prototype || (!captured && value.length > ENVELOPE_WIDTH)
      : prototype !== Object.prototype && prototype !== null) ||
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  )
    json = JSON.stringify(value);
  else if (Array.isArray(value)) json = `[${value.map((item) => jsonOf(item, depth + 1, below) ?? 'null').join(',')}]`;
  else {
    const said: string[] = [];
    for (const key of Object.keys(value)) {
      const inner = jsonOf((value as Record<string, unknown>)[key], depth + 1, below);
      if (inner !== undefined) said.push(`${JSON.stringify(key)}:${inner}`);
    }
    json = `{${said.join(',')}}`;
  }
  if (captured) capturedJson.set(value, json);
  return json;
}

/** `value` as JSON.stringify says it. */
export function replyJson(value: unknown): string {
  return jsonOf(value, 0, 0) ?? JSON.stringify(value);
}
