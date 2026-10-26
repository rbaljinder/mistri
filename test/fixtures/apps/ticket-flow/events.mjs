import { defineEvent, id, shape } from '../../../../packages/mistri/src/server/commands.ts';

export const ticketAnswered = defineEvent('ticket.answered', shape({ ticket: id() }));
