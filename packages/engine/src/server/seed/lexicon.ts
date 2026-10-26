/**
 * The words `tablewalk seed` picks by meaning. A schema says what it is about
 * in its table and column names (appointments, patients, lab_results; orders,
 * carts, SKUs), so the words are chosen from that: a domain for the whole
 * database, then, inside it, the list a table or a column calls for — a
 * department is Cardiology in a clinic and Grocery in a shop, a staff title is
 * a Registered nurse or a Cashier, a lab test is not a "Lab order 39". A schema
 * that says nothing gets neutral, plausible text rather than another domain's
 * parts and faults.
 */

export type DomainId = 'clinical' | 'retail' | 'logistics' | 'finance' | 'hr' | 'education' | 'property' | 'repair' | 'general';

interface Domain {
  id: DomainId;
  /** Table and column names that say a database is about this. */
  signals: RegExp;
  departments: string[];
  categories: string[];
  /** What a staff row's title, position or role is. */
  jobs: string[];
  /** The subject or title of one piece of work, a visit, a ticket. */
  subjects: string[];
  /** Why: a reason, a cancellation, a complaint. */
  reasons: string[];
  /** A sentence for a note or a description. */
  notes: string[];
  /** What an item the domain keeps is called, for a `name` the table word does not already settle. */
  items?: string[];
}

