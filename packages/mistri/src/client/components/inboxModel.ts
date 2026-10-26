/**
 * What the bell and the inbox's lists share (InboxBell.tsx, InboxList.tsx),
 * apart from both so the bell's first-paint module never reaches into the
 * part it loads on demand.
 */

/** Every inbox read shares this key, so marking one read refreshes the bell, the menu and the room together. */
export const INBOX_QUERY = 'inbox';

/** Up to 99, then "99+": a badge is a glance, not a figure. */
export const unreadWord = (unread: number): string => (unread > 99 ? '99+' : String(unread));
