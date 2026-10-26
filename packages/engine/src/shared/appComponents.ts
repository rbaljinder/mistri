/**
 * Custom components, as the App definition declares them: an author's own
 * React module, referenced by path and placed only through a declared kind —
 * a `custom` section on a page or a dashboard, a value renderer where a
 * display rule stands, an input where a form draws a field, a list view's
 * rows (`customList`) or a free-form page (`definePage` in `pages/*.page.tsx`).
 *
 * The definition stays data. `app.ts` is evaluated in a worker and crosses
 * back by structured clone, so a component can never be embedded as a
 * function: `component(id, { module })` is a name and a path, and the server
 * compiles the module beside the App (packages/mistri/src/server/app/appComponents.ts). What
 * the component reads is declared here too — the record's own fields and
 * named reads of rows — so it is checked, planned and authorized like every
 * built-in section, and the module only draws what it is handed.
 *
 * Author code is deployment code, trusted like `commands.ts`; the server
 * stays the only security boundary. A signed-out visitor may meet one where
 * the public grant already lets them read — a page, a list or a value over a
 * resource `auth.public` opens — and every read it makes is the public
 * grant's, refused on the server like any other; what a component declares
 * it reads there is held to that grant as the App loads, so a public page
 * never breaks for its visitors. The landing and public forms stay a closed
 * set of kinds that never runs markup: no component stands on either.
 */
import { allowKeys, isRecord } from './model.js';

