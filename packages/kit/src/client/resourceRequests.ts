import type { HttpFilter, HttpRecordKey, HttpScalar, HttpValues } from '@mistriwork/engine/shared/resourceHttp.js';
import { say } from './copy/shell/resourceRequests.js';

function scalar(value: unknown): HttpScalar {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error(say('thisRecordContainsAValue'));
}

/** Preserve string IDs (including integers above 2^53). Never coerce keys to
 * numbers or let a missing record key become an unfiltered write request. */
export function recordKey(value: unknown): HttpRecordKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(say('thisRecordHasNoUsable'));
  const entries = Object.entries(value);
  if (!entries.length) throw new Error(say('thisRecordHasNoUsable'));
  return Object.fromEntries(
    entries.map(([column, item]) => {
      if (!column || (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))) {
        throw new Error(say('thisRecordHasNoUsable'));
      }
      return [column, item];
    }),
  );
}

export function equalityFilter(values: Record<string, unknown>): HttpFilter {
  return { groups: [Object.entries(values).map(([column, value]) => ({ column, op: '=', value: scalar(value) }))] };
}

export function writeValues(values: Record<string, unknown>): HttpValues {
  return Object.fromEntries(Object.entries(values).map(([column, value]) => [column, scalar(value)]));
}

export function pathEqualityFilter(values: Record<string, unknown>): HttpFilter<'path'> {
  return { groups: [Object.entries(values).map(([path, value]) => ({ path, op: '=', value: scalar(value) }))] };
}
