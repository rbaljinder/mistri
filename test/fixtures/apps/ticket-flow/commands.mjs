import { defineCommand, defineCommands, field, id, shape } from '../../../../packages/mistri/src/server/commands.ts';
import { ticketAnswered } from './events.mjs';

const done = shape({ id: id() });

export default defineCommands({
  openTicket: defineCommand({
    source: 'data',
    target: 'ticket',
    targets: 'none',
    input: { title: field.text({ max: 80 }), priority: field.choice(['low', 'high']) },
    output: done,
    async handle({ db }, { title, priority }) {
      const row = await db.ticket.insert({ title, priority, stage: 'new' });
      return { id: row.id };
    },
  }),
  // A flow's step kind: the step's `team` column is its input.
  askTeam: defineCommand({
    source: 'data',
    target: 'ticket',
    input: { team: field.text({ max: 40 }) },
    output: done,
    async handle({ db, record }, { team }) {
      await db.ticket.update(record, { asked: team });
      return { id: record.id };
    },
  }),
  answerTicket: defineCommand({
    source: 'data',
    target: 'ticket',
    input: { answer: field.choice(['yes', 'no']) },
    output: shape({ ticket: id() }),
    // The fact is the output's `ticket`: what a waiting flow matches the ticket by.
    events: { answered: ticketAnswered },
    async handle({ db, record }, { answer }) {
      await db.ticket.update(record, { answer });
      return { ticket: record.id };
    },
  }),
});
