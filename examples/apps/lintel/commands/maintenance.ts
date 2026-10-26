/* A repair, from the resident's first words to the technician's last. Every
   message on it — the resident's, the desk's replies, its internal notes — is a
   line of request_note written in the transaction of the step it goes with, so
   the page's conversation is the repair's whole story. Who wrote it comes from
   the verified session, never the form. */
import { defineCommand, field, refuse, shape, text } from '@mistriwork/mistri/commands';
import { author, day, lintel, said, stamp } from '../source.ts';

const CATEGORIES = [
  { value: 'plumbing', label: 'Plumbing', icon: 'drop' },
  { value: 'electrical', label: 'Electrical', icon: 'lightning' },
  { value: 'appliance', label: 'Appliance', icon: 'plug' },
  { value: 'hvac', label: 'Heating and cooling', icon: 'sun' },
  { value: 'general', label: 'Something else', icon: 'wrench' },
] as const;

/* The part of the day a resident will be home for a visit. */
const WINDOWS = [
  { value: 'morning', label: 'Morning, 8 to noon' },
  { value: 'afternoon', label: 'Afternoon, noon to 5' },
  { value: 'evening', label: 'Evening, 5 to 8' },
] as const;

/**
 * A resident reports a problem in their home. They are found by their
 * account's verified email, and the home by their current lease, both read in
 * the rows the row policy gives them (policy.ts): nothing the form says picks
 * another household's home.
 */
export const reportIssue = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  targets: 'none',
  read: ['resident', 'lease', 'unit'],
  write: ['request_note'],
  input: {
    title: field.text({ label: 'What’s wrong?', max: 120, help: 'A few words, such as “Kitchen sink drips”.' }),
    category: field.choice(CATEGORIES, { label: 'Kind of problem', as: 'cards' }),
    description: field.textarea({ label: 'Tell us more', max: 2000, help: 'Where it is, when it started, anything you have tried.' }),
    urgent: field.bool({ label: 'Is it urgent?', help: 'Water, gas, no heat or no power.', as: 'buttons' }),
    entry_ok: field.bool({ label: 'May we let ourselves in if you’re out?', as: 'buttons' }),
    // Asked only of someone who wants to be home for the visit: a day and a part of it, side by side.
    visit_on: field.date({ label: 'Day that suits you', when: 'entry_ok = false' }),
    visit_window: field.choice(WINDOWS, { label: 'Time of day', as: 'select', when: 'entry_ok = false' }),
  },
  output: shape({ message: text({ max: 300 }), requestId: text({ max: 20, pattern: /^\d+$/ }) }),
  async handle({ db, actor, now }, input) {
    const resident = actor.email ? await db.resident.find({ email: actor.email.toLowerCase() }) : undefined;
    if (!resident) refuse('Your account is not linked to a resident yet. Call the office to report a problem.');
    const lease = await db.lease.where`resident_id = ${resident.id} and (status = active or status = notice)`.first();
    if (!lease) refuse('You have no current lease to report a problem on.');
    if (input.visit_on !== undefined && input.visit_on < day(now)) refuse('Pick today or a day still to come.', { field: 'visit_on' });
    const request = await db.maintenance_request.insert({
      unit_id: lease.unit_id,
      resident_id: resident.id,
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.urgent ? 'urgent' : 'normal',
      status: 'new',
      entry_ok: input.entry_ok,
      reported_on: day(now),
    });
    if (input.visit_on !== undefined && input.visit_window !== undefined) {
      const said = WINDOWS.find((each) => each.value === input.visit_window)!.label.toLowerCase();
      await db.request_note.insert({
        request_id: request.id,
        kind: 'resident',
        author: author(actor),
        body: `I’d like to be home for the visit: ${input.visit_on}, ${said}.`,
        sent_at: stamp(now),
      });
    }
    /* The description is the request's own, not a first message: the conversation is what came after it, each
       message a note on the request. */
    return { message: 'Thanks. The office will be in touch about a visit.', requestId: String(request.id) };
  },
});

/* Who looks at a repair, said before a visit is booked. The routing decision in jobs.ts offers its answer through this
   command, so a suggestion lands under the same rules as the desk's own choice. */
export const assignTechnician = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  read: ['staff', 'unit', 'property'],
  input: {
    assigned_to: field.reference('staff', {
      by: 'id',
      labelColumn: 'name',
      query: 'role = technician and active = true',
      label: 'Technician',
    }),
  },
  output: said,
  async handle({ db, record }, input) {
    const technician = await db.staff.get(input.assigned_to);
    if (technician.role !== 'technician' || !technician.active)
      refuse(`${technician.name} does not take repairs.`, { field: 'assigned_to' });
    await db.maintenance_request.update(record, { assigned_to: technician.id, status: 'triaged' });
    return { message: `Assigned to ${technician.name}.` };
  },
});

