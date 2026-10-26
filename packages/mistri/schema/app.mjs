/**
 * The runtime half of the typed veneer: `defineApp` returns its argument.
 * The types live in app.d.ts beside this file — the schema-typed layer and,
 * on `defineApp`, the reference layer that checks nav, home and embeds
 * against the App's own view ids; the value goes through the same
 * parseAppConfig every app.json goes through, so the server only ever sees
 * data.
 *
 * Two ways to a typed app.mjs, by how the app lives.
 *
 * In a project that has mistri installed (`npm i -D @mistriwork/mistri`):
 *
 *   import { defineApp } from '@mistriwork/mistri/app';
 *   export default defineApp({ name: 'Field Ops', views: { ... }, home: 'work-orders', nav: [ ... ] });
 *
 * Anywhere at all — a bare directory run with `npx @mistriwork/mistri --app` —
 * skip the import and annotate instead: a JSDoc block reading
 * `@type {import('@mistriwork/mistri/app').AppConfig}` above `export default`
 * gives the editor the same checking with nothing to resolve at runtime
 * (add `// @ts-check` at the top to make the squiggles errors).
 */
export const defineApp = (app) => app;
/** Plain flag definitions. The App parser captures and validates the full catalog. */
const flagDefinition = (type, value, options) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError('Flag options require plain data.');
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!['owner', 'variants', 'safeValue', 'expiry', 'tenantManaged'].includes(key)
      || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Unknown or non-data flag option.');
  }
  return { type, default: value, ...(type === 'boolean' ? { safeValue: false } : {}), ...options };
};
export const flag = Object.freeze({
  boolean: (value, options) => flagDefinition('boolean', value, options),
  string: (value, options) => flagDefinition('string', value, options),
  number: (value, options) => flagDefinition('number', value, options),
  object: (value, options) => flagDefinition('object', value, options),
});
/** Immutable experiment epoch declaration, validated with its flag at App load. */
export const experiment = (declaration) => declaration;
/** The in-App assistant; identity at runtime, checked at load. */
export const assistant = (declaration) => declaration;
/** A checked same- or cross-App destination. Static overloads serve nav and
 * authored App menus; record surfaces may bind fields. Import the manifest as a type only. */
export const appLink = (target) => target;
/** A feature, one ordered slice of an App's content, listed in the App's `features` and merged at load. Its types check its nav against its own views. */
export const defineFeature = (feature) => feature;
/** Explicit API projection: read fields, and opt-in generic writes. The App's api declaration uses it; serving routes remains opt-in. */
export const expose = (fields, options = {}) => {
  for (const key of Object.keys(options)) {
    if (!['filters', 'sorts', 'description', 'create', 'update', 'delete'].includes(key)) throw new TypeError(`Unsupported exposure option "${key}".`);
    if (['create', 'update', 'delete'].includes(key) && options[key] !== true) throw new TypeError(`Exposure option "${key}" is true or absent.`);
  }
  return { ...options, fields };
};

/** A resource's state machine: `machine('status', { draft: { on: { submit: 'submitted' } }, submitted: { final: true } })`. The
    states' order is the record's; a verb names a command, or is a fixed move that sets the column. */
export const machine = (column, states, opts = {}) => ({ column, states, ...opts });
/** One list over several tables, in one order and one page: `union('my_requests', [{ from: 'incident', as: { title: 'short_description' } }, …])`. */
export const union = (name, branches) => ({ name, branches });
/** A fixed update, or a command by its name (`command: 'assignReviewer'`); the label stays a literal, so a view's `actions` selector is checked. */
export const action = (label, options) => ({ ...options, label });
/** An OpenID Connect provider for `auth.providers`, by its config entry's name; `oidc.tenants()` is each tenant's own. */
export const oidc = Object.assign((name) => `oidc:${name}`, { tenants: () => 'oidc:*' });
/** A SAML 2.0 identity provider for `auth.providers`, by its config entry's name; `saml.tenants()` is each tenant's own. */
export const saml = Object.assign((name) => `saml:${name}`, { tenants: () => 'saml:*' });
/** A reusable, data-only theme. The app parser validates it at load time. */
export const defineTheme = (theme) => ({ ...theme, kind: 'theme' });
/** A data-only record branding descriptor. The App parser validates it and
 * keeps its static fallback; an authorized request supplies the record. */
