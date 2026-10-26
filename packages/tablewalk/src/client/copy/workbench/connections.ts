/** What connections says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  schemaReRead: 'Schema re-read — {changes}.',
  schemaReReadNothing: {
    one: 'Schema re-read — nothing changed ({count} table).',
    other: 'Schema re-read — nothing changed ({count} tables).',
  },
  tablesAdded: '{tables} added',
  gonecountRemoved: '{goneCount} removed',
  columnsAdded: { one: '{count} column added', other: '{count} columns added' },
  columnsRemoved: { one: '{count} column removed', other: '{count} columns removed' },
});
