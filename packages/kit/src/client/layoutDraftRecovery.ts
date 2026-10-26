import type { Template } from './components/LayoutBuilder.js';
import { draftRecovery } from './draftRecovery.js';

function decode(value: unknown, base: string): Template | undefined {
  const draft = value as Template | undefined;
  if (
    !draft ||
    draft.base !== base ||
    typeof draft.id !== 'string' ||
    (draft.name !== undefined && typeof draft.name !== 'string') ||
    !Array.isArray(draft.sections)
  )
    return;
  const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');
  for (const section of draft.sections) {
    if (
      !section ||
      (section.title !== undefined && typeof section.title !== 'string') ||
      (section.off !== undefined && typeof section.off !== 'boolean')
    )
      return;
    if (section.kind === 'fields') {
      if (!strings(section.paths)) return;
    } else if (section.kind === 'list') {
      if (
        typeof section.via !== 'string' ||
        !strings(section.columns) ||
        (section.limit !== undefined && (!Number.isInteger(section.limit) || section.limit < 1 || section.limit > 50))
      )
        return;
    } else return;
  }
  return draft;
}

export function layoutDraftRecovery(connection: string, original: Template, storage: () => Storage = () => localStorage) {
  return draftRecovery(
    `mistri.layouts.draft.${encodeURIComponent(connection)}.${encodeURIComponent(original.base)}`,
    original,
    (value) => decode(value, original.base),
    storage,
  );
}
