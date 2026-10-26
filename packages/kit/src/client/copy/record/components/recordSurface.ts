/** What recordSurface says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisRecordSurfaceIsNoLonger: 'This record surface is no longer current.',
  couldNotRefreshThisRecord: 'Could not refresh this record. Showing the last loaded layout.',
  incompleteSurfaceRoot: 'Incomplete surface root',
  thisSurfaceNeedsAComplete: 'This surface needs a complete record key and the page’s base table.',
});
