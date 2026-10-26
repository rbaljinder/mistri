/** What write says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  resolveThePendingOrUnconfirmed: 'Resolve the pending or unconfirmed change before leaving this view.',
  waitForThePending: 'Wait for the pending record update before changing modes.',
  discardPendingRecordChanges: 'Discard pending record changes?',
  theseFieldChangesHaveNotBeen: 'These field changes have not been applied.',
  discardChanges: 'Discard changes',
  thisConnectionIsRead: 'This connection is read-only.',
  unsavedChangesWereRetained: 'Unsaved changes were retained in this tab. Review them when you return.',
  theRecordConnectionOrTable: 'The record, connection or table definition changed. Review the current record before applying changes.',
  theRecordChangedBefore: 'The record changed before saving. Review it and save again.',
  updatedColumnsOnTheOriginal: {
    one: 'Updated {count} column on the original record in {connection}.',
    other: 'Updated {count} columns on the original record in {connection}.',
  },
  changesSaved: 'Changes saved',
  updatedColumns: { one: 'Updated {count} column on {name}.', other: 'Updated {count} columns on {name}.' },
  applyThisChange: 'Apply this change?',
  applyChanges: { one: 'Apply {count} change?', other: 'Apply {count} changes?' },
  unknownTable: 'Unknown table.',
  thisIsAView: 'This is a view. Views are read-only.',
  thisTableHasNoPrimary: 'This table has no primary key, so there is no way to identify one row safely.',
  parameters: 'parameters {params}',
  theOriginalConnection: 'the original connection',
});
