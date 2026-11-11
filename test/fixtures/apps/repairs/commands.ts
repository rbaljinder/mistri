/*
 * The repairs fixture's command, and its `--commands` entry. Server-only.
 *
 * A public report: a title, up to three photos (pictures only), close-ups
 * that are each a picture and what it shows, and a signature, each file held
 * as it is sent; the handler stores every file as a row of its resource, under
 * the repair it writes, and answers a random reference.
 */
import {
  defineCommand,
  defineCommands,
  defineSource,
  field,
  literal,
  publicReference,
  publicReferencePattern,
  shape,
  text,
} from '@mistriwork/mistri/commands';

const garage = defineSource('garage');

export const reportRepair = defineCommand({
  source: garage,
  target: 'repair',
  targets: 'none',
  public: true,
  read: [],
  write: ['repair', 'repair_photo', 'repair_signature'],
  input: {
    title: field.text({ max: 80, label: 'What needs fixing?' }),
    photos: field.files('repair_photo', { max: 3, accept: 'image/*' }),
    closeUps: field.group(
      {
        photo: field.files('repair_photo', { max: 1, accept: 'image/*', label: 'Close-up' }),
        note: field.text({ max: 80, label: 'What it shows' }),
      },
      { label: 'Close-ups', repeat: { max: 2 } },
    ),
    signature: field.signature('repair_signature'),
  },
  output: shape({ reference: text({ pattern: publicReferencePattern('REP') }), message: literal('Your repair is in.') }),
  async handle({ db }, input) {
    const reference = publicReference('REP');
    const repair = await db.repair.insert({ reference, title: input.title });
    for (const photo of input.photos) await db.repair_photo.insertFile(photo, { repair_id: repair.id as number });
    for (const closeUp of input.closeUps)
      await db.repair_photo.insertFile(closeUp.photo[0]!, { repair_id: repair.id as number, caption: closeUp.note });
    await db.repair_signature.insertFile(input.signature, { repair_id: repair.id as number });
    return { reference, message: 'Your repair is in.' as const };
  },
});

export default defineCommands({ reportRepair });
