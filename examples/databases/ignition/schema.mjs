/**
 * Ignition's two PostgreSQL databases, as DDL and as deterministic rows.
 *
 * The lending database is the App's own source, and a tenant App's database
 * holds nothing else: every visible table is a declared resource or a reserved
 * `__mistri_*` table, or startup refuses the source (docs/tenant-apps.md,
 * "A database of its own"). That is why there is no migration marker here —
 * the 0.4 sample's markers would each be an undeclared table — and why
 * reseeding, not migration, is how this sample moves forward.
 *
 * Ownership decides the shape, not taste:
 *
 * - A tenant-owned row carries `tenant_id text NOT NULL`, the ownership
 *   column the runtime injects and never lets a caller write. PostgreSQL
 *   admits `text` and `varchar` for it and nothing else: `character(n)`
 *   ignores trailing spaces and `citext` folds case, so neither can capture
 *   ownership.
 * - A tenant row may reference a platform row only as the tenancy profile,
 *   through that same ownership column. So `dealer.id` *is* the tenant id,
 *   and the lender's own columns cannot sit on a dealer's application: they
 *   are split out into the platform-owned `review_file` (one per
 *   application). That split is the schema paying for the realm boundary.
 * - A tenant → tenant key is composite, `(tenant_id, x_id) → x(tenant_id,
 *   id)`, so a key can never point out of its own tenant. Each such target
 *   carries `UNIQUE (tenant_id, id)` for the composite key to land on.
 * - Every unique index on a tenant-owned table includes `tenant_id`, except
 *   the primary key, which is one opaque text id. That is what lets three
 *   dealers each hold `L-0001` and `AL-1001`.
 * - A global row references globals only, so `vehicle_model` is a leaf.
 *
 * Keys are opaque text (`north-motors:lead:0001`), not integers: the tenant
 * writer's uniqueness rule exempts a single opaque text primary key, and
 * equal business references across dealers are the point of the fixture.
 */

/* ---------- the lending database: the App's own source ---------- */

/** Platform-owned: the lender's own tables, read across every dealer. */
const PLATFORM = `
CREATE TABLE public.dealer (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  region text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('franchise', 'independent')),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  -- The public intake address: 128 bits the dealer publishes on its own form
  -- link and only the server resolves. A routing address, never a credential.
  intake_address text UNIQUE,
  joined_on date NOT NULL,
  -- The dealership's profile as the lender keeps it: its color on the lender's
  -- boards, the hour its finance desk opens, how far it is to this year's
  -- volume target (0-100), its DMS connection settings as a JSON document, and
  -- the month its agreement renews ('YYYY-MM').
  brand_color text CHECK (brand_color ~ '^#[0-9a-f]{6}$'),
  opens_at time,
  target_attainment integer CHECK (target_attainment BETWEEN 0 AND 100),
  dms_settings text,
  renewal_month text CHECK (renewal_month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- The revision rotateIntakeAddress guards, so two administrators rotating the
  -- same dealership's address at once cannot silently overwrite each other.
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE public.review_desk (
  id text PRIMARY KEY,
  name text NOT NULL,
  coverage text NOT NULL
);
CREATE TABLE public.lender_staff (
  id text PRIMARY KEY,
  desk_id text REFERENCES public.review_desk(id),
  -- The native account this staff row belongs to. A platform command resolves
  -- its author through this column, which is why no IGNITION_STAFF_MAP file
  -- exists any more: the mapping is data the lender owns, not a private file.
  account_id text UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('platform_admin', 'manager', 'reviewer')),
  active boolean NOT NULL
);
-- One per application, holding exactly what the lender knows and the dealer
-- must not: the desk, the reviewer, the manager, the clock and the notes.
CREATE TABLE public.review_file (
  -- A command inserts this row without naming a key, and nothing in the write
  -- path invents one: a required column needs an authored input or a real
  -- database default, and a generated key is the latter. Every table a command
  -- inserts into carries this.
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  application_id text NOT NULL UNIQUE REFERENCES public.loan_application(id),
  dealer_id text NOT NULL REFERENCES public.dealer(id),
  desk_id text NOT NULL REFERENCES public.review_desk(id),
  reviewer_id text REFERENCES public.lender_staff(id),
  manager_id text REFERENCES public.lender_staff(id),
  review_due_on date NOT NULL,
  review_context text NOT NULL,
  opened_on date NOT NULL
);
CREATE TABLE public.application_review (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  application_id text NOT NULL REFERENCES public.loan_application(id),
  reviewer_id text NOT NULL REFERENCES public.lender_staff(id),
  kind text NOT NULL CHECK (kind IN ('initial', 'manager')),
  status text NOT NULL CHECK (status IN ('queued', 'in_progress', 'complete', 'canceled')),
  opened_on date NOT NULL,
  completed_on date,
  summary text NOT NULL,
  CHECK (completed_on IS NULL OR completed_on >= opened_on)
);
CREATE TABLE public.loan_decision (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  application_id text NOT NULL UNIQUE REFERENCES public.loan_application(id),
  decided_by text NOT NULL REFERENCES public.lender_staff(id),
  outcome text NOT NULL CHECK (outcome IN ('approved', 'declined')),
  recorded_on date NOT NULL,
  record_note text NOT NULL
);
CREATE TABLE public.assignment_history (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  application_id text NOT NULL REFERENCES public.loan_application(id),
  assigned_to text NOT NULL REFERENCES public.lender_staff(id),
  assigned_by text NOT NULL REFERENCES public.lender_staff(id),
  assigned_on timestamptz NOT NULL,
  reason text NOT NULL
);
-- One alert per application whose review date passed undecided. Its own table,
-- so the review clock never bumps an application's version under an open form.
CREATE TABLE public.review_alert (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  application_id text NOT NULL UNIQUE REFERENCES public.loan_application(id),
  due_on date NOT NULL,
  raised_on date NOT NULL,
  CHECK (raised_on > due_on)
);
-- A public submission no intake address placed: the lender's own triage queue.
-- The platform never inserts a dealer's row, so a triaged submission is closed
-- or noted here and followed up with the applicant on the dealer's own link.
--
-- The financing form is saved on every step, so a submission starts here as a
-- 'draft' the moment its first step is saved, whichever place it landed in.
-- What later steps fill is empty until they do, and the CHECK at the end says
-- that a submission out of its draft has everything.
CREATE TABLE public.intake_submission (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- The applicant's receipt, given on submit: a draft has none yet.
  reference text UNIQUE,
  applicant_name text NOT NULL,
  applicant_email text NOT NULL,
  applicant_phone text,
  address_line text,
  city text,
  state text,
  postal_code text,
  employer text,
  annual_income numeric(12, 2) CHECK (annual_income >= 0),
  dealer_hint text,
  vehicle_stock text,
  requested_amount numeric(12, 2) CHECK (requested_amount > 0),
  down_payment numeric(12, 2) CHECK (down_payment >= 0),
  term_months integer CHECK (term_months IN (36, 48, 60)),
  submitted_on date,
  status text NOT NULL CHECK (status IN ('draft', 'triage', 'closed')),
  outcome_note text,
  -- The saved form's place, which the server keeps and no handler writes: the
  -- hash of the applicant's token (never the token), when the draft expires,
  -- and which steps are saved. The token's hash is cleared on submit.
  resume_token_hash text,
  resume_expires_at timestamptz,
  resume_progress text,
  -- The revision closeIntakeSubmission guards.
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK (status = 'draft' OR (reference IS NOT NULL AND requested_amount IS NOT NULL
    AND term_months IS NOT NULL AND submitted_on IS NOT NULL))
);
-- Up to two co-applicants on a triaged submission, by their place in it.
CREATE TABLE public.intake_co_applicant (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  submission_id text NOT NULL REFERENCES public.intake_submission(id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 2),
  name text NOT NULL,
  email text NOT NULL,
  UNIQUE (submission_id, position)
);
`;

