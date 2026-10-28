/**
 * Draft an App from a schema: the engine behind `--scaffold-app` on the CLI.
 *
 * Draft, not decide. Real tables in, join tables out (they are the lines,
 * not the places). What comes out is a project in the house style — the one
 * the docs teach and Compass is written in: `app.ts` with `defineApp`, the
 * resources, views and dashboard in their own modules, a record page per
 * main table under `pages/`, built from the helpers (`listView`, `dashboard`,
 * `page`, `fields`, `related`, `header`…) rather than dumped as JSON, in a look
 * of its own with a grouped menu, and each resource's New form grouped and
 * filled in where the catalog says how (mistri docs compose-form), plus the
 * `tsconfig.json`, `package.json` and generated schema types that make it
 * typecheck on the first run of `mistri check`.
 *
 * The words are the framework's own: a view says its table's plural
 * ("Work orders"), a record its singular noun, a vocabulary word the way
 * its chip says it — `humanName`, `pluralOf`, `vocabularyWord`, never a
 * second opinion. A list hides what nobody reads in a list (surrogate keys,
 * `version`, raw reference ids, long text); a short CHECK vocabulary becomes
 * tones and a tab strip. The first 80% is this file; the taste stays the
 * author's.
 *
 * One plan, two readings: the plan is a tree of helper calls, rendered as
 * TypeScript for the files and evaluated, helper by helper, for the draft
 * object — which is validated before it leaves, so the files never teach a
 * spelling the parser refuses.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { formatScripts, oxfmtConfigText, oxfmtRange } from './formatterConfig.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  columnKind,
  labelColumn as schemaLabelColumn,
  primaryKey,
  tableNamed,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { autoKey, isRequired } from '@mistriwork/engine/shared/form.js';
import {
  appFileRules,
  appRollupRules,
  appTagRules,
  appTransitionRules,
  parseAppConfig,
  parseAppPages,
  resolveDisplay,
  resolveResources,
  resolveViews,
  withRollups,
} from '../shared/app.js';
import { nounTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import { humanName, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { isMoneyColumn, isPeople, UNITS, vocabularyTones } from '@mistriwork/engine/shared/displayDefaults.js';
import { DUE } from '@mistriwork/engine/shared/dueDate.js';
import { headingOf, pluralOf } from '@mistriwork/engine/shared/appNoun.js';
import { validatePage } from '@mistriwork/engine/shared/page.js';
import { RESERVED_PATHS } from '../shared/appAddress.js';
import { anatomySections, recordAnatomy } from '@mistriwork/engine/shared/pageAnatomy.js';
import { describeSchema } from '@mistriwork/engine/shared/shape.js';
import { accessibleSchema } from './app/appAccess.js';
import { appResourceCatalog } from './app/appResources.js';
import { createAppSourceCatalog } from './app/appSourceCatalog.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { LANGUAGE_WORDS } from '../shared/appSegments.js';
import { draftMachine, machineWrites, type DraftedMachine } from '@mistriwork/engine/server/scaffoldMachine.js';
import { inferredFormDefaults } from '../shared/formRules.js';
import { withDeclaredDates } from '../shared/declaredDates.js';
import type { DeclaredDate } from '../shared/appModel.js';
import { moduleTypeProblem } from './cli/projectSetup.js';
import { typesForSchema } from './typegen.js';

/* ---------- the plan: helper calls, rendered or evaluated ---------- */

/* What each helper the draft calls returns: exactly the JSON it stands for,
   as packages/mistri/schema/app.mjs defines it. Restated rather than imported because the
   server build compiles src/ alone; test/scaffold.test.ts holds each one to
   the shipped helper, argument for argument. */
type Opts = Record<string, unknown>;
export const SCAFFOLD_HELPERS = {
  listView: (label: string, from: string, opts: Opts = {}) => ({ kind: 'list', label, from, ...opts }),
  dashboard: (label: string, sections: unknown[], opts: Opts = {}) => ({ kind: 'dashboard', label, sections, ...opts }),
  metric: (title: string, from: string, opts: Opts = {}) => ({ kind: 'metric', title, from, ...opts }),
  breakdown: (title: string, from: string, by: string, opts: Opts = {}) => ({ kind: 'breakdown', title, from, by, ...opts }),
  chart: (title: string, from: string, by: string, opts: Opts = {}) => ({ kind: 'chart', title, from, by, ...opts }),
  rows: (title: string, from: string, opts: Opts = {}) => ({ kind: 'rows', title, from, ...opts }),
  firstRun: (title: string, steps: unknown[], opts: Opts = {}) => ({ kind: 'firstRun', title, steps, ...opts }),
  page: (base: string, sections: unknown[], opts?: Opts) => ({ base, sections, ...(opts ?? {}) }),
  fields: (show: string[], opts: Opts = {}) => ({ kind: 'fields', show, ...opts }),
  header: (opts: Opts) => ({ kind: 'header', ...opts }),
  history: (title?: string, opts: Opts = {}) => ({ kind: 'history', ...(title === undefined ? {} : { title }), ...opts }),
  related: (title: string, from: string, whose: string, opts: Opts = {}) => ({ kind: 'list', title, from, whose, ...opts }),
  card: (title: string, reference: string, show: string[] = [], opts: Opts = {}) => ({
    kind: 'card',
    title,
    show: [reference, ...show.map((p) => `${reference}.${p}`)],
    ...opts,
  }),
  current: (title: string, from: string, whose: string, opts: Opts = {}) => ({ kind: 'current', title, from, whose, ...opts }),
  action: (label: string, opts: Opts = {}) => ({ ...opts, label }),
  count: (from: string, opts: Opts = {}) => ({ fn: 'count', from, ...opts }),
  sum: (from: string, column: string, opts: Opts = {}) => ({ fn: 'sum', from, column, ...opts }),
  navGroup: (id: string, label: string, children: unknown[], opts: Opts = {}) => ({ id, label, children, ...opts }),
  machine: (column: string, states: unknown, opts: Opts = {}) => ({ column, states, ...opts }),
  /* A member of an exported namespace, rendered as written and imported by its namespace. */
  'computed.number': (value: string) => ({ type: 'number', value }),
} as const;
const HELPERS = SCAFFOLD_HELPERS;
type Helper = keyof typeof HELPERS;

/** A helper call: rendered as `fn(args)`, evaluated by the helper itself. */
class Call {
  constructor(
    readonly fn: Helper,
    readonly args: unknown[],
  ) {}
}
/** A name another module exports: rendered bare, evaluated to what it names. */
class Ref {
  constructor(
    readonly name: string,
    readonly value: unknown,
  ) {}
}
/** A value `@mistriwork/mistri/app` exports — `today`, `now` — rendered bare and imported beside the helpers. */
class Constant extends Ref {}
const filled = (word: 'today' | 'now') => new Constant(word, { auto: word });
const call = (fn: Helper, ...args: unknown[]) => new Call(fn, args);

function evaluate(value: unknown): unknown {
  if (value instanceof Call) return (HELPERS[value.fn] as (...args: unknown[]) => unknown)(...value.args.map(evaluate));
  if (value instanceof Ref) return evaluate(value.value);
  if (Array.isArray(value)) return value.map(evaluate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, evaluate(v)]));
  return value;
}

/** Every helper a tree calls, for the module's import line. */
function helpersIn(value: unknown, into = new Set<string>()): Set<string> {
  if (value instanceof Constant) into.add(value.name);
  else if (value instanceof Call) {
    into.add(value.fn.split('.')[0]);
    value.args.forEach((arg) => helpersIn(arg, into));
  } else if (Array.isArray(value)) value.forEach((item) => helpersIn(item, into));
  else if (value && typeof value === 'object' && !(value instanceof Ref)) Object.values(value).forEach((v) => helpersIn(v, into));
  return into;
}

const WIDTH = 100;
const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const propertyKey = (key: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key));