export const fromRecord = (resource, options) => ({ ...options, kind: 'fromRecord', from: resource });

/* ---------- the helpers ----------
   Pure data constructors: each returns exactly the JSON it stands for,
   and their value is the types — a section built by its own kind's
   function is checked against that kind's fields in the editor, where
   the one wide interface could only be checked by the server at startup.
   They are the one spelling: the types require each section, view, page
   and action to be made by its function (app.d.ts, MadeBy). What they
   return is still the plain object app.json and a build carry. */

/* ---------- values filled in ----------
   The day, the moment and the signed-in person, which a form's `defaults`
   and a fixed action's `set` fill in rather than state: `{ due_on: today,
   owner_id: me }`. Objects, not words, so a literal "now" stays a literal. */

/** The day the form opens, on a date column. */
export const today = Object.freeze({ auto: 'today' });
/** The moment: when the form opens, or when an action's write lands. */
export const now = Object.freeze({ auto: 'now' });
/** The signed-in person: their row on a reference to `auth.me`'s table, their email on a text column. */
export const me = Object.freeze({ auto: 'me' });
/* ---------- computed columns: a typed expression over the record's own columns ---------- */

/** resource computed columns: `computed: { is_overdue: computed.boolean('due_on < today and not completed') }`. */
export const computed = Object.freeze({
  boolean: (value) => ({ type: 'boolean', value }),
  number: (value) => ({ type: 'number', value }),
  date: (value) => ({ type: 'date', value }),
});
/* ---------- rollups: one number about the rows that point at a record ---------- */

/** resource rollup: how many `from` rows point at the record — `count('task', { query: 'status = open' })`. */
export const count = (from, opts = {}) => ({ fn: 'count', from, ...opts });
/** resource rollup: the sum of a column of those rows — `sum('order_line', 'amount')`. */
export const sum = (from, column, opts = {}) => ({ fn: 'sum', from, column, ...opts });
/** resource rollup: the least value of a column of those rows — `min('invoice', 'due_on')`. */
export const min = (from, column, opts = {}) => ({ fn: 'min', from, column, ...opts });
/** resource rollup: the greatest value of a column of those rows — `max('activity', 'happened_on')`. */
export const max = (from, column, opts = {}) => ({ fn: 'max', from, column, ...opts });
/** resource rollup: a column of the newest of those rows — `latest('payment', 'status')`, by key or by `opts.by`. */
export const latest = (from, column, opts = {}) => ({ fn: 'latest', from, column, ...opts });

/* A metric and a breakdown say the same thing on a dashboard and on a page:
   rows of a table, measured. On a page, given `whose`, the rows point at the
   page's record. */
const measured = (kind, title, from, opts, rest) => ({ kind, title, from, ...rest, ...opts });
/** A metric: one number — `metric('Pipeline', 'opportunity', { measure: 'sum amount', compare })` on a dashboard,
    `metric('Open tasks', 'task', { whose: 'account_id', query: 'status = open' })` on a page. */
export const metric = (title, from, opts = {}) => measured('metric', title, from, opts, {});
/** A chart: a line (bucketed by), bars or a donut — `chart('Bookings', 'opportunity', 'month close_date')` on a dashboard,
    `chart('Billed by month', 'invoice', 'month issued_on', { whose: 'customer_id', measure: 'sum total' })` on a page. */
export const chart = (title, from, by, opts = {}) => measured('chart', title, from, opts, { by });
/** A breakdown: ranked bars — `breakdown('Pipeline', 'opportunity', 'stage', { measure: 'sum amount' })` on a dashboard,
    `breakdown('Issue status', 'issue', 'status', { whose: 'project_id' })` on a page. */