/** Global: shared reference data every dealer reads and none owns. */
const GLOBAL = `
CREATE TABLE public.vehicle_model (
  id text PRIMARY KEY,
  make text NOT NULL,
  model text NOT NULL,
  model_year integer NOT NULL
);
`;

/** Tenant-owned: one dealer's own rows, by the ownership column `tenant_id`. */
const TENANT = `
CREATE TABLE public.vehicle (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.dealer(id),
  stock_reference text NOT NULL,
  model_id text NOT NULL REFERENCES public.vehicle_model(id),
  condition text NOT NULL CHECK (condition IN ('new', 'used')),
  mileage integer NOT NULL CHECK (mileage >= 0),
  price numeric(12, 2) NOT NULL CHECK (price > 0),
  status text NOT NULL CHECK (status IN ('available', 'financed', 'sold')),
  -- Tenant-local: two dealers may both hold DEMO-STOCK-1049.
  UNIQUE (tenant_id, stock_reference),
  -- What a composite tenant key lands on.
  UNIQUE (tenant_id, id)
);
-- The public financing form is saved on every step: a lead is a 'draft' from
-- its first step, in the dealership its intake address named, and becomes
-- 'new' on submit. What a later step fills is empty until it does; the last
-- CHECK says that a lead out of its draft has everything the gate reads.
CREATE TABLE public.lead (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL REFERENCES public.dealer(id),
  -- The applicant's receipt, given on submit: a draft has none yet.
  reference text,
  applicant_name text NOT NULL,
  applicant_email text NOT NULL,
  applicant_phone text,
  address_line text,
  city text,
  state text,
  postal_code text,
  employer text,
  annual_income numeric(12, 2) CHECK (annual_income >= 0),
  vehicle_stock text,
  requested_amount numeric(12, 2) CHECK (requested_amount > 0),
  down_payment numeric(12, 2) CHECK (down_payment >= 0),
  term_months integer CHECK (term_months IN (36, 48, 60)),
  submitted_on date,
  status text NOT NULL CHECK (status IN ('draft', 'new', 'qualified', 'converted', 'disqualified')),
  -- The saved form's place, which the server keeps and no handler writes: the
  -- hash of the applicant's token bound to this dealership (never the token),
  -- when the draft expires, and which steps are saved. Cleared on submit.
  resume_token_hash text,
  resume_expires_at timestamptz,
  resume_progress text,
  -- The dealer member who qualified it, by native account id. Membership is
  -- not a business table, so this is a recorded identity and not a key.
  qualified_by text,
  qualified_on date,
  disqualified_reason text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, id),
  CHECK (status NOT IN ('qualified', 'converted') OR (qualified_by IS NOT NULL AND qualified_on IS NOT NULL)),
  CHECK ((status = 'disqualified') = (disqualified_reason IS NOT NULL)),
  CHECK (status = 'draft' OR (reference IS NOT NULL AND vehicle_stock IS NOT NULL AND requested_amount IS NOT NULL
    AND down_payment IS NOT NULL AND term_months IS NOT NULL AND submitted_on IS NOT NULL))
);
-- Up to two co-applicants on a lead, by their place in it, inside the lead's
-- own dealership: the composite key cannot point out of it, and the single one
-- is what the lead page's related list walks (see loan_application below).
CREATE TABLE public.lead_co_applicant (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL REFERENCES public.dealer(id),
  lead_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 2),
  name text NOT NULL,
  email text NOT NULL,
  UNIQUE (tenant_id, lead_id, position),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES public.lead(tenant_id, id),
  FOREIGN KEY (lead_id) REFERENCES public.lead(id)
);
CREATE TABLE public.loan_application (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL REFERENCES public.dealer(id),
  reference text NOT NULL,
  lead_id text,
  vehicle_id text NOT NULL,
  applicant_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'documents_pending', 'in_review',
    'manager_review', 'approved', 'declined', 'withdrawn')),
  requested_amount numeric(12, 2) NOT NULL CHECK (requested_amount > 0),
  down_payment numeric(12, 2) NOT NULL CHECK (down_payment >= 0),
  term_months integer NOT NULL CHECK (term_months IN (36, 48, 60)),
  submitted_on date NOT NULL,
  document_status text NOT NULL CHECK (document_status IN ('not_started', 'incomplete', 'complete')),
  -- Why the dealership withdrew it, kept where both sides read it. One
  -- direction only: a reason belongs to a withdrawn application, but the
  -- seeded snapshot's withdrawn rows predate the command that asks for one.
  withdrawn_reason text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK (withdrawn_reason IS NULL OR status = 'withdrawn'),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, id),
  -- Composite, so neither key can ever point out of this dealer.
  FOREIGN KEY (tenant_id, lead_id) REFERENCES public.lead(tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES public.vehicle(tenant_id, id),
  -- And the same keys again as single columns. The composite pair above is what
  -- keeps a key inside its tenant; these are what a related list walks, because
  -- a section's "whose" takes one foreign key to the complete primary key, and a
  -- composite key to a (tenant_id, id) unique is not that. Both hold at once, so
  -- the isolation is not weakened by making the App's own pages resolvable.
  FOREIGN KEY (lead_id) REFERENCES public.lead(id),
  FOREIGN KEY (vehicle_id) REFERENCES public.vehicle(id)
);
CREATE TABLE public.application_document (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.dealer(id),
  application_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('identity', 'income', 'vehicle')),
  status text NOT NULL CHECK (status IN ('requested', 'received', 'reviewed', 'needs_revision')),
  received_on date,
  notes text NOT NULL,
  UNIQUE (tenant_id, application_id, category),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.loan_application(tenant_id, id),
  -- The single-column key its related list walks; see loan_application above.
  FOREIGN KEY (application_id) REFERENCES public.loan_application(id)
);
`;