/** The tree on one line, the way a person writes a short one. */
function inline(value: unknown): string {
  if (value instanceof Ref) return value.name;
  if (value instanceof Call) return `${value.fn}(${value.args.map(inline).join(', ')})`;
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, v]) => (v instanceof Ref && v.name === k ? k : `${propertyKey(k)}: ${inline(v)}`)).join(', ')} }`;
  }
  return String(value);
}

/** The tree as source: one line where it fits in `WIDTH` after `used` characters, else broken at its brackets. */
function render(value: unknown, indent: string, used: number): string {
  const flat = inline(value);
  if (
    used + flat.length <= WIDTH ||
    !(value instanceof Call || Array.isArray(value) || (value && typeof value === 'object' && !(value instanceof Ref)))
  ) {
    return flat;
  }
  const inner = `${indent}  `;
  if (value instanceof Call) {
    /* Leading arguments stay on the call's line; the one that does not fit
       breaks, and what follows it starts where its closing bracket left off. */
    let text = `${value.fn}(`;
    value.args.forEach((arg, i) => {
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      const column = text.includes('\n') ? lastLine.length : used + lastLine.length;
      text += `${i ? ', ' : ''}${render(arg, indent, column + (i ? 2 : 0))}`;
    });
    return `${text})`;
  }
  if (Array.isArray(value)) {
    /* A list of words is packed, the way a person writes `show`; anything else goes one to a line. */
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      const lines: string[] = [];
      for (const item of value.map(inline)) {
        const last = lines.at(-1);
        if (last !== undefined && inner.length + last.length + item.length + 2 <= WIDTH) lines[lines.length - 1] = `${last}, ${item}`;
        else lines.push(item);
      }
      return `[\n${lines.map((line) => `${inner}${line},\n`).join('')}${indent}]`;
    }
    return `[\n${value.map((item) => `${inner}${render(item, inner, inner.length)},\n`).join('')}${indent}]`;
  }
  return `{\n${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      if (v instanceof Ref && v.name === k) return `${inner}${k},\n`;
      const lead = `${inner}${propertyKey(k)}: `;
      return `${lead}${render(v, inner, lead.length)},\n`;
    })
    .join('')}${indent}}`;
}

/* ---------- reading the schema ---------- */

/* What a column holds, read off its name and type, is displayDefaults.ts's: the one reading the runtime applies. */
const SUMMED = /(amount|total|subtotal|balance|revenue|paid|billed)$/i;
/** Date columns worth sorting and charting by, most tellingly named first. */
const DATE_PICK = [
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
const VERSION = /^(version|lock_version|row_version|rowversion|revision)$/i;
const SECRET = /(password|passwd|secret|token|hash|salt)/i;
const LONG_TEXT = /(description|body|notes?|summary|content|details|comments?|bio|message|text|address|html|markdown)$/i;
const HOUSEKEEPING = /^(updated|modified|sys_|deleted)/i;
const OPAQUE = /blob|bytea|binary|json|xml|tsvector|vector/i;
const WORD = /^[A-Za-z0-9_]+$/;

const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  staff: 'staff',
  data: 'data',
  media: 'media',
};
const IRREGULAR_PLURAL = Object.fromEntries(Object.entries(IRREGULAR).map(([many, one]) => [one, many]));
/* Words that have no plural: a list of stock is "Stock", never "Stocks". */
const MASS = new Set([
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
const spoken = (words: string) =>
  words
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');

/* A field of study or work said with an -ics that is one thing, not many: "Logistics", never "Logistic". Any
   other -ics is a plural (mechanics, clinics, topics). */
const ICS =
  /(analytics|logistics|physics|economics|statistics|ethics|mathematics|electronics|athletics|politics|genetics|linguistics|robotics|aerobics|optics|acoustics|aesthetics|semantics|ergonomics|forensics|diagnostics|metrics)$/;

/** The singular of a noun's last word, by rule: what a table named in the plural calls one row. */
function singularOf(noun: string): string {
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

const pluralNoun = (one: string) => {
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

function iconFor(table: string): string {
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
function keyFor(name: string, taken: Set<string>): string {
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
function identifier(key: string, suffix = ''): string {
  const camel = key.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  const name = `${camel.charAt(0).toLowerCase()}${camel.slice(1)}${suffix}`;
  return /^[0-9]/.test(name) || !name ? `_${name}` : name;
}

interface TableInfo {
  table: TableMeta;
  /** The view key its list opens at. */
  key: string;
  /** What one row is called, mid-sentence; `noun` is written only when the table's name would not say it. */
  one: string;
  many: string;
  noun?: string | { one: string; many: string };
  label: string;
  icon: string;
  /** Single-column references, by column: the target and the column that names its rows. */
  refs: Map<string, { target: TableMeta; label?: string }>;
  /** The column the work divides by — a vocabulary named like a state — which becomes the list's tabs. */
  status?: ColumnMeta;
  /** The life the status vocabulary reads as, when it reads as one. */
  machine?: DraftedMachine;
  /** Any short vocabulary: what the Overview's breakdown falls back to. */
  vocab?: ColumnMeta;
  date?: ColumnMeta;
  show: string[];
}

/** A key a person would never read: a number or a uuid the database handed out, not a code someone typed. */
const surrogate = (table: TableMeta, column: ColumnMeta) =>
  column.primaryKey &&
  (columnKind(column.type ?? '') === 'number' || /^(id|uuid|guid)$/i.test(column.name) || /uuid/i.test(column.type ?? '')) &&
  table.columns.filter((c) => c.primaryKey).length === 1;

const isMoney = isMoneyColumn;

const opaque = (column: ColumnMeta) => OPAQUE.test(column.type ?? '') || SECRET.test(column.name) || VERSION.test(column.name);

function dateColumn(table: TableMeta): ColumnMeta | undefined {
  const dated = table.columns.filter((c) => columnKind(c.type ?? '') === 'date' && !HOUSEKEEPING.test(c.name));
  /* A due date is when the work should end, not when it happened: a list sorted by it reads as a plan. */
  const happened = dated.filter((c) => !DUE.test(c.name) && !/(^|_)(due|scheduled|planned|expected|promised)(_|$)/i.test(c.name));
  for (const want of DATE_PICK) {
    const hit = happened.find((c) => want.test(c.name));
    if (hit) return hit;
  }
  return happened[0] ?? dated[0];
}

/** A short CHECK vocabulary of plain words: what a breakdown divides by, and — named like a state — a tab strip. */
function vocabColumns(table: TableMeta): ColumnMeta[] {
  return table.columns.filter(
    (c) => (c.allowed?.length ?? 0) >= 2 && (c.allowed?.length ?? 0) <= 6 && c.allowed!.every((v) => WORD.test(v)),
  );
}

/* The column that names a table's rows, unless a sample of the rows says it
   is empty in all of them — a name nobody filled in names nothing. */
let emptyColumns: ReadonlySet<string> = new Set();
function labelColumn(table: TableMeta): string | undefined {
  const name = schemaLabelColumn(table);
  return name && emptyColumns.has(`${table.name}.${name}`) ? primaryKey(table)[0] : name;
}

/* A secondary source's table is `source.table`: it is named by its own part. */
const localName = (name: string) => name.slice(name.lastIndexOf('.') + 1);

function describe(schema: DatabaseSchema, table: TableMeta, viewKeys: Set<string>, qualifier?: string): TableInfo {
  const local = localName(table.name);
  const said = spoken(humanName(local) || local);
  const lowered = /^[A-Z]{2}/.test(said) ? said : said.charAt(0).toLowerCase() + said.slice(1);
  const one = singularOf(lowered);
  const many = pluralNoun(one);
  /* recordNoun's default is the table's name as said: a table named in the
     plural ("orders") needs its noun written, or every New reads "New orders";
     so does one said with an acronym ("PO line"), or a word with no plural. */
  const plain = humanName(local) || local;
  const bare = plain.charAt(0).toLowerCase() + plain.slice(1);
  const last = one.split(' ').at(-1)!;
  const noun =
    IRREGULAR_PLURAL[last] || MASS.has(last.toLowerCase()) || many !== pluralOf(one) ? { one, many } : one === bare ? undefined : one;
  /* Two sources each with a `partner`: the list says whose. */
  const label = `${headingOf(many)}${qualifier ? ` (${humanName(qualifier)})` : ''}`;
  const refs = new Map<string, { target: TableMeta; label?: string }>();
  for (const fk of schema.foreignKeys) {
    if (fk.from.table !== table.id || fk.from.columns.length !== 1) continue;
    const target = schema.tables.find((tb) => tb.id === fk.to.table);
    if (!target) continue;
    const name = labelColumn(target);
    refs.set(fk.from.columns[0], {
      target,
      label:
        name &&
        !surrogate(
          target,
          target.columns.find((c) => c.name === name)!,
        )
          ? name
          : undefined,
    });
  }
  const vocab = vocabColumns(table);
  const status = vocab.find((c) => /status|state|stage|phase/i.test(c.name));
  /* A lifecycle may run longer than a tab strip's six: the machine reads up to ten states. */
  const lifecycle =
    status ??
    table.columns.find(
      (c) => /(^|_)(status|state|stage|phase)$/i.test(c.name) && (c.allowed?.length ?? 0) > 6 && c.allowed!.every((v) => WORD.test(v)),
    );
  const machine = lifecycle ? draftMachine(table, lifecycle) : undefined;
  const date = dateColumn(table);
  const title = labelColumn(table);
  /* A list says what a person scans a list for: the row's name, its state,
     who or what it belongs to (by name, never the id), its figures and its
     date — at most six. Keys the database handed out, versions, secrets,
     long text and housekeeping stamps stay on the record page or off it. */
  const candidates: string[] = [];
  const push = (entry: string | undefined) => {
    if (entry && !candidates.includes(entry)) candidates.push(entry);
  };
  const shown = (c: ColumnMeta) =>
    !surrogate(table, c) && !opaque(c) && !HOUSEKEEPING.test(c.name) && !(LONG_TEXT.test(c.name) && c.name !== title);
  if (title) push(table.columns.find((c) => c.name === title && shown(c))?.name);
  if (status) push(status.name);
  for (const c of vocab) if (shown(c)) push(c.name);
  for (const c of table.columns) {
    if (!shown(c)) continue;
    const ref = refs.get(c.name);
    if (ref) {
      if (ref.label) push(`${c.name}.${ref.label}`);
      continue;
    }
    /* A member of a composite reference is half a hop: a raw id, hidden. */
    if (c.references) continue;
    push(c.name);
  }
  return {
    table,
    key: keyFor(qualifier ? `${qualifier} ${many}` : many, viewKeys),
    one,
    many,
    noun,
    label,
    icon: iconFor(local),
    refs,
    status,
    ...(machine ? { machine } : {}),
    vocab: status ?? vocab[0],
    date,
    show: candidates.slice(0, 6),
  };
}

/* ---------- a record's name ---------- */

/* A name that is a code within its parent: unit "B103" is Maple Court's B103. */
const CODE_NAME = /^(label|code|number|num|no|unit|slot|position)$/i;

/** How a table's own name column reads: a name, a code within a parent, or no name at all. */
function nameKind(table: TableMeta): 'strong' | 'code' | 'weak' {
  const name = schemaLabelColumn(table);
  const column = name ? table.columns.find((c) => c.name === name) : undefined;
  if (!column || column.primaryKey || column.nullable || emptyColumns.has(`${table.name}.${name}`) || LONG_TEXT.test(column.name))
    return 'weak';
  return CODE_NAME.test(column.name) ? 'code' : 'strong';
}

/* A count of what a line holds: an order line's quantity, a work order's parts. */
const QUANTITY = /^(qty|quantity)$|_(qty|quantity)$/i;

/**
 * The words that tell a record from its siblings, as template fields of its
 * own table: a required kind ("follow-up"), or its own required words (a
 * bike's make and model). Never a date, a code, a note or a contact.
 */
function ownWords(info: TableInfo): string[] {
  const { table } = info;
  const kind = table.columns.find((c) => c !== info.status && !c.nullable && (c.allowed?.length ?? 0) >= 2 && !c.flag);
  if (kind) return [kind.name];
  return table.columns
    .filter(
      (c) =>
        !c.nullable &&
        !c.primaryKey &&
        !emptyColumns.has(`${table.name}.${c.name}`) &&
        !info.refs.has(c.name) &&
        !c.references &&
        !c.allowed?.length &&
        !opaque(c) &&
        columnKind(c.type ?? '') === 'text' &&
        !/_(at|on|date)$/i.test(c.name) &&
        !LONG_TEXT.test(c.name) &&
        !CONTACT.test(c.name) &&
        !CODE_NAME.test(c.name) &&
        !/(^|_)(sku|serial|code|ref|reference|number|no|slug|hash|key|token|uuid|guid)$/i.test(c.name) &&
        !HOUSEKEEPING.test(c.name),
    )
    .slice(0, 2)
    .map((c) => c.name);
}

/**
 * The record's name where its own column does not say it, read up its parent
 * chain: a unit is "Maple Court B103", a visit "Ada Park · follow-up", a bike
 * "Ada Park · Trek FX 3", a work order its customer and the bike's make and
 * model (two hops: the bike has no name either), and a line what it holds and
 * how many ("Brake pads × 2"). A row with none of these is said by its noun and
 * key ("Payment #12") rather than by an optional note or a payment method.
 * Only required references: a name with a hole in it reads as a bug.
 */
function recordLabelFor(info: TableInfo, byId: Map<string, TableInfo>): string | undefined {
  const { table } = info;
  const own = nameKind(table);
  if (own === 'strong') return undefined;
  const position = (column: string) => table.columns.findIndex((c) => c.name === column);
  const required = [...info.refs]
    .filter(([column, ref]) => ref.label && table.columns.find((c) => c.name === column)?.nullable === false)
    .sort(([a], [b]) => position(a) - position(b));
  const strong = required.filter(([, ref]) => nameKind(ref.target) === 'strong');
  const parent = strong[0];
  const key = primaryKey(table);
  const name = schemaLabelColumn(table);
  const field = ([column, ref]: (typeof required)[number]) => `{${column}.${ref.label}}`;
  if (own === 'code') return parent ? `${field(parent)} {${name}}` : undefined;
  /* A line is what it holds, counted: of its named references, the thing with a price, else the last. */
  const quantity = table.columns.find((c) => QUANTITY.test(c.name) && !c.nullable && columnKind(c.type ?? '') === 'number');
  if (quantity && strong.length) {
    const held = strong.find(([, ref]) => ref.target.columns.some(isMoney)) ?? strong.at(-1)!;
    return `${field(held)} × {${quantity.name}}`;
  }
  const mine = ownWords(info);
  const kinded = mine.length === 1 && table.columns.find((c) => c.name === mine[0])?.allowed?.length;
  const sibling = strong.find((entry) => entry !== parent);
  /* A reference without a name of its own is said by its own words, one hop on: a work order's bike by its make and model. */
  const weak = [...info.refs]
    .filter(([column]) => table.columns.find((c) => c.name === column)?.nullable === false && !strong.some(([s]) => s === column))
    .sort(([a], [b]) => position(a) - position(b))
    .map(([column, ref]) => ({
      column,
      /* Its own name when every row has one (a unit's label); else the words every row has (a bike's make and model). */
      words:
        ref.label && ref.target.columns.find((c) => c.name === ref.label)?.nullable === false
          ? [ref.label]
          : byId.get(ref.target.id)
            ? ownWords(byId.get(ref.target.id)!)
            : [],
    }))
    .find((entry) => entry.words.length);
  const second = kinded
    ? `{${mine[0]}}`
    : sibling
      ? field(sibling)
      : mine.length
        ? mine.map((c) => `{${c}}`).join(' ')
        : weak
          ? weak.words.map((c) => `{${weak.column}.${c}}`).join(' ')
          : undefined;
  if (parent && second) return `${field(parent)} · ${second}`;
  if (second && mine.length && !kinded) return second;
  /* A weak name the catalog would still choose (an optional note) is written over; none at all is the App's default. */
  return name && key.length === 1 && !table.columns.find((c) => c.name === name)?.primaryKey
    ? nounTemplate(headingOf(info.one), key[0])
    : undefined;
}

/* ---------- what the schema says about the work ---------- */

/* The people who do the work and sign in to do it, by the table's head noun: never the customers it is done for. */
const STAFF =
  /^(staff|staffer|user|employee|mechanic|technician|tech|agent|rep|worker|driver|operator|engineer|nurse|doctor|physician|clinician|instructor|teacher|provider|dispatcher|manager|associate|team_member|crew|crew_member|courier|inspector|stylist|therapist|trainer|coach|consultant|accountant|attorney|lawyer|planner|developer|designer|librarian|volunteer)s?$/i;

/** A staff table's sign-in column: an email every row has, or one the database holds unique. */
function staffTable(table: TableMeta): string | undefined {
  const local = localName(table.name).toLowerCase();
  if (!STAFF.test(local) && !STAFF.test(local.slice(local.lastIndexOf('_') + 1))) return undefined;
  const email = table.columns.find(
    (c) => /(^|_)e_?mail$/i.test(c.name) && columnKind(c.type ?? '') === 'text' && (!c.nullable || table.unique?.includes(c.name)),
  );
  return email?.name;
}

/* A line's price: what one of the things it counts costs, never the total it comes to. */
const UNIT_PRICE = /^(unit_price|price|unit_cost|cost|rate|unit_amount)$/i;

/** A line's total, worked out from its own quantity and price: `quantity * unit_price`, named where nothing else is. */
function lineTotalOf(info: TableInfo): { name: string; expression: string } | undefined {
  const { table } = info;
  const quantity = table.columns.find((c) => QUANTITY.test(c.name) && columnKind(c.type ?? '') === 'number' && !c.flag && !c.primaryKey);
  const price = table.columns.find((c) => UNIT_PRICE.test(c.name) && isMoney(c));
  if (!quantity || !price) return undefined;
  if (table.columns.some((c) => SUMMED.test(c.name) && isMoney(c))) return undefined;
  const name = ['line_total', 'total', 'amount'].find((candidate) => !table.columns.some((c) => c.name === candidate));
  return name ? { name, expression: `${quantity.name} * ${price.name}` } : undefined;
}

/** The machine as written: each state's verbs in the graph's order (the forward one first, the stepper's path), the
    finals marked, and each verb said in full only where it writes a stamp, asks a reason or asks first. */
function machineCall(machine: DraftedMachine): Call {
  const states = Object.fromEntries(
    machine.states.map((state) => {
      if (state === machine.path.at(-1) || machine.exits.includes(state)) return [state, { final: true }];
      const on = Object.fromEntries(
        machine.verbs
          .filter((verb) => verb.from.includes(state))
          .map((verb) => {
            const extra = {
              ...(verb.stamps.length ? { set: Object.fromEntries(verb.stamps.map((stamp) => [stamp, filled('now')])) } : {}),
              ...(verb.reason ? { reason: verb.reason } : {}),
              ...(verb.confirm ? { confirm: true } : {}),
            };
            return [verb.verb, Object.keys(extra).length ? { to: verb.to, ...extra } : verb.to];
          }),
      );
      return [state, { on }];
    }),
  );
  return call('machine', machine.column, states, ...(machine.since ? [{ since: machine.since }] : []));
}

/**
 * A segment's name on a table: the first of `words` the query language and the resource do not already read — a
 * column, a computed column, a state of its machine, a segment it declares — else that word and what the rows are
 * (`open_orders`), as a machine's states take the plain words first.
 */
function segmentNameFor(info: TableInfo, resource: Record<string, unknown>, ...words: string[]): string {
  const slug = (said: string) => {
    const name = said
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return /^[a-z_]/.test(name) ? name : `segment_${name}`;
  };
  const free = (name: string) =>
    !LANGUAGE_WORDS.has(name) &&
    !info.table.columns.some((c) => c.name.toLowerCase() === name) &&
    !info.machine?.states.includes(name) &&
    !Object.hasOwn((resource.computed as object | undefined) ?? {}, name) &&
    !Object.hasOwn((resource.segments as object | undefined) ?? {}, name);
  const tried = words.map(slug);
  const base = tried.find(free) ?? `${tried[0]}_${slug(info.many)}`;
  let name = base;
  for (let n = 2; !free(name); n++) name = `${base}_${n}`;
  return name;
}

/** Declares a segment on the resource, its label written only where its name would say another. */
function declareSegment(resource: Record<string, unknown>, name: string, query: string, label?: string): void {
  const segments = (resource.segments ??= {}) as Record<string, unknown>;
  segments[name] = label && label !== humanName(name) ? { query, label } : query;
}

/**
 * Sign-in for an App whose work is done by staff who have emails: `me` is their row, so "My work orders" is a query.
 * Two roles: the staff, who change the work but not who is on the staff, and an admin, who changes everything — the
 * account a first start makes (MISTRI_AUTH_ADMIN_EMAIL). Over a read-only connection both only read.
 */
/** Which first-shot recipe (skills/mistri/references/recipes.md) the draft is nearest, and the schema's reason. */
interface Recipe {
  name: string;
  why: string;
}

const NAMED = (infos: TableInfo[], pattern: RegExp) => infos.filter((info) => pattern.test(localName(info.table.name)));
const listed = (infos: TableInfo[]) => infos.map((info) => info.label.toLowerCase()).join(', ');

/* The recipe is read off the tables' names and shapes, most particular first: a forum and a CRM name themselves; work
   moving through states toward the people who do it is a service desk, even beside a parts table with stock. */
function recipeFor(described: TableInfo[], hero: TableInfo | undefined, people: TableInfo | undefined): Recipe {
  const forum = NAMED(described, /^(posts?|threads?|topics?|replies|reply|comments?|forums?|boards?)$/i);
  if (forum.length >= 2)
    return { name: 'Community or forum', why: `${listed(forum)} read as conversations, so the draft leads with reading.` };
  const crm = NAMED(described, /^(leads?|accounts?|contacts?|deals?|opportunit(y|ies)|pipelines?|prospects?)$/i);
  if (crm.length >= 2) return { name: 'CRM', why: `${listed(crm)} are a sales pipeline's tables.` };
  if (hero?.machine && people && [...hero.refs.values()].some((ref) => ref.target.id === people.table.id))
    return {
      name: 'Service desk or ticketing',
      why: `${hero.label.toLowerCase()} move through states (${hero.machine.path.join(' → ')}) and each is someone's among the ${people.label.toLowerCase()}, so the draft gives them a "My ${hero.label.toLowerCase()}" queue.`,
    };
  const stock = described.filter((info) =>
    info.table.columns.some((c) => /^(stock|on_hand|quantity_on_hand|qty_on_hand|in_stock)$/i.test(c.name)),
  );
  const moves = NAMED(described, /^(stock_)?(movements?|moves?|transfers?|receipts?|adjustments?|warehouses?|locations?|bins?)$/i);
  if (stock.length && moves.length)
    return { name: 'Inventory or warehouse', why: `${listed(stock)} hold stock that ${listed(moves)} move.` };
  const catalog = NAMED(described, /^(listings?|products?|items?|vehicles?|properties|property|catalog\w*)$/i).filter((info) =>
    info.table.columns.some((c) => isMoney(c)),
  );
  if (catalog.length && !hero?.machine) return { name: 'Marketplace or catalog', why: `${listed(catalog)} are priced things to browse.` };
  if (people) return { name: 'Internal admin tool', why: `${people.label.toLowerCase()} sign in to work the other tables.` };
  return { name: 'Anything else', why: 'no table names a kind of App, so the draft keeps the shared spine.' };
}

