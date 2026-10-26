import { addTeamMemberInput, changeTeamRoleInput, deactivateTeamMemberInput, updateDealerContactInput } from './inputs.ts';
// Explicit --commands entry. Never import this module from the App.
import { defineCommand, defineCommands, defineSource, field, literal, refuse, shape } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

/* The dealership's decisions, each checked where it runs. Under the row
   policy every row read or written here is already one of the actor's own
   dealerships', so the handlers copy dealer_id from the record they act on,
   never from input. What the policy cannot say is the actor's standing at
   *that* dealership: the App has one role, and whether someone is its owner
   or its sales manager is their seat on dealer_user. So each team command
   reads the actor's seat at the record's dealership and judges it. */

const keystone = defineSource<Rows>('keystone');
type Actor = { id: string; email?: string };
type Seat = Rows['dealer_user'];

const today = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ROLE_WORDS: Record<string, string> = {
  owner: 'an owner',
  sales_manager: 'a sales manager',
  finance_manager: 'a finance manager',
  salesperson: 'a salesperson',
  viewer: 'a viewer',
};
// What a sales manager may hand out and take back; everything else is the owner's.
const FLOOR = ['salesperson', 'viewer'];

// The actor's own active seat at this dealership: by the linked account, else by the invited email.
async function seatOf(db: { dealer_user: { find(where: Partial<Seat>): Promise<Seat | undefined> } }, dealerId: string, actor: Actor) {
  const linked = await db.dealer_user.find({ dealer_id: dealerId, dealer_account_id: actor.id, status: 'active' });
  if (linked) return linked;
  if (!actor.email) return undefined;
  const invited = await db.dealer_user.find({ dealer_id: dealerId, email: actor.email.toLowerCase(), status: 'active' });
  return invited && invited.dealer_account_id === null ? invited : undefined;
}

async function managerAt(db: Parameters<typeof seatOf>[0], dealerId: string, actor: Actor) {
  const seat = await seatOf(db, dealerId, actor);
  if (!seat || (seat.role !== 'owner' && seat.role !== 'sales_manager'))
    refuse('Only the dealership’s owner or sales manager manages its team.');
  return seat!;
}

const addTeamMember = defineCommand({
  target: 'dealer',
  input: addTeamMemberInput,
  source: keystone,
  write: ['dealer_user'],
  when: 'status in (active, prospect)',
  output: shape({ message: literal('Added. They are on the team as invited until they first sign in to the leads desk.') }),
  async handle({ db, record, actor, now }, input) {
    const seat = await managerAt(db, record.id, actor);
    if (seat.role !== 'owner' && !FLOOR.includes(input.role)) {
      refuse(`A sales manager adds salespeople and viewers; ask an owner to add ${ROLE_WORDS[input.role]}.`);
    }
    const email = input.email.trim().toLowerCase();
    const taken = await db.dealer_user.find({ dealer_id: record.id, email });
    if (taken) refuse(`${taken.name} already uses ${email} here${taken.status === 'deactivated' ? ', on a deactivated seat' : ''}.`);
    await db.dealer_user.insert({
      dealer_id: record.id,
      name: input.name.trim(),
      email,
      phone: input.phone?.trim() || null,
      role: input.role,
      status: 'invited',
      invited_on: today(now()),
    });
    return { message: 'Added. They are on the team as invited until they first sign in to the leads desk.' as const };
  },
});

const updateDealerContact = defineCommand({
  target: 'dealer',
  input: updateDealerContactInput,
  source: keystone,
  read: ['dealer_user'],
  initial: ({ record }) => ({ phone: record.phone, email: record.email }),
  output: shape({ message: literal('Contact details updated.') }),
  async handle({ db, record, actor }, input) {
    await managerAt(db, record.id, actor);
    await db.dealer.update(record, { phone: input.phone.trim(), email: input.email.trim().toLowerCase() });
    return { message: 'Contact details updated.' as const };
  },
});

// No one leaves a dealership without an active owner.
async function lastOwner(db: { dealer_user: { count(where: Partial<Seat>): Promise<number> } }, member: Seat) {
  return (
    member.role === 'owner' &&
    member.status === 'active' &&
    (await db.dealer_user.count({ dealer_id: member.dealer_id, role: 'owner', status: 'active' })) <= 1
  );
}