/* `review_file` references `loan_application`, which the tenant block creates,
   so the platform's own tables are made in two passes rather than reordering
   the readable blocks above. */
const PLATFORM_FIRST = PLATFORM.slice(0, PLATFORM.indexOf('CREATE TABLE public.review_file'));
const PLATFORM_REST = PLATFORM.slice(PLATFORM.indexOf('CREATE TABLE public.review_file'));

/** The lending database's whole schema, in dependency order. */
export const LENDING_SCHEMA = `${PLATFORM_FIRST}${GLOBAL}${TENANT}${PLATFORM_REST}`;

/** Indexes the App's own screens read by. Never on a reserved table. */
export const LENDING_INDEXES = `
CREATE INDEX lead_tenant_status ON public.lead (tenant_id, status);
CREATE INDEX application_tenant_status ON public.loan_application (tenant_id, status);
CREATE INDEX vehicle_tenant_status ON public.vehicle (tenant_id, status);
CREATE INDEX document_application ON public.application_document (tenant_id, application_id);
CREATE INDEX review_file_desk ON public.review_file (desk_id, review_due_on);
CREATE INDEX review_file_reviewer ON public.review_file (reviewer_id);
CREATE INDEX review_alert_due ON public.review_alert (due_on);
CREATE INDEX intake_submission_status ON public.intake_submission (status, submitted_on);
CREATE INDEX lead_co_applicant_lead ON public.lead_co_applicant (lead_id);
CREATE INDEX intake_co_applicant_submission ON public.intake_co_applicant (submission_id);
-- The keys a record page's related lists find their rows by, each leading its
-- own index (check's warnings name them): an application's lead and vehicle, a
-- document's application, and the lender's reviews, decisions, files and staff.
CREATE INDEX application_lead ON public.loan_application (lead_id);
CREATE INDEX application_vehicle ON public.loan_application (vehicle_id);
CREATE INDEX document_application_id ON public.application_document (application_id);
CREATE INDEX review_file_dealer ON public.review_file (dealer_id);
CREATE INDEX review_reviewer ON public.application_review (reviewer_id);
CREATE INDEX decision_decided_by ON public.loan_decision (decided_by);
CREATE INDEX staff_desk ON public.lender_staff (desk_id);
`;

