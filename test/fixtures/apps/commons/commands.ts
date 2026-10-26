// Explicit --commands entry. Never import this module from the App graph.
import { defineCommands } from '@mistriwork/mistri/commands';
import { editPost, editProfile, joinCommunity, reactToPost, replyToThread, reportPost, startThread } from './member-commands.ts';
import {
  approvePost,
  dismissReport,
  hidePost,
  lockThread,
  moveThread,
  pinThread,
  removeReportedPost,
  restorePost,
  unlockThread,
  unpinThread,
  warnMember,
} from './moderator-commands.ts';

export default defineCommands({
  joinCommunity,
  startThread,
  replyToThread,
  editPost,
  reactToPost,
  editProfile,
  // Public: reachable only through the report form, under its public principal.
  reportPost,
  approvePost,
  hidePost,
  restorePost,
  lockThread,
  unlockThread,
  pinThread,
  unpinThread,
  moveThread,
  removeReportedPost,
  dismissReport,
  warnMember,
});
