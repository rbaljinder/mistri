/** What IntegrationsForm says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  loading: 'Loading integrations…',
  couldNotLoad: 'Integrations could not be loaded.',
  readOnly: "Only this organization's admins can change its integrations.",
  none: 'This App uses no integrations.',
  set: 'Set {date}',
  notSet: 'Not set',
  webhook: 'Webhook address',
  webhookHint: 'Give this to the provider as the address it sends events to.',
  channel: 'Sends {channel} messages.',
  newValue: 'New value',
  keep: 'Leave empty to keep the saved value.',
  remove: 'Remove',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved. The next call uses it.',
  couldNotSave: 'The secrets could not be saved.',
});