function authFor(people: TableInfo, email: string, written: TableInfo[]): Record<string, unknown> {
  const said = keyFor(people.one, new Set()).replace(/-/g, '_');
  const role = /^[a-z][a-z0-9_]*$/.test(said) && said !== 'admin' ? said : 'staff';
  const work = written.filter((info) => info !== people).map((info) => info.table.name);
  return {
    providers: ['email'],
    me: { from: people.table.name, column: email },
    defaultRole: role,
    roles: {
      [role]: { label: headingOf(people.one), read: true, ...(work.length ? { write: work } : {}) },
      admin: { label: 'Admin', read: true, ...(written.length ? { write: true } : {}) },
    },
  };
}

/** The App's definition with the actions that run any of these commands left out (a copy; the draft keeps them). */
function withoutCommandActions(app: Record<string, unknown>, commands: ReadonlySet<string>): Record<string, unknown> {
  type Resource = {
    actions?: Record<string, { command?: string }>;
    machine?: { states?: Record<string, { on?: Record<string, unknown> }> };
  };
  const copy = structuredClone(app) as { resources?: Record<string, Resource> };
  for (const resource of Object.values(copy.resources ?? {})) {
    for (const [id, action] of Object.entries(resource.actions ?? {}))
      if (action.command && commands.has(action.command)) delete resource.actions![id];
    for (const state of Object.values(resource.machine?.states ?? {}))
      /* A verb that names a command is renamed, not dropped: a state's step still has to be one. */
      for (const verb of Object.keys(state.on ?? {}))
        if (commands.has(verb)) {
          state.on![verb.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()] = state.on![verb];
          delete state.on![verb];
        }
  }
  return copy as Record<string, unknown>;
}

/** Sign-in with the roles a brief names: the first that is not an admin one is what a new account gets. */
function authFromBrief(
  roles: NonNullable<NonNullable<ScaffoldOptions['brief']>['roles']>,
  people?: { table: string; column: string },
): Record<string, unknown> {
  const grant = (list: true | string[] | undefined) => (list === true ? true : list?.length ? list : undefined);
  return {
    providers: ['email'],
    ...(people ? { me: { from: people.table, column: people.column } } : {}),
    defaultRole: (roles.find((role) => !/admin|owner/.test(role.id)) ?? roles[0]).id,
    roles: Object.fromEntries(
      roles.map((role) => [
        role.id,
        {
          label: role.label,
          ...(grant(role.read) ? { read: grant(role.read) } : {}),
          ...(grant(role.write) ? { write: grant(role.write) } : {}),
          ...(role.commands.length ? { commands: role.commands } : {}),
        },
      ]),
    ),
  };
}

/* A TEXT column named for a day or a moment: `due_on`, `start_date` a day; `ready_at` a moment. */
const TEXT_DAY = /(_on|_date|^date|(^|_)(birthday|dob|birth_date))$/i;
const TEXT_MOMENT = /_at$/i;

/** The SQLite text columns that hold dates, by their names, as the App's `types` declares them. */
function textDates(schema: DatabaseSchema): DeclaredDate[] {
  if (schema.dialect !== 'sqlite') return [];
  return schema.tables
    .filter((table) => !table.isView)
    .flatMap((table) =>
      table.columns.flatMap((column): DeclaredDate[] => {
        if (column.primaryKey || column.references || column.allowed?.length || !/^(text|varchar.*|char.*|)$/i.test(column.type.trim()))
          return [];
        const as = TEXT_DAY.test(column.name) ? 'date' : TEXT_MOMENT.test(column.name) ? 'datetime' : undefined;
        return as ? [{ table: table.id, column: column.name, as }] : [];
      }),
    );
}

/* ---------- the shell ---------- */

/** The menu's folded part: the records in one group, the lookups in another; two groups of one are one group.
    The lookups are filed under rather than worked in, so their section starts folded in a side menu. */
