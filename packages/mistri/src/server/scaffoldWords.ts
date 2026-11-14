/* The words a scaffolded App is drafted in: what a column's name says it holds, a table's singular and plural,
   its icon, and the keys and module names it is written under. Lifted out of scaffold.ts, which reads the schema
   with them. */
import { pluralOf } from '@mistriwork/engine/shared/appNoun.js';
import { RESERVED_PATHS } from '../shared/appAddress.js';

/* What a column holds, read off its name and type, is displayDefaults.ts's: the one reading the runtime applies. */
export const SUMMED = /(amount|total|subtotal|balance|revenue|paid|billed)$/i;
/** Date columns worth sorting and charting by, most tellingly named first. */
export const DATE_PICK = [
  /created/i,
  /opened/i,
  /ordered/i,
  /placed/i,
  /received|registered|reported|requested|raised|booked|logged/i,
  /submitted/i,
  /happened/i,
  /date/i,
  /_on$/i,
  /_at$/i,
];
export const VERSION = /^(version|lock_version|row_version|rowversion|revision)$/i;
export const SECRET = /(password|passwd|secret|token|hash|salt)/i;
export const LONG_TEXT = /(description|body|notes?|summary|content|details|comments?|bio|message|text|address|html|markdown)$/i;
export const HOUSEKEEPING = /^(updated|modified|sys_|deleted)/i;
export const OPAQUE = /blob|bytea|binary|json|xml|tsvector|vector/i;
export const WORD = /^[A-Za-z0-9_]+$/;

const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  staff: 'staff',
  data: 'data',
  media: 'media',
};
export const IRREGULAR_PLURAL = Object.fromEntries(Object.entries(IRREGULAR).map(([many, one]) => [one, many]));
/* Words that have no plural: a list of stock is "Stock", never "Stocks". */
export const MASS = new Set([
  'stock',
  'inventory',
  'equipment',
  'staff',
  'data',
  'media',
  'information',
  'software',
  'hardware',
  'furniture',
  'feedback',
  'news',
  'mail',
  'luggage',
  'baggage',
  'freight',
  'cargo',
  'merchandise',
  'clothing',
  'payroll',
  'research',
  'evidence',
  'advice',
  'traffic',
  'weather',
  'knowledge',
  'personnel',
  'livestock',
  'produce',
  'machinery',
]);
/* Letters a person says one by one: a table named `po_line` is "PO lines". */
const ACRONYMS = new Set([
  'po',
  'sku',
  'id',
  'api',
  'url',
  'crm',
  'erp',
  'hr',
  'qa',
  'ui',
  'ux',
  'vat',
  'gst',
  'pdf',
  'csv',
  'ip',
  'faq',
  'kpi',
  'roi',
  'sla',
  'rma',
  'bom',
  'usa',
  'uk',
  'eu',
  'us',
  'sms',
  'tax_id',
  'ssn',
  'ein',
  'iban',
  'swift',
  'rfq',
  'rfp',
  'ach',
]);
export const spoken = (words: string) =>
  words
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');

/* A field of study or work said with an -ics that is one thing, not many: "Logistics", never "Logistic". Any
   other -ics is a plural (mechanics, clinics, topics). */
const ICS =
  /(analytics|logistics|physics|economics|statistics|ethics|mathematics|electronics|athletics|politics|genetics|linguistics|robotics|aerobics|optics|acoustics|aesthetics|semantics|ergonomics|forensics|diagnostics|metrics)$/;

/** The singular of a noun's last word, by rule: what a table named in the plural calls one row. */
export function singularOf(noun: string): string {
  const words = noun.split(' ');
  const last = words.pop()!;
  const lower = last.toLowerCase();
  const one =
    IRREGULAR[lower] ??
    (MASS.has(lower) || ICS.test(lower)
      ? last
      : /[^aeiou]ies$/.test(lower)
        ? `${last.slice(0, -3)}y`
        : /(ss|us|is)$/.test(lower)
          ? last
          : /(sses|xes|ches|shes|zes)$/.test(lower)
            ? last.slice(0, -2)
            : lower.endsWith('s')
              ? last.slice(0, -1)
              : last);
  return [...words, one].join(' ');
}

export const pluralNoun = (one: string) => {
  const words = one.split(' ');
  const last = words.pop()!;
  return [...words, MASS.has(last.toLowerCase()) ? last : (IRREGULAR_PLURAL[last] ?? pluralOf(last))].join(' ');
};

/* Icons by what a table's name says: the whole name where it is listed (`work_order` is a wrench), else head noun
   first (`purchase_order` is an order). */