export const COMPONENT_KINDS = ['section', 'value', 'input', 'list', 'page'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export const COMPONENT_PROP_TYPES = ['number', 'text', 'boolean', 'choice'] as const;

/** One declared prop: JSON-safe, with its default and its bounds, so a value is checked at load. */
export type ComponentPropDecl =
  | { type: 'number'; default?: number; min?: number; max?: number }
  | { type: 'text'; default?: string; max?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'choice'; options: string[]; default?: string };

/** What `component()` returns: a name, a path relative to the App directory, a kind and its props. */
export interface ComponentDecl {
  id: string;
  module: string;
  kind: ComponentKind;
  props?: Record<string, ComponentPropDecl>;
}

/** The key a component is referenced by: lowercase, the file names it is served under start with it. */
export const COMPONENT_ID = /^[a-z][a-z0-9-]{0,47}$/;
/** What a component module may be: TypeScript or JavaScript, with or without JSX. */
const COMPONENT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;
/**
 * How many named reads one custom section may declare. Its reads are asked together, one request each, so this
 * bounds the fan-out of a single paint (the server runs one active connection per process); the section draws one
 * skeleton until all are in, so more reads never shift the layout. Four was short of a real section (a list, its
 * neighbours and a few tables to look names up in); eight keeps a paint at a handful of queries.
 */
export const MAX_CUSTOM_READS = 8;
/** The keys `component()` writes. */
const COMPONENT_KEYS = ['id', 'module', 'kind', 'props'] as const;
/** How many columns a custom list presentation reads beside the keys. */
const MAX_CUSTOM_LIST_SHOW = 32;
/**
 * How many aggregate reads (`figures`) one custom section may declare. Each is one breakdown, asked with the paint's
 * other breakdowns in a single request (breakdownBatch.ts), so the bound is on the work one section adds to it.
 */
export const MAX_CUSTOM_FIGURES = 8;
/** The keys a declared read of rows takes, on a page and on a dashboard. */
export const PAGE_READ_KEYS = ['from', 'whose', 'query', 'show', 'sort', 'limit'] as const;
export const DASH_READ_KEYS = ['from', 'query', 'show', 'sort', 'limit', 'over'] as const;
/** The keys a declared aggregate read takes, on a page and on a dashboard. */
const PAGE_TOTAL_KEYS = ['from', 'measure', 'by', 'whose', 'query', 'limit'] as const;
const DASH_TOTAL_KEYS = ['from', 'measure', 'by', 'query', 'over', 'limit'] as const;
/** What a total measures: the breakdown grammar's aggregates over one column of the resource (count takes none). */
const TOTAL_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
type TotalFunction = (typeof TOTAL_FUNCTIONS)[number];
const TOTAL_MEASURE = /^(count|(?:sum|avg|min|max)\s+[A-Za-z_][A-Za-z0-9_]*)$/;
/** The most groups one total returns, and what it returns when it says none. */
const MAX_TOTAL_GROUPS = 500;
const DEFAULT_TOTAL_GROUPS = 100;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Whether a value is a component declaration: what a display rule or a section names in place of its own words. */
export function isComponentDecl(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.module === 'string' && typeof value.id === 'string';
}

/**
 * A component declaration, checked in shape. The file itself — that it
 * exists, inside the App directory, and compiles — is the loader's to judge
 * (it knows the directory); this is what can be said of the data alone.
 */
export function parseComponentDecl(raw: unknown, at: string, expected?: ComponentKind): ComponentDecl {
  if (!isRecord(raw)) throw new Error(`${at} is not a component — declare it with component('id', { module: './widgets/Thing.tsx' }).`);
  allowKeys(raw, COMPONENT_KEYS, `${at} (a component)`);
  const id = raw.id;
  if (typeof id !== 'string' || !COMPONENT_ID.test(id)) {
    throw new Error(
      `${at} has a component id ${JSON.stringify(id)}: lowercase letters, digits and hyphens, starting with a letter, at most 48 characters.`,
    );
  }
  const module = raw.module;
  if (
    typeof module !== 'string' ||
    !module.startsWith('./') ||
    module.includes('\\') ||
    module.split('/').some((part) => part === '..' || part === '') ||
    !COMPONENT_EXTENSIONS.some((ext) => module.endsWith(ext))
  ) {
    throw new Error(
      `${at}: the component "${id}" names the module ${JSON.stringify(module)}. A module is a path inside the App directory, ` +
        `written from it — './widgets/Thing.tsx' — ending in ${COMPONENT_EXTENSIONS.join(', ')}.`,
    );
  }
  const kind = raw.kind === undefined ? 'section' : raw.kind;
  if (!(COMPONENT_KINDS as readonly unknown[]).includes(kind)) {
    throw new Error(
      `${at}: the component "${id}" has a kind of ${JSON.stringify(kind)}. Use ${COMPONENT_KINDS.map((k) => `"${k}"`).join(' or ')}.`,
    );
  }
  if (expected && kind !== expected) {
    throw new Error(
      `${at} names the component "${id}", ${KIND_WORDS[kind as ComponentKind]}. ${PLACED[expected]} takes a component of kind "${expected}": ` +
        `component('${id}', { module, kind: '${expected}' }).`,
    );
  }
  const props = raw.props === undefined ? undefined : parsePropDecls(raw.props, `${at}: the component "${id}"`);
  return { id, module, kind: kind as ComponentKind, ...(props ? { props } : {}) };
}

/** What each kind is, and where each is placed, for a refusal that says both. */
const KIND_WORDS: Record<ComponentKind, string> = {
  section: 'a section',
  value: 'a value renderer',
  input: 'an input',
  list: 'a list presentation',
  page: 'a free-form page',
};
const PLACED: Record<ComponentKind, string> = {
  section: 'A custom section',
  value: 'A display rule',
  input: 'An input',
  list: 'customList()',
  page: 'A free-form page (pages/*.page.tsx)',
};

function parsePropDecls(raw: unknown, at: string): Record<string, ComponentPropDecl> {
  if (!isRecord(raw))
    throw new Error(`${at} has "props" that are not an object of prop.number(), prop.text(), prop.bool() or prop.choice().`);
  const out: Record<string, ComponentPropDecl> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const here = `${at}, prop "${name}"`;
    if (!NAME.test(name)) throw new Error(`${here}: a prop's name is a word of letters, digits and underscores.`);
    if (!isRecord(entry) || !(COMPONENT_PROP_TYPES as readonly unknown[]).includes(entry.type)) {
      throw new Error(`${here} is not a prop declaration — write prop.number(), prop.text(), prop.bool() or prop.choice([...]).`);
    }
    const decl = entry as ComponentPropDecl & Record<string, unknown>;
    if (decl.type === 'number') {
      allowKeys(decl, ['type', 'default', 'min', 'max'], here);
      for (const key of ['min', 'max'] as const) {
        if (decl[key] !== undefined && (typeof decl[key] !== 'number' || !Number.isFinite(decl[key])))
          throw new Error(`${here} has a "${key}" that is not a number.`);
      }
      if (decl.min !== undefined && decl.max !== undefined && decl.min > decl.max) throw new Error(`${here} has a "min" above its "max".`);
    } else if (decl.type === 'text') {
      allowKeys(decl, ['type', 'default', 'max'], here);
      if (decl.max !== undefined && (!Number.isInteger(decl.max) || decl.max < 1))
        throw new Error(`${here} has a "max" that is not a positive whole number.`);
    } else if (decl.type === 'boolean') {
      allowKeys(decl, ['type', 'default'], here);
    } else {
      allowKeys(decl, ['type', 'options', 'default'], here);
      if (
        !Array.isArray(decl.options) ||
        !decl.options.length ||
        decl.options.some((option) => typeof option !== 'string' || !option.trim())
      ) {
        throw new Error(`${here} is a choice with no "options": name its values, prop.choice(['week', 'month']).`);
      }
    }
    /* A default is a value like any other: checked against its own declaration now,
       so a component never receives what its declaration says it cannot. */
    if (decl.default !== undefined) propValue(decl, decl.default, `${here}, its default`);
    out[name] = { ...decl } as ComponentPropDecl;
  }
  return out;
}

