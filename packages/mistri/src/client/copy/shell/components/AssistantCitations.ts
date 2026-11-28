/** What AssistantCitations says, in the shell room. */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  memoryScopePerson: 'Private',
  memoryScopeApp: 'Shared',
  memoryRemembered: 'Remembered',
  memoryUpdated: 'Updated memory',
  memoryForgot: 'Forgot memory',
  memoryManage: 'Manage',
  sources: { one: '{count} source', other: '{count} sources' },
  sourcesRegion: 'Cited sources',
  openSource: 'Open {title}',
  leaveOutContext: 'Leave out {label}',
});
