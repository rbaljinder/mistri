/**
 * `tablewalk seed`: rows to look at, in an App's database, so a first draft
 * is judged on believable data rather than on an empty Overview or on a
 * seed script someone had to write.
 *
 * Believable means the rows say what the schema says. A CHECK vocabulary is
 * the only words a column gets; a reference points at a row that exists, so
 * parents are filled before children; a unique column never repeats; a NOT
 * NULL column is never left empty. Work that moves through states is spread
 * over them the way a working shop's is — most of it open, a third done, a
 * little called off — and each record carries the stamps of the states it
 * passed through and none of the ones it did not: a collected work order has
 * its `ready_at`, a received one does not. Dates fall across the windows a
 * dashboard reads (the last 7, 30 and 90 days), and some open work is due
 * today or overdue, so the "due" dressing has something to say.
 *
 * Deterministic: one generator (mulberry32) seeded by `--seed`, tables in a
 * fixed order, and dates counted from the start of today (UTC), so the same
 * seed on the same day writes the same rows.
 */
import type { Adapter, WriteTransaction } from '../../adapters/adapter.js';
import { isMoneyColumn } from '../../shared/displayDefaults.js';
import {
  columnKind,
  isFlagColumn,
  momentColumn,
  stateStampColumn,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '../../shared/schema.js';
import { draftMachine } from '../scaffoldMachine.js';
import * as L from './lexicon.js';
import * as W from './words.js';

/** A refusal before anything is written: said to the person, exit 2. */
export class SeedRefusal extends Error {}

export interface SeedResource {
  /** How this table's status moves, when something above the engine knows (cli/appTargets.ts reads an App's machine). */
  life?: (table: TableMeta) => SeedLife;
  /** SQLite text dates the App declares (`types: { due_on: 'date' }`). */
  types?: Record<string, string>;
  /** Money columns the App keeps as whole minor units (`display: { total: { format: 'money', minor: true } }`): seeded as cents. */
  minor?: string[];
}

export interface SeedOptions {
  /** Rows for a main table; staff and lookups get fewer, lines more. */
  rows: number;
  seed: number;
  /** Add to tables that already hold rows, instead of refusing. */
  append?: boolean;
  /** The App's resources, by table name: its machines and declared dates. Without an App, every table, its machine drafted. */
  resources?: Record<string, SeedResource>;
  /** The table `auth.me` signs in from, and its column. */
  people?: { table: string; column: string };
  /** The day dates are counted back from; the start of today (UTC) by default. */
  today?: Date;
}

interface SeedReport {
  tables: Array<{ table: string; rows: number }>;
  /** A few addresses to sign in with, from the people table. */
  signIn: string[];
}

type Value = string | number | boolean | null;

/* ---------- the generator ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Dice {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const total = items.reduce((sum, item) => sum + weight(item), 0);
    let at = this.next() * total;
    for (const item of items) if ((at -= weight(item)) < 0) return item;
    return items[items.length - 1];
  }
}

/* ---------- reading the schema ---------- */

const DAY = 86_400_000;
const two = (n: number) => String(n).padStart(2, '0');
const dayText = (at: Date) => at.toISOString().slice(0, 10);
const wallText = (at: Date) => `${dayText(at)} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())}`;

/* The runtime's own tables (the migration history, its stores, by their names before and since mistri) are not the
   App's to fill. */
const OWN = /^(__)?mistri_|^_mistri/i;
const STAFF =
  /^(staff|users?|employees?|mechanics?|agents?|technicians?|members?|team|team_members?|operators?|engineers?|people|persons?|reps?)$/i;
const PERSON =
  /^(customers?|clients?|contacts?|patients?|students?|drivers?|owners?|authors?|guests?|tenants?|buyers?|sellers?|leads?|subscribers?|volunteers?|applicants?|candidates?)$/i;
const COMPANY = /^(companies|company|accounts?|organi[sz]ations?|orgs?|vendors?|suppliers?|partners?|businesses|business|firms?|brands?)$/i;
const BORN = [/created/i, /opened/i, /received|registered|reported|requested|raised|booked|logged/i, /ordered|placed|submitted/i, /date$/i];
/* Columns that hold when something is to happen, not when it did: a schedule's dashboards read "today" and "next". */
const SCHEDULE =
  /(^|_)(appointment|appt|scheduled|starts?|begins?|follow_?up|planned|booked_for|check_?in|session|visit)(_|$)|^start_(at|on|date|time)$/i;
/* Optional by nature: a note may well be blank; every other text column is filled nearly always. */
const OPTIONAL_TEXT =
  /(^|_)(notes?|comments?|remarks?|cancel(l?ation)?|middle_name|nickname|suffix|address_?line_?2|line_?2|fax|alt|secondary)(_|$)/i;
/* Roles in the building that a title is a job title for. */
const JOBLIKE =
  /^(doctors?|nurses?|physicians?|clinicians?|providers?|therapists?|teachers?|instructors?|professors?|technicians?|employees?|workers?|associates?|cashiers?|advisors?|managers?|caregivers?|pharmacists?|dentists?)$/i;
/* A table of things kept: a part, a product — the one place a "Compact filter" is the right name. */
const PRODUCTISH = /(^|_)(parts?|products?|items?|catalog|merchandise|goods|equipment|assets?|stock|inventory|skus?)$/i;
const DUE = /^(due|due_on|due_at|due_date|deadline)$|(^|_)(due|scheduled|planned|expected|promised)(_|$)/i;
const LIFECYCLE = /(^|_)(status|state|stage|phase)$/i;
/* A lookup's own name, and the columns that make a short list a catalog instead: a code, a count on the shelf. */
const LOOKUP_NAME = /^(name|title|label)$/i;
const CATALOG = /(^|_)(sku|code|barcode|upc|serial|serial_number|stock|in_stock|on_hand|inventory|e?mail|phone)$/i;
/* A lookup's rows by kind: a list of kinds (categories, types) by topic; anything else, an offering by tier, the
   cheapest first, so a price or a duration beside it climbs with it. */
const SORTS =
  /(^|_)(categor(y|ies)|types?|kinds?|topics?|groups?|tags?|labels?|departments?|teams?|sources?|channels?|reasons?|priorit(y|ies)|statuses)$/i;
const TIERS = ['Basic', 'Standard', 'Premium', 'Express', 'Full', 'Deluxe', 'Quick', 'Seasonal', 'Annual', 'Custom', 'Starter', 'Pro'];
const TIER_PRICES = [29, 49, 89, 129, 189, 249];
const TIER_MINUTES = [15, 30, 45, 60, 90, 120];
const local = (name: string) => name.slice(name.lastIndexOf('.') + 1);

/** How a column holds a moment, the App's declaration first: `TEXT` named `due_date` is a day when the App says so. */
function moment(column: ColumnMeta, types: Record<string, string> | undefined): 'date' | 'instant' | 'instant-zoned' | undefined {
  const declared = types?.[column.name];
  if (declared === 'date') return 'date';
  if (declared === 'datetime') return 'instant';
  const read = momentColumn(column);
  if (read) return read;
  if (columnKind(column.type ?? '') === 'date') return /time/i.test(column.type) ? 'instant' : 'date';
  return columnKind(column.type ?? '') === 'text' && /(^|_)date$/i.test(column.name) ? 'date' : undefined;
}

/** A machine as seed walks it: the forward path, the side states, the exits, and what entering each state stamps. */
export interface SeedLife {
  column: string;
  since?: string;
  path: string[];
  holds: Map<string, string>;
  exits: string[];
  stamps: Map<string, string[]>;
  reasons: Map<string, string>;
}

function draftedLife(table: TableMeta): SeedLife | undefined {
  const column = table.columns.find((c) => LIFECYCLE.test(c.name) && (c.allowed?.length ?? 0) >= 3);
  const drafted = column && draftMachine(table, column);
  if (!drafted) return undefined;
  const stamps = new Map<string, string[]>();
  const reasons = new Map<string, string>();
  for (const state of drafted.states) {
    const own = stateStampColumn(state, table.columns, drafted);
    stamps.set(state, own ? [own.name] : []);
  }
  for (const verb of drafted.verbs) {
    stamps.set(verb.to, [...new Set([...(stamps.get(verb.to) ?? []), ...verb.stamps])]);
    if (verb.reason) reasons.set(verb.to, verb.reason);
  }
  return {
    column: drafted.column,
    ...(drafted.since ? { since: drafted.since } : {}),
    path: drafted.path,
    holds: drafted.holds,
    exits: drafted.exits,
    stamps,
    reasons,
  };
}

/* ---------- ordering ---------- */

interface Plan {
  table: TableMeta;
  resource?: SeedResource;
  life?: SeedLife;
  rows: number;
  domain: L.DomainId;
  /** Its `title` is a job title: the table holds staff of one kind or another. */
  job: boolean;
  /** Money columns held in minor units. */
  minor: Set<string>;
  /** References to fill, each to a table filled before this one. */
  refs: Map<string, { table: string; column: string }>;
  /** References left empty: to this table itself, or back around a cycle. */
  deferred: Set<string>;
  /** A short list other tables pick from — services, categories — whose rows are named one by one, not drawn at random. */
  lookup?: boolean;
}

function referencesOf(schema: DatabaseSchema, table: TableMeta): Map<string, { table: string; column: string; nullable: boolean }> {
  const refs = new Map<string, { table: string; column: string; nullable: boolean }>();
  for (const fk of schema.foreignKeys) {
    if (fk.from.table !== table.id || fk.from.columns.length !== 1) continue;
    const column = table.columns.find((c) => c.name === fk.from.columns[0]);
    if (column) refs.set(column.name, { table: fk.to.table, column: fk.to.columns[0], nullable: column.nullable });
  }
  return refs;
}

/** Parents first. A reference that would close a loop is left empty, which is only possible where it may be. */
function ordered(schema: DatabaseSchema, tables: TableMeta[]): Array<{ table: TableMeta; deferred: Set<string> }> {
  const ids = new Set(tables.map((table) => table.id));
  const done = new Set<string>();
  const out: Array<{ table: TableMeta; deferred: Set<string> }> = [];
  const pending = [...tables];
  while (pending.length) {
    let progressed = false;
    for (const table of [...pending]) {
      const refs = referencesOf(schema, table);
      const waiting = [...refs.values()].filter((ref) => ref.table !== table.id && ids.has(ref.table) && !done.has(ref.table));
      if (waiting.length) continue;
      const deferred = new Set([...refs].filter(([, ref]) => ref.table === table.id).map(([column]) => column));
      out.push({ table, deferred });
      done.add(table.id);
      pending.splice(pending.indexOf(table), 1);
      progressed = true;
    }
    if (progressed) continue;
    /* A loop: break it at the first table whose waiting references may all be empty. */
    const breakable = pending.find((table) =>
      [...referencesOf(schema, table).values()].every((ref) => ref.nullable || done.has(ref.table) || !ids.has(ref.table)),
    );
    if (!breakable)
      throw new SeedRefusal(
        `${pending.map((table) => table.name).join(', ')} reference each other with required columns, so no one of them can be filled first.`,
      );
    const deferred = new Set(
      [...referencesOf(schema, breakable)]
        .filter(([, ref]) => ref.table === breakable.id || !done.has(ref.table))
        .map(([column]) => column),
    );
    out.push({ table: breakable, deferred });
    done.add(breakable.id);
    pending.splice(pending.indexOf(breakable), 1);
  }
  return out;
}

/* ---------- making a row ---------- */

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const headWord = (table: TableMeta) => {
  const word = local(table.name).replace(/_/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');
  return word.charAt(0).toUpperCase() + word.slice(1);
};
const initials = (table: TableMeta) =>
  local(table.name)
    .split('_')
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 3) || 'R';

interface Moment {
  /** When the record came to be. */
  born: Date;
  /** When it entered each state it passed through, in order. */
  entered: Array<{ state: string; at: Date }>;
  state?: string;
  open: boolean;
}

function lifeOfRow(dice: Dice, life: SeedLife | undefined, today: Date): Moment {
  const back = (days: number) => new Date(today.getTime() - days * DAY - dice.int(30, 8 * 60) * 60_000);
  if (!life) {
    const roll = dice.next();
    const days = roll < 0.25 ? dice.int(0, 6) : roll < 0.6 ? dice.int(7, 29) : dice.int(30, 89);
    return { born: back(days), entered: [], open: true };
  }
  const { path } = life;
  const final = path[path.length - 1];
  const open = path.slice(0, -1);
  const holds = [...life.holds.keys()];
  const roll = dice.next();
  let visited: string[];
  if (life.exits.length && roll < 0.1) {
    visited = [...path.slice(0, dice.int(1, Math.max(1, path.length - 1))), dice.pick(life.exits)];
  } else if (roll < 0.45 || !open.length) {
    visited = path;
  } else if (holds.length && dice.chance(0.12)) {
    const hold = dice.pick(holds);
    visited = [...path.slice(0, path.indexOf(life.holds.get(hold)!) + 1), hold];
  } else {
    /* Earlier states hold more of the open work: it arrives faster than it finishes. */
    const at = dice.weighted(
      open.map((_, i) => i),
      (i) => open.length - i + 1,
    );
    visited = path.slice(0, at + 1);
  }
  const state = visited[visited.length - 1];
  const isOpen = state !== final && !life.exits.includes(state);
  /* Open work is recent; finished work is spread over the quarter. */
  const age = isOpen ? dice.int(0, 20) : dice.int(Math.max(3, visited.length * 2), 89);
  const born = back(age);
  const span = today.getTime() - born.getTime();
  const entered = [{ state: visited[0], at: born }];
  let at = born.getTime();
  for (let i = 1; i < visited.length; i++) {
    const room = (today.getTime() - at) / (visited.length - i + 1);
    at = Math.min(at + Math.max(30 * 60_000, dice.next() * room), born.getTime() + span - 60_000);
    entered.push({ state: visited[i], at: new Date(at) });
  }
  return { born, entered, state, open: isOpen };
}

interface Person {
  first: string;
  last: string;
  company: string;
}

/** Values already taken, per unique column (and per unique pair), so none repeats. */
class Taken {
  private readonly sets = new Map<string, Set<string>>();
  has(key: string, value: Value): boolean {
    return this.sets.get(key)?.has(String(value)) ?? false;
  }
  add(key: string, value: Value): void {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key)!.add(String(value));
  }
}

