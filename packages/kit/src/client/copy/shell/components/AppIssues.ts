/** What AppIssues says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  problemsInThisApps: 'Problems in this app’s config — click for the list',
  problemsIn: 'Problems in {name}',
  eachLineNamesItsFix: 'Each line names its fix. Save the app file and hot reload applies it; mistri check runs the same list in CI.',
  problems: { one: '{count} problem', other: '{count} problems' },
  issues: 'issues {problemsCount}',
});
