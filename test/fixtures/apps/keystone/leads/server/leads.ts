import { logContactInput, markLeadLostInput, recordWalkInInput, startDealInput, takeApplicationInput } from '../features/leads-inputs.ts';
// The lead's verbs: log a contact, take a credit application, start a deal,
// mark it lost, and record a walk-in. Tenant-realm commands: each runs inside
// one dealer, so `db.lead.where({})` is that dealer's leads and nobody else's,
// and every insert has its `dealer_id` injected.
//
// A write is checked against every parent of the row it changes, inside the
// command's own footprint, so each command reads the lead's parents (the car
// and the salesperson) even where the handler does not look at them.
import { defineCommand, literal, refuse, shape, text } from '@mistriwork/mistri/commands';

import { aprFor, cents, day, grid, known, nextReference, num, outsideProgram, payment, stamp, work } from './dealMath.ts';
import { keystone } from './source.ts';

const key = text({ max: 200 });

/** The dealer's person behind a signed-in account, for "who did it". */
type People = { find(where: { account_id: string }): Promise<{ id: string; role: string } | undefined> };
export const whoIs = async (people: People, actor: { id: string }) => (await people.find({ account_id: actor.id })) ?? null;

/** Sales tax by the state the customer registers the car in, when the dealer has no deal yet to copy its rate from. */
const TAX: Record<string, number> = { PA: 6, OH: 5.75, NJ: 6.625, MD: 6, NY: 8 };

const LOST = {
  bought_elsewhere: 'bought elsewhere',
  no_response: 'stopped responding',
  credit: 'credit',
  price: 'price',
  other: 'other',
} as const;

const logged = shape({ leadId: key, message: literal('Contact logged.') });
const taken = shape({ applicantId: key, message: literal('Application taken.') });
const started = shape({ dealId: key, reference: text({ max: 20 }), message: literal('Deal started.') });
const lost = shape({ leadId: key, message: literal('Lead marked lost.') });
const walkedIn = shape({ leadId: key, reference: text({ max: 20 }), message: literal('Walk-in recorded.') });