/** Every table the lending database holds, for the seed's own check that it
 * created exactly the App's declared resources and nothing more. Sorted, so it
 * reads as a set rather than as a sequence. */
export const LENDING_TABLES = Object.freeze([
  'application_document',
  'application_review',
  'assignment_history',
  'dealer',
  'intake_co_applicant',
  'intake_submission',
  'lead',
  'lead_co_applicant',
  'lender_staff',
  'loan_application',
  'loan_decision',
  'review_alert',
  'review_desk',
  'review_file',
  'vehicle',
  'vehicle_model',
]);

/**
 * The order rows go in: a parent before anything that points at it. This is
 * deliberately *not* LENDING_TABLES, which is sorted for the set check above —
 * inserting alphabetically would put a document before the dealership that owns
 * it, and the ownership foreign key would refuse it.
 *
 * The shape of this list is the ownership rules again, from another angle: the
 * profile first because every tenant row's ownership column points at it, then
 * the lender's own reference tables, then the global catalogue, then each
 * dealership's rows, and last the lender's rows about them.
 */
export const LENDING_INSERT_ORDER = Object.freeze([
  'dealer',
  'review_desk',
  'lender_staff',
  'vehicle_model',
  'vehicle',
  'lead',
  'lead_co_applicant',
  'loan_application',
  'application_document',
  'review_file',
  'application_review',
  'loan_decision',
  'assignment_history',
  'review_alert',
  'intake_submission',
  'intake_co_applicant',
]);

/* ---------- the applicants database: a platform-only source ---------- */

/**
 * The lender's customer file, in a database of its own. It is declared
 * `realm: 'platform'`, so only the platform realm ever reads it: a dealer's
 * context is built without it, and no command, intake or writer reaches it.
 * Read-only, so its connection never says `writable: true`.
 */
export const APPLICANTS_SCHEMA = `
CREATE TABLE public.applicant (
  id text PRIMARY KEY,
  name text NOT NULL,
  reference text NOT NULL UNIQUE,
  preferred_name text NOT NULL,
  created_on date NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('pending', 'verified', 'needs_review'))
);
CREATE TABLE public.residence (
  id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES public.applicant(id),
  name text NOT NULL,
  address_line text NOT NULL,
  city text NOT NULL,
  region text NOT NULL,
  postal_code text NOT NULL,
  tenure text NOT NULL CHECK (tenure IN ('rent', 'own', 'family')),
  months_at_address integer NOT NULL CHECK (months_at_address >= 0),
  monthly_housing_cost numeric(10, 2) NOT NULL CHECK (monthly_housing_cost >= 0),
  current boolean NOT NULL
);
CREATE TABLE public.contact (
  id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES public.applicant(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email', 'phone')),
  value text NOT NULL,
  verified boolean NOT NULL,
  preferred boolean NOT NULL,
  UNIQUE (applicant_id, kind)
);
CREATE TABLE public.employment (
  id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES public.applicant(id),
  name text NOT NULL,
  employer text NOT NULL,
  job_title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('employed', 'self_employed', 'contract')),
  months_employed integer NOT NULL CHECK (months_employed >= 0),
  stated_annual_income numeric(12, 2) NOT NULL CHECK (stated_annual_income >= 0),
  verification_status text NOT NULL CHECK (verification_status IN ('pending', 'verified', 'needs_review'))
);
`;

export const APPLICANTS_TABLES = Object.freeze(['applicant', 'contact', 'employment', 'residence']);

/** The applicant before the three things that point at it. Stated rather than
 * left to the sorted order, which only happens to agree. */
export const APPLICANTS_INSERT_ORDER = Object.freeze(['applicant', 'residence', 'contact', 'employment']);

/* ---------- the §5.17 fixture, deterministic ---------- */

const day = (offset) => new Date(Date.UTC(2026, 7, 3 + offset)).toISOString().slice(0, 10);
const money = (value) => value.toFixed(2);

/** The four dealers: three active, one suspended, so a suspended tenant is
 * something the sample actually holds rather than a paragraph. */
