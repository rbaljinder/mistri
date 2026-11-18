/*
 * The drawer fixture's two commands, and its `--commands` entry. Server-only.
 * `quickNote` has two inputs (the centered dialog); `fullNote` has twelve, past
 * New's threshold of eight (the side drawer). Both write the same note.
 */
import { defineCommand, defineCommands, defineSource, field, id, int, literal, shape } from '@mistriwork/mistri/commands';

type Rows = {
  patient: { id: number; name: string; last_note: string | null; version: number };
  visit_note: { id: number; name: string; patient_id: number; body: string };
};
const clinic = defineSource<Rows>('clinic');

const output = shape({ patientId: id(), version: int({ min: 1 }), message: literal('Note written.') });

export default defineCommands({
  quickNote: defineCommand({
    source: clinic,
    target: 'patient',
    input: { title: field.text({ max: 80 }), body: field.textarea({ optional: true, max: 500 }) },
    write: ['visit_note'],
    output,
    async handle({ db, record }, input) {
      const patient = await db.patient.update(record, { last_note: input.title });
      await db.visit_note.insert({ name: input.title, patient_id: patient.id, body: input.body ?? '' });
      return { patientId: patient.id, version: patient.version, message: 'Note written.' as const };
    },
  }),
  fullNote: defineCommand({
    source: clinic,
    target: 'patient',
    input: {
      title: field.text({ max: 80 }),
      complaint: field.text({ optional: true }),
      history: field.text({ optional: true }),
      allergies: field.text({ optional: true }),
      medications: field.text({ optional: true }),
      pulse: field.text({ optional: true }),
      pressure: field.text({ optional: true }),
      temperature: field.text({ optional: true }),
      weight: field.text({ optional: true }),
      plan: field.text({ optional: true }),
      follow_up: field.text({ optional: true }),
      body: field.textarea({ optional: true, max: 500 }),
    },
    write: ['visit_note'],
    output,
    async handle({ db, record }, input) {
      const patient = await db.patient.update(record, { last_note: input.title });
      await db.visit_note.insert({ name: input.title, patient_id: patient.id, body: input.body ?? '' });
      return { patientId: patient.id, version: patient.version, message: 'Note written.' as const };
    },
  }),
});
