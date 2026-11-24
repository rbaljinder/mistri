/** What sdk/blocks says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  blockHasNo: '<{block}> has no "{name}". It takes {takes}.',
  blockRenamed: '<{block}> has "{name}", which is now "{now}".',
  blockNeeds: '<{block}> needs "{name}".',
  blockReadsUndeclared: '<{block}> reads "{resource}", which the page "{label}" does not read. It reads {reads}.',
  blockWhere: '<{block}> has a where it cannot ask: {problem}',
  blockNotAResource: '<{block}> reads "{resource}", which is not one of this App\'s resources.',
  blockValue: '<{block}> has a "{name}" of "{value}". Use {allowed}.',
  blockMoveUndeclared: '<{block}> moves a card with "{name}", which the page "{label}" does not declare. It declares {declared}.',
  blockSplitKey: '<RecordSplit> picks a record by one key column, and "{resource}" has {count}.',
  blockSplitParam: '<RecordSplit> keeps its pick in "{param}", which is not one of the page\'s params.',
  blockSplitDetail: 'Details',
  blockWindowParam: '<Metric> takes its window from "{param}", which is not one of the page\'s params. It has {params}.',
  blockWholeNumber: 'a whole number of 1 or more',
  blockNothing: 'no commands or actions',
  blockNoPage: 'This record has no page.',
});