export const DEALERS = Object.freeze([
  {
    id: 'north-motors',
    code: 'NORTH',
    name: 'Demo North Motors',
    region: 'North',
    channel: 'franchise',
    status: 'active',
    ...profile('#1d4ed8', '08:30', 72, 'DealerTrack', 'v4', '2027-03'),
  },
  {
    id: 'harbor-auto',
    code: 'HARBOR',
    name: 'Demo Harbor Auto',
    region: 'Coastal',
    channel: 'independent',
    status: 'active',
    ...profile('#0e7490', '09:00', 41, 'CDK', 'v2', '2026-12'),
  },
  {
    id: 'valley-vehicles',
    code: 'VALLEY',
    name: 'Demo Valley Vehicles',
    region: 'Central',
    channel: 'franchise',
    status: 'active',
    ...profile('#15803d', '07:45', 88, 'Reynolds', 'v3', '2027-06'),
  },
  {
    id: 'parkside',
    code: 'PARKSIDE',
    name: 'Demo Parkside Motors',
    region: 'West',
    channel: 'independent',
    status: 'suspended',
    ...profile('#b45309', '10:00', 12, 'CDK', 'v2', '2026-11'),
  },
]);

/** A dealership's profile columns, deterministic: its color, opening hour, attainment, DMS settings and renewal month. */
function profile(brandColor, opensAt, attainment, dms, version, renewal) {
  return {
    brand_color: brandColor,
    opens_at: opensAt,
    target_attainment: attainment,
    dms_settings: JSON.stringify({
      provider: dms,
      api: version,
      sync: { inventory: true, deals: attainment > 30 },
      mappings: { stock: 'StockNo', vin: 'VIN' },
    }),
    renewal_month: renewal,
  };
}
export const ACTIVE_DEALERS = Object.freeze(DEALERS.filter((dealer) => dealer.status === 'active'));

/** Each active dealership's public intake address, as the fixture ships it:
 * 32 characters of the alphabet the column takes. Deterministic so a test can
 * publish `/form/finance?via=<address>` without reading the database;
 * the PostgreSQL seed replaces them with real random values. */
export const INTAKE_ADDRESSES = Object.freeze({
  'north-motors': 'fixture-north-motors-intake-0001',
  'harbor-auto': 'fixture-harbor-auto-intake-00001',
  'valley-vehicles': 'fixture-valley-vehicles-intake01',
});

export const DESKS = Object.freeze([
  { id: 'desk-north', name: 'North review desk', coverage: 'North and Coastal' },
  { id: 'desk-central', name: 'Central review desk', coverage: 'Central and West' },
]);

/**
 * The lender's staff and the dealers' people, as accounts to create and
 * memberships to grant. Emails use the reserved `example.invalid` domain.
 * Sam Reyes holds a membership at North *and* Harbor: the one person who
 * proves per-tab dealer switching.
 */
export const LENDER_STAFF = Object.freeze([
  { id: 'staff-admin', name: 'Morgan Lee', email: 'morgan.lee@lender.example.invalid', role: 'platform_admin', desk: null },
  { id: 'staff-manager-north', name: 'Casey Ellis', email: 'casey.ellis@lender.example.invalid', role: 'manager', desk: 'desk-north' },
  { id: 'staff-manager-central', name: 'Robin Bell', email: 'robin.bell@lender.example.invalid', role: 'manager', desk: 'desk-central' },
  { id: 'staff-reviewer-1', name: 'Avery Shaw', email: 'avery.shaw@lender.example.invalid', role: 'reviewer', desk: 'desk-north' },
  { id: 'staff-reviewer-2', name: 'Jamie Reed', email: 'jamie.reed@lender.example.invalid', role: 'reviewer', desk: 'desk-north' },
  { id: 'staff-reviewer-3', name: 'Alex Blake', email: 'alex.blake@lender.example.invalid', role: 'reviewer', desk: 'desk-central' },
]);

/** One dealer_admin and two dealer_staff per active dealer, plus the person in two. */
export const DEALER_PEOPLE = Object.freeze([
  { name: 'Dana Ward', email: 'dana.ward@north.example.invalid', memberships: [{ tenant: 'north-motors', role: 'dealer_admin' }] },
  {
    name: 'Sam Reyes',
    email: 'sam.reyes@north.example.invalid',
    memberships: [
      { tenant: 'north-motors', role: 'dealer_staff' },
      { tenant: 'harbor-auto', role: 'dealer_staff' },
    ],
  },
  { name: 'Kit Marsh', email: 'kit.marsh@north.example.invalid', memberships: [{ tenant: 'north-motors', role: 'dealer_staff' }] },
  { name: 'Rowan Pike', email: 'rowan.pike@harbor.example.invalid', memberships: [{ tenant: 'harbor-auto', role: 'dealer_admin' }] },
  { name: 'Ellis Bay', email: 'ellis.bay@harbor.example.invalid', memberships: [{ tenant: 'harbor-auto', role: 'dealer_staff' }] },
  { name: 'Noa Finch', email: 'noa.finch@valley.example.invalid', memberships: [{ tenant: 'valley-vehicles', role: 'dealer_admin' }] },
  { name: 'Tam Alder', email: 'tam.alder@valley.example.invalid', memberships: [{ tenant: 'valley-vehicles', role: 'dealer_staff' }] },
  { name: 'Juno Vale', email: 'juno.vale@valley.example.invalid', memberships: [{ tenant: 'valley-vehicles', role: 'dealer_viewer' }] },
]);

