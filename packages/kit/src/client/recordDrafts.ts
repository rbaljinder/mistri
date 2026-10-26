import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { updateOwnerKey, type UpdateOwner } from './updateAttempts.js';
import type { RecordEditControlState } from './recordEditValidation.js';

type Value = string | number | boolean | null;
export interface RecordDraft extends UpdateOwner {
  schemaKey: string;
  needsReview: boolean;
  /** Resume only restores editing; it must not turn retained/rejected intent
   * into an automatic submission. Explicit Save or Discard clears this latch. */
  manualSaveRequired: boolean;
  values: Record<string, Value>;
  originals: Record<string, Value>;
  inputs: Record<string, { element: HTMLElement; onCommitted?: (value: Value) => void; readState?: () => RecordEditControlState }>;
  /** Each staged row-defined field (`specs.capacity`): its column, the object it was read in, and its box's text as a value. */
  folds?: Record<string, DefinedFold>;
}

/** How a row-defined field's edit becomes part of its column's object (DefinedFields.tsx, write.js). */
export interface DefinedFold {
  column: string;
  /** The definition's caption, which the field's editor is named by. */
  label: string;
  object: Readonly<Record<string, unknown>>;
  /** Undefined is empty: the key leaves the object. */
  toValue: (text: unknown) => unknown;
}

/** Presentation changes do not invalidate drafts; storage/validation and field policy changes do. */
export function draftSchemaKey(table: TableMeta): string {
  return JSON.stringify([
    table.id,
    table.isView,
    [...(table.columns ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((column) => [column.name, column.type, column.nullable, column.primaryKey, column.references, column.allowed, column.writable]),
  ]);
}

/** Tab-memory only. Suspending releases DOM callbacks without losing business values. */
export function createRecordDrafts() {
  const drafts = new Map<string, RecordDraft>();
  const acquire = (owner: UpdateOwner, schemaKey: string): RecordDraft => {
    const id = updateOwnerKey(owner);
    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        ...owner,
        key: { ...owner.key },
        schemaKey,
        needsReview: false,
        manualSaveRequired: false,
        values: {},
        originals: {},
        inputs: {},
      };
      drafts.set(id, draft);
    }
    if (draft.schemaKey !== schemaKey && Object.keys(draft.values).length) {
      draft.needsReview = true;
      draft.manualSaveRequired = true;
    } else if (!Object.keys(draft.values).length) {
      draft.schemaKey = schemaKey;
      draft.needsReview = false;
    }
    return draft;
  };
  const suspend = (draft: RecordDraft) => {
    draft.inputs = {};
    if (Object.keys(draft.values).length) {
      draft.needsReview = true;
      draft.manualSaveRequired = true;
    } else if (!draft.manualSaveRequired) drafts.delete(updateOwnerKey(draft));
  };
  return {
    acquire,
    suspend,
    clear: () => drafts.clear(),
    drop: (owner: UpdateOwner) => drafts.delete(updateOwnerKey(owner)),
    hasPending: () => [...drafts.values()].some((draft) => Object.keys(draft.values).length > 0),
  };
}
