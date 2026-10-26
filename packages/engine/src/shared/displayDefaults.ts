/**
 * The conventions an App applies without being told: how a column is drawn
 * when its name, type or vocabulary says what it holds. A `price` is money, a
 * `due_on` is said from today, an `email` is a link, a CHECK vocabulary of
 * plain words wears tones by what the words mean, a machine's states wear
 * tones by where they stand, a person's name has an initials disc. The
 * scaffold used to write each of these out; now the platform infers them at
 * runtime, `mistri check --defaults` prints every one per resource, and a
 * rule the App writes that only restates one is a `restated` warning.
 *
 * What the App writes wins, concern by concern: a declared `format` (or a
 * unit, a bar) replaces the inferred figure, a declared `tone` or `colors` the
 * inferred tones, declared `values` the inferred words, a declared avatar or
 * mark the inferred disc. An empty rule (`display: { value: {} }`) keeps the
 * column exactly as stored.
 *
 * Pure over one table's catalog entry, so the server's payload, `check` and
 * the scaffold read one rule.
 */
import {
  columnKind,
  isFlagColumn,
  labelColumn,
  stateStampColumn,
  tableNamed,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from './schema.js';
import type { AppDisplayRule } from './servedApp.js';
import { displayWord, type DisplayTone } from './model.js';
import { inferredFormDefaults } from './formValues.js';
import { columnCaption } from './columnCaption.js';
import { DUE } from './dueDate.js';
import type { Rollup } from './rollups.js';

/** A machine as the conventions read it: its column, its states in order and its verbs. An App's machine
    (appMachine.ts) says more; this is the part a tone or a stamp is read from. */
interface DisplayMachine {
  column: string;
  since?: string;
  states: readonly { name: string; final?: boolean }[];
  edges: readonly { verb: string; from: string; to: readonly string[]; fixed?: { set: Record<string, unknown> } }[];
}

/** What the conventions read of an App's declared resources: their captions, record label, display rules,
    machine and New form defaults. The App's own definition (appModel.ts) holds them, among much else. */
interface DeclaredResources {
  resources?: Readonly<
    Record<
      string,
      {
        labels?: Record<string, string>;
        recordLabel?: string | false;
        display?: Record<string, AppDisplayRule>;
        machine?: DisplayMachine;
        form?: { defaults?: unknown };
      }
    >
  >;
  ui?: unknown;
}

/* Money by name, the words a ledger uses (a rent, a charge, what was billed and paid, an hourly rate), on a
   column the catalog says holds a number; a Postgres `money` column is money whatever it is called. */
export const MONEY =
  /(^|_)(amount|total|subtotal|price|cost|costs|revenue|budget|quota|fee|fees|salary|balance|value|pay|paid|wage|wages|rent|charge|charges|billed|deposit|refund|payout|premium|(hourly|daily|nightly|day)_rate)$/i;
const MONEY_TYPE = /^money$/i;
/* Named like a yes-or-no. `auto_` is a switch (auto_renew, auto_pay) unless a plural follows it: a lender's
   `auto_tradelines` counts car loans, 0 to 3. */
const FLAG_NAME = /^(is|has)_|able$|^auto_(?!.*[^s]s$)/i;
const PERCENT = /(probability|percent|pct|progress|(^|_)rate)$/i;
/* valueModel.ts YEAR_NAME: the browser already says such a column as a year. */
const YEAR = /(^|_)(year|yr)(_|$)/i;
/* A figure's unit, read off its name: "30 min", "1,494 sq ft", "3 bd". */
export const UNITS: Array<[RegExp, string]> = [
  [/(^|_)minutes$/i, 'min'],
  [/(^|_)hours$/i, 'h'],
  [/(^|_)days$/i, 'days'],
  [/(^|_)(square_feet|sq_ft|sqft)$/i, 'sq ft'],
  [/^bedrooms$/i, 'bd'],
  [/^bathrooms$/i, 'ba'],
  [/(^|_)(miles|mileage)$/i, 'mi'],
  [/(^|_)kg$/i, 'kg'],
  [/(^|_)(lb|lbs)$/i, 'lb'],
];
/* A column named like a way to reach someone (valueModel.ts links the same names in the browser). */
const LINKS: Array<[RegExp, 'email' | 'phone' | 'url']> = [
  [/(^|_)e_?mail(_address)?$/i, 'email'],
  [/(^|_)(phone|mobile|cell|telephone|tel)(_number|_no)?$/i, 'phone'],
  [/(^|_)(url|website|web_site|homepage|home_page)$/i, 'url'],
];
/* A table whose rows are people, by its head noun (`customer`, `field_technician`): their name wears an initials
   disc. The scaffold's people icons (users, user) read the same nouns. */
const PEOPLE =
  /^(customer|client|person|people|member|user|patient|student|guest|owner|employee|staff|agent|rep|worker|author|driver|technician|mechanic|provider|doctor|physician|nurse|clinician|instructor|teacher)s?$/i;
const CODE_NAME = /^(label|code|number|num|no|unit|slot|position)$/i;
const LONG_TEXT = /(description|body|notes?|summary|content|details|comments?|bio|message|text|address|html|markdown)$/i;

/* A stored vocabulary word's tone, by what the word says. Unrecognised words
   stay neutral: a chip only earns a colour when the word earns it. Arriving
   is an outcome (`received` is good); calling something off is not a failure
   (`cancelled`, `void`, `archived` stay neutral) — red is for what went wrong. */
const GOOD =
  /^(done|complete|completed|paid|won|closed_won|active|approved|resolved|shipped|delivered|received|arrived|converted|qualified|success|succeeded|published|accepted|fulfilled|confirmed|live|healthy|passed|hot|good|in_stock|on_track|occupied)$/i;
const BAD =
  /^(failed|failure|lost|closed_lost|rejected|denied|overdue|error|expired|churned|declined|blocked|critical|urgent|bounced|cold|suspended|dead|bad|out_of_stock|off_track|no_show)$/i;
const WARN =
  /^(hold|on_hold|pending|awaiting|awaiting_\w+|waiting|waiting_\w+|draft|paused|review|in_review|at_risk|warm|high|delayed|late|stale|warn|warning|due|expiring|vacant|partially_paid|partial)$/i;
const INFO =
  /^(open|new|in_progress|working|ready|planned|planning|scheduled|submitted|sent|started|processing|info|negotiation|proposal|upcoming|make_ready)$/i;

/* A stored word is judged as said: "in progress", "no-show" and IN_REVIEW are the same words as in_progress. */
function wordTone(stored: string): DisplayTone {
  const value = stored
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return GOOD.test(value) ? 'good' : BAD.test(value) ? 'bad' : WARN.test(value) ? 'warn' : INFO.test(value) ? 'info' : 'neutral';
}

/** Tones for a short vocabulary, or nothing: a map that colours nothing says nothing. */
export function vocabularyTones(allowed: readonly string[]): Record<string, DisplayTone> | undefined {
  if (allowed.length > 12) return undefined;
  const map = Object.fromEntries(allowed.map((value) => [value, wordTone(value)]));
  return Object.values(map).some((tone) => tone !== 'neutral' && tone !== 'info') ? map : undefined;
}

/**
 * A machine's tones, where the App gives none: a final state is neutral (it is
 * over, however it ended); the open state furthest along that hands the record
 * to a final one (`ready` before `collected`) is good, the work done; a state
 * whose word says it waits (`waiting_parts`, `on_hold`) warns, one whose word
 * says it went wrong is bad, and the rest are neutral or, by their word, info.
 */
export function machineTones(machine: Pick<DisplayMachine, 'states' | 'edges'>): Record<string, DisplayTone> {
  const final = new Set(machine.states.filter((state) => state.final).map((state) => state.name));
  /* How far each state is from the first, along any verb. */
  const depth = new Map<string, number>([[machine.states[0]?.name, 0]]);
  for (let frontier = [machine.states[0]?.name]; frontier.length;) {
    const next: string[] = [];
    for (const from of frontier)
      for (const edge of machine.edges)
        if (edge.from === from)
          for (const to of edge.to)
            if (!depth.has(to)) {
              depth.set(to, depth.get(from)! + 1);
              next.push(to);
            }
    frontier = next;
  }
  let done: string | undefined;
  for (const state of machine.states) {
    const name = state.name;
    if (state.final || !machine.edges.some((edge) => edge.from === name && edge.to.some((to) => final.has(to)))) continue;
    if (wordTone(name) === 'warn' || wordTone(name) === 'bad' || (depth.get(name) ?? 0) === 0) continue;
    if (done === undefined || (depth.get(name) ?? 0) >= (depth.get(done) ?? 0)) done = name;
  }
  return Object.fromEntries(
    machine.states.map((state) => {
      if (state.final) return [state.name, 'neutral'];
      if (state.name === done) return [state.name, 'good'];
      const word = wordTone(state.name);
      return [state.name, word === 'good' ? 'info' : word];
    }),
  );
}

/* The words a vocabulary is said in without a rule: lowercase words joined by `_`, a space or `-` (vocabularyWord).
   A code in capitals (IN_REVIEW) or run together (InReview) needs a `values` map to read as words. */
const SAID_AS_WORDS = /^[a-z][a-z0-9]*(?:(?:_+| |-)[a-z0-9]+)*$/;

/** A figure that is money: named like money on a number column, or typed as money. */
export function isMoneyColumn(column: ColumnMeta): boolean {
  return (
    !column.flag &&
    !column.primaryKey &&
    (MONEY_TYPE.test(column.type ?? '') || (columnKind(column.type ?? '') === 'number' && MONEY.test(column.name)))
  );
}

/** One inferred rule and the reason it is inferred, in words `check --defaults` prints. */
interface InferredRule {
  rule: AppDisplayRule;
  why: string;
  /** False where the browser already reads the convention off the name (a year, an email's link): the rule is
      printed and a restatement warned, but nothing is served, so the two readings cannot drift. */
  served?: false;
}

/** What the conventions are read with: the table's machine, the catalog its rollups reach, and the rules the App
    declares on any table (a figure made of money is counted as that money is). */
interface InferOptions {
  machine?: DisplayMachine;
  schema?: DatabaseSchema;
  declared?: (table: TableMeta) => Readonly<Record<string, AppDisplayRule>> | undefined;
}

/** The App's declared display rules looked up by table, as `InferOptions.declared` reads them. */
export function declaredDisplayOf(
  app: DeclaredResources,
  schema: DatabaseSchema,
): (table: TableMeta) => Readonly<Record<string, AppDisplayRule>> | undefined {
  const byId = new Map<string, Readonly<Record<string, AppDisplayRule>>>();
  for (const [resource, def] of Object.entries(app.resources ?? {})) {
    const table = def.display && tableNamed(schema, resource);
    if (table && !byId.has(table.id)) byId.set(table.id, def.display!);
  }
  return (table) => byId.get(table.id);
}

/**
 * Every rule the conventions give one table's columns, keyed by column. A
 * reference, a key and a column whose type says nothing are left alone.
 */
export function inferredDisplay(table: TableMeta, opts: InferOptions = {}): Record<string, InferredRule> {
  const inferred: Record<string, InferredRule> = {};
  const named = labelColumn(table);
  for (const column of table.columns) {
    if (column.primaryKey || column.references) continue;
    const kind = columnKind(column.type ?? '');
    const link = LINKS.find(([pattern]) => pattern.test(column.name));
    const unit = kind === 'number' && !column.flag ? UNITS.find(([pattern]) => pattern.test(column.name)) : undefined;
    let made: InferredRule | undefined;
    if (opts.machine?.column === column.name) {
      made = { rule: { tone: machineTones(opts.machine) }, why: "the machine's states: final neutral, the last forward state good" };
    } else if (FLAG_NAME.test(column.name) && /int/i.test(column.type ?? '') && !column.flag && !column.allowed?.length) {
      made = { rule: { values: { 0: 'No', 1: 'Yes' } }, why: 'a 0/1 integer named like a yes-or-no' };
    } else if (isMoneyColumn(column)) {
      made = { rule: { format: 'money' }, why: MONEY_TYPE.test(column.type ?? '') ? 'a money column' : 'a number named like money' };
    } else if (kind === 'number' && PERCENT.test(column.name) && !column.flag) {
      made = { rule: { format: 'percent', bar: true }, why: 'a number named like a percentage' };
    } else if (kind === 'number' && YEAR.test(column.name) && !column.flag) {
      made = { rule: { format: 'year' }, why: 'a number named like a year', served: false };
    } else if (kind === 'date' && DUE.test(column.name)) {
      made = { rule: { format: 'relative' }, why: 'a date named like a due date, said from today' };
    } else if (unit) {
      made = { rule: { unit: unit[1] }, why: `a number whose name says its unit` };
    } else if (link && kind === 'text') {
      made = {
        rule: { format: link[1] },
        why: `a text column named like ${link[1] === 'url' ? 'a web address' : link[1] === 'email' ? 'an email' : 'a phone number'}`,
        served: false,
      };
    } else if (column.allowed?.length && !column.flag) {
      const tones = vocabularyTones(column.allowed);
      if (tones) made = { rule: { tone: tones }, why: 'a vocabulary whose words say a tone' };
      else if (column.allowed.some((value) => !SAID_AS_WORDS.test(value)))
        made = {
          rule: { values: Object.fromEntries(column.allowed.map((value) => [value, displayWord({ humanize: true }, value) ?? value])) },
          why: 'a vocabulary of codes, said as words',
        };
    }
    if (!made && column.name === named && isPeople(table) && strongName(column)) {
      const email = table.columns.find((candidate) => /(^|_)email$/i.test(candidate.name));
      made = {
        rule: { avatar: true, ...(email ? { subtitle: email.name } : {}) },
        why: `a person's name${email ? ', their email under it' : ''}`,
      };
    }
    if (made) inferred[column.name] = made;
  }
  /* A figure computed from money is money: `labor + parts`, a sum of charges, the most a line cost. */
  const declaredOn = (of: TableMeta | undefined, name: string) => (of ? opts.declared?.(of)?.[name] : undefined);
  const moneyOn = (of: TableMeta | undefined, name: string): boolean => {
    if (declaredOn(of, name)?.format === 'money') return true;
    const stored = of?.columns.find((column) => column.name === name);
    if (stored) return isMoneyColumn(stored);
    const computed = of?.computed?.[name];
    if (computed) return computed.type === 'number' && moneyExpression(of!, computed.reads);
    const rollup = of?.rollups?.[name];
    return Boolean(rollup && rollup.fn !== 'count' && rollup.fn !== 'latest' && rollupMoney(rollup));
  };
  /* A rollup's child, and the child's columns it reads: a sum of money is money. A child's figures never read a
     rollup (appRollupRules), so the walk ends there. */
  const rollupChild = (rollup: Rollup) => (opts.schema ? tableNamed(opts.schema, rollup.via.slice(0, rollup.via.indexOf('.'))) : undefined);
  const rollupReads = (rollup: Rollup) => (rollup.expression ? rollup.expression.reads : rollup.column ? [rollup.column] : []);
  const rollupMoney = (rollup: Rollup): boolean => {
    const child = rollupChild(rollup);
    return Boolean(
      rollup.column &&
      (rollup.expression
        ? rollup.expression.type === 'number' && child && moneyExpression(child, rollup.expression.reads)
        : moneyOn(child, rollup.column)),
    );
  };
  const moneyExpression = (of: TableMeta, reads: readonly string[]) =>
    reads.length > 0 && reads.every((path) => !path.includes('.') && moneyOn({ ...of, computed: undefined }, path));
  /* The money a figure is made of says how it is counted: cents in, cents out. A price kept in minor units times a
     quantity is minor units too, and drawn as dollars it would read a hundred times too large. A currency every
     input shares carries the same way; inputs that disagree carry neither. */
  const countedAs = (of: TableMeta | undefined, reads: readonly string[], seen = new Set<string>()): AppDisplayRule => {
    const rules: AppDisplayRule[] = [];
    for (const path of reads) {
      if (!of || path.includes('.') || !moneyOn(of, path)) continue;
      const own = declaredOn(of, path);
      const computed = of.computed?.[path];
      const rollup = of.rollups?.[path];
      const key = `${of.id}.${path}`;
      if (own?.format === 'money' || (!computed && !rollup) || seen.has(key)) rules.push(own ?? {});
      else if (computed) rules.push(countedAs(of, computed.reads, new Set([...seen, key])));
      else rules.push(countedAs(rollupChild(rollup!), rollupReads(rollup!), new Set([...seen, key])));
    }
    if (!rules.length) return {};
    const minor = rules.every((rule) => rule.minor === true);
    const currency = rules[0]!.currency;
    return {
      ...(minor ? { minor: true as const } : {}),
      ...(currency && rules.every((rule) => rule.currency === currency) ? { currency } : {}),
    };
  };
  for (const [name, computed] of Object.entries(table.computed ?? {})) {
    if (inferred[name] || computed.type !== 'number') continue;
    if (MONEY.test(name) || moneyExpression(table, computed.reads))
      inferred[name] = {
        rule: { format: 'money', ...countedAs(table, computed.reads) },
        why: MONEY.test(name) ? 'a figure named like money' : 'a figure made of money columns',
      };
  }
  for (const [name, rollup] of Object.entries(table.rollups ?? {})) {
    if (inferred[name] || rollup.fn === 'count' || rollup.fn === 'latest' || columnKind(rollup.type) !== 'number') continue;
    const fromMoney = rollupMoney(rollup);
    if (fromMoney || MONEY.test(name))
      inferred[name] = {
        rule: { format: 'money', ...countedAs(rollupChild(rollup), rollupReads(rollup)) },
        why: fromMoney ? `a ${rollup.fn} of money` : 'a figure named like money',
      };
  }
  return inferred;
}

/* A name a person is known by: one every row has, not a key, a code or a note. */
const strongName = (column: ColumnMeta) =>
  !column.primaryKey &&
  !column.nullable &&
  !LONG_TEXT.test(column.name) &&
  !CODE_NAME.test(column.name) &&
  !isFlagColumn(column) &&
  columnKind(column.type) === 'text';

/** Rows that are people, by the table's head noun. */
export function isPeople(table: Pick<TableMeta, 'name'>): boolean {
  const local = table.name.slice(table.name.lastIndexOf('.') + 1).toLowerCase();
  return PEOPLE.test(local) || PEOPLE.test(local.slice(local.lastIndexOf('_') + 1));
}

/* Each concern of a rule, by the keys that say it: a declared key of a concern replaces the inferred concern whole. */
const CONCERNS: ReadonlyArray<{ name: string; owns: readonly (keyof AppDisplayRule)[]; displaces: readonly (keyof AppDisplayRule)[] }> = [
  {
    name: 'figure',
    owns: ['format', 'bar', 'unit', 'minor', 'currency'],
    displaces: ['format', 'bar', 'unit', 'ring', 'slider', 'outOf', 'max', 'minor', 'currency', 'currencyColumn', 'values', 'avatar'],
  },
  { name: 'words', owns: ['values'], displaces: ['values', 'format'] },
  { name: 'tone', owns: ['tone'], displaces: ['tone', 'colors'] },
  { name: 'disc', owns: ['avatar', 'subtitle'], displaces: ['avatar', 'icon', 'format', 'subtitle'] },
];
const WHOLE: readonly string[] = ['component', 'masked'];

/** The inferred concerns a declared rule leaves standing: what the App did not say about that part of the column. */
function standingInferred(inferred: AppDisplayRule, declared: AppDisplayRule | undefined): AppDisplayRule {
  if (!declared) return inferred;
  const said = Object.keys(declared);
  // An empty rule keeps the column as stored; a component or a mask draws it whole.
  if (!said.length || said.some((key) => WHOLE.includes(key))) return {};
  const kept: Record<string, unknown> = {};
  for (const concern of CONCERNS) {
    if (concern.displaces.some((key) => said.includes(key))) continue;
    for (const key of concern.owns) if (inferred[key] !== undefined) kept[key] = inferred[key];
  }
  return kept as AppDisplayRule;
}

/** The rule a column is drawn by: the inferred concerns the App left standing, under what the App wrote. */
function withInferred(inferred: AppDisplayRule | undefined, declared: AppDisplayRule | undefined): AppDisplayRule | undefined {
  if (!inferred) return declared;
  const standing = standingInferred(inferred, declared);
  if (!Object.keys(standing).length) return declared;
  return { ...standing, ...declared };
}

/**
 * The concerns of a declared rule that say exactly what the conventions
 * would: each is a deletion. A tone map is the same when it gives every value
 * the inferred tone; a figure when its format, bar and unit are the inferred ones.
 */
function restatedConcerns(inferred: AppDisplayRule, declared: AppDisplayRule): Array<{ keys: string[]; said: string }> {
  const found: Array<{ keys: string[]; said: string }> = [];
  if (Object.keys(declared).some((key) => WHOLE.includes(key))) return found;
  const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  for (const concern of CONCERNS) {
    const own = concern.owns.filter((key) => inferred[key] !== undefined);
    if (!own.length) continue;
    const declaredKeys = Object.keys(declared).filter((key) => concern.displaces.includes(key as keyof AppDisplayRule));
    if (!declaredKeys.length || declaredKeys.some((key) => !own.includes(key as keyof AppDisplayRule))) continue;
    if (own.every((key) => same(inferred[key], declared[key])))
      found.push({ keys: own as string[], said: own.map((key) => `${key}: ${JSON.stringify(declared[key])}`).join(', ') });
  }
  return found;
}

function sorted(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sorted(v)]),
  );
}