const ICONS: Array<[RegExp, string]> = [
  [/^(ticket|incident|case|request|issue)$/, 'ticket'],
  [/^(bug|defect)$/, 'bug'],
  [/^(contact|lead)$/, 'address-book'],
  [/^(opportunity|deal)$/, 'handshake'],
  [/^(customer|client|person|people|member|user|team|group|patient|student|guest|owner)$/, 'users'],
  [/^(employee|staff|agent|rep|worker|author|driver|technician|mechanic|operator|engineer)$/, 'user'],
  [/^(company|account|organization|organisation|org|vendor|supplier|partner|dealer|tenant|industry)$/, 'buildings'],
  [/^(store|shop|branch|dealership)$/, 'storefront'],
  [/^(order|cart|purchase|basket)$/, 'shopping-cart'],
  [/^(invoice|bill|receipt|transaction|expense)$/, 'receipt'],
  [/^(payment|charge|card)$/, 'credit-card'],
  [/^(payroll|salary|pay|wage|price|budget|payout)$/, 'currency-dollar'],
  [/^(ledger|bank|deposit)$/, 'bank'],
  [/^(product|item|sku|inventory|stock|part|asset|equipment|line)$/, 'package'],
  [/^(warehouse|depot|storage|stockroom|bin|shelf)$/, 'archive'],
  [/^(shipment|delivery|parcel|package|route|trip)$/, 'truck'],
  [/^(vehicle|car|fleet)$/, 'car'],
  [/^(project|board|sprint|milestone|epic)$/, 'kanban'],
  [/^(task|todo|checklist|chore|job)$/, 'list-checks'],
  [/^(event|meeting|appointment|visit|booking|reservation|cycle|schedule|shift|session|period)$/, 'calendar'],
  [/^(property|unit|home|house|apartment|building|room|listing)$/, 'house'],
  [/^(lease|contract|agreement)$/, 'file'],
  [/^(maintenance|repair|work_order|service)$/, 'wrench'],
  [/^(milestone|goal|deadline)$/, 'flag'],
  [/^(time|timesheet|hour|entry)$/, 'clock'],
  [/^(provider|doctor|physician|nurse|clinician|instructor|teacher)$/, 'user'],
  [/^(insurer|payer|carrier|lender|bank)$/, 'buildings'],
  [/^(claim)$/, 'receipt'],
  [/^(prescription|medication|treatment|diagnosis)$/, 'note'],
  [/^(comment|reply|message|conversation|thread|chat|activity)$/, 'chat-circle'],
  [/^(note|memo)$/, 'note'],
  [/^(document|file|attachment|photo|image|upload)$/, 'file'],
  [/^(label|tag|category|type|kind|status)$/, 'tag'],
  [/^(country|region|location|address|site|city|place|area|zone|territory)$/, 'map-pin'],
  [/^(campaign|announcement|promotion)$/, 'megaphone'],
  [/^(email|mail|newsletter)$/, 'envelope'],
  [/^(setting|config|configuration|preference)$/, 'gear'],
  [/^(log|audit|history|event_log)$/, 'clock'],
  [/^(role|permission|policy)$/, 'shield-check'],
  [/^(key|token|credential)$/, 'key'],
  [/^(review|rating|favorite|favourite)$/, 'star'],
  [/^(report|metric)$/, 'chart-bar'],
];

export function iconFor(table: string): string {
  const words = table
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => IRREGULAR[word] ?? singularOf(word));
  /* The whole name, as written or said in the singular: `work_orders` is a wrench, like `work_order`. */
  const whole = ICONS.find(([pattern]) => pattern.test(table.toLowerCase()) || pattern.test(words.join('_')));
  if (whole) return whole[1];
  for (const word of words.reverse()) {
    const hit = ICONS.find(([pattern]) => pattern.test(word));
    if (hit) return hit[1];
  }
  return 'table';
}

/** A view, page or App key: lowercase letters, digits and hyphens, unique among `taken`. */
export function keyFor(name: string, taken: Set<string>): string {
  const said =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 56) || 'view';
  /* A table named like an address the server keeps (`assets`, `new`) is listed under another: "/assets-list". */
  const base = RESERVED_PATHS.includes(said) ? `${said}-list` : said;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** A module-level name for a key: `work-orders` → `workOrders`. */
export function identifier(key: string, suffix = ''): string {
  const camel = key.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  const name = `${camel.charAt(0).toLowerCase()}${camel.slice(1)}${suffix}`;
  return /^[0-9]/.test(name) || !name ? `_${name}` : name;
}