export const breakdown = (title, from, by, opts = {}) => measured('breakdown', title, from, opts, { by });
/** dashboard section: the newest/matching rows, projected — `rows('Closing soon', 'opportunity', { show, sort, limit })`. */
export const rows = (title, from, opts = {}) => ({ kind: 'rows', title, from, ...opts });
/** The author speaking, on a dashboard or a record's page. */
export const note = (text, opts = {}) => ({ kind: 'note', text, ...opts });
/** A new App's first steps on its home: `firstRun('Welcome', [{ label: 'Add your first customer', to: 'customers' }])`. */
export const firstRun = (title, steps, opts = {}) => ({ kind: 'firstRun', title, steps, ...opts });
/** dashboard section: two keys crossed, heat by the measure — `matrix('Pipeline', 'opportunity', 'stage, month close_date')`. */
export const matrix = (title, from, by, opts = {}) => ({ kind: 'matrix', title, from, by, ...opts });
/** dashboard section: how many of a table's rows reach each stage, in order — `funnel('Inquiries', 'inquiry', [{ label: 'Received' }, { label: 'Contacted', query: 'stage != new' }])`. */
export const funnel = (title, from, stages, opts = {}) => ({ kind: 'funnel', title, from, stages, ...opts });
/** dashboard section: lanes of cards by a column's values — `board('Order flow', 'work_order', 'status', { primary: 'reference', lines: ['customer_id.name'] })`. */
export const board = (title, from, by, opts = {}) => ({ kind: 'board', title, from, by, ...opts });
/** A dashboard view: sections about whole tables — metric, chart, breakdown, rows, note, matrix, board — and `embed()`s of list views. Its key in `views` is its address. */
export const dashboard = (label, sections, opts = {}) => ({ kind: 'dashboard', label, sections, ...opts });
/** dashboard section: recent changes across resources, from their record history — `activity('Latest updates', { pick_list: { icon: 'truck' } })`. */
export const activity = (title, resources, opts = {}) => ({ kind: 'activity', title, resources, ...opts });
/** dashboard section: one box over several resources' records — `find('Find anything', ['article', 'catalog_item'], { placeholder })`. */
export const find = (title, resources, opts = {}) => ({ kind: 'find', title, resources, ...opts });
/** dashboard section: a tenant's own Branding form, for the App's `branding` — `brandingForm('Branding')`. */
export const brandingForm = (title, opts = {}) => ({ kind: 'branding', ...(title === undefined ? {} : { title }), ...opts });
/** dashboard section: the integrations' settings form, where admins enter their secrets — `integrationsForm('Integrations')`. */
export const integrationsForm = (title, opts = {}) => ({ kind: 'integrations', ...(title === undefined ? {} : { title }), ...opts });
/** A list view drawn read-only inside a dashboard, as its room draws it — `embed('projects', { width: 'half', limit: 6 })` —
    on a landing, as its cards, or on a record's page, given `whose`, its rows that point at the record. */
export const embed = (view, opts = {}) => ({ kind: 'view', view, ...opts });

/* ---------- list views and how their rows draw ---------- */

/** A list view: the rows of one resource — `listView('Issues', 'issue', { show, tabs, presentation })`, or
    `listView('issue', { show })` to be called what the resource's `noun` says. Its key in `views` is its address. */
export const listView = (label, from, opts = {}) => typeof from === 'string'
  ? { kind: 'list', label, from, ...opts }
  : { kind: 'list', from: label, ...(from ?? {}) };
/** list presentation: a card per row, a text column and the boolean it toggles — `checklist('name', 'completed', { lines: ['due_on'] })`. */
export const checklist = (primary, checked, opts = {}) => ({ kind: 'checklist', primary, checked, ...opts });
/** list presentation: a keyboard-first selection queue — `queue('name', { lines: ['status', 'priority'] })`. */
/* With no primary — `queue()`, `queue({ lines })` — a card says its record's name. */
const titledBy = (primary) => (primary === undefined ? {} : { primary });
export const queue = (primary, opts = {}) =>
  typeof primary === 'object' && primary !== null ? { kind: 'queue', ...primary } : { kind: 'queue', ...titledBy(primary), ...opts };
/** list presentation: a month of records by one date column — `calendar('due_on', 'subject')`, or `calendar('due_on')` titled by the record's name. */
export const calendar = (date, primary, opts = {}) =>
  typeof primary === 'object' && primary !== null
    ? { kind: 'calendar', date, ...primary }
    : { kind: 'calendar', date, ...titledBy(primary), ...opts };