function textFor(dice: Dice, plan: Plan, column: ColumnMeta, person: Person, n: number, personLike: boolean, companyLike: boolean): Value {
  const name = column.name.toLowerCase();
  const table = plan.table;
  if (/(^|_)e?mail(_address)?$/.test(name))
    return companyLike && !personLike
      ? `hello@${slug(person.company)}.example.com`
      : `${slug(person.first)}.${slug(person.last)}@example.com`;
  if (/^(first_name|firstname|given_name|forename)$/.test(name)) return person.first;
  if (/^(last_name|lastname|surname|family_name)$/.test(name)) return person.last;
  if (/(^|_)(phone|mobile|cell|tel|telephone|fax)(_number)?$/.test(name))
    return `(${dice.pick(['206', '212', '303', '312', '404', '415', '503', '617'])}) 555-01${two(dice.int(0, 99))}`;
  if (/(^|_)(company|organi[sz]ation|employer|business)(_name)?$/.test(name)) return person.company;
  if (/^(name|full_name|display_name|contact_name|contact|customer_name|owner_name)$/.test(name)) {
    if (personLike || /contact|customer|owner|full|display/.test(name)) return `${person.first} ${person.last}`;
    if (companyLike) return person.company;
    const pool = L.entityNames(plan.domain, table.name);
    if (pool) return pool[n % pool.length] + (n >= pool.length ? ` ${Math.floor(n / pool.length) + 1}` : '');
    if (PRODUCTISH.test(local(table.name))) return `${dice.pick(W.THING_ADJ)} ${dice.pick(W.THING)}`;
    return `${headWord(table)} ${n + 1}`;
  }
  const meaning = L.meaningOf(name, table.name, plan.job);
  if (meaning === 'reason') {
    /* Without a machine to say it, a reason on a visit or a request is the reason for it. */
    const event = /appointment|visit|encounter|consult|booking|ticket|request|inquir/i.test(local(table.name));
    return dice.pick(L.wordsFor(plan.domain, event ? 'subject' : 'reason'));
  }
  if (meaning) return dice.pick(L.wordsFor(plan.domain, meaning));
  if (/(^|_)city$/.test(name)) return dice.pick(W.CITIES);
  if (/(^|_)(state|province|region)$/.test(name)) return dice.pick(W.STATES);
  if (/(^|_)country(_code)?$/.test(name)) return name.endsWith('code') ? 'US' : 'United States';
  if (/(^|_)(zip|zip_code|postal_code|postcode)$/.test(name)) return String(dice.int(10000, 99899));
  if (/(^|_)(address|street|address_line_?1|line1)$/.test(name)) return `${dice.int(10, 9899)} ${dice.pick(W.STREETS)}`;
  if (/(^|_)(make|brand|manufacturer)$/.test(name)) return dice.pick(W.MAKES);
  if (/(^|_)model$/.test(name)) return `${dice.pick(W.MODELS)} ${dice.int(1, 9)}`;
  if (/(^|_)colou?r$/.test(name)) return dice.pick(W.COLORS);
  if (/(^|_)(url|website|homepage|link)$/.test(name)) return `https://example.com/${slug(local(table.name))}/${n + 1}`;
  if (/(^|_)(sku|code|serial|serial_number|number|no|ref|reference|slug|key|tag)$/.test(name)) {
    const prefix = /sku/.test(name) ? 'SKU' : /serial/.test(name) ? 'SN' : initials(table);
    return name === 'slug' ? `${slug(headWord(table))}-${n + 1}` : `${prefix}-${String(1000 + n * 7 + dice.int(0, 6)).padStart(4, '0')}`;
  }
  if (/(^|_)team$/.test(name)) return dice.pick(L.wordsFor(plan.domain, 'department'));
  if (/(^|_)(uuid|guid)$/.test(name) || /uuid/i.test(column.type)) return uuid(dice);
  return `${headWord(table)} ${n + 1}`;
}

