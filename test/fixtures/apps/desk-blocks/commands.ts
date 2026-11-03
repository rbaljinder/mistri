/*
 * The desk's two composer commands, and its `--commands` entry. Both add a message to the ticket they run on: a
 * reply the customer would see, and an internal note only the team does. And one that files a ticket under a
 * category, picked from the categories' hierarchy.
 */
import { defineCommand, defineCommands, defineSource, field, id, literal, refuse, shape } from '@mistriwork/mistri/commands';
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

/* A category is found by walking to it, three levels down, and said with its path once chosen. */
const categorize = defineCommand({
  source: desk,
  target: 'ticket',
  input: { category: field.reference('category', { label: 'Category', by: 'id', labelColumn: 'name', tree: 'parent_id' }) },
  read: ['category'],
  write: ['ticket'],
  output: shape({ message: literal('Filed.') }),
  async handle({ db, record }, input) {
    const category = (await db.category.find({ id: Number(input.category) })) ?? refuse('invalid_input', 'category');
    await db.ticket.update(record, { category_id: category.id });
    return { message: 'Filed.' as const };
  },
});

export default defineCommands({ reply: say('reply'), addNote: say('internal'), categorize });
