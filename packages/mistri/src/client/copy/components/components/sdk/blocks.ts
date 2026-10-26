/** What sdk/blocks says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  blockHasNo: '<{block}> has no "{name}". It takes {takes}.',
  blockRenamed: '<{block}> has "{name}", which is now "{now}".',
  blockNeeds: '<{block}> needs "{name}".',
  blockReadsUndeclared: '<{block}> reads "{resource}", which the page "{label}" does not read. It reads {reads}.',
  blockNotAResource: '<{block}> reads "{resource}", which is not one of this App\'s resources.',
  blockValue: '<{block}> has a "{name}" of "{value}". Use {allowed}.',
  blockTabs: '<Tabs> needs "tabs": a list of tabs, each with its own "key", a "label" and its "content".',
  blockTabParam: '<Tabs> keeps its tab in "{param}", which is not one of the page\'s params.',
  blockNoPage: 'This record has no page.',
});
