import { captureScopedStorage } from './sessionIdentity.js';

/** Browser recovery is a separate document from acknowledged server state. */
export interface RecoveredDraft<T> {
  version: 1;
  original: string;
  draft: T;
  updatedAt: number;
  revision: string;
}
export type RecoveryStatus = 'stored' | 'empty' | 'unavailable' | 'conflict';

export function draftRecovery<T>(
  key: string,
  original: T,
  decodeDraft: (value: unknown) => T | undefined,
  storage: () => Storage = () => localStorage,
) {
  const target = captureScopedStorage(storage);
  const source = JSON.stringify(original);
  let expected: string | null = null;
  let available = true;
  try {
    expected = target.getItem(key);
  } catch {
    available = false;
  }
  let recovered: RecoveredDraft<T> | undefined;
  try {
    const value = JSON.parse(expected ?? 'null');
    if (
      value?.version === 1 &&
      typeof value.original === 'string' &&
      typeof value.revision === 'string' &&
      Number.isFinite(value.updatedAt) &&
      Math.abs(value.updatedAt) <= 8.64e15
    ) {
      const draft = decodeDraft(value.draft);
      if (draft) recovered = { ...value, draft };
    }
  } catch {
    /* Malformed recovery must never reach the renderer. */
  }

  const change = (draft?: T): RecoveryStatus => {
    try {
      // An old editor must not overwrite or erase another editor's recovery.
      if (target.getItem(key) !== expected) return 'conflict';
      if (!draft) {
        target.removeItem(key);
        expected = null;
        return 'empty';
      }
      const revision = Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) => word.toString(16).padStart(8, '0')).join('');
      const next = JSON.stringify({ version: 1, original: source, draft, updatedAt: Date.now(), revision } satisfies RecoveredDraft<T>);
      target.setItem(key, next);
      expected = next;
      return 'stored';
    } catch {
      return 'unavailable';
    }
  };
  return {
    recovered,
    sourceChanged: recovered !== undefined && recovered.original !== source,
    status: (available ? (recovered ? 'stored' : 'empty') : 'unavailable') as RecoveryStatus,
    write: (draft: T) => change(draft),
    clear: () => change(),
  };
}