/** list presentation: records as the tree their parent column makes — `tree('parent_account_id', 'name')`. */
export const tree = (parent, primary, opts = {}) => ({ kind: 'tree', parent, primary, ...opts });
/** list presentation: records as bars from one date to another, a row per group — `gantt('starts_on', 'due_on', 'name', { by: 'owner_id.name' })`. */
export const gantt = (start, end, primary, opts = {}) => ({ kind: 'gantt', start, end, primary, ...opts });
/** list presentation: a grid of cards — `cards('title', { value: 'price', facts: ['year', 'mileage'] })`, or
    `cards({ value: 'price' })` titled by the record's name. */
export const cards = (primary, opts = {}) => (typeof primary === 'string' ? { kind: 'cards', primary, ...opts } : { kind: 'cards', ...(primary ?? {}) });
/** page section: the record's own change history — who changed which fields, from what to what, and when. */
export const history = (title, opts = {}) => ({ kind: 'history', ...(title === undefined ? {} : { title }), ...opts });
/** page section: the record's row-driven flow runs — each run's state, its steps and what it waits for; a workflow operator may start a manual flow. */
export const flows = (title, opts = {}) => ({ kind: 'flows', ...(title === undefined ? {} : { title }), ...opts });
/** page section: a flow's steps drawn on the flow's own page, or a record's run over them — positions as columns, the steps sharing one as lanes, a branch's other way to its goto. */
export const diagram = (title, opts = {}) => ({ kind: 'diagram', ...(title === undefined ? {} : { title }), ...opts });
/** page section: dated child rows merged into one feed — streams built with stream(). */
export const timeline = (title, streams, opts = {}) => ({ kind: 'timeline', title, streams, ...opts });
/** Structural navigation parent; roots and subgroups use the same shape. Children are view ids, `{ to, label }` or groups. */
export const navGroup = (id, label, children, opts = {}) => ({ id, label, children, ...opts });
/** A command form view: one form running one command, by name — `commandForm('Log a call', 'logCall', [step(...)], { done })`.
    Signed in unless it says `public: true`, when it is served signed out at /{app}/form/<its key in views>.
    The steps may be left out (one page), with or without the options after them. */
export const commandForm = (label, command, steps, opts) => Array.isArray(steps) || steps === undefined
  ? { kind: 'form', label, command, ...(steps === undefined ? {} : { steps }), ...(opts ?? {}) }
  : { kind: 'form', label, command, ...steps };
/** One step of a multi-step form: `label` is its caption in the stepper; the id is the label's slug unless given,
    and a `msg()` label's is its key's, so a step is one step in every language.
    Its fields are the form command's input names — or the name of a command of its own, whose inputs the step
    asks and whose handler saves them, which makes the form one saved on every step. */
export const step = (label, fields, opts = {}) => ({
  id: opts.id ?? (typeof label === 'string' ? label : label.message).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label,
  ...(Array.isArray(fields) ? { fields } : { command: fields }),
  ...Object.fromEntries(['title', 'lead', 'next', 'skip'].filter((key) => opts[key] !== undefined).map((key) => [key, opts[key]])),
});

/* ---------- the landing ----------
   The public front page of an App that signs people in: plain text only,
   links held to https:, mailto: and tel:. A section's title may be left out
   by passing the items alone. */
const titled = (kind, title, items) => Array.isArray(title)
  ? { kind, items: title } : { kind, ...(title === undefined ? {} : { title }), items };
/** The landing view, the App's public front page — `landing(hero(...), [steps(...), faq(...)])`, wearing the App's `ui.footer`. Requires `auth`; home reaches it. */
export const landing = (hero, sections, opts = {}) => ({ kind: 'landing', ...opts, hero, ...(sections === undefined ? {} : { sections }) });
/** The top of the landing — `hero('Finance your next car', 'One line.', [applyTo('finance', 'Apply')], { image, layout, search, highlights, badge, tiles, points })`; the description may be left out, and the options too. */
export const hero = (heading, description, actions, opts) => Array.isArray(description)
  ? { heading, actions: description, ...(actions ?? {}) } : { heading, ...(description === undefined ? {} : { description }), actions, ...(opts ?? {}) };