function propValue(decl: ComponentPropDecl, value: unknown, at: string): unknown {
  switch (decl.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at} is ${JSON.stringify(value)}, not a number.`);
      if (decl.min !== undefined && value < decl.min) throw new Error(`${at} is ${value}, below its min of ${decl.min}.`);
      if (decl.max !== undefined && value > decl.max) throw new Error(`${at} is ${value}, above its max of ${decl.max}.`);
      return value;
    case 'text':
      if (typeof value !== 'string') throw new Error(`${at} is ${JSON.stringify(value)}, not text.`);
      if (decl.max !== undefined && value.length > decl.max) throw new Error(`${at} is longer than its max of ${decl.max} characters.`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${at} is ${JSON.stringify(value)}, not true or false.`);
      return value;
    case 'choice':
      if (typeof value !== 'string' || !decl.options.includes(value))
        throw new Error(`${at} is ${JSON.stringify(value)}; it is one of ${decl.options.map((o) => `"${o}"`).join(', ')}.`);
      return value;
  }
}

/**
 * The props a placement hands its component: each value checked against the
 * component's declaration and every default filled in, so the module reads
 * exactly the shape its types promise. A prop the declaration does not name is
 * refused, as an unknown key is everywhere else.
 */
export function componentPropValues(decl: ComponentDecl, raw: unknown, at: string): Record<string, unknown> {
  if (raw !== undefined && !isRecord(raw)) throw new Error(`${at} has "props" that are not an object.`);
  const given = (raw ?? {}) as Record<string, unknown>;
  const declared = decl.props ?? {};
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(declared, name)) {
      const names = Object.keys(declared);
      throw new Error(
        `${at} gives the prop "${name}", which the component "${decl.id}" does not declare. ${names.length ? `It declares: ${names.join(', ')}.` : 'It declares none.'}`,
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(declared)) {
    const value = Object.hasOwn(given, name) ? given[name] : prop.default;
    if (value !== undefined) out[name] = propValue(prop, value, `${at}, prop "${name}"`);
  }
  return out;
}

/** One declared read of rows on a page: related to the record by `whose`, or the resource's own rows, narrowed. */
export interface PageCustomRead {
  from: string;
  /** Config `whose`: the path from `from` back to the page's record. Absent, the rows are not tied to it. */
  path?: string;
  filter?: string;
  columns: string[];
  /** Query-bar text, as authored; `orderBy` is what the planner runs. */
  sort?: string;
  orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  limit?: number;
}

/** One declared read of rows on a dashboard: the rows section's words, the window's `over` included. */
export interface DashCustomRead {
  table: string;
  query?: string;
  show: string[];
  sort?: string;
  limit?: number;
  over?: string;
  /** Served, never authored: the query without its own window, as a rows section's. */
  windowBase?: string;
}

function readShape(raw: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`${at} is not an object like { from: 'invoice', show: ['number', 'total'] }.`);
  allowKeys(raw, keys, at);
  if (typeof raw.from !== 'string' || !raw.from.trim()) throw new Error(`${at} has no "from": the resource its rows come from.`);
  if (!Array.isArray(raw.show) || !raw.show.length || raw.show.some((path) => typeof path !== 'string' || !PATH.test(path.trim()))) {
    throw new Error(`${at} has no "show": the columns the component reads, label paths welcome — ['number', 'customer_id.name'].`);
  }
  for (const key of ['query', 'sort', 'whose', 'over'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !(raw[key] as string).trim()))
      throw new Error(`${at} has a "${key}" that is not a non-empty string.`);
  }
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 500)) {
    throw new Error(`${at} has a "limit" that is not a whole number from 1 to 500.`);
  }
  return raw;
}

