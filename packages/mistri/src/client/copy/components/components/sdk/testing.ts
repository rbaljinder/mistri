/** What sdk/testing says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  regionNamed:
    'Expected one region named "{name}" on the page, found {count}. A region is a section, group or list with that aria-label, or a Panel with that title.',
  noDay: 'The calendar draws no day {date}: it shows another month, or a different span.',
});