const DOMAINS: Domain[] = [
  {
    id: 'clinical',
    signals:
      /patient|appointment|clinic|doctor|physician|nurse|diagnos|prescription|medicat|lab_?(test|result|order)|treatment|encounter|ward|triage|insurer|dosage|provider|vital|allerg/i,
    departments: ['Cardiology', 'Pediatrics', 'Radiology', 'Emergency', 'Orthopedics', 'Oncology', 'Neurology', 'Laboratory'],
    categories: ['Consultation', 'Procedure', 'Imaging', 'Laboratory', 'Vaccination', 'Therapy', 'Screening', 'Follow-up'],
    jobs: [
      'Physician',
      'Registered nurse',
      'Nurse practitioner',
      'Medical assistant',
      'Receptionist',
      'Radiology technician',
      'Lab technician',
      'Pharmacist',
      'Billing specialist',
      'Office manager',
    ],
    subjects: [
      'Annual physical',
      'Follow-up visit',
      'New patient consultation',
      'Blood pressure check',
      'Flu shot',
      'Lab review',
      'Post-surgery check',
      'Medication review',
      'Referral to a specialist',
      'Skin rash',
      'Persistent cough',
      'Back pain',
    ],
    reasons: [
      'Patient asked to reschedule',
      'Provider unavailable',
      'Insurance not verified',
      'Symptoms resolved',
      'Could not reach the patient',
      'Moved to another clinic',
    ],
    notes: [
      'Patient prefers morning appointments.',
      'Reviewed the last lab results together.',
      'Advised to follow up in two weeks.',
      'Allergies confirmed with the patient.',
      'Insurance card copied at check-in.',
      'Discussed treatment options; patient will decide by next visit.',
      'Referral letter sent to the specialist.',
      'Patient reports improvement since the last visit.',
    ],
    items: [
      'Amoxicillin 500 mg',
      'Lisinopril 10 mg',
      'Metformin 500 mg',
      'Atorvastatin 20 mg',
      'Ibuprofen 200 mg',
      'Albuterol inhaler',
      'Omeprazole 20 mg',
      'Sertraline 50 mg',
    ],
  },
  {
    id: 'retail',
    signals: /product|cart|checkout|sku|catalog|merchant|shop|store|basket|storefront|wishlist|coupon|discount|inventory|order_?items?/i,
    departments: ['Grocery', 'Apparel', 'Home & Garden', 'Electronics', 'Toys', 'Pharmacy', 'Bakery', 'Customer Service'],
    categories: ['Apparel', 'Electronics', 'Home', 'Grocery', 'Beauty', 'Toys', 'Sports', 'Books'],
    jobs: [
      'Cashier',
      'Store manager',
      'Sales associate',
      'Stock clerk',
      'Buyer',
      'Merchandiser',
      'Customer service lead',
      'Shift supervisor',
    ],
    subjects: [
      'Order has not arrived',
      'Wrong size delivered',
      'Item arrived damaged',
      'Request to change the address',
      'Refund status',
      'Coupon did not apply',
      'Question about stock',
      'Exchange for another color',
    ],
    reasons: ['Changed their mind', 'Found it cheaper elsewhere', 'Arrived damaged', 'Wrong item sent', 'Duplicate order', 'Out of stock'],
    notes: [
      'Gift order; no price on the packing slip.',
      'Customer asked for a call before delivery.',
      'Restocked and shipped the next day.',
      'Applied a goodwill discount.',
      'Left at the front desk with the neighbor.',
      'Repeat customer, usually orders in pairs.',
    ],
    items: [
      'Cotton crew tee',
      'Stainless water bottle',
      'Wireless earbuds',
      'Ceramic mug set',
      'Trail running shoes',
      'Linen throw blanket',
      'Desk lamp',
      'Organic coffee beans',
      'Yoga mat',
      'Canvas tote bag',
    ],
  },
  {
    id: 'logistics',
    signals:
      /shipment|freight|carrier|dispatch|route|warehouse|consignment|pallet|waybill|tracking|delivery|driver|fleet|container|manifest|depot|stop/i,
    departments: ['Dispatch', 'Warehouse', 'Receiving', 'Fleet', 'Customs', 'Returns', 'Billing', 'Planning'],
    categories: ['Parcel', 'Freight', 'Pallet', 'Cold chain', 'Express', 'Bulk', 'Hazmat', 'Returns'],
    jobs: [
      'Dispatcher',
      'Driver',
      'Warehouse associate',
      'Forklift operator',
      'Route planner',
      'Customs broker',
      'Fleet manager',
      'Shift lead',
    ],
    subjects: [
      'Delivery window missed',
      'Damaged pallet at receiving',
      'Address not found',
      'Customs hold',
      'Reroute for road closure',
      'Signature required',
      'Temperature alarm in the trailer',
      'Shortage on arrival',
    ],
    reasons: ['Recipient not available', 'Address incorrect', 'Vehicle breakdown', 'Weather delay', 'Refused at the dock', 'Customs hold'],
    notes: [
      'Call the dock before arrival.',
      'Liftgate needed at delivery.',
      'Left at the side door per instructions.',
      'Rerouted through the north hub.',
      'Seal intact on arrival.',
      'Appointment required at the receiving dock.',
    ],
    items: [
      'Pallet of canned goods',
      'Crate of auto parts',
      'Roll of packing film',
      'Box of fasteners',
      'Drum of lubricant',
      'Carton of sensors',
    ],
  },
  {
    id: 'finance',
    signals:
      /ledger|transaction|account_?(holder|number)|loan|payment|invoice|balance|interest|statement|deposit|withdraw|journal|budget|portfolio|trade|payee|bank/i,
    departments: ['Accounting', 'Treasury', 'Risk', 'Compliance', 'Audit', 'Payroll', 'Lending', 'Collections'],
    categories: ['Checking', 'Savings', 'Loan', 'Card', 'Transfer', 'Fee', 'Investment', 'Insurance'],
    jobs: [
      'Accountant',
      'Loan officer',
      'Teller',
      'Financial analyst',
      'Compliance officer',
      'Auditor',
      'Relationship manager',
      'Controller',
    ],
    subjects: [
      'Disputed charge',
      'Statement question',
      'Late payment fee',
      'Wire transfer delayed',
      'Request for a payoff letter',
      'Card replacement',
      'Reconcile the monthly ledger',
      'Update the billing address',
    ],
    reasons: [
      'Insufficient funds',
      'Duplicate payment',
      'Account closed',
      'Disputed by the customer',
      'Failed verification',
      'Requested by the customer',
    ],
    notes: [
      'Verified identity by phone.',
      'Waived the fee as a one-time courtesy.',
      'Awaiting the signed authorization form.',
      'Payment plan agreed for three months.',
      'Flagged for a second review.',
      'Statement re-sent by email.',
    ],
    items: [
      'Monthly maintenance fee',
      'Wire transfer',
      'Annual membership',
      'Late payment fee',
      'Overdraft protection',
      'Card replacement',
    ],
  },
  {
    id: 'hr',
    signals:
      /employee|payroll|leave|vacation|timesheet|candidate|applicant|job_?(opening|posting)|salary|benefit|onboard|interview|performance_?review|headcount|position/i,
    departments: ['Engineering', 'Sales', 'Marketing', 'Finance', 'Operations', 'People', 'Legal', 'Support'],
    categories: ['Full-time', 'Part-time', 'Contract', 'Intern', 'Remote', 'Seasonal', 'Temporary', 'Consultant'],
    jobs: [
      'Software engineer',
      'Account executive',
      'Product designer',
      'Operations manager',
      'HR generalist',
      'Financial analyst',
      'Support specialist',
      'Recruiter',
      'Marketing manager',
      'Office administrator',
    ],
    subjects: [
      'Leave request',
      'Onboarding checklist',
      'Annual performance review',
      'Benefits enrollment question',
      'Expense report',
      'Interview feedback',
      'Equipment request',
      'Schedule change',
    ],
    reasons: [
      'Schedule conflict',
      'Position filled',
      'Withdrew the application',
      'Budget not approved',
      'Personal reasons',
      'Role changed',
    ],
    notes: [
      'Manager approved by email.',
      'Strong references; moving to the next round.',
      'Start date agreed for the first of the month.',
      'Needs a laptop before day one.',
      'Prefers remote two days a week.',
      'Reviewed goals for the next quarter.',
    ],
    items: ['Annual review', 'Team offsite', 'Onboarding session', 'Safety training', 'Benefits briefing', 'Quarterly planning'],
  },
  {
    id: 'education',
    signals:
      /student|course|enrol|teacher|grade|semester|class(es|room)?|lesson|assignment|exam|school|curriculum|attendance|syllabus|instructor|campus/i,
    departments: ['Mathematics', 'Science', 'English', 'History', 'Arts', 'Athletics', 'Counseling', 'Administration'],
    categories: ['Lecture', 'Lab', 'Seminar', 'Workshop', 'Exam', 'Elective', 'Core', 'Independent study'],
    jobs: ['Teacher', 'Teaching assistant', 'Counselor', 'Principal', 'Librarian', 'Registrar', 'Coach', 'Department head'],
    subjects: [
      'Missing assignment',
      'Request for a grade review',
      'Schedule change request',
      'Parent conference',
      'Field trip permission',
      'Make-up exam',
      'Advising meeting',
      'Library hold',
    ],
    reasons: ['Illness', 'Schedule conflict', 'Transferred schools', 'Course full', 'Prerequisite not met', 'Family emergency'],
    notes: [
      'Meeting with the family scheduled for Friday.',
      'Strong progress this term.',
      'Needs extra time on exams.',
      'Attended every lab session.',
      'Assignment resubmitted after feedback.',
      'Recommended for the advanced section.',
    ],
    items: [
      'Algebra II',
      'World History',
      'Introduction to Biology',
      'English Composition',
      'Studio Art',
      'Chemistry Lab',
      'Physical Education',
      'Computer Science',
    ],
  },
  {
    id: 'property',
    signals:
      /propert|tenant|lease|unit|landlord|rent|building|apartment|maintenance_?request|inspection|listing|occupan|mortgage|parcel_?id/i,
    departments: ['Leasing', 'Maintenance', 'Accounting', 'Resident Services', 'Security', 'Grounds', 'Marketing', 'Compliance'],
    categories: ['Apartment', 'Townhouse', 'Studio', 'Condo', 'Office', 'Retail', 'Storage', 'Parking'],
    jobs: [
      'Property manager',
      'Leasing agent',
      'Maintenance technician',
      'Groundskeeper',
      'Concierge',
      'Accountant',
      'Inspector',
      'Regional manager',
    ],
    subjects: [
      'Leaking kitchen faucet',
      'Heating not working',
      'Annual inspection',
      'Lease renewal',
      'Parking space request',
      'Noise complaint',
      'Broken window latch',
      'Move-out walkthrough',
    ],
    reasons: ['Lease ended', 'Moved out early', 'Rent unpaid', 'Unit sold', 'Tenant request', 'Application withdrawn'],
    notes: [
      'Tenant prefers contact by text.',
      'Access arranged with the front desk.',
      'Photos attached to the inspection.',
      'Parts ordered; repair next week.',
      'Deposit refunded after the walkthrough.',
      'Renewal offered at a small increase.',
    ],
    items: ['Unit 2B', 'Unit 4A', 'Unit 7C', 'Garden studio', 'Corner suite', 'Loft 12', 'Penthouse 1', 'Garden level 3'],
  },
  {
    id: 'repair',
    signals: /work_?order|mechanic|repair|bike|vehicle|garage|workshop|warranty/i,
    departments: ['Service', 'Parts', 'Sales', 'Workshop', 'Front Desk', 'Accounts', 'Warranty', 'Detailing'],
    categories: ['Maintenance', 'Repair', 'Inspection', 'Upgrade', 'Warranty', 'Accessories', 'Safety', 'Tuning'],
    jobs: ['Lead mechanic', 'Mechanic', 'Service advisor', 'Parts counter', 'Shop manager', 'Apprentice', 'Detailer', 'Receptionist'],
    subjects: [
      'Annual service',
      'Noise when in use',
      'Replace worn part',
      'Inspect and report',
      'Adjust and tune',
      'Will not start',
      'Intermittent fault',
      'Routine check',
      'Leaking at the seal',
      'Upgrade requested',
      'Warranty claim',
      'Safety check before a trip',
    ],
    reasons: ['Customer changed their mind', 'Too expensive to repair', 'Duplicate request', 'Could not reach the customer'],
    notes: [
      'Customer asked to be called before any extra work.',
      'Parts ordered; expected later this week.',
      'Checked twice, no fault found on the bench.',
      'Wants it back before the weekend.',
      'Quoted the larger job; waiting on a decision.',
      'Same issue as last visit, worse now.',
      'Left a voicemail with the estimate.',
      'Paid a deposit at drop-off.',
    ],
  },
  {
    id: 'general',
    signals: /$^/,
    departments: ['Operations', 'Finance', 'Sales', 'Support', 'Administration', 'Marketing', 'Legal', 'Engineering'],
    categories: ['General', 'Billing', 'Support', 'Shipping', 'Accounts', 'Feedback', 'Onboarding', 'Sales'],
    jobs: ['Manager', 'Coordinator', 'Analyst', 'Specialist', 'Associate', 'Supervisor', 'Administrator', 'Assistant'],
    subjects: [
      'Question about an account',
      'Follow-up requested',
      'Update needed',
      'Review pending',
      'Request for information',
      'Change of details',
      'Scheduled check-in',
      'Needs a decision',
    ],
    reasons: [
      'Requested by the customer',
      'Duplicate entry',
      'No response',
      'Out of scope',
      'Replaced by a newer request',
      'Resolved elsewhere',
    ],
    notes: [
      'Waiting on a reply.',
      'Confirmed by phone.',
      'Details checked and up to date.',
      'Follow up next week.',
      'Prefers email over phone.',
      'Reviewed with the team.',
    ],
  },
];

