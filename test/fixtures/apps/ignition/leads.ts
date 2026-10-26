// The dealership's own verbs: qualify a lead, disqualify it, convert it into an
// application, and withdraw that application. Server-only, registered through
// the explicit --commands entry (commands.ts) and never imported from the App
// graph.
//
// All four are **tenant-realm** commands, which is the whole point of the
// reshape: each runs inside one dealership, and the runtime composes that
// dealership's ownership predicate outside anything written here. So
// `db.vehicle.find({ stock_reference })` below cannot match another dealer's
// stock however the stock numbers collide — and three dealers hold the same
// `DEMO-STOCK-1001` on purpose. Ownership is injected on insert, never supplied.
//
// The gate: a lead is `new` when a public submission places it, `qualified` by
// a dealer admin, and only then `converted`. The lead's machine
// (features/dealer-workspace.ts) says which state each command runs from, and
// the platform reads the lead inside the command transaction at the revision
// the form saw, refusing one in any other status before the handler runs; the
// same graph draws the buttons, and the lead table's CHECKs hold the gate
// underneath.
import { date, defineCommand, field, int, list, literal, oneOf, refuse, shape, text } from '@mistriwork/mistri/commands';
import { applicationSubmitted } from './events.ts';
import { lending } from './lending.ts';

const DAY = 86_400_000;
const isoDate = (day: Date) => day.toISOString().slice(0, 10);
const key = text({ max: 200 });

export const qualifyOutput = oneOf(
  shape({ leadId: key, version: int({ min: 1 }), message: literal('Lead qualified.') }),
  shape({
    leadIds: list(key, { min: 2, max: 200 }),
    versions: list(int({ min: 1 }), { min: 2, max: 200 }),
    message: literal('Leads qualified.'),
  }),
);
export const disqualifyOutput = shape({ leadId: key, version: int({ min: 1 }), message: literal('Lead disqualified.') });
export const convertOutput = shape({
  leadId: key,
  applicationId: key,
  reference: text({ max: 100 }),
  version: int({ min: 1 }),
  reviewDueOn: date(),
  message: literal('Lead converted.'),
});
export const withdrawOutput = shape({ applicationId: key, version: int({ min: 1 }), message: literal('Application withdrawn.') });

export const leadCommands = {
  /* A dealer admin confirms a real customer and a real deal: `new` to
     `qualified`, recording who and when. The author is the verified account
     id — membership is not a business table here, so the lead records the
     identity rather than a key into one. Several at once from the New leads
     queue, all or none. */
  qualifyLead: defineCommand({
    source: lending,
    target: 'lead',
    targets: 'many',
    output: qualifyOutput,
    async handle({ db, records, actor, now }) {
      const qualified = [];
      for (const lead of records) {
        qualified.push(await db.lead.update(lead, { status: 'qualified', qualified_by: actor.id, qualified_on: isoDate(now()) }));
      }
      return qualified.length === 1
        ? { leadId: String(qualified[0].id), version: Number(qualified[0].version), message: 'Lead qualified.' }
        : {
            leadIds: qualified.map((lead) => String(lead.id)),
            versions: qualified.map((lead) => Number(lead.version)),
            message: 'Leads qualified.',
          };
    },
  }),

  /* Not going ahead, from `new` or `qualified`, with the reason the dealership
     keeps. A converted lead is an application now and is not disqualified here. */
  disqualifyLead: defineCommand({
    source: lending,
    target: 'lead',
    input: { reason: field.textarea({ max: 500, help: 'Kept on the lead for the dealership. Nothing is sent to the applicant.' }) },
    output: disqualifyOutput,
    async handle({ db, record: lead }, { reason }) {
      const { version } = await db.lead.update(lead, { status: 'disqualified', disqualified_reason: reason });
      return disqualifyOutput.parse({ leadId: String(lead.id), version: Number(version), message: 'Lead disqualified.' });
    },
  }),

  /* Only from `qualified`. The stock number the applicant typed is matched
     against this dealership's own inventory — inside the tenant, so there is
     no enumeration to worry about and no other dealer's vehicle to find. It
     reserves nothing (a vehicle stays `available`): two dealerships may work
     the same model and nothing scarce is held by a lead.

     The application is created `submitted`, the lead records that it converted,
     and the fact `application.submitted` is recorded, all in one transaction.
     The lender's review file does not exist yet: creating it is the platform's
     own step (assignReviewer), because a dealer's command cannot insert one of
     the lender's rows. So the deadline the clock starts on travels in the fact
     rather than on either row. */
  convertLead: defineCommand({
    source: lending,
    target: 'lead',
    read: ['vehicle'],
    write: ['loan_application'],
    output: convertOutput,
    events: {
      submitted: applicationSubmitted,
    },
    async handle({ db, record: lead, now }) {
      /* A lead out of its draft holds every one of these (the schema's CHECK);
         said again here, where the application is made from them. */
      const { reference, vehicle_stock: stock, requested_amount: amount, down_payment: down, term_months: term } = lead;
      if (reference === null || stock === null || amount === null || down === null || term === null) return refuse('ineligible_state');
      const vehicle = await db.vehicle.find({ stock_reference: stock });
      // Fix it with the applicant, or disqualify the lead: a stock number this
      // dealership does not hold is not a lead anyone can convert.
      if (!vehicle) refuse('ineligible_state');
      if (await db.loan_application.count({ vehicle_id: vehicle.id })) refuse('duplicate_record');
      const reviewDueOn = isoDate(new Date(now().getTime() + 7 * DAY));
      const application = await db.loan_application.insert({
        // Tenant-local: `L-2001` becomes `AL-2001` in this dealership, and the
        // same pair exists in every other one.
        reference: `AL-${reference.replace(/^L-/, '')}`,
        lead_id: lead.id,
        vehicle_id: vehicle.id,
        applicant_ref: reference,
        status: 'submitted',
        requested_amount: amount,
        down_payment: down,
        term_months: term,
        submitted_on: isoDate(now()),
        document_status: 'not_started',
        withdrawn_reason: null,
        version: 0,
      });
      const { version } = await db.lead.update(lead, { status: 'converted' });
      return convertOutput.parse({
        leadId: String(lead.id),
        applicationId: String(application.id),
        reference: String(application.reference),
        version: Number(version),
        reviewDueOn,
        message: 'Lead converted.',
      });
    },
  }),

  /* The dealership withdraws its own application before a decision. The
     revision guard makes the race against the lender's commands an honest
     one: whichever commits first, the other is refused as stale rather than
     quietly overwriting it. */
  withdrawApplication: defineCommand({
    source: lending,
    target: 'loan_application',
    input: { reason: field.textarea({ max: 500, label: 'Why it is being withdrawn', help: 'Kept on the application for both sides.' }) },
    /* `vehicle` and `lead` are read because they are `loan_application`'s
       foreign-key parents, not because this handler looks at either. A write
       is checked against every parent of the row it changes, and that check
       runs inside the command's own scope — so a parent the command has not
       declared cannot be seen, and the write is refused with no field and no
       table named. Declaring the footprint is what makes the write legal. */
    read: ['vehicle', 'lead'],
    write: ['loan_application'],
    output: withdrawOutput,
    async handle({ db, record: application }, { reason }) {
      const { version } = await db.loan_application.update(application, { status: 'withdrawn', withdrawn_reason: reason });
      return withdrawOutput.parse({ applicationId: String(application.id), version: Number(version), message: 'Application withdrawn.' });
    },
  }),
};
