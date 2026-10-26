/** What connmanager says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  removeName: 'Remove "{name}"?',
  typeTheNameToConfirm: 'Type the name to confirm',
  thisConnectionCameFromTheConfig: 'This connection came from the config file. Removing it here affects this session only, until you save.',
  removingItHereAffects: 'Removing it here affects this session only.',
  namesDidNotMatch: 'Names did not match — nothing removed.',
  removalWasNotConfirmed: 'Removal was not confirmed. Refresh Connections before trying again.',
  removed: 'Removed {name}.',
  addAConnection: 'Add a connection',
  addAndOpen: 'Add and open',
  theWorkspaceChangedClose: 'The workspace changed. Close this form and open Connections again.',
  aConnectionStringOrFile: 'A connection string or file path is required.',
  additionWasNotConfirmed: 'Addition was not confirmed. Check Connections before trying again.',
  added: 'Added {name}.',
  editQuotedNameQuoted: 'Edit "{name}"',
  aChangeToThisConnection: 'A change to this connection is still pending.',
  nothingToChange: 'Nothing to change.',
  updateWasNotConfirmed: 'Update was not confirmed. Check Connections before trying again.',
  updated: 'Updated {name}.',
  couldNotUpdateTheConnection: 'Could not update the connection.',
  writeConnectionsToAFile: 'Write connections to a file',
  path: 'Path',
  connectionsWillBeWritten: {
    one: '{count} connection will be written. Passwords are moved to secure storage where available; check the result before sharing the file.',
    other:
      '{count} connections will be written. Passwords are moved to secure storage where available; check the result before sharing the file.',
  },
  fileSaveWasNotConfirmed: 'File save was not confirmed. Check the file before trying again.',
  theKeychain: 'the keychain',
  aCredentialsFileMode: 'a credentials file (mode 600)',
  passwordsMovedToTheFile: {
    one: ' {count} password moved to {where} — the file has none.',
    other: ' {count} passwords moved to {where} — the file has none.',
  },
  wroteConnections: { one: 'Wrote {count} connection to {path}.{secrets}', other: 'Wrote {count} connections to {path}.{secrets}' },
});