function reads<T>(
  raw: unknown,
  at: string,
  one: (entry: unknown, here: string) => T,
  { key = 'rows', most = MAX_CUSTOM_READS, noun = 'reads' }: { key?: string; most?: number; noun?: string } = {},
): Record<string, T> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !Object.keys(raw).length)
    throw new Error(`${at} has "${key}" that are not an object of named ${noun}: { runs: { from, show } }.`);
  const names = Object.keys(raw);
  if (names.length > most) throw new Error(`${at} declares ${names.length} ${noun}; a custom section reads at most ${most}.`);
  return Object.fromEntries(
    names.map((name) => {
      if (!NAME.test(name))
        throw new Error(`${at}: a read's name is a word of letters, digits and underscores, like "runs"; "${name}" is not.`);
      return [name, one(raw[name], `${at}, ${key} "${name}"`)];
    }),
  );
}

export function parsePageReads(raw: unknown, at: string): Record<string, PageCustomRead> | undefined {
  return reads(raw, at, (entry, here) => {
    const r = readShape(entry, here, PAGE_READ_KEYS);
    return {
      from: (r.from as string).trim(),
      ...(r.whose === undefined ? {} : { path: (r.whose as string).trim() }),
      ...(r.query === undefined ? {} : { filter: (r.query as string).trim() }),
      columns: (r.show as string[]).map((path) => path.trim()),
      ...(r.sort === undefined ? {} : { sort: (r.sort as string).trim() }),
      ...(r.limit === undefined ? {} : { limit: r.limit as number }),
    };
  });
}

export function parseDashReads(raw: unknown, at: string): Record<string, DashCustomRead> | undefined {
  return reads(raw, at, (entry, here) => {
    const r = readShape(entry, here, DASH_READ_KEYS);
    return {
      table: (r.from as string).trim(),
      ...(r.query === undefined ? {} : { query: (r.query as string).trim() }),
      show: (r.show as string[]).map((path) => path.trim()),
      ...(r.sort === undefined ? {} : { sort: (r.sort as string).trim() }),
      ...(r.limit === undefined ? {} : { limit: r.limit as number }),
      ...(r.over === undefined ? {} : { over: (r.over as string).trim() }),
    };
  });
}

/** One declared aggregate read on a page: a count, sum, average, minimum or maximum, tied to the record by `whose`. */
export interface PageCustomTotal {
  from: string;
  fn: TotalFunction;
  /** The column measured; absent for a count. */
  column?: string;
  /** What the figure is grouped by, in the breakdown grammar ("status", "month opened_on"); absent, one figure. */
  by?: string;
  /** Config `whose`: the path from `from` back to the page's record. Absent, the resource's own rows. */
  path?: string;
  filter?: string;
  limit?: number;
}

/** One declared aggregate read on a dashboard: a measure in the breakdown grammar, narrowed by the window's `over`. */
export interface DashCustomTotal {
  table: string;
  /** "count" or "sum amount": the breakdown grammar's measure. */
  measure: string;
  by?: string;
  query?: string;
  over?: string;
  limit?: number;
  /** Served, never authored: the query without its own window, as a rows section's. */
  windowBase?: string;
}

function totalShape(raw: unknown, at: string, keys: readonly string[]): Record<string, unknown> & { measure: string } {
  if (!isRecord(raw)) throw new Error(`${at} is not an object like { from: 'invoice', measure: 'sum total' }.`);
  allowKeys(raw, keys, at);
  if (typeof raw.from !== 'string' || !raw.from.trim()) throw new Error(`${at} has no "from": the resource it measures.`);
  if (typeof raw.measure !== 'string' || !TOTAL_MEASURE.test(raw.measure.trim().replace(/\s+/g, ' '))) {
    throw new Error(`${at} has no "measure": "count", or ${TOTAL_FUNCTIONS.slice(1).join(', ')} and a column — 'sum amount'.`);
  }
  for (const key of ['by', 'query', 'whose', 'over'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !(raw[key] as string).trim()))
      throw new Error(`${at} has a "${key}" that is not a non-empty string.`);
  }
  if (raw.limit !== undefined) {
    if (raw.by === undefined) throw new Error(`${at} has a "limit" and no "by": a figure with no groups has no groups to cut.`);
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_TOTAL_GROUPS)
      throw new Error(`${at} has a "limit" that is not a whole number from 1 to ${MAX_TOTAL_GROUPS}.`);
  }
  return { ...raw, measure: raw.measure.trim().replace(/\s+/g, ' ') };
}

