import { applyForFinancingInput, askAboutVehicleInput, requestTestDriveInput } from './server/inputs.ts';
// The website's three forms, as the server runs them. Loaded with --commands,
// never imported from the App graph.
//
// Each is public: it runs under a public principal, holds nothing scarce, and
// writes a `new` lead the dealer answers in /leads (SUITE.md cross-App flows 1
// and 2), with the first line of its timeline. Only the enrolled placement
// binder supplies its destination. Stock selects a car within that destination;
// neither input nor a car's ownership can choose a different dealer.
import {
  defineCommand,
  defineCommands,
  literal,
  publicReference,
  publicReferencePattern,
  refuse,
  shape,
  text,
  type BusinessCommandContext,
  type CommandDb,
} from '@mistriwork/mistri/commands';
import { keystone } from './source.ts';

const receipt = { reference: text({ pattern: publicReferencePattern('LD') }) };

// A lead's moment is a UTC timestamp without a zone (SUITE.md, conventions).
const stamp = (now: Date) => now.toISOString().slice(0, 19).replace('T', ' ');
const dollars = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const WHEN = { morning: 'in the morning', afternoon: 'in the afternoon', evening: 'in the evening' } as const;

/* A missing placement cannot fall back to ordinary/fixed public intake.
   Dealer PKs are text in schema.sql: use the trusted key exactly, never coerce
   it or derive it from a stock prefix. Eligibility is locked by the binder. */
async function place(
  db: CommandDb<typeof keystone, 'dealer' | 'vehicle'>,
  placement: BusinessCommandContext['placement'],
  stock: string | null | undefined,
) {
  if (!placement || typeof placement.tenantId !== 'string' || !placement.tenantId) refuse('forbidden');
  const dealer = await db.dealer.find({ id: placement.tenantId });
  if (!dealer || dealer.id !== placement.tenantId) refuse('forbidden');
  const car = stock ? await db.vehicle.find({ dealer_id: dealer.id, stock_number: stock }) : null;
  // Unknown and another dealer's stock receive the same field refusal.
  if (stock && (!car || car.dealer_id !== dealer.id)) refuse('invalid_input', 'stock_number');
  return {
    dealer_id: dealer.id,
    vehicle_id: car?.id ?? null,
    named: car ? `the ${car.year} ${car.make} ${car.model} ${car.trim} (${stock})` : null,
  };
}

const askAboutVehicle = defineCommand({
  input: askAboutVehicleInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: ['dealer', 'vehicle'],
  write: ['lead', 'lead_activity'],
  output: shape({ ...receipt, message: literal('Question received.') }),
  async handle({ db, now, placement }, input) {
    const { dealer_id, vehicle_id, named } = await place(db, placement, input.stock_number);
    const reference = publicReference('LD');
    const lead = await db.lead.insert({
      dealer_id,
      reference,
      source: 'website',
      status: 'new',
      vehicle_id,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone ?? null,
      message: input.message,
      created_at: stamp(now()),
    });
    await db.lead_activity.insert({
      dealer_id,
      lead_id: lead.id,
      kind: 'note',
      created_at: stamp(now()),
      body: named ? `Asked about ${named} on the website.` : 'Sent a question from the website.',
    });
    return { reference, message: 'Question received.' as const };
  },
});

const requestTestDrive = defineCommand({
  input: requestTestDriveInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: ['dealer', 'vehicle'],
  write: ['lead', 'lead_activity'],
  output: shape({ ...receipt, message: literal('Test drive requested.') }),
  async handle({ db, now, placement }, input) {
    const { dealer_id, vehicle_id, named } = await place(db, placement, input.stock_number);
    const reference = publicReference('LD');
    const day = new Date(`${input.preferred_on}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const when = `${day} ${WHEN[input.time_of_day]}`;
    const lead = await db.lead.insert({
      dealer_id,
      reference,
      source: 'website',
      status: 'new',
      vehicle_id,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      message: [`Test drive requested for ${when}.`, input.message].filter(Boolean).join('\n\n'),
      next_follow_up_on: input.preferred_on,
      created_at: stamp(now()),
    });
    await db.lead_activity.insert({
      dealer_id,
      lead_id: lead.id,
      kind: 'test_drive',
      created_at: stamp(now()),
      body: `Asked to drive ${named ?? 'a car'} on ${when}. Confirm the time.`,
    });
    return { reference, message: 'Test drive requested.' as const };
  },
});

/* The application is the lead and its primary applicant, in one
   transaction; the dealer's finance manager structures the deal and submits
   it to Keystone from /leads. A co-applicant is added there too: the short
   form here is the one a person fills in alone on a phone. */
const applyForFinancing = defineCommand({
  input: applyForFinancingInput,
  targets: 'none',
  source: keystone,
  target: 'lead',
  public: true,
  read: ['dealer', 'vehicle'],
  write: ['lead', 'applicant', 'lead_activity'],
  // Nothing typed here is kept in the command journal's audit, only which columns were written.
  audit: { redact: 'values' },
  output: shape({ ...receipt, message: literal('Application received.') }),
  async handle({ db, now, placement }, input) {
    const { dealer_id, vehicle_id, named } = await place(db, placement, input.stock_number);
    if (!input.consent) refuse('Confirm that your details are true and you consent to sending this application.');
    const reference = publicReference('LD');
    const down = input.down_payment != null ? `${dollars(input.down_payment)} down` : 'down payment not decided';
    const lead = await db.lead.insert({
      dealer_id,
      reference,
      source: 'website',
      status: 'new',
      vehicle_id,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      message: `Applied for financing on the website${named ? ` for ${named}` : ', before choosing a car'}; ${down}.`,
      created_at: stamp(now()),
    });
    await db.applicant.insert({
      dealer_id,
      lead_id: lead.id,
      role: 'primary',
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      date_of_birth: input.date_of_birth,
      ssn_last4: input.ssn_last4,
      street: input.street,
      city: input.city,
      state: input.state,
      zip: input.zip,
      housing: input.housing,
      monthly_housing: input.monthly_housing.toFixed(2),
      years_at_address: input.years_at_address.toFixed(1),
      employer: input.employer ?? null,
      job_title: input.job_title ?? null,
      employment_type: input.employment_type,
      years_employed: input.years_employed.toFixed(1),
      monthly_income: input.monthly_income.toFixed(2),
      created_at: stamp(now()),
    });
    await db.lead_activity.insert({
      dealer_id,
      lead_id: lead.id,
      kind: 'note',
      created_at: stamp(now()),
      body: `Credit application from the website; ${down}. Start a deal to submit it to Keystone.`,
    });
    return { reference, message: 'Application received.' as const };
  },
});

export default defineCommands({ askAboutVehicle, requestTestDrive, applyForFinancing });
