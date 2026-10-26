/** What LayoutBuilder says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  fields: 'Fields',
  discardDraft: 'Discard draft',
  recordLayout: 'Record layout',
  layoutName: 'Layout name',
  defaultLayout: 'Default layout',
  anUnsavedDraftIsAvailable: 'An unsaved draft is available. The saved layout has changed since it was started.',
  anUnsavedLayoutDraft: 'An unsaved layout draft is available.',
  restoreDraft: 'Restore draft',
  anotherEditorChangedTheRecovery: 'Another editor changed the recovery copy. This draft is kept in this tab only.',
  browserRecoveryIsUnavailable: 'Browser recovery is unavailable. Keep this tab open until the layout is saved.',
  resetToDefault: 'Reset to default',
  saveLayout: 'Save layout',
  renameSection: 'Rename section',
  heading: 'Heading',
  tableNamed: 'table · {table}',
  thatReferenceIsNoLonger: 'That reference is no longer in the schema.',
  thatRelationshipIsNoLonger: 'That relationship is no longer in the schema.',
  rowsOnThePage: 'Rows on the page',
  for: 'for {name}',
  block: 'block {i}',
  fieldsKind: 'fields',
});