export const leadCommands = {
  /* A touch on the lead: the timeline gets it, a new lead becomes contacted,
     and the next follow-up is what was just agreed (none clears it). */
  logContact: defineCommand({
    target: 'lead',
    input: logContactInput,
    source: keystone,
    read: ['vehicle', 'dealer_user'],
    write: ['lead_activity'],
    when: 'status in (new, contacted, desking, submitted)',
    output: logged,
    async handle({ db, record: lead, actor, now }, input) {
      const me = await whoIs(db.dealer_user, actor);
      const at = stamp(now());
      await db.lead_activity.insert({ lead_id: lead.id, kind: input.kind, body: input.body, author_id: me?.id ?? null, created_at: at });
      await db.lead.update(lead, {
        status: lead.status === 'new' ? 'contacted' : lead.status,
        last_contact_at: input.kind === 'note' ? lead.last_contact_at : at,
        next_follow_up_on: input.next_follow_up_on ?? null,
        salesperson_id: lead.salesperson_id ?? me?.id ?? null,
      });
      return { leadId: lead.id, message: 'Contact logged.' as const };
    },
  }),

  /* The credit application, as the customer tells it at the desk. One
     primary and at most one co-applicant a lead, as the schema holds them. */
  takeApplication: defineCommand({
    target: 'lead',
    input: takeApplicationInput,
    source: keystone,
    read: ['vehicle', 'dealer_user'],
    write: ['applicant', 'lead_activity'],
    when: 'status in (new, contacted, desking)',
    output: taken,
    initial: ({ record: lead }) => ({
      role: 'primary',
      person: known({
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
      }),
    }),
    async handle({ db, record: lead, actor, now }, input) {
      if (await db.applicant.find({ lead_id: lead.id, role: input.role })) {
        refuse(input.role === 'primary' ? "This lead already has its customer's application." : 'This lead already has a co-applicant.');
      }
      const at = stamp(now());
      const applicant = await db.applicant.insert({
        lead_id: lead.id,
        role: input.role,
        ...input.person,
        ...input.home,
        monthly_housing: cents(input.home.monthly_housing),
        years_at_address: input.home.years_at_address.toFixed(1),
        employment_type: input.work.employment_type,
        employer: input.work.employer ?? null,
        job_title: input.work.job_title ?? null,
        years_employed: input.work.years_employed.toFixed(1),
        monthly_income: cents(input.work.monthly_income),
        created_at: at,
      });
      const me = await whoIs(db.dealer_user, actor);
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: 'note',
        author_id: me?.id ?? null,
        created_at: at,
        body:
          input.role === 'primary'
            ? 'Took the credit application.'
            : `Took ${input.person.first_name} ${input.person.last_name}'s application as co-applicant.`,
      });
      return { applicantId: applicant.id, message: 'Application taken.' as const };
    },
  }),

  /* The deal on the desk, from the car and the program: the price is the
     sticker, the fees the dealer's usual, the tax the dealer's own rate, and
     the grid's three structures are worked out at once. The lead moves to
     desking. Only a car that is for sale, and a structure the program lends. */
  startDeal: defineCommand({
    target: 'lead',
    input: startDealInput,
    source: keystone,
    read: ['vehicle', 'dealer_user', 'applicant', 'program'],
    write: ['deal', 'deal_scenario', 'lead_activity'],
    when: 'status in (new, contacted, desking)',
    output: started,
    initial: ({ record: lead }) => known({ vehicle: lead.vehicle_id ?? undefined, term_months: 72 as const, cash_down: 0 }),
    async handle({ db, record: lead, actor, now }, input) {
      const applicant = await db.applicant.find({ lead_id: lead.id, role: 'primary' });
      if (!applicant) refuse("Take the customer's credit application first: a deal is desked for its applicant.");
      const co = await db.applicant.find({ lead_id: lead.id, role: 'co_applicant' });
      const vehicle = await db.vehicle.get(input.vehicle);
      if (vehicle.status !== 'listed' && vehicle.status !== 'in_stock')
        refuse(`Stock ${vehicle.stock_number} is ${vehicle.status.replace('_', ' ')}, not for sale.`);
      const program = await db.program.get(input.program);
      if (!program.active) refuse(`${program.name} is closed to new deals.`);
      // The dealer's own rate, as its latest deal has it; else the state's.
      const last = await db.deal.where({}).orderBy('created_on', 'desc').first();
      const taxRate = last ? num(last.tax_rate) : (TAX[applicant.state] ?? 6);
      const figures = {
        sale_price: num(vehicle.list_price),
        rebate: 0,
        doc_fee: 449,
        title_fees: 245,
        tax_rate: taxRate,
        trade_allowance: 0,
        trade_payoff: 0,
        service_contract: 0,
        gap: 0,
        cash_down: input.cash_down,
      };
      const { sales_tax, amount_financed } = work(figures);
      const term = input.term_months;
      const why = outsideProgram(program, amount_financed, term, vehicle, now());
      if (why) refuse(why);
      const apr = aprFor(program, term);
      const me = await whoIs(db.dealer_user, actor);
      const reference = nextReference('DL', await db.deal.where({}).limit(5000));
      const at = now();
      const deal = await db.deal.insert({
        reference,
        lead_id: lead.id,
        applicant_id: applicant.id,
        co_applicant_id: co?.id ?? null,
        vehicle_id: vehicle.id,
        salesperson_id: lead.salesperson_id ?? me?.id ?? null,
        finance_manager_id: me?.role === 'finance_manager' ? me.id : null,
        program_id: program.id,
        status: 'structuring',
        sale_price: cents(figures.sale_price),
        rebate: '0.00',
        doc_fee: cents(figures.doc_fee),
        title_fees: cents(figures.title_fees),
        tax_rate: taxRate.toFixed(3),
        sales_tax: cents(sales_tax),
        trade_allowance: '0.00',
        trade_payoff: '0.00',
        service_contract: '0.00',
        gap: '0.00',
        cash_down: cents(figures.cash_down),
        amount_financed: cents(amount_financed),
        term_months: term,
        apr: apr.toFixed(3),
        monthly_payment: cents(payment(amount_financed, apr, term)),
        created_on: day(at),
        updated_at: stamp(at),
        version: 0,
      });
      for (const row of grid(program, amount_financed, term, figures.cash_down)) {
        await db.deal_scenario.insert({
          deal_id: deal.id,
          label: row.label,
          term_months: row.term_months,
          apr: row.apr.toFixed(3),
          cash_down: cents(row.cash_down),
          amount_financed: cents(row.amount_financed),
          monthly_payment: cents(row.monthly_payment),
          selected: row.label === 'A',
        });
      }
      await db.lead.update(lead, { status: 'desking', vehicle_id: vehicle.id, salesperson_id: lead.salesperson_id ?? me?.id ?? null });
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: 'status',
        author_id: me?.id ?? null,
        created_at: stamp(at),
        body: `Started ${reference} on the ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
      });
      return { dealId: deal.id, reference, message: 'Deal started.' as const };
    },
  }),

  /* Not going ahead, with the reason the dealer keeps. A deal still on the
     desk for it is cancelled with it; one with Keystone is withdrawn from the
     application instead, where Keystone reads why. */
  markLeadLost: defineCommand({
    target: 'lead',
    input: markLeadLostInput,
    source: keystone,
    read: ['vehicle', 'dealer_user', 'applicant', 'program'],
    write: ['deal', 'lead_activity'],
    when: 'status in (new, contacted, desking)',
    output: lost,
    async handle({ db, record: lead, actor, now }, input) {
      for (const deal of await db.deal.where({ lead_id: lead.id, status: 'structuring' })) {
        await db.deal.update(deal, { status: 'cancelled', updated_at: stamp(now()) });
      }
      await db.lead.update(lead, { status: 'lost', lost_reason: input.reason, next_follow_up_on: null });
      const me = await whoIs(db.dealer_user, actor);
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: 'status',
        author_id: me?.id ?? null,
        created_at: stamp(now()),
        body: `Marked lost: ${LOST[input.reason as keyof typeof LOST]}.${input.note ? ` ${input.note}` : ''}`,
      });
      return { leadId: lead.id, message: 'Lead marked lost.' as const };
    },
  }),

  /* A customer on the floor about this car: a new lead, the salesperson who
     recorded it as its owner, and the visit as its first touch. */
  recordWalkIn: defineCommand({
    target: 'vehicle',
    input: recordWalkInInput,
    source: keystone,
    read: ['dealer_user'],
    write: ['lead', 'lead_activity'],
    when: 'status in (listed, in_stock, pending)',
    output: walkedIn,
    async handle({ db, record: vehicle, actor, now }, input) {
      const me = await whoIs(db.dealer_user, actor);
      const reference = nextReference('LD', await db.lead.where({}).limit(5000));
      const at = stamp(now());
      const lead = await db.lead.insert({
        reference,
        source: input.source,
        status: 'contacted',
        first_name: input.first_name,
        last_name: input.last_name,
        email: input.email ?? null,
        phone: input.phone,
        vehicle_id: vehicle.id,
        salesperson_id: me?.id ?? null,
        message: input.message ?? null,
        marketplace_account_id: null,
        created_at: at,
        last_contact_at: at,
        next_follow_up_on: null,
        lost_reason: null,
        version: 0,
      });
      await db.lead_activity.insert({
        lead_id: lead.id,
        kind: input.source === 'phone' ? 'call' : 'visit',
        author_id: me?.id ?? null,
        created_at: at,
        body: `${input.source === 'phone' ? 'Called' : 'Came in'} about the ${vehicle.year} ${vehicle.make} ${vehicle.model}, stock ${vehicle.stock_number}.`,
      });
      return { leadId: lead.id, reference, message: 'Walk-in recorded.' as const };
    },
  }),
};