/**
 * A resource's display rules as they are drawn: each column's declared rule
 * over the conventions it leaves standing, and a rule for every column the
 * conventions dress that the App did not mention. `served` keeps only what the
 * server sends (the browser reads a year and a link off the name itself).
 */
export function effectiveDisplay(
  declared: Readonly<Record<string, AppDisplayRule>> | undefined,
  table: TableMeta,
  opts: InferOptions & { served?: boolean } = {},
): Record<string, AppDisplayRule> {
  const out: Record<string, AppDisplayRule> = { ...declared };
  for (const [column, inferred] of Object.entries(inferredDisplay(table, opts))) {
    if (opts.served && inferred.served === false) continue;
    const merged = withInferred(inferred.rule, declared?.[column]);
    if (merged) out[column] = merged;
  }
  return out;
}

/** A declared rule, or part of one, that says what the platform would: a deletion. */
export interface RestatedRule {
  resource: string;
  /** The keys from the anchor written in the source down to the object holding `keys`: `['display', 'price']`,
      `['defaults']`, `['set']`, `['labels']`, `['display', 'kind', 'values']`; empty for the resource's own key. */
  at: string[];
  /** The keys there to delete. */
  keys: string[];
  /** The object at `at` as the App declares it: what the source must say there for the deletion to be made. */
  held?: Record<string, unknown>;
  /** The whole rule or holder goes: nothing else is left in it. */
  whole: boolean;
  /** The warning: what is restated, where, and why the platform says it already. */
  warning: string;
}

