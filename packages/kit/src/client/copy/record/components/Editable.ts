/** What Editable says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  edit: 'Edit {label}',
  doneEditing: 'Done editing {label}',
  yesValue: 'yes',
  noValue: 'no',
  one: 'one of: {allowed}',
  proposedChanges: 'Proposed changes',
  retainedDraft: 'Retained draft',
  unsavedChangesFromYourPrevious: {
    one: '{count} unsaved change from your previous visit',
    other: '{count} unsaved changes from your previous visit',
  },
  theTableDefinitionChanged: 'The table definition changed. This draft cannot be resumed.',
  discardDraft: 'Discard draft',
  resumeDraft: 'Resume draft',
  savedChanges: 'Saved changes',
  unsavedChanges: 'Unsaved changes',
  discard: 'Discard',
  awaitingConfirmation: 'Awaiting confirmation...',
  reviewApply: 'Review & apply',
  countUnsavedChanges: { one: '{count} unsaved change', other: '{count} unsaved changes' },
});