/* A visit booked: who goes, and which day. The resident reads the desk's line about it on their request. */
export const scheduleVisit = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  read: ['staff'],
  write: ['request_note'],
  input: {
    technician: field.reference('staff', { by: 'id', labelColumn: 'name', query: 'role = technician and active = true' }),
    visit_on: field.date(),
  },
  output: said,
  async initial({ record }) {
    return {
      ...(record.assigned_to === null ? {} : { technician: record.assigned_to }),
      ...(record.scheduled_on === null ? {} : { visit_on: record.scheduled_on }),
    };
  },
  async handle({ db, record, now }, input) {
    if (input.visit_on < day(now)) refuse('A visit is booked for today or a day still to come.', { field: 'visit_on' });
    const technician = await db.staff.get(input.technician);
    if (technician.role !== 'technician' || !technician.active)
      refuse(`${technician.name} does not take repairs.`, { field: 'technician' });
    await db.maintenance_request.update(record, { status: 'scheduled', assigned_to: technician.id, scheduled_on: input.visit_on });
    const when = new Date(`${input.visit_on}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    await db.request_note.insert({
      request_id: record.id,
      kind: 'staff',
      author: technician.name,
      body: `${technician.name.split(' ')[0]} will be by on ${when}${record.entry_ok ? ', and has your OK to let themselves in' : ''}.`,
      sent_at: stamp(now),
    });
    return { message: `Booked ${technician.name} for ${input.visit_on}.` };
  },
});

/* The work is done: what was done is kept, and the resident is emailed (resources.ts `notify`). */
export const completeRequest = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  write: ['request_note'],
  input: { resolution: field.textarea({ label: 'What was done', max: 1000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await db.maintenance_request.update(record, { status: 'completed', resolution: input.resolution });
    await db.request_note.insert({
      request_id: record.id,
      kind: 'staff',
      author: author(actor),
      body: input.resolution,
      sent_at: stamp(now),
    });
    return { message: 'Completed. The resident has been told.' };
  },
});

/* A repair called off, with why. A command rather than a bare move of the road, so that only the roles granted it are
   offered Cancel (the desk's: app.ts): a technician moves a repair by its status alone and never writes its resolution. */
export const cancelRequest = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  write: ['request_note'],
  input: { resolution: field.textarea({ label: 'Why it is called off', max: 1000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await db.maintenance_request.update(record, { status: 'cancelled', resolution: input.resolution });
    await db.request_note.insert({
      request_id: record.id,
      kind: 'internal',
      author: author(actor),
      body: `Called off: ${input.resolution}`,
      sent_at: stamp(now),
    });
    return { message: 'The repair is cancelled.' };
  },
});

/* The page composer's Reply: words the resident reads. */
export const replyToResident = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  write: ['request_note'],
  input: { body: field.textarea({ label: 'Reply', max: 4000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await db.request_note.insert({ request_id: record.id, kind: 'staff', author: author(actor), body: input.body, sent_at: stamp(now) });
    return { message: 'Reply sent.' };
  },
});

/* The composer's Internal note: the desk's alone. The policy never gives a resident one. */
export const addNote = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  write: ['request_note'],
  input: { body: field.textarea({ label: 'Note', max: 4000 }) },
  output: said,
  async handle({ db, record, actor, now }, input) {
    await db.request_note.insert({ request_id: record.id, kind: 'internal', author: author(actor), body: input.body, sent_at: stamp(now) });
    return { message: 'Note added.' };
  },
});

/* A resident's message on their own repair. The policy reaches only their own requests, so `record` is theirs. */
export const messageOffice = defineCommand({
  source: lintel,
  target: 'maintenance_request',
  read: ['resident'],
  write: ['request_note'],
  input: { body: field.textarea({ label: 'Message', max: 2000 }) },
  when: 'status != closed and status != cancelled',
  output: said,
  async handle({ db, record, actor, now }, input) {
    const resident = record.resident_id === null ? undefined : await db.resident.find({ id: record.resident_id });
    await db.request_note.insert({
      request_id: record.id,
      kind: 'resident',
      author: resident?.name ?? author(actor),
      body: input.body,
      sent_at: stamp(now),
    });
    return { message: 'Sent to the office.' };
  },
});
