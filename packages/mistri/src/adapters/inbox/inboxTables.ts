/* The inbox store's table names, on their own so the outbox (inboxMail.ts)
   and the store (inbox.ts) can both name them without importing each other. */
export const INBOX_PREFIX = '__mistri_inbox_';
/* `mail` is the outbox: a row per notice that is also emailed, written with
   the notice and gone once it is sent (inboxMail.ts). `optout` holds the
   people who asked for no email, by a digest of App and address. */
export const INBOX_TABLES = Object.freeze({
  meta: `${INBOX_PREFIX}meta`,
  notice: `${INBOX_PREFIX}notice`,
  mail: `${INBOX_PREFIX}mail`,
  optout: `${INBOX_PREFIX}optout`,
});
