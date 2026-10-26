import { defineInbound, defineJobs, hmac } from '../../../../packages/mistri/src/server/jobs.ts';
import { defineWorkflows, flowRunner } from '../../../../packages/mistri/src/server/workflows.ts';
import { ticketAnswered } from './events.mjs';

const signed = (command, key, input, target) =>
  defineInbound({
    verify: hmac({
      secret: 'TICKET_FLOW_SECRET',
      signature: { header: 'x-signature', encoding: 'hex' },
      timestamp: { header: 'x-timestamp', window: '5 minutes' },
    }),
    runAs: 'intake',
    command,
    key,
    input,
    ...(target ? { target } : {}),
  });

export default defineJobs(
  {},
  {
    principals: { intake: { roles: ['intake'] }, automation: { roles: ['automation'] } },
    inbound: {
      open: signed(
        'openTicket',
        (body) => body.key,
        (body) => ({ title: body.title, priority: body.priority }),
      ),
      answer: signed(
        'answerTicket',
        (body) => body.key,
        (body) => ({ answer: body.answer }),
        (body) => ({ id: body.ticket }),
      ),
    },
    workflows: defineWorkflows({ tickets: flowRunner('ticket', { runAs: 'automation', listens: [ticketAnswered] }) }),
    store: { namespace: 'ticketflow' },
  },
);