const totalReads = { key: 'figures', most: MAX_CUSTOM_FIGURES, noun: 'figures' };

export function parsePageTotals(raw: unknown, at: string): Record<string, PageCustomTotal> | undefined {
  return reads(
    raw,
    at,
    (entry, here) => {
      const r = totalShape(entry, here, PAGE_TOTAL_KEYS);
      const [fn, column] = r.measure.split(' ') as [TotalFunction, string | undefined];
      return {
        from: (r.from as string).trim(),
        fn,
        ...(column === undefined ? {} : { column }),
        ...(r.by === undefined ? {} : { by: (r.by as string).trim() }),
        ...(r.whose === undefined ? {} : { path: (r.whose as string).trim() }),
        ...(r.query === undefined ? {} : { filter: (r.query as string).trim() }),
        ...(r.limit === undefined ? {} : { limit: r.limit as number }),
      };
    },
    totalReads,
  );
}

export function parseDashTotals(raw: unknown, at: string): Record<string, DashCustomTotal> | undefined {
  return reads(
    raw,
    at,
    (entry, here) => {
      const r = totalShape(entry, here, DASH_TOTAL_KEYS);
      return {
        table: (r.from as string).trim(),
        measure: r.measure,
        ...(r.by === undefined ? {} : { by: (r.by as string).trim() }),
        ...(r.query === undefined ? {} : { query: (r.query as string).trim() }),
        ...(r.over === undefined ? {} : { over: (r.over as string).trim() }),
        ...(r.limit === undefined ? {} : { limit: r.limit as number }),
      };
    },
    totalReads,
  );
}

/** How many groups a total with a `by` returns when it says no limit. */
export const groupsAsked = (limit: number | undefined): number => limit ?? DEFAULT_TOTAL_GROUPS;

/** A record's own fields a page's custom section reads. */
export function parseRecordFields(raw: unknown, at: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.some((path) => typeof path !== 'string' || !PATH.test(path.trim()))) {
    throw new Error(
      `${at} has a "record" that is not a list of the record's fields, label paths welcome — ['status', 'customer_id.name'].`,
    );
  }
  return raw.map((path) => (path as string).trim());
}

/** A custom list presentation as the App serves it: the component, the columns it reads, its props. */
export interface CustomListPresentation {
  kind: 'custom';
  component: ComponentDecl;
  show: string[];
  props: Record<string, unknown>;
}

/**
 * `customList(postStream, { show: ['body', 'author_id.display_name'] })`: a
 * list view's rows drawn by the author's component. The platform keeps the
 * query, the tabs, the filters, the sort, the paging and the bulk actions;
 * `show` is what the query reads beside the keys, so every row the component
 * receives carries exactly those columns.
 */
export function parseCustomList(raw: Record<string, unknown>, at: string): CustomListPresentation {
  allowKeys(raw, ['kind', 'component', 'show', 'props'], `${at} (a custom list)`);
  const component = parseComponentDecl(raw.component, `${at}, "component"`, 'list');
  const show = raw.show;
  if (
    !Array.isArray(show) ||
    !show.length ||
    show.length > MAX_CUSTOM_LIST_SHOW ||
    show.some((path) => typeof path !== 'string' || !PATH.test(path.trim()))
  ) {
    throw new Error(
      `${at} has no "show": the columns its component reads, one to ${MAX_CUSTOM_LIST_SHOW}, label paths welcome — ['body', 'author_id.display_name'].`,
    );
  }
  const columns = show.map((path) => (path as string).trim());
  if (new Set(columns).size !== columns.length) throw new Error(`${at} names one column twice in "show".`);
  return { kind: 'custom', component, show: columns, props: componentPropValues(component, raw.props, at) };
}

/** A free-form page as its `pages/*.page.tsx` file declares it, before it is served as the dashboard that draws it (appViews.ts). */
interface PageDecl {
  component: ComponentDecl;
  /** The resources the page reads, which gate it: a reader who cannot read one of them is not offered it. */
  reads: string[];
  /** The commands the page runs; any other is refused, in the browser and by the server. */
  commands: string[];
  /** The address parameters the page keeps its place in: `/{app}/pick-walk?list=12`. */
  params: string[];
  /** The loader that reads for it on the server, by its name in the commands module (`defineLoaders`). */
  loader?: string;
  props: Record<string, unknown>;
}