const changeTeamRole = defineCommand({
  target: 'dealer_user',
  input: changeTeamRoleInput,
  source: keystone,
  when: 'status in (invited, active)',
  initial: ({ record }) => ({ role: record.role as 'owner' | 'sales_manager' | 'finance_manager' | 'salesperson' | 'viewer' }),
  output: shape({ message: literal('Role changed.') }),
  async handle({ db, record, actor }, input) {
    const seat = await managerAt(db, record.dealer_id, actor);
    if (seat.id === record.id) refuse('You cannot change your own role; ask another owner.');
    if (input.role === record.role) refuse(`${record.name} is already ${ROLE_WORDS[record.role]}.`);
    if (seat.role !== 'owner' && !(FLOOR.includes(record.role) && FLOOR.includes(input.role))) {
      refuse('A sales manager moves people between salesperson and viewer; ask an owner for anything else.');
    }
    if (await lastOwner(db, record)) refuse(`${record.name} is the dealership’s only owner. Make someone else an owner first.`);
    await db.dealer_user.update(record, { role: input.role });
    return { message: 'Role changed.' as const };
  },
});

const deactivateTeamMember = defineCommand({
  target: 'dealer_user',
  input: deactivateTeamMemberInput,
  source: keystone,
  when: 'status in (invited, active)',
  output: shape({ message: literal('Deactivated. They can no longer be assigned leads.') }),
  async handle({ db, record, actor }) {
    const seat = await managerAt(db, record.dealer_id, actor);
    if (seat.id === record.id) refuse('You cannot deactivate yourself; ask another owner.');
    if (seat.role !== 'owner' && !FLOOR.includes(record.role)) refuse('A sales manager deactivates salespeople and viewers; ask an owner.');
    if (await lastOwner(db, record)) refuse(`${record.name} is the dealership’s only owner. Make someone else an owner first.`);
    // An invited seat never joined, so it keeps no joined day; the CHECK ties invited to an empty one.
    await db.dealer_user.update(record, { status: 'deactivated', ...(record.joined_on ? {} : { joined_on: record.invited_on }) });
    return { message: 'Deactivated. They can no longer be assigned leads.' as const };
  },
});

const publishWebsite = defineCommand({
  source: keystone,
  target: 'dealer_site',
  input: {},
  when: 'published = false',
  output: shape({ message: literal('Website published.') }),
  async handle({ db, record, now }) {
    await db.dealer_site.update(record, { published: true, published_on: today(now()) });
    return { message: 'Website published.' as const };
  },
});

const unpublishWebsite = defineCommand({
  source: keystone,
  target: 'dealer_site',
  input: { confirm: field.bool({ label: 'Unpublish this website' }) },
  when: 'published = true',
  output: shape({ message: literal('Website unpublished.') }),
  async handle({ db, record }, input) {
    if (!input.confirm) refuse('Confirm the change to continue.');
    await db.dealer_site.update(record, { published: false, published_on: null });
    return { message: 'Website unpublished.' as const };
  },
});

const listForSale = defineCommand({
  source: keystone,
  target: 'vehicle',
  input: {},
  when: 'status = in_stock',
  output: shape({ message: literal('Vehicle listed.') }),
  async handle({ db, record, now }) {
    await db.vehicle.update(record, { status: 'listed', listed_on: today(now()) });
    return { message: 'Vehicle listed.' as const };
  },
});

const takeOffTheMarket = defineCommand({
  source: keystone,
  target: 'vehicle',
  input: { confirm: field.bool({ label: 'Take this vehicle off the market' }) },
  when: 'status = listed',
  output: shape({ message: literal('Vehicle taken off the market.') }),
  async handle({ db, record }, input) {
    if (!input.confirm) refuse('Confirm the change to continue.');
    await db.vehicle.update(record, { status: 'in_stock' });
    return { message: 'Vehicle taken off the market.' as const };
  },
});

export default defineCommands({
  addTeamMember,
  updateDealerContact,
  changeTeamRole,
  deactivateTeamMember,
  publishWebsite,
  unpublishWebsite,
  listForSale,
  takeOffTheMarket,
});
