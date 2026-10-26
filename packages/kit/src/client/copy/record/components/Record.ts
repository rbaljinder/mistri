/** What Record says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  everythingAboutThisRecord: 'Everything about this record on one page',
  asAPage: 'As a page →',
  theRowsKeyItsShape: 'The row’s key, its shape and how to read it over MCP — not its values',
  copyForAgent: 'Copy for agent',
  thatRecordCouldNotBeRead: 'That record could not be read.',
  thatRowIsNoLonger: 'That row is no longer there.',
  required: 'required',
  thisLayoutHasNoRelated: 'This layout has no related tables. Add one under Layout.',
  nothingPointsAtThisRow: 'Nothing points at this row.',
  related: 'Related',
  relationshipsWithNoRows: 'Relationships with no rows',
  hideEmpty: 'hide {emptyCount} empty',
  viaColumns: 'via {columns}',
  rowsRangeOf: '{first}–{last} of {total}',
  prev: '← Prev',
  seeAllCount: 'See all {count} →',
  nameViaColumns: '{name} via {columns}',
});