const DOMAIN = new Map(DOMAINS.map((d) => [d.id, d]));
const local = (name: string) => name.slice(name.lastIndexOf('.') + 1);

/** The domain a schema is about: the one whose signals its table names (heavier) and column names hit most. */
export function detectDomain(tables: readonly string[], columns: readonly string[]): DomainId {
  let best: DomainId = 'general';
  let top = 0;
  for (const domain of DOMAINS) {
    if (domain.id === 'general') continue;
    let score = 0;
    for (const t of tables) if (domain.signals.test(local(t))) score += 3;
    for (const c of columns) if (domain.signals.test(c)) score += 1;
    if (score > top) {
      top = score;
      best = domain.id;
    }
  }
  return best;
}

/* Lists a table word settles whatever the domain. */
const LOCATIONS = ['Downtown', 'Riverside', 'Northgate', 'Westfield', 'Harbor View', 'Eastside', 'Lakeshore', 'Midtown'];
const SPECIALTIES = [
  'Family medicine',
  'Cardiology',
  'Dermatology',
  'Pediatrics',
  'Orthopedics',
  'Neurology',
  'Internal medicine',
  'Radiology',
];
const ROLES = ['Admin', 'Manager', 'Staff', 'Viewer', 'Auditor', 'Support', 'Analyst', 'Guest'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const STATUSES = ['Open', 'In progress', 'On hold', 'Done', 'Cancelled'];
const SOURCES = ['Website', 'Phone', 'Referral', 'Walk-in', 'Email', 'Partner', 'Social media', 'Event'];
const PAYMENT_METHODS = ['Cash', 'Credit card', 'Debit card', 'Check', 'Bank transfer', 'Insurance', 'Mobile wallet', 'Gift card'];
const PAYERS = [
  'Evergreen Health',
  'Summit Mutual',
  'Bluebird Care',
  'Harbor Mutual',
  'Northwind Health',
  'Cedar Assurance',
  'Pioneer Plan',
  'Lakeside Benefits',
];
const TESTS = [
  'Complete blood count',
  'Basic metabolic panel',
  'Lipid panel',
  'Hemoglobin A1c',
  'Thyroid stimulating hormone',
  'Urinalysis',
  'Liver function panel',
  'Vitamin D level',
  'Chest X-ray',
  'Electrocardiogram',
];
const PROCEDURES = [
  'Office visit',
  'Blood draw',
  'Vaccination',
  'Wound care',
  'Physical therapy session',
  'Ultrasound',
  'MRI scan',
  'Allergy test',
];
const DIAGNOSES = [
  'Hypertension',
  'Type 2 diabetes',
  'Seasonal allergies',
  'Migraine',
  'Asthma',
  'Lower back pain',
  'Anxiety',
  'High cholesterol',
];

/**
 * The named rows of a lookup table — its first n, a handful, each its own — or undefined when no list fits and the
 * table is better named by its word and a number ("Ward 3").
 */
export function lookupList(domain: DomainId, tableName: string): string[] | undefined {
  const t = local(tableName).toLowerCase();
  const d = DOMAIN.get(domain)!;
  if (/specialt(y|ies)/.test(t)) return SPECIALTIES;
  if (/(^|_)roles?$/.test(t)) return ROLES;
  if (/(^|_)(locations?|branch(es)?|sites?|clinics?|stores?|offices?|campus(es)?|facilit(y|ies))$/.test(t)) return LOCATIONS;
  if (/priorit(y|ies)/.test(t)) return PRIORITIES;
  if (/statuses|(^|_)status(es)?$/.test(t)) return STATUSES;
  if (/(^|_)(sources?|channels?)$/.test(t)) return SOURCES;
  if (/payment_?(methods?|types?)|tender/.test(t)) return PAYMENT_METHODS;
  if (/(insurers?|payers?|insurance_?(plans?|providers?|companies))/.test(t)) return PAYERS;
  if (/reasons?$/.test(t)) return d.reasons;
  if (/departments?|divisions?|(^|_)teams?$|wards?$/.test(t)) return d.departments;
  if (/(^|_)(job_?)?(titles?|positions?)$/.test(t)) return d.jobs;
  if (/(categor(y|ies)|types?|kinds?|topics?|groups?|tags?|labels?|classes)$/.test(t)) return d.categories;
  return undefined;
}

/** The pool a name column draws from in a table that is not a lookup: a drug, a test, a product; undefined for no pool. */
export function entityNames(domain: DomainId, tableName: string): string[] | undefined {
  const t = local(tableName).toLowerCase();
  const d = DOMAIN.get(domain)!;
  if (/lab|test/.test(t) && domain === 'clinical') return TESTS;
  if (/medication|drug|prescription|formular|pharmac/.test(t)) return DOMAIN.get('clinical')!.items;
  if (/procedure|service|treatment|visit_?type/.test(t) && domain === 'clinical') return PROCEDURES;
  if (/diagnos|condition|problem_?list/.test(t)) return DIAGNOSES;
  if (/course|class|subject|module/.test(t) && domain === 'education') return d.items;
  if (/propert|unit|apartment|listing|building/.test(t) && domain === 'property') return d.items;
  if (/product|item|catalog|sku|merch|goods|part|equipment|asset|stock|inventory/.test(t)) return d.items;
  return undefined;
}

type Meaning =
  | 'job'
  | 'subject'
  | 'reason'
  | 'notes'
  | 'category'
  | 'department'
  | 'specialty'
  | 'diagnosis'
  | 'test'
  | 'procedure'
  | 'drug';

/** The meaning a text column's name has in this table, when a domain list answers it. */
export function meaningOf(column: string, tableName: string, staffLike: boolean): Meaning | undefined {
  const c = column.toLowerCase();
  const t = local(tableName).toLowerCase();
  if (/(^|_)(job_?title|position|occupation|designation)$/.test(c) || (staffLike && /(^|_)(title|role)$/.test(c))) return 'job';
  if (/(^|_)(department|dept|division|ward)(_name)?$/.test(c)) return 'department';
  if (/(^|_)specialt(y|ies)$/.test(c)) return 'specialty';
  if (/(^|_)(diagnos[ie]s|condition|chief_complaint)$/.test(c)) return 'diagnosis';
  if (/(^|_)(test|test_name|panel|assay)$/.test(c) || (/lab/.test(t) && /(^|_)name$/.test(c))) return 'test';
  if (/(^|_)(procedure|treatment)(_name)?$/.test(c)) return 'procedure';
  if (/(^|_)(medication|drug)(_name)?$/.test(c)) return 'drug';
  if (/(^|_)(reason|cancel(l)?ation_reason|resolution|outcome_reason)$/.test(c)) return 'reason';
  if (/(^|_)(description|notes?|body|comments?|details|content|message|remarks|bio|about|summary_notes)$/.test(c)) return 'notes';
  if (/(^|_)(title|subject|summary|problem|issue|headline|request|complaint|purpose|visit_reason)$/.test(c)) return 'subject';
  if (/(^|_)(category|topic|type|kind|group|label|class)$/.test(c)) return 'category';
  return undefined;
}

/** The list a meaning draws from, in this domain. */
export function wordsFor(domain: DomainId, meaning: Meaning): string[] {
  const d = DOMAIN.get(domain)!;
  switch (meaning) {
    case 'job':
      return d.jobs;
    case 'subject':
      return d.subjects;
    case 'reason':
      return d.reasons;
    case 'notes':
      return d.notes;
    case 'category':
      return d.categories;
    case 'department':
      return d.departments;
    case 'specialty':
      return SPECIALTIES;
    case 'diagnosis':
      return DIAGNOSES;
    case 'test':
      return TESTS;
    case 'procedure':
      return PROCEDURES;
    case 'drug':
      return DOMAIN.get('clinical')!.items!;
  }
}
