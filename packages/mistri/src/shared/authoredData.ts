/** Structural equality for authored data shared by feature and API composition. */
import { isRecord } from '@mistriwork/engine/shared/model.js';

/** Authored data compared as data: arrays in order, objects by key whatever their order. */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameData(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}
