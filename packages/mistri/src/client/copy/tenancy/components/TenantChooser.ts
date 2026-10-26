/** What TenantChooser says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  platform: 'Platform',
  tenantColon: 'Tenant:',
  chooseATenant: 'Choose a tenant',
  thisLinkBelongs: 'This link belongs to',
  chooseThatTenantToOpen: '. Choose that tenant to open it, or choose another tenant to open its home.',
  pleaseWait: 'Please wait…',
  noAvailableTenantsContact: 'No available tenants. Contact your administrator for access.',
  availableTenants: 'Available tenants',
  current: 'Current',
  checkAgain: 'Check again',
  sandbox: 'Sandbox',
  /* The same words where the App names its tenants (`auth.tenancy.label`):
     `{name}` is "dealer", `{names}` is "dealers", `{Name}` is "Dealer". */
  labeledColon: '{Name}:',
  chooseLabeled: 'Choose a {name}',
  // Before a vowel: "Choose an agency".
  chooseLabeledVowel: 'Choose an {name}',
  chooseThatLabeledToOpen: '. Choose that {name} to open it, or choose another {name} to open its home.',
  noLabeledContact: 'No available {names}. Contact your administrator for access.',
  labeledChoices: 'Available {names}',
});
