/* Chair's commands module: one command and one loader. The schedule's "follow up" line is worked out from the notes'
   follow-up asks, which the desk's role does not read: the loader reads `note` under the App's own authority
   (`elevate`) and hands the page the asks alone, never a note's body. */
import { defineCommand, defineCommands, defineLoader, defineLoaders, defineSource, field } from '@mistriwork/mistri/commands';

const source = defineSource('chair');

/* The desk's own work: a visit on the schedule. */
export const bookVisit = defineCommand({
  source,
  target: 'visit',
  targets: 'none',
  read: ['visit'],
  write: ['visit'],
  input: { patient: field.text({ max: 80, label: 'Patient' }) },
  async handle({ db }, input) {
    await db.visit.insert({ patient: input.patient });
  },
});

export default defineCommands({ bookVisit });

export const loaders = defineLoaders({
  followUps: defineLoader({
    source,
    reads: ['visit', 'note'],
    elevate: { read: ['note'] },
    async load({ db }) {
      const asked = await db.note.where('follow_up != ""').orderBy('visit_id');
      return { followUps: asked.map((note) => ({ visit: note.visit_id, ask: note.follow_up })) };
    },
  }),
});