const MODELS = [
  ['model-vela-city', 'Vela', 'City', 2026, 24500],
  ['model-northstar-cross', 'Northstar', 'Cross', 2026, 32750],
  ['model-orison-touring', 'Orison', 'Touring', 2026, 28400],
  ['model-vela-estate', 'Vela', 'Estate', 2026, 35900],
  ['model-northstar-compact', 'Northstar', 'Compact', 2026, 21900],
  ['model-orison-trail', 'Orison', 'Trail', 2026, 38900],
];
export const VEHICLE_MODELS = Object.freeze(MODELS.map(([id, make, model, model_year]) => ({ id, make, model, model_year })));

const LEAD_STATES = ['new', 'new', 'qualified', 'qualified', 'converted', 'converted', 'converted', 'disqualified'];
const APPLICATION_STATES = [
  'submitted',
  'documents_pending',
  'in_review',
  'in_review',
  'manager_review',
  'approved',
  'declined',
  'withdrawn',
];

/**
 * The whole lending fixture, as rows per table. Every active dealer gets the
 * *same* business references — `L-0001`, `AL-1001` — because equal references
 * across dealers are what makes isolation visible rather than asserted.
 * Parkside is suspended and holds no rows: a suspended dealer nobody works.
 */
export function lendingRows() {
  const rows = {
    dealer: [],
    review_desk: [...DESKS],
    lender_staff: [],
    vehicle_model: [...VEHICLE_MODELS],
    vehicle: [],
    lead: [],
    lead_co_applicant: [],
    loan_application: [],
    application_document: [],
    review_file: [],
    application_review: [],
    loan_decision: [],
    assignment_history: [],
    review_alert: [],
    intake_submission: [],
    intake_co_applicant: [],
  };
  /* Every active dealership publishes an intake link, so the address belongs to
     the fixture rather than to one seed: a test fixture importing these rows
     needs it as much as the PostgreSQL seed does, and a dealership with no
     address has no form to publish. Deterministic here on purpose — the seed
     rotates them to real random values, and rotateIntakeAddress does after
     that. A suspended dealership has none: a link to it resolves to triage. */
  for (const [index, dealer] of DEALERS.entries()) {
    rows.dealer.push({ ...dealer, intake_address: INTAKE_ADDRESSES[dealer.id] ?? null, joined_on: day(index) });
  }
  for (const staff of LENDER_STAFF) {
    rows.lender_staff.push({ id: staff.id, desk_id: staff.desk, account_id: null, name: staff.name, role: staff.role, active: true });
  }

  const deskOf = (region) =>
    DESKS.find((desk) => desk.coverage.split(/\s*(?:,|and)\s*/i).some((part) => part.trim().toLowerCase() === region.toLowerCase())) ??
    DESKS[0];
  const reviewersOf = (desk) => LENDER_STAFF.filter((staff) => staff.role === 'reviewer' && staff.desk === desk.id);
  const managerOf = (desk) => LENDER_STAFF.find((staff) => staff.role === 'manager' && staff.desk === desk.id);

  let applications = 0;
  for (const dealer of ACTIVE_DEALERS) {
    const desk = deskOf(dealer.region),
      reviewers = reviewersOf(desk),
      manager = managerOf(desk);
    const key = (kind, n) => `${dealer.id}:${kind}:${String(n).padStart(4, '0')}`;
    /* Fourteen vehicles each, in two ranges that must not overlap. The first
       ten carry the seeded applications; the last four are on the lot with no
       application against them, and those are the ones the open leads name.
       That separation is what makes `convertLead` runnable at all: it refuses a
       vehicle that already has an application, so a lead pointing into the
       first range could never be converted. */
    for (let v = 0; v < 14; v++) {
      const [modelId, , , , price] = MODELS[v % MODELS.length];
      const used = v % 3 === 0;
      rows.vehicle.push({
        id: key('vehicle', v + 1),
        tenant_id: dealer.id,
        stock_reference: `DEMO-STOCK-${1001 + v}`,
        model_id: modelId,
        condition: used ? 'used' : 'new',
        mileage: used ? 15000 + v * 600 : 25,
        price: money(price - (used ? 4500 : 0)),
        status: 'available',
      });
    }
    // About eight leads each, across all four statuses, with equal references.
    const firstVehicle = rows.vehicle.length - 14;
    for (let l = 0; l < 8; l++) {
      const status = LEAD_STATES[l % LEAD_STATES.length];
      /* A lead still in play names one of the four free vehicles; a lead that
         already converted or was disqualified names one of the ten the seeded
         applications hold, which is where its own application came from. */
      const open = status === 'new' || status === 'qualified';
      const vehicle = rows.vehicle[firstVehicle + (open ? 10 + (l % 4) : l % 10)];
      const [, , , , price] = MODELS[l % MODELS.length];
      const down = 2500 + (l % 5) * 750;
      const amount = price - down;
      const qualified = status === 'qualified' || status === 'converted';
      /* Leads are numbered from 2001, clear of the applications' own
         `AL-1001`…`AL-1016`. `convertLead` derives an application's reference
         from the lead's (`L-2003` becomes `AL-2003`), and
         `UNIQUE (tenant_id, reference)` is the schema doing its job — so a lead
         whose derived reference is already a seeded application could never be
         converted, which is the same trap the two vehicle ranges above avoid.
         Renumbering the leads rather than the applications keeps `AL-1001` the
         reference three dealerships hold in common, which is what the sample's
         isolation story and its browser specs point at. */
      rows.lead.push({
        id: key('lead', l + 1),
        tenant_id: dealer.id,
        reference: `L-${String(2001 + l)}`,
        applicant_name: `Demo Applicant ${l + 1}`,
        applicant_email: `applicant-${l + 1}@${dealer.code.toLowerCase()}.example.invalid`,
        applicant_phone: `+1 202 555 ${String(100 + l).padStart(4, '0')}`,
        vehicle_stock: vehicle.stock_reference,
        requested_amount: money(amount),
        down_payment: money(down),
        term_months: [36, 48, 60][l % 3],
        submitted_on: day(l),
        status,
        qualified_by: qualified ? 'seed:dealer-admin' : null,
        qualified_on: qualified ? day(l + 1) : null,
        disqualified_reason: status === 'disqualified' ? 'Synthetic fixture: the applicant did not proceed with this quotation.' : null,
        version: 0,
      });
      // One qualified lead each applies with a co-applicant, so the lead page's list has a row to show.
      if (l === 2)
        rows.lead_co_applicant.push({
          id: `${key('lead', l + 1)}:co:1`,
          tenant_id: dealer.id,
          lead_id: key('lead', l + 1),
          position: 1,
          name: `Demo Co-applicant ${l + 1}`,
          email: `co-applicant-${l + 1}@${dealer.code.toLowerCase()}.example.invalid`,
        });
    }
    // Every converted lead is an application, and the 48 applications are
    // spread over the three active dealers in the states the screens need.
    const converted = rows.lead.filter((lead) => lead.tenant_id === dealer.id && lead.status === 'converted');
    for (let a = 0; a < 16; a++) {
      const lead = converted[a % converted.length];
      const state = APPLICATION_STATES[a % APPLICATION_STATES.length];
      // The first ten only: the last four stay free for the open leads.
      const vehicle = rows.vehicle[rows.vehicle.length - 14 + (a % 10)];
      const id = key('application', a + 1);
      const offset = a % 28;
      const complete = ['manager_review', 'approved', 'declined'].includes(state);
      const decided = state === 'approved' || state === 'declined';
      const assigned = state !== 'submitted';
      const reviewer = reviewers[a % reviewers.length];
      applications++;
      rows.loan_application.push({
        id,
        tenant_id: dealer.id,
        reference: `AL-${String(1001 + a)}`,
        // Only the first application of each dealer keeps its lead, so a lead
        // with no application and an application with no lead both exist.
        lead_id: a < converted.length ? lead.id : null,
        vehicle_id: vehicle.id,
        applicant_ref: `APPLICANT-${String(applications).padStart(4, '0')}`,
        status: state,
        requested_amount: lead.requested_amount,
        down_payment: lead.down_payment,
        term_months: lead.term_months,
        submitted_on: day(offset),
        document_status: complete ? 'complete' : state === 'submitted' ? 'not_started' : 'incomplete',
        version: 0,
      });
      const documentStates = complete
        ? ['reviewed', 'reviewed', 'reviewed']
        : state === 'submitted'
          ? ['requested', 'requested', 'requested']
          : state === 'documents_pending'
            ? ['reviewed', 'needs_revision', 'received']
            : ['reviewed', 'received', 'received'];
      for (const [d, category] of ['identity', 'income', 'vehicle'].entries()) {
        rows.application_document.push({
          id: `${id}:doc:${category}`,
          tenant_id: dealer.id,
          application_id: id,
          category,
          status: documentStates[d],
          received_on: documentStates[d] === 'requested' ? null : day(offset + 1),
          notes:
            documentStates[d] === 'needs_revision'
              ? 'Synthetic document status only: a clearer copy was requested.'
              : 'Synthetic checklist metadata only. No file or applicant document is stored here.',
        });
      }
      /* The lender's half of the same application — but only once it has been
         assigned. A `submitted` application has no review file yet, because
         creating one is exactly what `assignReviewer` does, and it refuses an
         application that already has one. Seeding a file for every application
         would leave the lender's central verb with nothing it could ever run. */
      if (assigned)
        rows.review_file.push({
          id: `${id}:file`,
          application_id: id,
          dealer_id: dealer.id,
          desk_id: desk.id,
          reviewer_id: reviewer.id,
          manager_id: manager.id,
          review_due_on: day(offset + 7),
          opened_on: day(offset),
          review_context:
            state === 'documents_pending'
              ? 'Income document revision is outstanding. Resume review after the requested material is received.'
              : state === 'manager_review'
                ? 'Initial review recorded. A manager review is queued in this snapshot.'
                : state === 'withdrawn'
                  ? 'The applicant withdrew the request before a decision was recorded.'
                  : 'Synthetic review file. Recorded states describe this fixed snapshot; no eligibility calculation or lending offer is performed.',
        });
      if (assigned) {
        rows.assignment_history.push({
          id: `${id}:assign:1`,
          application_id: id,
          assigned_to: reviewer.id,
          assigned_by: manager.id,
          assigned_on: `${day(offset + 1)}T09:00:00Z`,
          reason: 'Demo allocation to the desk covering this dealer.',
        });
        rows.application_review.push({
          id: `${id}:review:initial`,
          application_id: id,
          reviewer_id: reviewer.id,
          kind: 'initial',
          status: complete ? 'complete' : state === 'withdrawn' ? 'canceled' : state === 'documents_pending' ? 'queued' : 'in_progress',
          opened_on: day(offset + 1),
          completed_on: complete ? day(offset + 3) : null,
          summary: complete
            ? 'A synthetic initial-review record is complete. No automated recommendation is calculated.'
            : state === 'withdrawn'
              ? 'Review stopped after the request was withdrawn; no decision recorded.'
              : 'Review notes await the outstanding document checks.',
        });
      }
      if (complete) {
        rows.application_review.push({
          id: `${id}:review:manager`,
          application_id: id,
          reviewer_id: manager.id,
          kind: 'manager',
          status: state === 'manager_review' ? 'queued' : 'complete',
          opened_on: day(offset + 3),
          completed_on: state === 'manager_review' ? null : day(offset + 4),
          summary: 'Synthetic manager-review history, not an authorization or eligibility rule.',
        });
      }
      if (decided) {
        rows.loan_decision.push({
          id: `${id}:decision`,
          application_id: id,
          decided_by: manager.id,
          outcome: state,
          recorded_on: day(offset + 4),
          record_note:
            'Fictional seeded outcome chosen solely to demonstrate the interface. Not an underwriting ' +
            'result, credit assessment, lending offer or adverse-action notice.',
        });
      }
    }
  }
  // Two submissions in triage: the lender's own queue, which no dealer sees.
  rows.intake_submission.push(
    {
      id: 'triage-0001',
      reference: 'IGN-2026-000001',
      applicant_name: 'Demo Triage One',
      applicant_email: 'triage-one@example.invalid',
      applicant_phone: '+1 202 555 0191',
      dealer_hint: 'SOUTHSIDE',
      vehicle_stock: 'DEMO-STOCK-2001',
      requested_amount: money(18500),
      term_months: 48,
      submitted_on: day(20),
      status: 'triage',
      outcome_note: null,
    },
    {
      id: 'triage-0002',
      reference: 'IGN-2026-000002',
      applicant_name: 'Demo Triage Two',
      applicant_email: 'triage-two@example.invalid',
      applicant_phone: null,
      dealer_hint: null,
      vehicle_stock: null,
      requested_amount: money(24000),
      term_months: 60,
      submitted_on: day(22),
      status: 'triage',
      outcome_note: null,
    },
  );
  return rows;
}

