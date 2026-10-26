/** The Console's shared head: the App switcher, the jump box and the live read's clock (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  app: 'App',
  updating: 'Updating…',
  updatedNow: 'Updated just now',
  updatedSeconds: 'Updated {seconds} s ago',
  updatedMinutes: { one: 'Updated {count} min ago', other: 'Updated {count} min ago' },
  refreshNow: 'Refresh now',
  never: '—',
  jump: 'Jump to…',
  chordMac: '⌘K',
  chordOther: 'Ctrl K',
  paletteLabel: 'Jump to anything in the Console',
  palettePlaceholder: 'Type a flag, an App, a job…',
  paletteResults: 'Results',
  paletteNothing: 'Nothing by that name.',
  groupApps: 'Apps',
  groupRooms: 'Rooms',
  current: 'Current',
  roomFlags: 'Feature flags',
  roomOperations: 'Operations',
  roomAnalytics: 'Analytics',
  roomGovernance: 'Governance',
});