/**
 * Every declared value the platform derives, so deleting it changes nothing:
 * a display rule or concern of one the conventions give, a caption the screens
 * say anyway, a record label that is the label column, a `number` format beside
 * a unit, the App's own currency, a word a vocabulary says by itself, a form
 * default that is the schema's DEFAULT, a verb's stamp its state writes on
 * entry. `check` warns on each (`restated`) and `check --design --fix` deletes
 * exactly these, so the two never disagree.
 */
export function restatedDefaults(app: DeclaredResources, schema: DatabaseSchema): RestatedRule[] {
  const found: RestatedRule[] = [];
  const resources = app.resources ?? {};
  const own = (app.ui as { currency?: string } | undefined)?.currency ?? 'USD';
  for (const [resource, def] of Object.entries(resources)) {
    const table = tableNamed(schema, resource);
    const where = `resources "${resource}" [restated]`;
    if (table) {
      for (const [path, said] of Object.entries(def.labels ?? {})) {
        const { [path]: _stated, ...rest } = def.labels!;
        const derived = columnCaption({ ...resources, [resource]: { ...def, labels: rest } }, schema, table.id, path);
        if (derived === said)
          found.push({
            resource,
            at: ['labels'],
            keys: [path],
            held: def.labels,
            whole: Object.keys(def.labels!).length === 1,
            warning: `${where}: labels "${path}" says "${said}", which the screens say without it. Delete it.`,
          });
      }
      if (def.recordLabel !== undefined && def.recordLabel === labelColumn(table))
        found.push({
          resource,
          at: [],
          keys: ['recordLabel'],
          whole: false,
          warning: `${where}: recordLabel "${def.recordLabel}" is the table's label column already. Delete it.`,
        });
    }
    const inferred = table ? inferredDisplay(table, { machine: def.machine, schema }) : {};
    for (const [column, rule] of Object.entries(def.display ?? {})) {
      if (!rule) continue;
      const held = rule as Record<string, unknown>;
      const convention = inferred[column];
      const concerns = convention && Object.keys(rule).length ? restatedConcerns(convention.rule, rule) : [];
      if (concerns.length) {
        const keys = concerns.flatMap((concern) => concern.keys);
        const whole = Object.keys(rule).every((key) => keys.includes(key));
        found.push({
          resource,
          at: ['display', column],
          keys,
          held,
          whole,
          warning:
            `${where}: display "${column}" says ${concerns.map((concern) => concern.said).join(', ')}, which the platform infers ` +
            `(${convention!.why}). Delete ${whole ? 'the rule' : keys.length > 1 ? 'those keys' : 'it'}.`,
        });
        continue;
      }
      if (rule.format === 'number' && rule.unit !== undefined)
        found.push({
          resource,
          at: ['display', column],
          keys: ['format'],
          held,
          whole: false,
          warning: `${where}: display "${column}" says format: 'number' beside a unit, which already means a number. Delete the format.`,
        });
      /* A declared vocabulary (a check constraint, an enum) or a toned column says its values as words already, so an
         entry whose word is what that gives says nothing. A free-text column keeps its stored words. */
      const stored = table?.columns.find((candidate) => candidate.name === column);
      const allowed = stored?.allowed;
      /* Without a declared vocabulary, the keys of `values` are the order a `steps` breakdown, a chart and a donut
         read the column in (client groupOrder.ts declaredOrder), so deleting one reorders them: only a column the
         order does not read them from (a reference, or a vocabulary that has its own) has them restated. */
      const orders = !allowed?.length && !stored?.references;
      for (const [value, said] of Object.entries(rule.values ?? {}))
        if ((allowed?.includes(value) || (rule.tone !== undefined && !orders)) && displayWord({ humanize: true }, value) === said)
          found.push({
            resource,
            at: ['display', column, 'values'],
            keys: [value],
            held: rule.values,
            whole: false,
            warning: `${where}: display "${column}" values "${value}" says "${said}", which the screens say without it. Delete it.`,
          });
      if (rule.format === 'money' && rule.currency !== undefined && rule.currency.toUpperCase() === own)
        found.push({
          resource,
          at: ['display', column],
          keys: ['currency'],
          held,
          whole: false,
          warning: `${where}: display "${column}" says currency: '${rule.currency}', which is the App's currency (ui.currency, else USD). Delete it.`,
        });
    }
    if (!table) continue;
    /* A verb that stamps the state it enters, by hand: the machine stamps `ready_at` on entry to `ready` already. */
    for (const edge of def.machine?.edges ?? []) {
      const set = edge.fixed?.set ?? {};
      for (const to of edge.to.length === 1 ? edge.to : []) {
        const stamp = stateStampColumn(to, table.columns, def.machine!);
        const said = stamp ? stampWord(set[stamp.name]) : undefined;
        if (stamp && (said === 'now' || said === 'today'))
          found.push({
            resource,
            at: ['set'],
            keys: [stamp.name],
            held: set,
            whole: Object.keys(set).length === 1,
            warning:
              `${where}: machine verb "${edge.verb}" says set: { ${stamp.name}: ${said} }, which the platform infers ` +
              `("${stamp.name}" is stamped as the record enters "${to}"). Delete it.`,
          });
      }
    }
    const schemaDefaults = inferredFormDefaults(table);
    const declared = (def.form?.defaults ?? {}) as Record<string, unknown>;
    for (const column of Object.keys(declared).filter(
      (name) => schemaDefaults[name] !== undefined && declared[name] === schemaDefaults[name],
    ))
      found.push({
        resource,
        at: ['defaults'],
        keys: [column],
        held: declared,
        whole: false,
        warning:
          `${where}: form defaults "${column}" says ${JSON.stringify(declared[column])}, which the platform infers ` +
          "(the column's schema DEFAULT). Delete it.",
      });
  }
  return found;
}

/* A stamp word as written: the DSL's constant (`now`, an `{ auto: 'now' }`) or the word itself. */
const stampWord = (value: unknown) =>
  value && typeof value === 'object' && 'auto' in value
    ? String((value as { auto: unknown }).auto)
    : typeof value === 'string'
      ? value
      : undefined;

/** What `check --defaults` prints: each declared resource's inferred rules, and whether the App's own rule wins. */
export function inferredReport(
  app: DeclaredResources,
  schema: DatabaseSchema,
): Array<{ resource: string; column: string; rule: AppDisplayRule; why: string; overridden: boolean }> {
  const rows: Array<{ resource: string; column: string; rule: AppDisplayRule; why: string; overridden: boolean }> = [];
  const declaredOf = declaredDisplayOf(app, schema);
  for (const [resource, def] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, resource);
    if (!table) continue;
    for (const [column, inferred] of Object.entries(inferredDisplay(table, { machine: def.machine, schema, declared: declaredOf }))) {
      const declared = def.display?.[column];
      const standing = standingInferred(inferred.rule, declared);
      rows.push({ resource, column, rule: inferred.rule, why: inferred.why, overridden: !Object.keys(standing).length });
    }
  }
  return rows;
}