/** The most address parameters one page keeps. */
const MAX_PAGE_PARAMS = 8;
const PARAM = /^[a-z][a-z0-9_]{0,31}$/;
const LOADER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const words = (raw: unknown): raw is string[] => Array.isArray(raw) && raw.every((name) => typeof name === 'string' && name.trim() !== '');

/**
 * `definePage({ reads: ['pick_list'], commands: ['pickList'], params: ['list'], component })`:
 * a whole page drawn by the author's component. What it reads and runs is
 * declared, so a reader who cannot read every one of its resources is not
 * offered it, `mistri check` holds the module to it, and authority.lock
 * records it; its place is kept in the address by the parameters it names,
 * so a page reached by link opens where it was. A bracketed code leads each
 * refusal, for `mistri check` (checkProblems.ts).
 */
export function parsePage(raw: Record<string, unknown>, at: string): PageDecl {
  const component = parseComponentDecl(raw.component, `${at}, "component"`, 'page');
  const reads = raw.reads;
  if (!words(reads) || !reads.length) {
    throw new Error(
      `[page-reads] ${at} has no "reads": the resources the page reads — reads: ['pick_list', 'order_line']. A page reads nothing it does not declare.`,
    );
  }
  const commands = raw.commands === undefined ? [] : raw.commands;
  if (!words(commands))
    throw new Error(`[page-commands] ${at} has "commands" that are not a list of command names: commands: ['pickList'].`);
  const params = raw.params === undefined ? [] : raw.params;
  if (
    !Array.isArray(params) ||
    params.length > MAX_PAGE_PARAMS ||
    params.some((name) => typeof name !== 'string' || !PARAM.test(name)) ||
    params.includes('period')
  ) {
    throw new Error(
      `[page-params] ${at} has "params" that are not up to ${MAX_PAGE_PARAMS} lowercase words, like params: ['list']; "period" is a dashboard's.`,
    );
  }
  if (raw.loader !== undefined && (typeof raw.loader !== 'string' || !LOADER.test(raw.loader))) {
    throw new Error(
      `[page-loader] ${at} has a "loader" that is not a loader's name, as the commands module's defineLoaders() registers it.`,
    );
  }
  return {
    component,
    reads: [...new Set(reads.map((name) => name.trim()))],
    commands: [...new Set(commands.map((name) => name.trim()))],
    params: [...new Set(params as string[])],
    ...(raw.loader === undefined ? {} : { loader: raw.loader as string }),
    props: componentPropValues(component, raw.props, at),
  };
}

/**
 * `inputs: { color: colorPicker }`: a component standing in a form's field —
 * a resource's column in its edit and New forms, or a command's input in an
 * action's or a signed-in form's command form. It draws the control and
 * hands back a value; what the value must be is still the form's rules and
 * the server's to judge.
 */
export function parseInputs(raw: unknown, at: string, options: { paths?: boolean } = {}): Record<string, ComponentDecl> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !Object.keys(raw).length)
    throw new Error(`${at} has "inputs" that are not an object of field → input component: { color: colorPicker }.`);
  /* A command's input inside a group is named by its path, `trade.vin`: in a repeating group, every row's. */
  const named = options.paths ? /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  return Object.fromEntries(
    Object.entries(raw).map(([name, decl]) => {
      if (!named.test(name))
        throw new Error(`${at}, "inputs": "${name}" is not a field's name${options.paths ? ' or a path into a group (trade.vin)' : ''}.`);
      return [name, parseComponentDecl(decl, `${at}, inputs "${name}"`, 'input')];
    }),
  );
}

/** A command's input by its name or its path through groups (`trade.vin`), or undefined; a group itself is not one, nor are lines (their grid is the platform's). */
export function commandInputAt<F extends { name: string; type?: string; fields?: readonly F[] }>(
  fields: readonly F[],
  path: string,
): F | undefined {
  const [head, ...rest] = path.split('.');
  const field = fields.find((candidate) => candidate.name === head);
  if (!field) return undefined;
  if (!rest.length) return field.type === 'group' || field.type === 'lines' ? undefined : field;
  return field.type === 'group' && field.fields ? commandInputAt(field.fields, rest.join('.')) : undefined;
}
