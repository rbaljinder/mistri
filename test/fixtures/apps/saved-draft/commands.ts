/*
 * The saved draft's commands, and its `--commands` entry. Server-only.
 *
 * The first step inserts the root with the columns the platform hands it
 * (`draft.start`, which carries the signed-in person as the owner); every later
 * one writes beneath the draft it is given; the submit moves it out of its
 * draft state and answers a reference.
 */
import { defineCommand, defineCommands, defineSource, field, literal, refuse, shape, text } from '@mistriwork/mistri/commands';

const club = defineSource('club');
const saved = shape({ message: literal('Saved.') });
const base = {
  source: club,
  target: 'membership',
  targets: 'none',
  read: ['membership', 'contact', 'person'],
  write: ['membership', 'contact'],
} as const;

export const startMembership = defineCommand({
  ...base,
  output: saved,
  input: { full_name: field.text({ label: 'Full name', max: 60 }) },
  async handle({ db, draft }, input) {
    if (!draft) return refuse('forbidden');
    // Change from the review: the same root, overwritten.
    if (draft.root) await db.membership.update(await db.membership.get(draft.root), input);
    else await db.membership.insert({ ...input, ...draft.start });
    return { message: 'Saved.' as const };
  },
});

export const saveTier = defineCommand({
  ...base,
  output: saved,
  input: { tier: field.text({ label: 'Tier', max: 20 }) },
  async handle({ db, draft }, input) {
    await db.membership.update(await db.membership.get(draft!.root!), input);
    return { message: 'Saved.' as const };
  },
});

export const saveContact = defineCommand({
  ...base,
  output: saved,
  input: { contact_label: field.text({ label: 'Contact', max: 60 }) },
  async handle({ db, draft }, input) {
    for (const row of await db.contact.where({})) await db.contact.remove(row);
    await db.contact.insert({ label: input.contact_label, membership_id: draft!.root!.id as number });
    return { message: 'Saved.' as const };
  },
});

export const submitMembership = defineCommand({
  ...base,
  output: shape({ reference: text() }),
  input: { consent: field.bool({ label: 'These details are true' }) },
  async handle({ db, draft }, input) {
    if (!input.consent) refuse('invalid_input', 'consent');
    const root = await db.membership.get(draft!.root!);
    const reference = `MEM-${String(root.id).padStart(4, '0')}`;
    await db.membership.update(root, { status: 'submitted', reference });
    return { reference };
  },
});

export default defineCommands({ startMembership, saveTier, saveContact, submitMembership });
