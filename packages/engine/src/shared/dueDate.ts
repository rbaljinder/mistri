/**
 * A date named like a due date (`due_on`, `deadline`): the convention says it from today
 * (displayDefaults.ts), and the client draws one that has passed on a row still open in the
 * warning tone (client/components/dueOpen.ts). One name list, so the two cannot disagree.
 */
export const DUE = /^(due|due_on|due_at|due_date|deadline)$/i;