function navGroups(records: TableInfo[], lookups: TableInfo[]): unknown[] {
  const group = (id: string, label: string, members: TableInfo[], icon: string) =>
    call(
      'navGroup',
      id,
      label,
      members.map((info) => info.key),
      { icon },
    );
  if (records.length < 2 && lookups.length < 2)
    return records.length + lookups.length > 1
      ? [group('more', 'More', [...records, ...lookups], 'stack')]
      : [...records, ...lookups].map((info) => info.key);
  return [
    ...(records.length > 1 ? [group('records', 'Records', records, 'stack')] : records.map((info) => info.key)),
    ...(lookups.length > 1
      ? [
          call(
            'navGroup',
            'lookups',
            'Lookups',
            lookups.map((info) => info.key),
            { icon: 'tag', folded: true },
          ),
        ]
      : lookups.map((info) => info.key)),
  ];
}

/* ---------- a New form ---------- */

/* A date a new record is stamped with as it is entered: today, or now for a date and time. */
const STAMPED =
  /^(created|registered|reported|opened|submitted|posted|logged|recorded|joined|placed|ordered|prescribed|worked|entered|issued|raised|received)_(on|at|date)$/i;
const CONTACT =
  /^(email|e_mail|phone|mobile|telephone|fax|website|url|address|street|city|state|region|postcode|postal_code|zip|zip_code|country)$|_(email|phone|address)$/i;
const DATETIME = /time|timestamp/i;
/* A date a record is planned by, rather than stamped with: when it is due, starts, ends or is booked for. */
const PLANNED = /(^|_)(due|deadline|starts?|ends?|begins?|expires?|scheduled|planned|target|renew\w*|until|from|to)(_|$)/i;

/**
 * A New form in the samples' shape (Compass's lead, Depot's product): its
 * fields grouped under nouns — what the record is and whom it belongs to,
 * how to reach them, the rest, then its notes — required vocabularies and
 * entry stamps filled in, and a reference narrowed to the chosen parent's
 * records where one field's table belongs to another's (a task's milestone
 * to its project). Drafted for every table; it is drawn once a resource
 * takes writes.
 */
