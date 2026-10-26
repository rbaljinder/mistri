/** What InboxList says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  unread: 'Unread:',
  notifications: 'Notifications',
  markAllRead: 'Mark all read',
  nothingYetWhenSomeone: 'Nothing yet. When someone replies to you or acts on something of yours, it is listed here.',
  seeAllNotifications: 'See all notifications',
  emailMeTheseToo: 'Email me these too',
  unreadCount: '{count} unread',
  marking: 'Marking…',
  whichNotifications: 'Which notifications',
  unreadTab: 'Unread',
  nothingUnread: 'Nothing unread.',
  noNotificationsYet: 'No notifications yet.',
  whenSomeoneRepliesToYouAssigns: 'When someone replies to you, assigns you something or acts on a record of yours, it is listed here.',
  markRead: 'Mark read',
  showOlder: 'Show older',
});
