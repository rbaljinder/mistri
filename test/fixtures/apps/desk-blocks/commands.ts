/*
 * The desk's two composer commands, and its `--commands` entry. Both add a message to the ticket they run on: a
 * reply the customer would see, and an internal note only the team does.
 */
import { defineCommand, defineCommands, defineSource, field, id, literal, shape } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const desk = defineSource<Rows>('desk');

const say = (kind: 'reply' | 'internal') =>
  defineCommand({
    source: desk,
    target: 'ticket',
    input: { body: field.textarea({ label: kind === 'reply' ? 'Reply' : 'Internal note', max: 2000 }) },
    read: ['person'],
    write: ['message'],
    output: shape({ messageId: id(), message: literal('Sent.') }),
    async handle({ db, record, now }, input) {
      const sent = await db.message.insert({
        name: 'Robin Bell',
        ticket_id: record.id,
        body: input.body,
        kind,
        sent_at: now().toISOString(),
        author_id: 1,
      });
      return { messageId: sent.id, message: 'Sent.' as const };
    },
  });

export default defineCommands({ reply: say('reply'), addNote: say('internal') });