function formFor(info: TableInfo, byId: Map<string, TableInfo>): Record<string, unknown> | undefined {
  const { table } = info;
  /* What a person types, and whatever the database will not fill in itself — a key it hands out no value for is asked.
     Never what the machine writes: a new record starts in its first state, and its stamps are written as it moves. */
  const assigned = autoKey(table);
  const moved = info.machine ? machineWrites(table, info.machine) : new Set<string>();
  for (const verb of info.machine?.verbs ?? []) if (verb.reason) moved.add(verb.reason);
  /* The machine's own column is asked only where the database gives no first state; then the form starts it there. */
  const column = info.machine && table.columns.find((c) => c.name === info.machine!.column);
  if (column && !column.hasDefault && column.default === undefined) moved.delete(column.name);
  const editable = table.columns.filter(
    (c) =>
      !moved.has(c.name) &&
      (isRequired(c, assigned) || (!surrogate(table, c) && !opaque(c) && !HOUSEKEEPING.test(c.name) && c.identity === undefined)),
  );
  if (editable.length < 3) return undefined;
  const name = schemaLabelColumn(table);
  const long = (c: ColumnMeta) => LONG_TEXT.test(c.name) && !CONTACT.test(c.name) && c.name !== name;
  const identity = editable.filter((c) => c.name === name || info.refs.has(c.name) || ((c.allowed?.length ?? 0) >= 2 && !c.flag));
  const contact = editable.filter((c) => !identity.includes(c) && CONTACT.test(c.name));
  const notes = editable.filter((c) => !identity.includes(c) && !contact.includes(c) && long(c));
  let rest = editable.filter((c) => !identity.includes(c) && !contact.includes(c) && !notes.includes(c));
  /* The rest is named by what it holds, never "Details": what it costs and
     runs for is its terms (a lease's rent, start and renewal), the dates it
     is planned by its schedule (a task's due date and estimate); anything
     else describes the record itself, and joins its first group. */
  const restLabel = rest.some(isMoney)
    ? 'Terms'
    : rest.some((c) => columnKind(c.type ?? '') === 'date' && !STAMPED.test(c.name) && PLANNED.test(c.name))
      ? 'Schedule'
      : undefined;
  if (!restLabel) {
    identity.push(...rest);
    rest = [];
  }
  /* The name first, then what it belongs to (required before optional), then how it stands. */
  const rank = (c: ColumnMeta) => (c.name === name ? 0 : info.refs.has(c.name) ? (c.nullable ? 2 : 1) : 3);
  identity.sort((a, b) => rank(a) - rank(b));
  const groups = [
    { label: headingOf(info.one), fields: identity },
    { label: 'Contact', fields: contact },
    { label: restLabel ?? '', fields: rest },
    { label: 'Notes', fields: notes },
  ].filter((group) => group.fields.length);
  const show = groups.flatMap((group) => group.fields.map((c) => c.name));

  const defaults: Record<string, unknown> = {};
  const fields: Record<string, Record<string, unknown>> = {};
  /* A vocabulary's schema DEFAULT is the form's start already (formRules.ts): written again it is a restatement. */
  const schemaDefaults = inferredFormDefaults(table);
  for (const c of editable) {
    if (c.allowed?.length && !c.flag && !c.nullable) {
      if (schemaDefaults[c.name] === undefined) defaults[c.name] = c.allowed[0];
    } else if (isMoney(c)) {
      /* A price copied from the record a reference chooses: a line's unit price is its part's price, as the part is
         picked, until the person writes their own. */
      const bare = c.name.replace(/^(unit|list|sale|base|retail)_/i, '');
      const source = [...info.refs]
        .filter(([column]) => table.columns.find((other) => other.name === column)?.nullable === false)
        .flatMap(([column, ref]) =>
          ref.target.columns
            .filter((other) => isMoney(other) && [c.name, bare, 'price'].includes(other.name))
            .map((other) => `${column}.${other.name}`),
        )[0];
      if (source) defaults[c.name] = { from: source };
    } else if (columnKind(c.type ?? '') === 'date' && STAMPED.test(c.name)) {
      defaults[c.name] = filled(DATETIME.test(c.type ?? '') ? 'now' : 'today');
      fields[c.name] = { help: `${DATETIME.test(c.type ?? '') ? 'Now' : 'Today'}, unless you are entering an older ${info.one}.` };
    }
  }
  /* A reference whose records each belong to a parent this form also asks for, and must, offers only the chosen
     parent's: a task's milestone is one of its project's. Asked earlier, the parent is chosen first. */
  const required = (of: TableMeta, column: string) => of.columns.find((c) => c.name === column)?.nullable === false;
  for (const [column, ref] of info.refs) {
    const target = byId.get(ref.target.id);
    if (!target || !show.includes(column)) continue;
    const parents = [...target.refs]
      .filter(([hop]) => required(target.table, hop))
      .flatMap(([hop, up]) => {
        const own = [...info.refs].find(
          ([other, mine]) =>
            other !== column && mine.target.id === up.target.id && required(table, other) && show.indexOf(other) < show.indexOf(column),
        );
        return own ? [{ hop, own: own[0], parent: up.target }] : [];
      })
      .sort((a, b) => show.indexOf(a.own) - show.indexOf(b.own));
    const [pick] = parents;
    if (!pick) continue;
    fields[column] = {
      ...fields[column],
      where: { [pick.hop]: pick.own },
      help: `Only the ${target.many} of the chosen ${byId.get(pick.parent.id)?.one ?? humanName(pick.own).toLowerCase()}.`,
    };
  }
  /* Groups for a form long enough to need them, and then they are what the form shows; a short one reads as one column. */
  const grouped = show.length >= 6 && groups.length > 1;
  return {
    ...(grouped ? {} : { show }),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    ...(grouped ? { groups: groups.map((group) => ({ label: group.label, fields: group.fields.map((c) => c.name) })) } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

/* ---------- the draft ---------- */

interface ScaffoldOptions {
  name?: string;
  /**
   * What a brief (cli/brief.ts) says beyond the schema, which the draft would otherwise infer or leave out: the look,
   * the mark, the roles (which replace the two a staff table gets, and sign-in with them), and the commands' buttons,
   * each an action on its resource that runs the command by id (its module is the caller's file).
   */
  brief?: {
    theme?: string;
    logo?: string;
    roles?: Array<{ id: string; label: string; read: true | string[]; write?: true | string[]; commands: string[] }>;
    commands?: Array<{ id: string; table: string; label: string; set: Record<string, string> }>;
  };
  /** The tables to draft a list view of, in nav order. Absent means every non-join, non-view table. */
  tables?: string[];
  /** The configured connection the App binds, when it has a name worth writing. */
  connection?: string;
  /** Every configured connection's name, for the generated `Connections` type. */
  connections?: readonly string[];
  /** How the project reaches its database: a config file its scripts name, or a SQLite file a `mistri.json`
      beside the App names — config paths are relative to the App; CLI SQLite paths are absolute, never a URL with a password. */
  database?: { config: string } | { sqlite: string };
  /** `table.column` pairs, by logical name, a sample of the rows found empty: never a record's name. */
  emptyColumns?: ReadonlySet<string>;
  /** Whether the connection takes writes: a first run that says "Add your first…" over a read-only one invites what it refuses. */
  writable?: boolean;
  /**
   * Several configured connections, drafted as one App with `sources`: the
   * first is the default, whose resources stay bare; the rest are named
   * `source.table`. When given, the schema argument is the first one's.
   */
  sources?: Array<{
    name: string;
    connection: string;
    schema: DatabaseSchema;
    writable?: boolean;
    /** The one schema of its connection this source sees, where one database is drafted as a source per schema. */
    scope?: string;
  }>;
}

/* Bookkeeping a migration tool keeps beside the data (Liquibase, Flyway): no
   person opens it, and every schema a tool migrates has its own copy. */
const MIGRATION_TABLES = /^(databasechangelog|databasechangeloglock|flyway_schema_history)$/i;

/** The catalog a draft is written against: logical tables, and where each one physically is. */
interface DraftCatalog {
  schema: DatabaseSchema;
  /** The physical table behind a logical name, and the source that holds it (undefined without sources). */
  physical(logical: string): { id: string; name: string; source?: string };
  /** A table the caller named, by logical or physical name. */
  lookup(name: string): string | undefined;
}

function draftCatalog(physicalSchema: DatabaseSchema, opts: ScaffoldOptions): DraftCatalog {
  if (!opts.sources?.length) {
    const catalog = appResourceCatalog(physicalSchema);
    const byId = new Map(physicalSchema.tables.map((table) => [table.id, table]));
    return {
      schema: catalog.schema,
      physical: (logical) => {
        const id = catalog.toPhysical(logical);
        return { id, name: byId.get(id)?.name ?? id };
      },
      lookup: (name) => {
        if (catalog.schema.tables.some((table) => table.name === name)) return name;
        const table = tableNamed(physicalSchema, name);
        return table ? catalog.toLogical(table.id) : undefined;
      },
    };
  }
  const [first] = opts.sources;
  const merged = createAppSourceCatalog(
    Object.fromEntries(
      opts.sources.map((source) => [
        source.name,
        { schema: source.schema, group: source.connection, ...(source.scope ? { scope: source.scope } : {}) },
      ]),
    ),
    first.name,
  );
  const physicalOf = new Map(opts.sources.map((source) => [source.name, new Map(source.schema.tables.map((table) => [table.id, table]))]));
  return {
    schema: merged.schema,
    physical: (logical) => {
      const target = merged.resolve(logical);
      return {
        id: target.physicalTable,
        name: physicalOf.get(target.source)!.get(target.physicalTable)?.name ?? target.physicalTable,
        source: target.source,
      };
    },
    lookup: (name) => (merged.schema.tables.some((table) => table.name === name) ? name : undefined),
  };
}

interface Scaffolded {
  /** The draft as data: exactly what the files evaluate to, pages inline under `pages`. */
  app: Record<string, unknown>;
  /** The project, by path relative to the App directory. */
  files: Record<string, string>;
  /** Resolution errors the draft itself carries — a bug here, not a chore
      for the caller, and returned rather than thrown so the draft can
      still be inspected. */
  problems: string[];
  /** The first-shot recipe the draft is nearest, as the README says. */
  recipe: Recipe;
}

/**
 * A record page in the anatomy the samples share (shared/pageAnatomy.ts, the
 * rule the default page follows too): a header with the record's status and
 * a line of facts, a summary of its figures, the tables that point at it as
 * tabs of at most four columns, and beside them the card of the record it
 * belongs to, the child that is current (the next visit) and the rest of its
 * fields as a property rail named for the record, over its history. What only the draft knows rides in: which
 * columns it dresses as money, the name it found for each table, and which
 * tables it drafts at all.
 */
function recordPage(info: TableInfo, infos: TableInfo[], schema: DatabaseSchema, recordLabel?: string): Call {
  /* What the record's name already says (a visit's patient) is not said again under it. */
  const named = new Set([...(recordLabel ?? '').matchAll(/\{([^}.|]+)/g)].map((match) => match[1]));
  const byId = new Map(infos.map((other) => [other.table.id, other]));
  const anatomy = recordAnatomy(schema, info.table.id, {
    money: (_table, column) => isMoney(column),
    label: (table) => labelColumn(table),
    // A vocabulary the draft dresses in tones says how the record stands.
    status: (_table, column) => (column.allowed?.length && vocabularyTones(column.allowed) ? true : undefined),
    /* No history(): declaring one needs the record history store provisioned
       first (mistri docs pages), and a draft must start as it is written. */
    history: false,
    includes: (child) => byId.has(child.id),
    /* Two references from one table (raised by, assigned to), or one from the
       table to itself (manager), say which in the title. */
    title: (fk, child, ambiguous) => {
      const other = byId.get(child.id);
      if (!other) return undefined;
      return `${other.label}${ambiguous ? ` (${humanName(fk.from.columns[0].replace(/_id$/i, '')).toLowerCase()})` : ''}`;
    },
    noun: (table) => byId.get(table.id)?.one,
  });
  const sections: unknown[] = [];
  if (anatomy) {
    for (const section of anatomySections(anatomy)) {
      if (section.kind === 'fields' && section.presentation === 'header') {
        const facts = (section.paths ?? []).filter((path) => !named.has(path.split('.')[0]));
        /* A header with nothing to say is the served default page's way of
           holding a name-only record's name (pageAnatomy.ts); written, a
           header says a status or facts, so the scaffold leaves it out. */
        if (!section.status && !facts.length) continue;
        sections.push(call('header', { ...(section.status ? { status: section.status } : {}), ...(facts.length ? { facts } : {}) }));
      } else if (section.kind === 'fields' && section.presentation === 'summary') {
        sections.push(call('fields', section.paths ?? []));
      } else if (section.kind === 'fields' && section.presentation === 'card') {
        const [reference, ...rest] = section.paths ?? [];
        sections.push(
          call(
            'card',
            section.title ?? '',
            reference,
            rest.map((p) => p.slice(reference.length + 1)),
          ),
        );
      } else if (section.kind === 'fields') {
        sections.push(
          call('fields', section.paths ?? [], {
            title: section.title,
            /* A rail in the aside and a summary in the main column are what fields() draws unasked. */
            ...(section.presentation === 'properties' && section.region === 'aside'
              ? {}
              : section.presentation
                ? { presentation: section.presentation }
                : { columns: section.columns }),
            ...(section.region ? { region: section.region } : {}),
          }),
        );
      } else if (section.kind === 'list' && section.presentation === 'card' && anatomy.current) {
        const now = anatomy.current;
        sections.push(
          call('current', now.title, now.from, now.whose, {
            ...(now.query ? { query: now.query } : {}),
            ...(now.sort ? { sort: now.sort } : {}),
            ...(now.show.length ? { show: now.show } : {}),
          }),
        );
      } else if (section.kind === 'list') {
        const pick = anatomy.related.find((list) => list.from === section.from && list.whose === section.path)!;
        sections.push(
          call('related', pick.title ?? byId.get(section.from)?.label ?? humanName(section.from), section.from, section.path, {
            ...(pick.show.length ? { show: pick.show } : {}),
            ...(pick.sort ? { sort: pick.sort } : {}),
          }),
        );
      } else if (section.kind === 'history') {
        /* Untitled it says "History" in the reader's language, and it stands in the aside, eight writes at first. */
        sections.push(section.region === 'aside' ? call('history') : call('history', undefined, { region: 'main' }));
      }
    }
  }
  return call('page', info.table.name, sections, { listTabs: true });
}

export function scaffoldApp(physicalSchema: DatabaseSchema, opts: ScaffoldOptions = {}): Scaffolded {
  const catalog = draftCatalog(opts.sources?.[0]?.schema ?? physicalSchema, opts);
  /* SQLite keeps a date as text: a column named for one is declared one (`types`), so the draft — and the App — read it
     as a date from the first run: windows, a trend by month, a due date said from today. */
  const dates = opts.sources?.length ? [] : textDates(catalog.schema);
  const schema = withDeclaredDates(catalog.schema, dates);
  type Shaped = { joins: Array<{ table: { id: string } }> };
  const joinIds = new Set((describeSchema(schema) as unknown as Shaped).joins.map((j) => j.table.id));
  const wanted = opts.tables?.length
    ? opts.tables.map((name) => catalog.lookup(String(name)) ?? String(name))
    : schema.tables
        .filter((tb) => !tb.isView && !joinIds.has(tb.id) && !MIGRATION_TABLES.test(catalog.physical(tb.name).name))
        .map((tb) => tb.name);
  const tables = wanted
    .map((want) => schema.tables.find((tb) => tb.name === want || tb.id === want))
    .filter((tb): tb is TableMeta => Boolean(tb));
  const viewKeys = new Set(['overview']);
  emptyColumns = opts.emptyColumns ?? new Set();
  /* A table whose own name another drafted source also has says whose it is. */
  const locals = new Map<string, number>();
  for (const table of tables) locals.set(localName(table.name), (locals.get(localName(table.name)) ?? 0) + 1);
  const qualifierOf = (table: TableMeta) => {
    const source = catalog.physical(table.name).source;
    return source && (locals.get(localName(table.name)) ?? 0) > 1 ? source : undefined;
  };
  const described = tables.map((table) => describe(schema, table, viewKeys, qualifierOf(table)));
  const writable = (info: TableInfo) => {
    const source = catalog.physical(info.table.name).source;
    return source ? opts.sources?.find((s) => s.name === source)?.writable === true : opts.writable === true;
  };
  /* A machine moves records, and nothing moves over a read-only connection: there the status is a tab strip. */
  for (const info of described) if (!writable(info)) info.machine = undefined;
  /* A table that only ever belongs to others — an order's lines, a product's
     stock in each warehouse — is read on its parent's page, not from the menu:
     nothing points at it, it must point at a parent, and it is named as a part
     (`_line`, `_item`) or is little more than the references that join it. A
     list the caller asked for by name is always drafted. */
  const pointedAt = (info: TableInfo) => described.some((other) => [...other.refs.values()].some((ref) => ref.target.id === info.table.id));
  const partOf = (info: TableInfo) => {
    if (opts.tables?.length || pointedAt(info)) return false;
    const required = [...info.refs.keys()].filter((column) => info.table.columns.find((c) => c.name === column)?.nullable === false);
    if (!required.length) return false;
    const own = info.table.columns.filter((c) => !c.primaryKey && !info.refs.has(c.name) && !opaque(c));
    return (
      /(^|_)(line|lines|item|items|entry|entries|detail|details|allocation|allocations)$/i.test(info.table.name) ||
      (required.length >= 2 && own.length <= 2)
    );
  };
  const parts = new Set(described.filter(partOf));
  const infos = described.filter((info) => !parts.has(info));

  /* The main tables — the ones a record page and a card on the Overview are
     for. The hero is the busiest dated table, the one the others exist to
     serve; the rest are those other tables point at — a record page is for
     the records pointing at it — less the lookups (a code and a name). */
  const incoming = (info: TableInfo) =>
    described.filter((other) => [...other.refs.values()].some((ref) => ref.target.id === info.table.id)).length;
  const lookup = (info: TableInfo) => info.table.columns.filter((c) => !c.primaryKey && !opaque(c)).length <= 2;
  /* A record page opens one row by its key: a table without a primary key has
     no row to open, so it is listed and never paged — nor the hero the
     Overview is about. */
  const keyed = (info: TableInfo) => primaryKey(info.table).length > 0;
  const bySize = [...infos]
    .filter(keyed)
    .sort((a, b) => (b.table.approxRows ?? 0) - (a.table.approxRows ?? 0) || incoming(b) - incoming(a));
  /* Work that moves through states is what the rest exist to serve: over an empty database, it leads. */
  const hero =
    bySize.find((info) => info.machine && info.date && !lookup(info) && info.table.approxRows === bySize[0].table.approxRows) ??
    bySize.find((info) => info.date && !lookup(info)) ??
    bySize.find((info) => info.machine && !lookup(info)) ??
    bySize.find((info) => !lookup(info)) ??
    bySize[0];
  const main = infos
    .filter(keyed)
    .filter((info) => info === hero || (!lookup(info) && incoming(info) > 0))
    .sort(
      (a, b) =>
        Number(b === hero) - Number(a === hero) ||
        incoming(b) + (b.status ? 1 : 0) - (incoming(a) + (a.status ? 1 : 0)) ||
        (b.table.approxRows ?? 0) - (a.table.approxRows ?? 0),
    )
    .slice(0, 4);

  /* Resources: the record's noun where the table's name would not say it,
     and display rules guessed from names, types and CHECK vocabularies —
     guesses an author deletes in a second and would have typed for an hour. */
  /* Who signs in: the staff table — mechanics, agents, employees — with an email to sign in by. Its rows are the people
     `me` names (auth.me), so a reference to it is someone's work, and that work is their "My …" queue. */
  const people = described.filter(keyed).find((info) => staffTable(info.table) !== undefined);
  const peopleEmail = people ? staffTable(people.table) : undefined;
  /* A brief's command that moves a status its table's machine already draws takes that verb over: the machine names the
     command (`confirmBooking: 'confirmed'`) instead of the draft offering a second button for the same step. */
  const verbs = new Set<string>();
  for (const command of opts.brief?.commands ?? []) {
    const machine = described.find((info) => info.table.name === command.table)?.machine;
    const to = machine ? command.set[machine.column] : undefined;
    const verb = to === undefined ? undefined : machine!.verbs.find((candidate) => candidate.to === to);
    if (!verb) continue;
    verb.verb = command.id;
    verbs.add(command.id);
  }
  const resources: Record<string, Record<string, unknown>> = {};
  /* Each list's tabs, by the segments its resource declares for them. */
  const tabsOf = new Map<TableInfo, string[]>();
  /* The work still open on a table with a machine, declared once where the Overview first counts it. */
  const opened = new Map<TableInfo, string>();
  const openSegment = (info: TableInfo) => {
    let name = opened.get(info);
    if (name === undefined) {
      const resource = resources[info.table.name];
      name = segmentNameFor(info, resource, 'open', 'still_open');
      declareSegment(resource, name, `${info.machine!.column} is open`);
      opened.set(info, name);
    }
    return name;
  };
  const describedById = new Map(described.map((info) => [info.table.id, info]));
  const lineTotals = new Map(described.flatMap((info) => (lineTotalOf(info) ? [[info, lineTotalOf(info)!] as const] : [])));
  for (const info of described) {
    const display: Record<string, unknown> = {};
    const labels: Record<string, string> = {};
    /* Money, a percentage, a due date, a vocabulary's tones, a person's disc: the platform infers each at runtime
       (displayDefaults.ts), so the scaffold writes none of them. What it still writes is what a convention cannot
       say: the caption a unit leaves ("Duration", not "Duration minutes"), and a main table's mark. */
    for (const c of info.table.columns) {
      if (info.refs.has(c.name) || c.primaryKey || columnKind(c.type ?? '') !== 'number' || c.flag) continue;
      const unit = UNITS.find(([test]) => test.test(c.name));
      const rest = unit ? c.name.replace(unit[0], '') : '';
      if (rest) labels[c.name] = humanName(rest);
    }
    /* The name drawn as what it names: a main table's row led by its mark in a square tinted by its state — a list
       of things, not of rows. (A person's initials and email are the platform's convention.) */
    const title = labelColumn(info.table);
    const named = title !== undefined && nameKind(info.table) === 'strong' && !isPeople(info.table);
    const toned = info.status?.allowed?.length && vocabularyTones(info.status.allowed);
    if (named && toned && main.includes(info) && info.icon !== 'table' && info.icon !== 'users' && info.icon !== 'user') {
      display[title] = { icon: { mark: info.icon, toneOf: info.status!.name } };
    }
    /* A row with no name of its own is said by its noun and key ("Purchase
       order #3") — the App's default, written out where a sample found the
       would-be name empty, since the catalog alone would still choose it. */
    const recordLabel = recordLabelFor(info, describedById);
    const form = formFor(info, describedById);
    /* A name the catalog qualified (two schemas' `partner`) is pinned to its
       table, so it holds whatever else the database comes to hold. */
    const physical = catalog.physical(info.table.name);
    const pinned = physical.name !== localName(info.table.name);
    /* Edited where the connection takes writes — the person said so in its config. A resource reads by default and the
       validator refuses an 'access' of 'read', so a read-only table says nothing, with or without sign-in. */
    const access = writable(info) ? 'write' : undefined;
    const line = lineTotals.get(info);
    const types = Object.fromEntries(dates.filter((date) => date.table === info.table.id).map((date) => [date.column, date.as]));
    const computed = line ? { [line.name]: call('computed.number', line.expression) } : undefined;
    /* Where a short vocabulary says how the work divides, each of its words is a segment its list tabs by. */
    const segments: Record<string, unknown> = {};
    if (info.status?.allowed)
      tabsOf.set(
        info,
        info.status.allowed.map((v) => {
          const name = segmentNameFor(info, { computed, segments }, v);
          declareSegment({ segments }, name, `${info.status!.name} = ${v}`, vocabularyWord(v));
          return name;
        }),
      );
    resources[info.table.name] = {
      ...(pinned ? { physical: physical.id } : {}),
      ...(access ? { access } : {}),
      ...(info.noun ? { noun: info.noun } : {}),
      ...(recordLabel ? { recordLabel } : {}),
      ...(Object.keys(types).length ? { types } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(Object.keys(display).length ? { display } : {}),
      ...(computed ? { computed } : {}),
      ...(Object.keys(segments).length ? { segments } : {}),
      ...(info.machine ? { machine: machineCall(info.machine) } : {}),
      ...(form ? { form } : {}),
    };
  }

  /* A reference whose target's name may be empty (a bike's optional serial number) shows the target's own words
     instead (its model), so a list never has a column of blanks. */
  const byTable = new Map(described.map((info) => [info.table.id, info]));
  for (const info of described) {
    info.show = info.show.map((path) => {
      if (!path.includes('.')) return path;
      const column = path.slice(0, path.indexOf('.'));
      const ref = info.refs.get(column);
      const target = ref && byTable.get(ref.target.id);
      const named = ref && ref.target.columns.find((c) => c.name === path.slice(column.length + 1));
      const words = target ? ownWords(target) : [];
      return named?.nullable && words.length ? `${column}.${words.at(-1)}` : path;
    });
  }

  /* The list views: named, iconed, projected, filtered and — where a short
     vocabulary says how the work divides — tabbed, All last. */
  const lists: Record<string, Call> = {};
  for (const info of infos) {
    const { table } = info;
    const filters: string[] = [];
    for (const c of table.columns) if (c.allowed?.length && filters.length < 2) filters.push(c.name);
    for (const [column] of info.refs) if (filters.length < 3) filters.push(column);
    for (const c of table.columns) if (columnKind(c.type ?? '') === 'boolean' && filters.length < 4) filters.push(c.name);
    if (info.date && filters.length < 4) filters.push(info.date.name);
    /* The work's states in their order, then All, as every sample App's
       lists run: a list opens on its first state, the work to do now. */
    const named = tabsOf.get(info);
    const tabs = named ? [...named, { label: 'All' }] : undefined;
    lists[info.key] = call('listView', info.label, table.name, {
      icon: info.icon,
      ...(info.show.length ? { show: info.show } : {}),
      ...(filters.length ? { filters } : {}),
      ...(info.date ? { sort: `${info.date.name} desc` } : {}),
      ...(tabs ? { tabs } : {}),
      /* A main list with nothing in it says what belongs there, not "No rows": it is where a new App starts. */
      ...(main.includes(info)
        ? { empty: { title: `No ${info.many} yet`, ...(writable(info) ? { description: `Add the first ${info.one} with New.` } : {}) } }
        : {}),
    });
  }

  /* The work that is the signed-in person's: the busiest table that names a staff member, narrowed to `me` — and, with
     a machine, to what is still open — first in the menu after the Overview. */
  let mine: { key: string; info: TableInfo } | undefined;
  if (people) {
    const ASSIGNED = /(assign|owner|handler|responsible|worker|staff|employee|technician|mechanic|agent|rep)/i;
    for (const info of [...(hero ? [hero] : []), ...main, ...infos]) {
      if (info === people || !keyed(info)) continue;
      const refs = [...info.refs].filter(([, ref]) => ref.target.id === people.table.id);
      if (!refs.length) continue;
      const [column] = refs.find(([name]) => ASSIGNED.test(name)) ?? refs[0];
      const open = info.machine ? ` and ${info.machine.column} is open` : '';
      const due = info.table.columns.find((c) => DUE.test(c.name));
      const key = keyFor(`my ${info.many}`, viewKeys);
      const resource = resources[info.table.name];
      const segment = segmentNameFor(info, resource, 'mine', `my_${info.many}`);
      declareSegment(resource, segment, `${column} = me${open}`);
      lists[key] = call('listView', `My ${info.many}`, info.table.name, {
        icon: info.icon,
        query: segment,
        show: info.show.filter((path) => path !== column && !path.startsWith(`${column}.`)),
        sort: due ? `${due.name} asc` : info.date ? `${info.date.name} desc` : undefined,
        empty: { title: `No ${open ? 'open ' : ''}${info.many} of yours` },
      });
      if (!due && !info.date) delete (lists[key].args[2] as Opts).sort;
      mine = { key, info };
      break;
    }
  }

  /* The Overview: a count per main table; how the work flows through its
     states, as steps in their order where a status has three to six; how it
     trends by month and divides into its kinds, as a pair of charts; and its
     newest rows — the screen an ops App opens on. Over an empty database
     it opens on its first run instead: add the first record of each main
     table, the ones others point at first, since a row needs its parent. */
  let overview: Call | undefined;
  if (main.length) {
    const width = main.length === 2 || main.length === 4 ? 'half' : 'third';
    const needs = (info: TableInfo) =>
      [...info.refs.values()].filter((ref) => main.some((other) => other !== info && other.table.id === ref.target.id)).length;
    const order = [...main].sort((a, b) => needs(a) - needs(b));
    /* The first run asks for records, so only where they can be added. */
    const addable = order.filter(writable);
    const sections: Call[] = [
      ...(addable.length
        ? [
            call(
              'firstRun',
              'Get started',
              addable.map((info) => ({ label: `Add your first ${info.one}`, to: info.key })),
            ),
          ]
        : []),
      /* A table with a machine counts the work still open: the done and the called-off are history. */
      ...main.map((info) =>
        info.machine
          ? call('metric', `Open ${info.many}`, `${info.table.name}.${openSegment(info)}`, { width })
          : call('metric', info.label, info.table.name, { width }),
      ),
    ];
    const divided = main.find((info) => info.status) ?? main.find((info) => info.vocab);
    const monthly = main.find((info) => info.date);
    const by = divided?.status ?? divided?.vocab;
    /* Steps draw every value of the vocabulary, five to a row at a desk beside the side menu; a longer one is bars. */
    /* Where two lists read one table (the rent roll and "My …"), a group is a link to the whole one: said, since check
       asks which when it is not (drill-ambiguous). */
    const opens = (info: TableInfo): Opts => (mine?.info === info ? { to: info.key } : {});
    const flows = divided?.status && by === divided.status && (by.allowed?.length ?? 0) >= 3 && (by.allowed?.length ?? 0) <= 5;
    /* Charts pair across a row: an odd one out takes the newest rows beside it. */
    const halves: Call[] = [];
    if (divided && by) {
      const title = `${divided.label} by ${humanName(by.name).toLowerCase()}`;
      if (flows) sections.push(call('breakdown', title, divided.table.name, by.name, { shape: 'steps', ...opens(divided) }));
      else halves.push(call('breakdown', title, divided.table.name, by.name, { width: 'half', ...opens(divided) }));
    }
    if (monthly) {
      halves.push(
        call('chart', `${monthly.label} by month`, monthly.table.name, `month ${monthly.date!.name}`, {
          curve: 'smooth',
          width: 'half',
          ...opens(monthly),
        }),
      );
    }
    /* A second vocabulary — a kind, a channel, a priority — as shares of the whole, never the one the flow already said. */
    const kinds = main
      .flatMap((info) => vocabColumns(info.table).map((column) => ({ info, column })))
      .find(({ info, column }) => !column.flag && !(info === divided && column === by) && (column.allowed?.length ?? 0) <= 6);
    if (kinds) {
      halves.push(
        call('chart', `${kinds.info.label} by ${humanName(kinds.column.name).toLowerCase()}`, kinds.info.table.name, kinds.column.name, {
          shape: 'donut',
          total: kinds.info.label.slice(0, 40),
          width: 'half',
          ...opens(kinds.info),
        }),
      );
    }
    const newest = Boolean(hero?.date && hero.show.length);
    /* With nothing to stand beside it, an odd chart takes the row. */
    if (halves.length % 2 === 1 && !newest) {
      const [last] = halves.splice(-1);
      halves.push(call(last.fn, ...last.args.slice(0, -1), { ...(last.args.at(-1) as Opts), width: 'full' }));
    }
    sections.push(...halves);
    if (hero?.date && hero.show.length) {
      const beside = halves.length % 2 === 1;
      sections.push(
        call('rows', `Newest ${hero.many}`, hero.table.name, {
          /* Half a row has room for three columns at a desk; the rest would be left out (design lint's dashboard-columns). */
          show: hero.show.slice(0, beside ? 3 : 4),
          sort: `${hero.date.name} desc`,
          limit: 6,
          width: beside ? 'half' : 'full',
        }),
      );
    }
    overview = call('dashboard', 'Overview', sections, { icon: 'gauge' });
  }

  /* What a record's summary counts: how many of each drafted table point at
     it, and what their money adds up to — through one single-column
     reference each, so there is no `whose` to guess, and never a name one of
     its columns already has. A composite key to the same table (a line keyed
     by its order and its tenant) is a second reference the rollup would find,
     so then the draft names the single one with `whose`. */
  const rolled = new Map<string, Record<string, Call>>();
  for (const info of main) {
    const found: Record<string, Call> = {};
    const free = (name: string) =>
      /^[a-z_][a-z0-9_]*$/.test(name) &&
      !info.table.columns.some((c) => c.name === name) &&
      !Object.hasOwn(found, name) &&
      !Object.hasOwn((resources[info.table.name].segments as object | undefined) ?? {}, name);
    for (const child of described) {
      if (child === info || Object.keys(found).length >= 4) continue;
      const single = [...child.refs].filter(([, ref]) => ref.target.id === info.table.id);
      if (single.length !== 1) continue;
      const pointing = schema.foreignKeys.filter((fk) => fk.from.table === child.table.id && fk.to.table === info.table.id).length;
      const whose = pointing > 1 ? [{ whose: single[0][0] }] : [];
      const counted = child.many
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (free(counted)) found[counted] = call('count', child.table.name, ...whose);
      /* What its lines come to: the sum of each line's quantity times its price, named for what the lines are. */
      const line = lineTotals.get(child);
      if (line) {
        const own = info.one.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const total = `${counted.startsWith(`${own}_`) ? counted.slice(own.length + 1) : counted}_total`;
        if (free(total)) found[total] = call('sum', child.table.name, line.name, ...whose);
        continue;
      }
      /* A sum only of what adds up: a line's amount, never its unit price, nor a 0/1 flag named like money ("paid"). */
      const money = child.table.columns.find(
        (c) => columnKind(c.type ?? '') === 'number' && SUMMED.test(c.name) && !c.flag && !c.primaryKey && !child.refs.has(c.name),
      );
      if (money && free(money.name)) found[money.name] = call('sum', child.table.name, money.name, ...whose);
    }
    if (!Object.keys(found).length) continue;
    rolled.set(info.table.name, found);
    const resource = resources[info.table.name];
    resource.rollups = found;
    // A sum of money is money at runtime (displayDefaults.ts): nothing to write.
  }
  /* The pages read the rollups as the served catalog will, by name. */
  const withDrafted: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      rolled.has(table.name)
        ? {
            ...table,
            rollups: Object.fromEntries(
              Object.keys(rolled.get(table.name)!).map((name) => [name, { fn: 'count' as const, via: '', type: 'integer' }]),
            ),
          }
        : table,
    ),
  };
  const pageKeys = new Set<string>();
  /* A page for every main table and every table others point at — a
     property with its units, not only the payments that are busiest. */
  const paged = [...main, ...infos.filter((info) => !main.includes(info) && keyed(info) && !lookup(info) && incoming(info) > 0)];
  const pages = paged.map((info) => ({
    key: keyFor(info.table.name, pageKeys),
    info,
    page: recordPage(info, described, withDrafted, resources[info.table.name].recordLabel as string | undefined),
  }));

  const name = opts.name?.trim() || headingOf(humanName(databaseName(schema.label)) || 'App');
  const id = keyFor(name, new Set()) || 'app';
  const viewsTree: Record<string, unknown> = {
    ...(overview ? { overview: new Ref('overview', overview) } : {}),
    ...(mine ? { [mine.key]: lists[mine.key] } : {}),
    ...lists,
  };
  /* The nav leads with the Overview and the main tables, the rest after in
     the schema's order — or exactly the order the caller chose. A menu longer
     than a glance folds the rest into groups: the records, then the lookups
     they are filed under. */
  const others = infos.filter((info) => !main.includes(info) && !paged.includes(info));
  const flat = opts.tables?.length
    ? Object.keys(viewsTree)
    : [...(overview ? ['overview'] : []), ...paged.map((info) => info.key), ...others.map((info) => info.key)];
  /* The top bar holds about seven: past that, the pages beyond the main
     tables fold in with the other records. */
  const grouped = (open: TableInfo[], folded: TableInfo[]) => [
    ...(overview ? ['overview'] : []),
    ...open.map((info) => info.key),
    ...navGroups([...folded, ...others.filter((info) => !lookup(info))], others.filter(lookup)),
  ];
  const roomy = grouped(paged, []);
  const nav: unknown[] =
    opts.tables?.length || flat.length <= 6
      ? flat
      : roomy.length <= 7
        ? roomy
        : grouped(
            main,
            paged.filter((info) => !main.includes(info)),
          );
  if (mine && !nav.includes(mine.key)) nav.splice(overview ? 1 : 0, 0, mine.key);
  const home = overview ? 'overview' : flat[0];
  /* The brief's commands: a button on the record that runs each by id. The resource is written to, or the verb
     would refuse in front of the person it was drawn for. */
  for (const command of opts.brief?.commands ?? []) {
    const resource = resources[command.table];
    if (!resource || verbs.has(command.id)) continue;
    (resource.actions ??= {} as Record<string, unknown>) as Record<string, unknown>;
    (resource.actions as Record<string, unknown>)[command.id] = call('action', command.label, { command: command.id });
  }
  /* A look, a mark and a shell of its own: an App left in the default look
     with a flat menu reads as unstyled. The top menu, not the side, even for
     many tables: a record page's anatomy is a summary of up to four figures
     and tabs of four columns beside the aside, and at 1280 the side menu
     leaves the main column 538px — three figures and four short columns, the
     fourth figure wrapping until about 1480px (docs/design.md, "The aside is
     a budget"). The menu is folded short above, so it fits a bar. */
  const ui = {
    logo: opts.brief?.logo ?? (hero ? (hero.icon === 'table' ? 'stack' : hero.icon) : 'stack'),
    /* Lumen is the default look, written out so the choice is the author's to see and change. */
    theme: { preset: opts.brief?.theme ?? 'workshop' },
    shell: { placement: 'top' },
  };
  const pagesTree = Object.fromEntries(pages.map(({ key, page }) => [key, new Ref(identifier(key, 'Page'), page)]));
  const appTree: Record<string, unknown> = {
    id,
    name,
    ...(opts.sources?.length
      ? {
          sources: Object.fromEntries(
            opts.sources.map((source, i) => [
              source.name,
              {
                connection: source.connection,
                ...(source.scope ? { schema: source.scope } : {}),
                ...(i === 0 && (opts.sources?.length ?? 0) > 1 ? { default: true } : {}),
              },
            ]),
          ),
        }
      : opts.connection
        ? { connection: opts.connection }
        : {}),
    ...(opts.brief?.roles?.length
      ? { auth: authFromBrief(opts.brief.roles, people && peopleEmail ? { table: people.table.name, column: peopleEmail } : undefined) }
      : people && peopleEmail
        ? { auth: authFor(people, peopleEmail, described.filter(writable)) }
        : {}),
    resources: new Ref('resources', resources),
    views: new Ref('views', viewsTree),
    ...(pages.length ? { pages: new Ref('pages', pagesTree) } : {}),
    ...(home ? { home } : {}),
    nav,
    ui,
  };
  const app = evaluate(appTree) as Record<string, unknown>;

  /* Eat the cooking: a draft the validator rejects is a bug here, not a
     chore for the caller. */
  const problems: string[] = [];
  let served = schema;
  try {
    /* A brief's commands are written beside the App by the caller, which this check cannot load: it validates the
       App without their buttons, and `mistri check` validates them with the module. */
    const asked = new Set((opts.brief?.commands ?? []).map((command) => command.id));
    const parsed = parseAppConfig(asked.size ? withoutCommandActions(app, asked) : app, 'the scaffold');
    problems.push(...appRollupRules(parsed, schema).problems);
    served = withRollups(parsed, schema);
    for (const [key, view] of Object.entries(resolveViews(parsed, served))) if (view.error) problems.push(`view "${key}": ${view.error}`);
    problems.push(...resolveResources(parsed, schema).problems);
    problems.push(...appTransitionRules(parsed, schema).problems);
    problems.push(...appFileRules(parsed, schema, { strict: true }).problems);
    problems.push(...appTagRules(parsed, schema).problems);
    problems.push(...resolveDisplay(parsed, served).warnings);
    for (const page of parseAppPages(app, 'the scaffold')) {
      const checked = validatePage(served, page);
      if (checked.error) problems.push(`page "${page.name}": ${checked.error}`);
    }
  } catch (err) {
    problems.push((err as Error).message);
  }

  /* The types are what the App serves, its declared resources, as
     `mistri check --app` writes them: a table declared later is typed at
     the next check, which loads the App before it typechecks it. */
  const declared = new Set(schema.tables.filter((table) => Object.hasOwn(resources, table.name)).map((table) => table.id));
  const typed = accessibleSchema(served, { readable: declared, writable: declared });
  const recipe = recipeFor(described, hero, people);
  return {
    app,
    problems,
    recipe,
    files: projectFiles({
      recipe,
      people: people && peopleEmail ? { label: people.label.toLowerCase(), email: peopleEmail } : undefined,
      appTree,
      viewsTree,
      overview,
      pages,
      resources,
      name,
      id,
      typed,
      connections: opts.connections,
      database: opts.database,
    }),
  };
}

/* ---------- the files ---------- */

function moduleText(head: string, imports: string[], body: string): string {
  return `${head}\n${imports.filter(Boolean).join('\n')}\n\n${body}\n`;
}

function importLine(tree: unknown, from = '@mistriwork/mistri/app'): string {
  const used = [...helpersIn(tree)].sort();
  return used.length ? `import { ${used.join(', ')} } from '${from}';` : '';
}

function projectFiles({
  recipe,
  people,
  appTree,
  viewsTree,
  overview,
  pages,
  resources,
  name,
  id,
  typed,
  connections,
  database,
}: {
  recipe: Recipe;
  people?: { label: string; email: string };
  appTree: Record<string, unknown>;
  viewsTree: Record<string, unknown>;
  overview?: Call;
  pages: Array<{ key: string; page: Call }>;
  resources: Record<string, unknown>;
  name: string;
  id: string;
  typed: DatabaseSchema;
  connections?: readonly string[];
  database?: ScaffoldOptions['database'];
}): Record<string, string> {
  const files: Record<string, string> = {};
  const exported = (binding: string, tree: unknown, satisfies?: string) => {
    const lead = `export const ${binding} = `;
    return `${lead}${render(tree, '', lead.length)}${satisfies ? ` satisfies ${satisfies}` : ''};`;
  };

  files['app.ts'] = moduleText(
    `/**\n * ${name} — drafted by \`mistri --scaffold-app\` from the database's schema.\n` +
      ' * A start to curate: rename, regroup, cut. A running server reloads every\n' +
      ' * save; `mistri check --app <dir>` regenerates the schema types, typechecks\n' +
      ' * and validates the App in one pass.\n */',
    [
      `import { ${['defineApp', ...helpersIn(appTree)].sort().join(', ')} } from '@mistriwork/mistri/app';`,
      "import type { App } from './mistri-schema.d.ts';",
      ...(pages.length ? ["import { pages } from './pages/index.ts';"] : []),
      "import { resources } from './resources.ts';",
      "import { views } from './views.ts';",
    ],
    `export default defineApp(${render(appTree, '', 'export default defineApp('.length)} satisfies App);`,
  );

  files['resources.ts'] = moduleText(
    '/* What the App says about each table: what one record is called (`noun`) where\n' +
      "   the table's own name would not say it, how values dress, and its `segments`:\n" +
      '   each query named once, which a tab, a metric and a list read by name. Browsing is\n' +
      '   read-only; add `access: \'write\'` to a resource, and `"writable": true` to its\n' +
      '   connection, to let it be edited. */',
    [importLine(resources), "import type { Resources } from './mistri-schema.d.ts';"],
    exported('resources', resources, 'Resources'),
  );

  if (overview) {
    files['dashboard.ts'] = moduleText(
      '/* The Overview: a count per main table, how the busiest flows and divides,\n' +
        '   how it trends by month, and its newest rows. Give a metric a segment to\n' +
        "   count what matters ('<table>.open'), `over: '<date column>'` and dashboard\n" +
        '   `windows` to narrow it by time, a banner `note` to introduce the board. */',
      [importLine(overview)],
      exported('overview', overview),
    );
  }

  const listsOnly = Object.fromEntries(Object.entries(viewsTree).filter(([, v]) => !(v instanceof Ref)));
  files['views.ts'] = moduleText(
    '/* Everything a visitor can open; `nav` in app.ts arranges them. Captions come\n' +
      '   from the column names; say one differently with `labels` on its resource. */',
    [
      importLine(listsOnly),
      ...(overview ? ["import { overview } from './dashboard.ts';"] : []),
      "import type { Views } from './mistri-schema.d.ts';",
    ],
    exported('views', viewsTree, 'Views'),
  );

  if (pages.length) {
    for (const { key, page } of pages) {
      files[`pages/${key}.ts`] = moduleText(
        '/* A record page: its header and figures, the records that point at it as tabs, and beside them the record it belongs to, the one that is current and the rest of its fields. */',
        [importLine(page), "import type { Page } from '../mistri-schema.d.ts';"],
        exported(identifier(key, 'Page'), page, 'Page'),
      );
    }
    const index = Object.fromEntries(pages.map(({ key }) => [key, new Ref(identifier(key, 'Page'), undefined)]));
    files['pages/index.ts'] = moduleText(
      "/* Keyed by page id: the key is what a link names when the page's name alone is ambiguous. */",
      [
        ...pages.map(({ key }) => `import { ${identifier(key, 'Page')} } from './${key}.ts';`),
        "import type { Pages } from '../mistri-schema.d.ts';",
      ],
      exported('pages', index, 'Pages'),
    );
  }

  // The connections `mistri check` will find: the one mistri.json names, when the scaffold writes it.
  files['mistri-schema.d.ts'] = typesForSchema(typed, name, database && 'sqlite' in database ? [id] : connections);
  files['tsconfig.json'] = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        /* TypeScript 7 loads no @types package unless one is named: a command's, a job's or a test's `node:` import
           read "Cannot find module 'node:test'" in check's typecheck and `tsc`, about thirty errors after test init. */
        types: ['node'],
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`;
  /* The CLI supplies an absolute SQLite path so an explicit --config opens
     the same database from any working directory. Scripts remain local to
     the App; a caller-supplied config path is relative to that directory. */
  const explicitConfig = database && 'config' in database;
  if (explicitConfig) {
    /* Keep paths out of shell text: npm scripts run through cmd.exe on Windows,
       and through a POSIX shell elsewhere. The launcher passes the config as data. */
    files['mistri-run.mjs'] = moduleText(
      '/* The authoring loop, with the selected config passed as one argument on every platform. */',
      [
        "import { readFileSync } from 'node:fs';",
        "import { createRequire } from 'node:module';",
        "import { dirname, resolve } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
      ],
      'const [action, ...userArgs] = process.argv.slice(2);\n' +
        "if (!['check', 'start', 'seed'].includes(action)) throw new Error('Usage: node mistri-run.mjs <check|start|seed>');\n\n" +
        'const require = createRequire(import.meta.url);\n' +
        "const manifest = require.resolve('@mistriwork/mistri/package.json');\n" +
        "const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));\n" +
        "const entry = resolve(dirname(manifest), typeof bin === 'string' ? bin : bin.mistri);\n" +
        `process.argv = [process.execPath, entry, ...(action === 'start' ? [] : [action]), '--config', ${JSON.stringify(database.config)}, '--app', '.', ...userArgs];\n` +
        'await import(pathToFileURL(entry).href);',
    );
  }
  if (database && 'sqlite' in database) {
    files['mistri.json'] = `${JSON.stringify({ connections: [{ name: id, url: database.sqlite }] }, null, 2)}\n`;
  }
  files['.oxfmtrc.json'] = oxfmtConfigText;
  // What `mistri dev` keeps beside the App: a throwaway secret, passwords and accounts, never committed.
  files['.gitignore'] = '.mistri/\n';
  files['package.json'] = `${JSON.stringify(
    {
      name: id,
      private: true,
      type: 'module',
      /* The two commands of the authoring loop, run from this directory. Without
       a config named here they find the database the way mistri always
       does: ./mistri.json, then the user's config directory. */
      scripts: {
        check: explicitConfig ? 'node mistri-run.mjs check' : 'mistri check --app .',
        start: explicitConfig ? 'node mistri-run.mjs start' : 'mistri --app .',
        ...formatScripts,
      },
      /* mistri for its bin and the `@mistriwork/mistri/app` the modules import; the database browser (`tablewalk`) is not
         needed. */
      dependencies: { '@mistriwork/mistri': `^${runtimeVersion()}` },
      devDependencies: { '@types/node': nodeTypesRange(), oxfmt: oxfmtRange(), typescript: typescriptRange() },
    },
    null,
    2,
  )}\n`;
  const reach = database ? '' : ' <db>';
  files['README.md'] = [
    `# ${name}`,
    '',
    "Drafted by `mistri --scaffold-app` from the database's schema: a list view per table, an",
    'Overview, and a record page for each main table; a table that only belongs to another (an',
    "order's lines) is listed on its parent's page. Curate it — rename, regroup, cut.",
    '',
    '```sh',
    "npm install                                   # mistri, TypeScript and Node's types (not inside a mistri checkout)",
    explicitConfig
      ? 'npm run check                                 # schema types, typecheck, validation'
      : `npx @mistriwork/mistri check --app .${reach}      # schema types, typecheck, validation`,
    explicitConfig
      ? 'npm start                                     # serve it; a save to the App reloads it'
      : `npx @mistriwork/mistri${reach} --app .            # serve it; a save to the App reloads it`,
    '```',
    '',
    ...(explicitConfig
      ? [
          'Run these commands from this directory. `mistri-run.mjs` names the selected config; relative config paths resolve from this directory.',
          '',
        ]
      : []),
    ...(database && 'sqlite' in database
      ? [
          'Run these commands from this directory. The generated SQLite configuration uses an absolute database path, so an explicit `--config` also works from another directory. Update that path if you move the database.',
          '',
          'For existing configurations, relative SQLite paths resolve from the process working directory, not from the config file or App directory.',
          '',
        ]
      : []),
    `## Recipe: ${recipe.name}`,
    '',
    `Nearest first-shot recipe: ${recipe.name}, because ${recipe.why} \`npx @mistriwork/mistri docs\` and the`,
    "mistri skill's recipes say what an App of this kind shows first.",
    '',
    '## Rows to look at',
    '',
    '```sh',
    explicitConfig
      ? 'node mistri-run.mjs seed                  # about 40 believable rows per table'
      : `npx @mistriwork/mistri seed --app .${reach}   # about 40 believable rows per table`,
    '```',
    '',
    '`seed` writes only to a writable connection, refuses a table that already has rows unless',
    '`--append`, and walks each status the way the App moves it, its stamps set to match.',
    '`--seed <n>` makes the same rows again.',
    ...(people
      ? [
          '',
          `Sign in as one of the ${people.label}: \`me\` is the row whose \`${people.email}\` is the`,
          'address signed in with, and the "My …" list is their work.',
        ]
      : []),
    '',
    `${database ? '' : '`<db>` is a SQLite file, `--db <url>` or `--config <file>`. '}\`mistri check\` regenerates`,
    '`mistri-schema.d.ts` from the database, so run it after every migration.',
    '',
    'A save to the App reloads it, except a change to what it grants, its sources or its sign-in,',
    'and any change to the mistri config: those need a restart. `npx @mistriwork/mistri docs` lists the',
    'reference topics (`npx @mistriwork/mistri docs reload-and-restart`, `npx @mistriwork/mistri docs access-model`, …).',
    '',
    "Browsing is read-only. To edit, give a resource `access: 'write'` in `resources.ts` and its",
    `connection \`"writable": true\`${database && 'sqlite' in database ? ' in `mistri.json`' : ' in the mistri config'}; writes are refused at the`,
    'database adapter otherwise, whatever the App says.',
    '',
    '- `app.ts` — the App: its id, name, `home`, `nav` and `ui` — the look, logo and shell it was drafted with.',
    "- `resources.ts` — what each table's records are called, how values dress, and each New form.",
    '- `views.ts`, `dashboard.ts` — the lists and the Overview.',
    '- `pages/` — record pages, one per file.',
    '',
  ].join('\n');
  return files;
}

/* The Node types the tsconfig names (`types: ['node']`): the range mistri itself builds against. */
function nodeTypesRange(): string {
  try {
    const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    return own.devDependencies?.['@types/node'] ?? '*';
  } catch {
    return '*';
  }
}

function typescriptRange(): string {
  try {
    /* The peer range first: it is the TypeScript an App's check needs (7 or later), whatever the checkout's own compiler is. */
    const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return own.peerDependencies?.typescript ?? own.devDependencies?.typescript ?? '>=7';
  } catch {
    return '>=7';
  }
}

/* ---------- on disk ---------- */

/** What --scaffold-app wrote, for the CLI's report. */
interface WrittenScaffold {
  dir: string;
  name: string;
  written: string[];
  /** Project files that already stood and were left as they were. */
  kept: string[];
  /** Why package.json was not written, when it was not. */
  packageNote?: string;
  navCount: number;
  pageCount: number;
  problems: string[];
  recipe: Recipe;
}

/** The package whose scope a directory is in: the nearest package.json's name, if any. */
/** The manifests a checkout's directories sit under: the workspace root's, or a product package's own. */
const CHECKOUT_NAMES = new Set(['tablewalk-workspace', 'tablewalk', '@mistriwork/mistri']);

function packageScope(dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const manifest = join(at, 'package.json');
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ?? '';
      } catch {
        return '';
      }
    }
    if (dirname(at) === at) return undefined;
  }
}