/** Call to action: open a public form view at /{app}/form/{its key}. */
export const applyTo = (view, label, intent) => ({ label, to: view, ...(intent ? { intent } : {}) });
/** Call to action: staff sign-in at /{app}/sign-in. */
export const signIn = (label, intent) => ({ label, signIn: true, ...(intent ? { intent } : {}) });
/** Landing section: up to six short points, each { title, description }. */
export const features = (title, items) => titled('features', title, items);
/** Landing section: up to six numbered steps, each { title, description }. Not step(), which is one page of a form. */
export const steps = (title, items) => titled('steps', title, items);
/** Landing section: up to twelve { question, answer } disclosures. */
export const faq = (title, items) => titled('faq', title, items);
/** Landing section: up to eight { label, href } links — https://, mailto: or tel:. */
export const contact = (title, items) => titled('contact', title, items);
/** Landing section: up to 2,000 characters of prose; the title may be left out. */
export const text = (title, body) => body === undefined
  ? { kind: 'text', text: title } : { kind: 'text', ...(title === undefined ? {} : { title }), text: body };
/** Landing section: a search over a list view, one to six of its own filters — `search('vehicles', ['make', 'price'], { submitLabel: 'Show vehicles' })`. */
export const search = (view, filters, opts = {}) => ({ kind: 'search', ...opts, view, filters });
/** Landing section: a titled closing prompt with one to three calls to action; the description may be left out. */
export const callToAction = (title, description, actions) => Array.isArray(description)
  ? { kind: 'callToAction', title, actions: description } : { kind: 'callToAction', title, ...(description === undefined ? {} : { description }), actions };

/** A page: one record's screen, keyed in `pages` by its id, called what its
    resource's `noun` says. Sections are
    checked per-kind by the types the moment they sit in this call — the
    constructor's whole value, since a plain literal in a plain array checks
    as nothing. */
export const page = (base, sections, opts) => {
  retiredTitle('page', base, sections, opts);
  return { base, sections, ...(opts ?? {}) };
};
/* page('Title', 'resource', [...]) was the older form. Spread as it was, the array became the options and the
   refusal was `has no "0"`, which names nothing; a string where the sections go is the whole tell. */
const retiredTitle = (name, base, sections, opts) => {
  if (typeof sections !== 'string' && !(Array.isArray(opts) && typeof base === 'string')) return;
  const resource = typeof sections === 'string' ? sections : base;
  throw new TypeError(
    `${name}() no longer takes a title: it is ${name}('${resource}', [sections], { …options }) — the resource first, then its sections. ` +
    `The page is called what the resource's \`noun\` says, so ${name}('${base}', '${resource}', [...]) becomes ${name}('${resource}', [...]).`);
};
/** A record on paper, keyed in `pages`: `document('sales_order', [...sections], { label: 'Invoice', number: 'invoice_no' })`.
    The page's own `realm` and `roles` stay on the page; the rest is its `document`. */
export const document = (base, sections, opts) => {
  retiredTitle('document', base, sections, opts);
  const { realm, roles, ...paper } = opts ?? {};
  return { base, sections, document: paper, ...(realm === undefined ? {} : { realm }), ...(roles === undefined ? {} : { roles }) };
};
/** One timeline stream — the dated child rows a `timeline` section merges. */
export const stream = (from, whose, at, show, opts = {}) => ({ from, whose, at, show, ...opts });
/** Page: a group of the record's own fields — `fields(['name', 'status'], { title: 'Identity' })`. */
export const fields = (show, opts = {}) => ({ kind: 'fields', show, ...opts });
/** Page: rows whose reference points to this record (`related('Visits', 'visit', 'patient_id')`), or rows
    that share a key with it — `{ same: ['account_id'], near: { price: 0.25 } }` in place of the reference, over the
    page's own table with the record itself left out. */
export const related = (title, from, match, opts = {}) =>
  typeof match === 'string' ? { kind: 'list', title, from, whose: match, ...opts } : { kind: 'list', title, from, ...match, ...opts };
/** Page: a box for the record a reference names — who sells a car, who owns an account. `reference` is the column
    holding the link; `show` are that record's own columns: `card('Sold by', 'dealer_id', ['rating', 'city'])`. */
export const card = (title, reference, show = [], opts = {}) => ({
  kind: 'card',
  title,
  show: [reference, ...show.map((path) => `${reference}.${path}`)],
  ...opts,
});
/** Page: the first field as a large figure (a price), the rest a row of facts, `links` beside —
    `headline('price', { was: 'was_price', links: [{ label: 'Ask about this car', to: 'inquire' }] })`. */