/**
 * A lookup row's name, the n-th of its list: a topic for a list of kinds; a tier of what it offers ("Basic
 * service") where the list is priced or timed; undefined otherwise, for the usual words.
 */
function lookupName(table: TableMeta, n: number, domain: L.DomainId): string | undefined {
  const list =
    L.lookupList(domain, table.name) ??
    (table.columns.some((c) => lookupNumber(c, 0) !== undefined) ? L.entityNames(domain, table.name) : undefined);
  if (list) return list[n % list.length] + (n >= list.length ? ` ${Math.floor(n / list.length) + 1}` : '');
  if (SORTS.test(local(table.name))) return `${headWord(table)} ${n + 1}`;
  if (!table.columns.some((column) => lookupNumber(column, 0) !== undefined)) return undefined;
  const tier = TIERS[n];
  return tier ? `${tier} ${headWord(table).toLowerCase()}` : `${headWord(table)} ${n + 1}`;
}

/** A lookup row's price or duration, climbing with its tier; undefined for any other number. */
function lookupNumber(column: ColumnMeta, n: number): number | undefined {
  const step = (list: number[]) => list[n % list.length]! * (1 + Math.floor(n / list.length));
  if (isMoneyColumn(column)) return step(TIER_PRICES);
  if (/(^|_)(minutes|mins|duration|duration_minutes)$/i.test(column.name)) return step(TIER_MINUTES);
  return undefined;
}