/** The applicant directory: one row per application the dealers hold. */
export function applicantRows(total) {
  const first = ['Mara', 'Evan', 'Nina', 'Theo', 'Lena', 'Owen', 'Iris', 'Noel'];
  const last = ['Alder', 'Vale', 'Marlow', 'Finch', 'Rowan', 'Wren'];
  const employers = ['Example Manufacturing', 'Example Design Studio', 'Example Logistics', 'Example Community Services'];
  const rows = { applicant: [], residence: [], contact: [], employment: [] };
  for (let i = 0; i < total; i++) {
    const id = `applicant-${String(i + 1).padStart(4, '0')}`;
    rows.applicant.push({
      id,
      name: `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}`,
      reference: `APPLICANT-${String(i + 1).padStart(4, '0')}`,
      preferred_name: first[i % first.length],
      created_on: day(i % 28),
      verification_status: i % 8 === 1 ? 'needs_review' : i % 8 === 0 ? 'pending' : 'verified',
    });
    rows.residence.push({
      id: `${id}:residence`,
      applicant_id: id,
      name: 'Current residence',
      address_line: `${100 + i} Demonstration Lane`,
      city: 'Example City',
      region: 'DEMO',
      postal_code: '00000',
      tenure: ['rent', 'own', 'family'][i % 3],
      months_at_address: 12 + ((i * 7) % 120),
      monthly_housing_cost: money(700 + (i % 9) * 125),
      current: true,
    });
    rows.contact.push(
      {
        id: `${id}:email`,
        applicant_id: id,
        name: 'Email',
        kind: 'email',
        value: `${id}@example.invalid`,
        verified: i % 8 !== 0,
        preferred: true,
      },
      {
        id: `${id}:phone`,
        applicant_id: id,
        name: 'Phone',
        kind: 'phone',
        value: `+1 202 555 ${String(100 + (i % 48)).padStart(4, '0')}`,
        verified: i % 8 !== 0,
        preferred: false,
      },
    );
    rows.employment.push({
      id: `${id}:employment`,
      applicant_id: id,
      name: 'Current employment',
      employer: employers[i % 4],
      job_title: ['Operations specialist', 'Project coordinator', 'Service technician', 'Independent consultant'][i % 4],
      kind: ['employed', 'employed', 'contract', 'self_employed'][i % 4],
      months_employed: 8 + ((i * 5) % 108),
      stated_annual_income: money(42000 + (i % 16) * 3750),
      verification_status: i % 8 === 1 ? 'needs_review' : i % 8 < 4 ? 'pending' : 'verified',
    });
  }
  return rows;
}