/* The files that are the App: never overwritten. The project's own files — a
   package.json or tsconfig.json the directory already has — are kept as they
   are and named, since they are someone's project, not a draft. */
const PROJECT_FILES = new Set(['package.json', 'tsconfig.json', '.oxfmtrc.json', '.gitignore', 'mistri-schema.d.ts', 'README.md']);

/**
 * Draft an App and put it on disk — the write half of --scaffold-app, kept
 * beside the drafting brain so the CLI block stays a front door. Refusals
 * throw with the fix named, before anything is written: an App file already
 * standing is someone's work, and the loader refuses a directory holding two
 * manifests, so the scaffold must never create that state.
 *
 * Inside a mistri checkout no package.json is written: a package of its
 * own would hide the workspace's packages, and `@mistriwork/mistri/app` would stop
 * resolving for the very examples-style App the docs describe.
 */
export async function writeScaffold(schema: DatabaseSchema, dir: string, opts: ScaffoldOptions = {}): Promise<WrittenScaffold> {
  const { app, files, problems, recipe } = scaffoldApp(schema, opts);
  const standing = [...Object.keys(files).filter((file) => !PROJECT_FILES.has(file)), 'app.json', 'app.mjs'].filter((file) =>
    existsSync(join(dir, file)),
  );
  if (standing.length) {
    throw new Error(
      `${standing.map((file) => join(dir, file)).join(', ')} already exist${standing.length === 1 ? 's' : ''} — ` +
        'scaffolding refuses to overwrite an App. Move it aside, or choose a new directory.',
    );
  }
  let packageNote: string | undefined;
  if (CHECKOUT_NAMES.has(packageScope(dir) ?? '')) {
    delete files['package.json'];
    delete files['.oxfmtrc.json'];
    packageNote = "inside the mistri checkout, where @mistriwork/mistri/app resolves to the workspace's own package, so no package.json";
  }
  const written: string[] = [];
  const kept: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    if (existsSync(path)) {
      kept.push(file);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    written.push(file);
  }
  /* A package.json that stood is the project's, so it is not rewritten; one that reads the App as CommonJS is said, with the fix. */
  if (kept.includes('package.json')) packageNote = moduleTypeProblem(dir, shownPath) ?? packageNote;
  return {
    dir,
    name: String(app.name),
    written,
    kept,
    packageNote,
    navCount: (app.nav as unknown[]).flatMap((entry) => (typeof entry === 'string' ? [entry] : (entry as { children: unknown[] }).children))
      .length,
    pageCount: Object.keys((app.pages ?? {}) as object).length,
    problems,
    recipe,
  };
}

export const shownPath = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near.startsWith('.') ? near : `./${near}`;
};

/**
 * What an App is named after when `--name` is not given: a file's name, or
 * the database a URL names (`postgres://…/helpdesk` is Helpdesk), never the
 * redacted URL, which read "Postgres@127.0.0.1".
 */
function databaseName(label: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(label)) {
    try {
      const url = new URL(label);
      const database = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
      if (database) return database;
      return url.hostname;
    } catch {
      /* not a URL after all: the label as it is */
    }
  }
  return (label.split(/[\\/]/).pop() ?? label).replace(/\.(sqlite3?|db)$/i, '');
}
