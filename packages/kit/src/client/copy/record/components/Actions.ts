/** What Actions says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisActionBelongsToAPrevious: 'This action belongs to a previous record surface.',
  actionDone: '{label} — done',
  wasAppliedButTheRecord: '{label} was applied, but the record could not be refreshed.',
  nothingToDoForThisRecord: 'Nothing to do for this record now',
  moreActionsForThisRecord: 'More actions for this record',
  moreActions: 'More actions',
  sayWhyFor: 'Say why, for "{label}". ',
  sayWhy: 'Say why. ',
  theReasonIsKept: 'The reason is kept with the record.',
  reason: 'Reason',
  labelReason: '{label}: reason',
  revokeLinks: 'Revoke links',
  revokeLinksQuestion: 'Revoke links?',
  linksStopOpening: {
    one: 'The {count} link to {label} that still opens stops opening.',
    other: 'The {count} links to {label} that still open stop opening.',
  },
  noOpenLinks: 'No links to {label} are open.',
  linksAreKept: 'Keep links',
  linksRevoked: { one: 'Revoked {count} link.', other: 'Revoked {count} links.' },
  linksWereNotRevoked: 'The links were not revoked.',
});
