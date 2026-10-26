import { loadJson, saveJson } from './core.js';

const KEY = 'mistri.related-rows';
export const RELATED_SIZES = [5, 10, 20, 50];
let current: number | undefined;
const listeners = new Set<() => void>();

export function relatedRows(): number {
  if (current === undefined) {
    const stored = Number(loadJson(KEY, 10));
    current = RELATED_SIZES.includes(stored) ? stored : 10;
  }
  return current;
}

export function setRelatedRows(value: number): void {
  current = RELATED_SIZES.includes(value) ? value : 10;
  saveJson(KEY, current);
  for (const listener of listeners) listener();
}

export function subscribeRelatedRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