export const headline = (show, opts = {}) => ({ kind: 'headline', show: typeof show === 'string' ? [show] : show, ...opts });
/** Page: the record's head — its status chip, a facts line, its verbs with the destructive ones last and quiet.
    `primary` and `destructive` name the resource's actions by id: `header({ primary: 'renew' })`. */
export const header = (opts) => ({ kind: 'header', ...opts });
/** Page: the one related row a query and a sort choose — the active lease, the latest visit — as a card. */
export const current = (title, from, whose, opts = {}) => ({ kind: 'current', title, from, whose, ...opts });

/* ---------- custom components ----------
   An author's own React module, referenced by path — never embedded, since
   the definition crosses the loader's worker as data — and placed through a
   declared kind. What it reads is declared beside it, so it is planned and
   authorized like any section; the module draws with `@mistriwork/mistri/ui`. */

/** A prop a component declares: `prop.number({ default: 12, min: 1, max: 36 })`, `prop.text()`, `prop.bool()`, `prop.choice(['week', 'month'])`. */
export const prop = Object.freeze({
  number: (opts = {}) => ({ type: 'number', ...opts }),
  text: (opts = {}) => ({ type: 'text', ...opts }),
  bool: (opts = {}) => ({ type: 'boolean', ...opts }),
  choice: (options, opts = {}) => ({ type: 'choice', options: [...options], ...opts }),
});
/** A custom component: `component('payroll-timeline', { module: './widgets/PayrollTimeline.tsx' })`, a section unless it says
    `kind: 'value' | 'input' | 'list'`. */
export const component = (id, options) => ({ id, kind: 'section', ...options });
/** A custom section, on a page or a dashboard: `custom('Pay history', payrollTimeline, { record, rows, props })`, or
    `custom(binMap, { record })` with no title of its own. */
export const custom = (title, comp, opts = {}) => title !== null && typeof title === 'object' && typeof title.module === 'string'
  ? { kind: 'custom', component: title, ...(comp ?? {}) } : { kind: 'custom', title, component: comp, ...opts };
/** A list view's rows drawn by a component: `presentation: customList(postStream, { show: ['body', 'author_id.display_name'] })`. */
export const customList = (comp, opts) => ({ kind: 'custom', component: comp, ...opts });

/* An App's words, one catalog per locale in messages/<locale>.ts: `export default defineMessages('es', { 'lead.title':
   'Prospecto' })`. The loader finds the files; a caption names a message with `msg(key, args?)`, and the server
   says it in each reader's language (ICU MessageFormat). Plain frozen data, checked again where it is read. */
const MESSAGE_KEY = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const MESSAGE_ARG = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MESSAGE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const messageLocale = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const messagePlain = (value, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`${what} must be a plain object.`);
  return value;
};
export const defineMessages = (locale, entries) => {
  if (typeof locale !== 'string' || !messageLocale.test(locale)) throw new TypeError(`defineMessages: "${String(locale)}" is not a language tag like "es" or "pt-BR".`);
  const copied = Object.create(null);
  for (const [key, text] of Object.entries(messagePlain(entries, 'defineMessages entries'))) {
    if (!MESSAGE_KEY.test(key)) throw new TypeError(`defineMessages: "${key}" is not a message key like "lead.title".`);
    if (typeof text !== 'string' || !text.trim()) throw new TypeError(`defineMessages: "${key}" has no text.`);
    copied[key] = text;
  }
  return Object.freeze({ kind: 'messages', locale, entries: Object.freeze(copied) });
};
export const msg = (key, args) => {
  if (typeof key !== 'string' || !MESSAGE_KEY.test(key)) throw new TypeError(`msg: "${String(key)}" is not a message key like "lead.title".`);
  if (args === undefined) return Object.freeze({ message: key });
  const bound = Object.create(null);
  for (const [name, path] of Object.entries(messagePlain(args, `msg('${key}') args`))) {
    if (!MESSAGE_ARG.test(name) || typeof path !== 'string' || !MESSAGE_PATH.test(path))
      throw new TypeError(`msg('${key}'): an argument binds a name to a column path, like { days: 'due_in' }.`);
    bound[name] = path;
  }
  return Object.freeze({ message: key, args: Object.freeze({ ...bound }) });
};
