/** What IntegrationsForm says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  loading: 'Loading integrations…',
  couldNotLoad: 'Integrations could not be loaded.',
  readOnly: "Only this organization's admins can change its integrations.",
  none: 'This App uses no integrations.',
  configured: 'Configured: every secret is saved.',
  notConfigured: 'Not configured: no secret is saved yet.',
  partlyConfigured: 'Partly configured: {set} of {count} secrets saved.',
  set: 'Set {date}',
  notSet: 'Not set',
  webhook: 'Webhook address',
  webhookHint: 'Give this to the provider as the address it sends events to.',
  channel: 'Sends {channel} messages.',
  newValue: 'New value',
  keep: 'Leave empty to keep the saved value.',
  least: 'It signs the webhooks, so it is at least {count} characters.',
  remove: 'Remove',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved. The next call uses it.',
  testConnection: 'Test connection',
  testing: 'Testing…',
  connected: 'Connected.',
  couldNotTest: 'The connection could not be tested.',
  couldNotSave: 'The secrets could not be saved.',
});
