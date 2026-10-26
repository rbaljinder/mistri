/** What requestIdentity says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  noApp: 'No App at /{requested}.',
  invalidAuthenticationRequestIdentity: 'Invalid authentication request identity.',
  databaseConnectionManagementIsUnavailable: 'Database connection management is unavailable to applications.',
  applicationRequestsIdentifyAnApp: 'Application requests identify an app, not a connection.',
  invalidRequestIdentity: 'Invalid {field} request identity.',
  twoDifferentApplications: 'This request names two different applications.',
  twoDifferentConnections: 'This request names two different connections.',
});
