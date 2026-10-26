/** Browser-only recovery, separate from acknowledged server pages. */
import { checkedDraft, type PageDraft } from './components/pageDraft.js';
import { draftRecovery, type RecoveredDraft } from '@mistriwork/kit/client/draftRecovery.js';
export type { RecoveryStatus } from '@mistriwork/kit/client/draftRecovery.js';
export type RecoveredPageDraft = RecoveredDraft<PageDraft>;

function decode(value: unknown, base: string): PageDraft | undefined {
  const draft = value as PageDraft | undefined;
  if (
    !draft ||
    draft.base !== base ||
    typeof draft.id !== 'string' ||
    typeof draft.name !== 'string' ||
    draft.source !== 'saved' ||
    !Array.isArray(draft.sections)
  )
    return;
  // Incomplete names, empty layouts and an aggregation awaiting its column are recoverable.
  checkedDraft({
    ...draft,
    name: 'Recovery',
    sections: draft.sections.length
      ? draft.sections.map((section) =>
          section.kind === 'metric' && section.fn !== 'count' && !section.column ? { ...section, column: '__pending__' } : section,
        )
      : [{ kind: 'fields' }],
  });
  return draft;
}

export function pageDraftRecovery(connection: string, original: PageDraft, storage: () => Storage = () => localStorage) {
  const key = `mistri.pages.draft.${encodeURIComponent(connection)}.${encodeURIComponent(original.id)}`;
  return draftRecovery(key, original, (value) => decode(value, original.base), storage);
}