function uuid(dice: Dice): string {
  const hex = Array.from({ length: 32 }, () => dice.int(0, 15).toString(16));
  hex[12] = '4';
  hex[16] = ((dice.int(0, 15) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function numberFor(dice: Dice, column: ColumnMeta, line: boolean, minor = false): number {
  const dollars = amountFor(dice, column, line, minor);
  return minor ? Math.round(dollars * 100) : dollars;
}

function amountFor(dice: Dice, column: ColumnMeta, line: boolean, minor: boolean): number {
  const name = column.name.toLowerCase();
  /* Minor units are drawn as dollars and counted in cents after, so the dollars are never whole-number-limited. */
  const whole = !minor && /int|serial/i.test(column.type) && !/point|numeric|decimal/i.test(column.type);
  const cents = (lo: number, hi: number) => (whole ? dice.int(lo, hi) : dice.int(lo * 100, hi * 100) / 100);
  if (isMoneyColumn(column) || minor) {
    if (/(unit_)?price|cost|rate$/.test(name)) return whole ? dice.int(5, 400) : dice.int(5, 400) - 0.01 * dice.pick([1, 5, 50, 100]);
    if (/labou?r|fee|charge|deposit|shipping|tax/.test(name)) return cents(20, 400);
    return cents(40, 2500);
  }
  if (/(^|_)(quantity|qty|units|count)$/.test(name)) return line ? dice.int(1, 4) : dice.int(1, 20);
  if (/(^|_)(stock|on_hand|in_stock|quantity_on_hand|qty_on_hand|inventory)$/.test(name)) return dice.chance(0.1) ? 0 : dice.int(1, 120);
  if (/(^|_)(rating|stars|score)$/.test(name)) return dice.int(1, 5);
  if (/(percent|pct|discount|rate)$/.test(name)) return dice.int(0, 30);
  if (/(^|_)year$/.test(name)) return dice.int(2012, 2025);
  if (/(^|_)age$/.test(name)) return dice.int(18, 80);
  if (/(^|_)(position|sort|sort_order|rank|priority)$/.test(name)) return dice.int(1, 10);
  return whole ? dice.int(1, 100) : dice.int(100, 10000) / 100;
}

/* ---------- the run ---------- */

/** Fill the database. Throws SeedRefusal before writing when a table already holds rows and `append` is not set. */
export async function seedDatabase(adapter: Adapter, schema: DatabaseSchema, opts: SeedOptions): Promise<SeedReport> {
  if (!adapter.transaction) throw new SeedRefusal('this connection cannot write, so there is nowhere to put rows.');
  const dice = new Dice(opts.seed);
  const now = opts.today ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const resourceOf = (table: TableMeta) =>
    opts.resources?.[table.name] ?? opts.resources?.[local(table.name)] ?? opts.resources?.[table.id];

  /* The App's tables, and the parents a required reference of theirs needs; without an App, every table. */
  const candidates = schema.tables.filter(
    (table) => !table.isView && !table.union && table.insertable !== false && !OWN.test(local(table.name)),
  );
  let chosen = opts.resources ? candidates.filter((table) => resourceOf(table)) : candidates;
  for (let grew = true; grew;) {
    grew = false;
    for (const table of [...chosen])
      for (const ref of referencesOf(schema, table).values()) {
        const parent = candidates.find((t) => t.id === ref.table);
        if (!ref.nullable && parent && !chosen.includes(parent)) {
          chosen = [...chosen, parent];
          grew = true;
        }
      }
  }
  if (!chosen.length) throw new SeedRefusal('there are no tables to fill.');

  const domain = L.detectDomain(
    chosen.map((table) => table.name),
    chosen.flatMap((table) => table.columns.map((c) => c.name)),
  );
  const sizes = new Map<string, number>();
  const lookups = new Set<string>();
  const plans: Plan[] = ordered(schema, chosen).map(({ table, deferred }) => {
    const resource = resourceOf(table);
    const life = resource?.life ? resource.life(table) : opts.resources ? undefined : draftedLife(table);
    const refs = new Map<string, { table: string; column: string }>();
    for (const [column, ref] of referencesOf(schema, table))
      if (!deferred.has(column) && chosen.some((t) => t.id === ref.table)) refs.set(column, ref);
    const staff =
      (opts.people && local(opts.people.table) === local(table.name)) ||
      (STAFF.test(local(table.name)) && table.columns.some((c) => /e?mail/i.test(c.name)));
    const nonKey = table.columns.filter((c) => !c.primaryKey && !refs.has(c.name));
    /* A lookup is a short list other tables pick from and that points at nothing: a name and a value or two (a
       service's price and minutes). Filled like a main table, a shop had 40 services named "Bright widget". One
       that is kept in stock or by a code — parts, a catalog — or that holds people is a main table still. */
    const referenced = schema.foreignKeys.some((fk) => fk.to.table === table.id);
    const listed = L.lookupList(domain, table.name) !== undefined;
    const lookup =
      !staff &&
      referenced &&
      ((listed && nonKey.length <= 8 && !PERSON.test(local(table.name))) ||
        (!refs.size &&
          (nonKey.length <= 2 ||
            (nonKey.length <= 4 &&
              !PERSON.test(local(table.name)) &&
              !COMPANY.test(local(table.name)) &&
              nonKey.some((c) => LOOKUP_NAME.test(c.name)) &&
              !nonKey.some((c) => CATALOG.test(c.name))))));
    const line = refs.size >= 2 && table.columns.some((c) => /(^|_)(quantity|qty|units)$/i.test(c.name));
    const rows = staff
      ? Math.min(opts.rows, Math.max(4, Math.round(opts.rows / 5)))
      : lookup
        ? Math.min(opts.rows, listed || SORTS.test(local(table.name)) ? 8 : nonKey.length <= 2 ? 8 : 6)
        : line
          ? Math.round(opts.rows * 2.5)
          : opts.rows;
    /* Children outnumber the parents they hang from, or the lightest parents could not each have one. */
    const parentRows = Math.max(0, ...[...refs.values()].map((ref) => (sizes.get(ref.table) ?? 0) * (lookups.has(ref.table) ? 0 : 1)));
    const grown = !lookup && !staff && parentRows ? Math.min(opts.rows * 3, Math.max(rows, Math.ceil(parentRows * 1.5))) : rows;
    sizes.set(table.id, grown);
    if (lookup) lookups.add(table.id);
    const minor = new Set(resource?.minor ?? []);
    const job = JOBLIKE.test(local(table.name)) || STAFF.test(local(table.name));
    return { table, resource, ...(life ? { life } : {}), rows: grown, domain, job, minor, refs, deferred, ...(lookup ? { lookup } : {}) };
  });

  const tables = new Map(schema.tables.map((table) => [table.id, table]));
  return adapter.transaction(async (tx) => {
    /* Refused before a row is written: someone's data is not a draft to add to unasked. */
    const counts = new Map<string, number>();
    for (const plan of plans) counts.set(plan.table.id, await tx.count(plan.table.id));
    const holding = plans.filter((plan) => counts.get(plan.table.id)! > 0);
    if (holding.length && !opts.append)
      throw new SeedRefusal(
        `${holding.map((plan) => `${plan.table.name} (${counts.get(plan.table.id)} rows)`).join(', ')} already ${holding.length === 1 ? 'holds' : 'hold'} rows. ` +
          'seed fills an empty database; pass --append to add to it anyway.',
      );

    /* What a reference can point at: the rows made here, and in --append the rows already there — whole rows, so a
       child can agree with its parents (a work order's customer is its bike's owner, a line's price its part's). */
    const rowsOf = new Map<string, Array<Record<string, unknown>>>();
    const rowList = (table: string) => {
      if (!rowsOf.has(table)) rowsOf.set(table, []);
      return rowsOf.get(table)!;
    };
    const taken = new Taken();
    for (const plan of plans) {
      if (!counts.get(plan.table.id)) continue;
      const existing = await readAll(
        tx,
        plan.table.id,
        plan.table.columns.map((c) => c.name),
      );
      rowList(plan.table.id).push(...existing);
      for (const row of existing)
        for (const column of plan.table.unique ?? []) taken.add(`${plan.table.id}.${column}`, row[column] as Value);
    }

    const report: SeedReport = { tables: [], signIn: [] };
    for (const plan of plans) {
      const { table } = plan;
      const types = plan.resource?.types;
      const personLike =
        PERSON.test(local(table.name)) ||
        STAFF.test(local(table.name)) ||
        JOBLIKE.test(local(table.name)) ||
        table.columns.some((c) => /^(first_name|last_name)$/i.test(c.name));
      /* A person is named once in a table when there are names enough to go round. */
      const usedNames = new Set<string>();
      const companyLike = COMPANY.test(local(table.name));
      const line = plan.refs.size >= 2 && table.columns.some((c) => /(^|_)(quantity|qty|units)$/i.test(c.name));
      const bornColumn = (() => {
        const dated = table.columns.filter(
          (c) =>
            moment(c, types) &&
            !DUE.test(c.name) &&
            !SCHEDULE.test(c.name) &&
            !(plan.life && [...plan.life.stamps.values()].flat().includes(c.name)) &&
            c.name !== plan.life?.since,
        );
        for (const want of BORN) {
          const hit = dated.find((c) => want.test(c.name));
          if (hit) return hit.name;
        }
        return undefined;
      })();
      const pairs = [...(table.uniquePairs ?? [])];
      const primary = table.columns.filter((c) => c.primaryKey);
      if (primary.length === 2) pairs.push([primary[0].name, primary[1].name]);
      const offset = counts.get(table.id) ?? 0;
      let made = 0;
      const ordersOf = new Map<string, Crowd>();
      for (let n = offset; made < plan.rows && n < offset + plan.rows * 3; n++) {
        const person: Person = {
          ...(() => {
            let first = dice.pick(W.FIRST);
            let last = dice.pick(W.LAST);
            for (let tries = 0; personLike && usedNames.has(`${first} ${last}`) && tries < 40; tries++) {
              first = dice.pick(W.FIRST);
              last = dice.pick(W.LAST);
            }
            if (personLike) usedNames.add(`${first} ${last}`);
            return { first, last };
          })(),
          company: `${dice.pick(W.COMPANY_FIRST)} ${dice.pick(W.COMPANY_LAST)}${(() => {
            const suffix = dice.pick(W.COMPANY_SUFFIX);
            return suffix ? ` ${suffix}` : '';
          })()}`,
        };
        const life = lifeOfRow(dice, plan.life, today);
        const values: Record<string, Value> = {};
        const stamped = new Map<string, Date>();
        if (plan.life && life.state) {
          values[plan.life.column] = life.state;
          for (const { state, at } of life.entered) for (const column of plan.life.stamps.get(state) ?? []) stamped.set(column, at);
          if (plan.life.since) stamped.set(plan.life.since, life.entered[life.entered.length - 1].at);
        }
        const machineStamps = new Set(plan.life ? [...plan.life.stamps.values()].flat() : []);
        const parents = new Map<string, Record<string, unknown>>();
        let ok = true;
        for (const column of table.columns) {
          if (column.name in values || column.writable === false) continue;
          if (column.primaryKey && !plan.refs.has(column.name) && (column.identity || column.hasDefault || autoKey(column, primary)))
            continue;
          const ref = plan.refs.get(column.name);
          if (plan.deferred.has(column.name)) {
            if (column.nullable) values[column.name] = null;
            continue;
          }
          if (ref) {
            const options = rowList(ref.table).filter((row) => row[ref.column] != null);
            if (!options.length) {
              if (column.nullable) values[column.name] = null;
              else ok = false;
              continue;
            }
            /* The first rows go one to each parent, so none is childless; the rest favor a few, as a busy doctor or a
               popular product has more than a quiet one. */
            const covering = made < options.length;
            /* An optional reference is sometimes empty: not every work order has its mechanic yet. */
            if (column.nullable && !covering && dice.chance(0.12)) {
              values[column.name] = null;
              continue;
            }
            let order = ordersOf.get(column.name);
            if (!order) ordersOf.set(column.name, (order = crowd(dice, options)));
            if (!covering && (table.unique ?? []).includes(column.name)) {
              ok = false;
              continue;
            }
            const parent = covering ? order.rows[made]! : order.pick(dice);
            parents.set(column.name, parent);
            values[column.name] = parent[ref.column] as Value;
            continue;
          }
          const kind = moment(column, types);
          if (kind) {
            const at = (() => {
              if (stamped.has(column.name)) return stamped.get(column.name)!;
              if (machineStamps.has(column.name) || column.name === plan.life?.since) return undefined;
              if (column.name === bornColumn) return life.born;
              if (SCHEDULE.test(column.name) && !DUE.test(column.name)) {
                if (plan.life && !life.open)
                  return new Date(Math.min(life.born.getTime() + dice.int(0, 3) * DAY, today.getTime() - 60_000));
                return scheduledFor(dice, today);
              }
              if (DUE.test(column.name)) {
                if (!plan.life) return scheduledFor(dice, today);
                if (!life.open) return new Date(life.born.getTime() + dice.int(3, 14) * DAY);
                const roll = dice.next();
                return roll < 0.15
                  ? today
                  : roll < 0.35
                    ? new Date(today.getTime() - dice.int(1, 6) * DAY)
                    : new Date(today.getTime() + dice.int(1, 14) * DAY);
              }
              if (/birth|dob/i.test(column.name)) return new Date(Date.UTC(dice.int(1955, 2004), dice.int(0, 11), dice.int(1, 28)));
              if (/expir|valid_until|renew|ends?_(at|on)/i.test(column.name)) return new Date(today.getTime() + dice.int(30, 365) * DAY);
              if (column.nullable && !bornColumn && dice.chance(0.2)) return undefined;
              return new Date(Math.min(life.born.getTime() + dice.int(0, 3) * DAY, today.getTime() - 60_000));
            })();
            if (at === undefined) {
              if (column.nullable) values[column.name] = null;
              else values[column.name] = written(life.born, kind);
            } else values[column.name] = written(at, kind);
            continue;
          }
          if (column.allowed?.length) {
            if (column.nullable && dice.chance(0.1)) values[column.name] = null;
            else values[column.name] = dice.weighted(column.allowed, (value) => W.PRIORITY_WEIGHT[value.toLowerCase()] ?? 2);
            continue;
          }
          if (isFlagColumn(column)) {
            const p = /active|enabled|visible|published|available|in_stock/i.test(column.name) ? 0.85 : 0.2;
            const yes = dice.chance(p);
            values[column.name] = columnKind(column.type) === 'boolean' ? yes : yes ? 1 : 0;
            continue;
          }
          const kindOf = columnKind(column.type ?? '');
          if (kindOf === 'number') {
            const tier = plan.lookup ? lookupNumber(column, n) : undefined;
            values[column.name] =
              tier !== undefined
                ? plan.minor.has(column.name)
                  ? tier * 100
                  : tier
                : numberFor(dice, column, line, plan.minor.has(column.name));
            continue;
          }
          if (kindOf === 'boolean') {
            values[column.name] = dice.chance(0.3);
            continue;
          }
          if (kindOf === 'text') {
            const reasonOf = plan.life ? [...plan.life.reasons].find(([, c]) => c === column.name)?.[0] : undefined;
            if (reasonOf !== undefined || (plan.life && /(^|_)reason$/i.test(column.name))) {
              values[column.name] =
                life.state && (reasonOf === life.state || plan.life?.exits.includes(life.state))
                  ? dice.pick(L.wordsFor(plan.domain, 'reason'))
                  : column.nullable
                    ? null
                    : '';
              continue;
            }
            if (/json/i.test(column.type)) {
              values[column.name] = column.nullable ? null : '{}';
              continue;
            }
            /* Text is filled: a first look at a table with every other cell blank says nothing. Only what is blank by
               nature (a note, a second address line) is left so often. */
            if (
              column.nullable &&
              !/(^|_)(e?mail|name|title|subject|summary|problem|issue)$/i.test(column.name) &&
              dice.chance(OPTIONAL_TEXT.test(column.name) ? 0.4 : 0.04)
            ) {
              values[column.name] = null;
              continue;
            }
            let text = String(
              (plan.lookup && LOOKUP_NAME.test(column.name) ? lookupName(plan.table, n, plan.domain) : undefined) ??
                textFor(dice, plan, column, person, n, personLike, companyLike),
            );
            const max = column.text?.max;
            if (max && text.length > max) text = text.slice(0, max);
            values[column.name] = text;
            continue;
          }
          if (!column.nullable && !column.hasDefault) ok = false;
        }
        if (!ok) break;
        /* Two references that must agree do: when the bike picked has an owner, the work order's customer is that owner. */
        for (const [a, parent] of parents) {
          const via = referencesOf(schema, tables.get(plan.refs.get(a)!.table)!);
          for (const [b, refB] of plan.refs) {
            if (b === a || values[b] === null) continue;
            const through = [...via].find(([, ref]) => ref.table === refB.table && ref.column === refB.column)?.[0];
            if (through && parent[through] != null) values[b] = parent[through] as Value;
          }
        }
        /* A line's price is its part's price, as the App's form fills it. */
        for (const column of table.columns) {
          if (!isMoneyColumn(column) || plan.refs.has(column.name) || typeof values[column.name] !== 'number') continue;
          const bare = column.name.replace(/^unit_/, '');
          for (const parent of parents.values()) {
            const same = [column.name, bare].find(
              (name) =>
                typeof parent[name] === 'number' ||
                (typeof parent[name] === 'string' && parent[name] !== '' && !Number.isNaN(Number(parent[name]))),
            );
            if (same) {
              values[column.name] = Number(parent[same]);
              break;
            }
          }
        }
        /* Never repeat what must be unique: a second "Ada Lam" gets a number, a second pair is skipped. */
        for (const column of table.unique ?? []) {
          const key = `${table.id}.${column}`;
          const value = values[column];
          if (value === undefined || value === null) continue;
          if (!taken.has(key, value)) continue;
          let changed: Value | undefined;
          for (let k = 2; k < 1000 && changed === undefined; k++) {
            const next =
              typeof value === 'number'
                ? value + k * 1000
                : /@/.test(String(value))
                  ? String(value).replace('@', `${k}@`)
                  : `${value} ${k}`;
            if (!taken.has(key, next)) changed = next;
          }
          values[column] = changed ?? null;
        }
        const pairKeys = pairs.map(([a, b]) => `${table.id}.${a}+${b}`);
        if (pairs.some(([a, b], i) => values[a] != null && values[b] != null && taken.has(pairKeys[i], `${values[a]}\u0000${values[b]}`)))
          continue;
        const inserted = await tx.insert({ table: table.id, values });
        const row = { ...values, ...(inserted.row ?? {}), ...inserted.key };
        for (const column of table.unique ?? []) if (row[column] != null) taken.add(`${table.id}.${column}`, row[column] as Value);
        pairs.forEach(([a, b], i) => taken.add(pairKeys[i], `${row[a]}\u0000${row[b]}`));
        rowList(table.id).push(row);
        if (opts.people && local(opts.people.table) === local(table.name) && report.signIn.length < 3 && row[opts.people.column])
          report.signIn.push(String(row[opts.people.column]));
        made++;
        if (made >= plan.rows) break;
      }
      report.tables.push({ table: table.name, rows: made });
    }
    return report;
  });
}

/** Parents in a shuffled order, with a Zipf-ish weight by rank for the rows after each has one. */
interface Crowd {
  rows: Array<Record<string, unknown>>;
  pick: (dice: Dice) => Record<string, unknown>;
}

function crowd(dice: Dice, options: Array<Record<string, unknown>>): Crowd {
  const rows = [...options];
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(dice.next() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  let sum = 0;
  const cumulative = rows.map((_, rank) => (sum += 1 / (rank + 1) ** 0.8));
  return {
    rows,
    pick(d) {
      const at = d.next() * sum;
      let lo = 0;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! < at) lo = mid + 1;
        else hi = mid;
      }
      return rows[lo]!;
    },
  };
}

/** When a scheduled thing happens: a little of it today, most of it ahead, a good deal behind within the quarter. */
function scheduledFor(dice: Dice, today: Date): Date {
  const roll = dice.next();
  const days = roll < 0.15 ? 0 : roll < 0.6 ? dice.int(1, 21) : -dice.int(1, 90);
  return new Date(today.getTime() + days * DAY + dice.int(8, 17) * 3_600_000 + dice.int(0, 3) * 15 * 60_000);
}

/* SQLite's INTEGER PRIMARY KEY is the rowid: the database numbers it. */
const autoKey = (column: ColumnMeta, primary: ColumnMeta[]) => primary.length === 1 && /^integer$/i.test(column.type.trim());

function written(at: Date, kind: 'date' | 'instant' | 'instant-zoned'): string {
  return kind === 'date' ? dayText(at) : kind === 'instant-zoned' ? `${at.toISOString().slice(0, 19)}Z` : wallText(at);
}

async function readAll(tx: WriteTransaction, table: string, columns: string[]): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const page = await tx.query({ table, columns, limit: 1000, offset });
    rows.push(...page.rows);
    if (page.rows.length < 1000) break;
  }
  return rows;
}
