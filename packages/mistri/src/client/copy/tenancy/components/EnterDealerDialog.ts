/** What EnterDealerDialog says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

/* `{name}` is what the App calls a tenant (`auth.tenancy.label`, "customer"), `{names}` its plural and `{Name}` its
   capital; "tenant" where it names none (tenancyNoun.ts). */
export const say = defineMessages({
  tenant: 'tenant',
  enterATenant: 'Enter a {name}',
  // Before a vowel: "Enter an agency".
  enterATenantVowel: 'Enter an {name}',
  youSeeTheTenants:
    "You see the {name}'s App as the role you choose, for thirty minutes at most. The session is recorded with your name and the reason you give, and the {name} can read that record.",
  checkingWhichTenantsYouMay: 'Checking which {names} you may enter…',
  noTenantIsOpen: 'No {name} is open to you for support.',
  chooseATenantProblem: 'Choose the {name} to enter.',
  role: 'Role in',
  chooseTheRoleToEnter: 'Choose the role to enter as.',
  reason: 'Reason',
  giveAReasonOfOne: 'Give a reason of one line, up to {max} characters.',
  oneLineKeptInTheSupport: 'One line, kept in the support record.',
  confirmItIsYou: 'Confirm it is you',
  enteringATenantNeeds: 'Entering for support needs a sign-in from the last five minutes.',
  signOutAndSign: 'Sign out and sign in again, then enter the {name} within five minutes.',
  confirmAtYourProvider: 'Confirm at your sign-in provider',
  yourProviderAsksAgain: "Your organization's sign-in asks for you again, then brings you back here to enter the {name}.",
  enterYourPasswordToSign: 'Enter your password to sign in again.',
  theLastAttemptsResult: "The last attempt's result is not known yet. Check it before trying again.",
  checkTheAttempt: 'Check the attempt',
  enterTenant: 'Enter {name}',
});
