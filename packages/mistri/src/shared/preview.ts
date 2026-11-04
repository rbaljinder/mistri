/**
 * The features that stay Preview at 1.0: one list, read by `mistri check` (the `preview-feature` finding) and by
 * scripts/public-surface.mjs (the inventory's `preview` statuses). They work as documented and may change in any 1.x
 * release; docs/status.md says so beside each, and a root key carries `@preview` in packages/mistri/schema/app.d.ts. A feature
 * leaves the list when it graduates, and the inventory is regenerated in the same commit.
 */
import { servedViewKind } from './appDestinations.js';

/** Key paths of the App DSL (the inventory's section 1) that are Preview. A path matches when any rule matches it.
 * `mistri check` tests the paths of the App's own config against the same rules, so a map's key level is written
 * `[^.]+`: it matches the inventory's `*` and an App's `leads` alike. */
export const PREVIEW_PATHS: readonly RegExp[] = [
  /^resources\.[^.]+\.search(\.|$)/, // a search pack, which ships after 1.0
  /^resources\.[^.]+\.triggers(\[|$)/, // triggers a row policy accepts, their effects proven per write (docs/trigger-effects.md)
  /^ui\.pwa(\.|$)/, // an installable PWA: manifest, worker and offline page, but no offline data
  /^(flags|audiences|experiments|analytics)(\.|\[|$)/,
  /^auth\.roles\.[^.]+\.(flags|experiments)(\.|\[|$)/,
  /^auth\.roles\.[^.]+\.operations\[\] = "analytics"$/,
  /\[kind=gantt\]/,
  /\[kind=current\]\.opens$/, // rc.16: a card over a link table opens its far record
  /\[kind=timeline\]\.reactions(\.|$)/, // rc.15: reactions on a conversation, one sample at most
  /^resources\.[^.]+\.display\.[^.]+\.(copy|timezone)( = true)?$/, // a value's copy button; the zone a date is read in
  /^resources\.[^.]+\.display\.[^.]+\.format = "address"$/,
  /* Two money knobs that overlap `ui: MoneyFormat`: one money vocabulary is chosen after 1.0. */
  /^resources\.[^.]+\.display\.[^.]+\.whole( = true)?$/,
  /\[kind=metric\]\.figure( = .*)?$/,
  /\[kind=fields\]\.empty( = .*)?$/, // rc.16: a block of fields leaves out what the record does not have
  /\[kind=headline\]\.subtitle( = .*)?$/, // rc.16: a headline's second line, read from a column of the record
  /^views\.[^.]+\[kind=list\]\.group$/, // rows grouped under a heading
  /\[kind=calendar\]\.span( = .*)?$/, // a calendar's day, week or month
  /^resources\.[^.]+\.form\.fields\.[^.]+\.tree$/, // a reference offered as the hierarchy its parent column makes
  /^ui\.shell\.breadcrumbs\.(home|top)$/,
  /^resources\.[^.]+\.query( = .*)?$/, // rc.16: one table bound as several resources, each on fixed conditions (appNarrowed.ts)
  /^resources\.[^.]+\.computed\.[^.]+(\[type=text\]|\.type = "text")$/, // rc.16: a JSON column's member as text, display only
];

/** Whole package entry points that are Preview. */
export const PREVIEW_ENTRIES: readonly string[] = [
  './openfeature',
  './react/next', // the embed router adapters: one sample at most, each proven against its router's current version only
  './react/react-router',
  './react/tanstack-router',
];

/** Exported names of the Preview features, as `entry: name`. */
export const PREVIEW_EXPORTS: readonly string[] = [
  './app: flag',
  './app: experiment',
  './app: gantt',
  './app: AppFlagGate',
  './app: AppFlagValues',
  './app: AppGanttList',
  './app: AnalyticsDeclaration',
  './app: AnalyticsStep',
  './app: AudienceDefinition',
  './app: ExperimentCapability',
  './app: ExperimentDeclaration',
  './app: FlagCapability',
  './app: FlagDefinition',
  './app: FlagDefinitionOf',
  './app: FlagJson',
  './app: FlagObject',
  './app: FlagOptions',
  './app: FlagValue',
  './commands: ExperimentConversion',
  './commands: defineExperimentConversion',
  './maintenance: AnalyticsFunnel',
  './maintenance: AnalyticsLocation',
  './maintenance: FunnelResult',
  './maintenance: inspectFunnel',
  './maintenance: pruneAnalyticsEvents',
  './page: Gantt',
  './ui: FlagReader',
  './ui: useAnalytics',
  './ui: useFlags',
  './ui: useVisitor',
  './testing: roundTrips',
  './app: TimelineReactions',
  './page: Loaded',
  './ui: Loaded',
  /* The command aggregates (rc.11): `db.<t>.group(…)` and its types. `RowQuery`, which types the older `where()`, stays. */
  './commands: count',
  './commands: sum',
  './commands: avg',
  './commands: min',
  './commands: max',
  './commands: period',
  './commands: Aggregated',
  './commands: Boundary',
  './commands: GroupBy',
  './commands: Grouped',
  './commands: GroupKey',
  './commands: GroupRow',
  './commands: Measure',
  './commands: Measures',
  './commands: MeasureWord',
  './commands: Page',
  './commands: Period',
];

/** CLI commands and flags that are Preview, as the inventory names them. */
export const PREVIEW_CLI: readonly string[] = [
  'flag --reindex',
  'flag --no-query-check', // the queries step of `mistri check`, new in rc.16
  'flag --errors', // `mistri observe --errors`: new in rc.16, one field report's use
  'command flags',
  'command experiments',
  'command analytics',
  'command suite',
  'command deploy', // the Cloudflare roll (`@mistriwork/cloudflare` is Preview with it): one target, proven on one field deployment
];

/** Check codes that are Preview: the finding follows a Preview feature (docs/status.md), so it is as free to change. */
export const PREVIEW_CODES: readonly string[] = [
  'command-trigger',
  'narrowed-overlap',
  'trigger-double-write',
  'trigger-lock',
  'trigger-unknown',
  'query-invalid',
];

/** Command inputs that are Preview, as the inventory names them under `./commands`: a `field` member, or one option of
 * one (`field.number.as = "rating"`). `mistri check` reads them off the loaded commands. */
export const PREVIEW_COMMAND_FIELDS: readonly string[] = [
  'field.time',
  'field.files',
  'field.signature',
  'field.number.as = "rating"',
  'field.text.as = "scan"',
  'field.text.as = "color"',
  'field.reference.tree',
];

/** A value the walk below can descend into: a plain object or an array (not a class instance, a function or a date). */
const container = (value: unknown): value is Record<string, unknown> | unknown[] => {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const DISCRIMINANTS = ['kind', 'type', 'realm'];
const MAX_DEPTH = 24;
const hit = (path: string) => PREVIEW_PATHS.some((rule) => rule.test(path));

/** The path as the inventory names it, a map's key level `*`: each segment is replaced where a rule still matches the
 * result by a rule that writes map keys as `[^.]+`; a rule writes a fixed key literally, so only a map's keys give way. `tail` is the value the rule tests too. */
function generalize(path: string, tail = ''): string {
  const segments = path.split('.');
  for (let i = 0; i < segments.length; i++) {
    const [, name = '', rest = ''] = /^([^[]*)(.*)$/.exec(segments[i]!) ?? [];
    if (name === '*' || name === '') continue;
    const trial = segments.slice();
    trial[i] = `*${rest}`;
    const joined = trial.join('.') + tail;
    if (PREVIEW_PATHS.some((rule) => rule.source.includes('[^.]+') && rule.test(joined))) segments[i] = trial[i]!;
  }
  return segments.join('.');
}

/** The Preview keys an App uses, in the order its config writes them: what `check` lists in its `preview-feature` finding. Each config
 * value is named in the inventory's grammar (`views.<id>[kind=list].presentation[kind=calendar].span = "week"`; a
 * section's or presentation's `kind` stands in brackets, as the inventory writes it) and tested against
 * PREVIEW_PATHS, so a nested key is found where the rules name it, and a new rule needs no code here. */
export function previewKeysUsed(app: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  /* A feature slice restates root keys, so `features[].flags` is as Preview as `flags`. */
  const bare = (path: string) => path.replace(/^features\[\]\./, '');
  const walk = (value: unknown, path: string, depth: number): void => {
    const name = bare(path);
    if (!container(value)) {
      if (value === undefined || value === null || value === false || value === '' || typeof value === 'function') return;
      const tail = ` = ${JSON.stringify(value)}`;
      if (hit(name)) found.add(generalize(name));
      else if (hit(name + tail)) found.add(generalize(name, tail) + tail);
      return;
    }
    if (seen.has(value) || depth > MAX_DEPTH) return;
    if (!(Array.isArray(value) ? value.length : Object.keys(value).length)) return;
    if (path && hit(name)) return void found.add(generalize(name));
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') walk(item, `${path}[]`, depth + 1);
        else if (hit(`${name}[] = ${JSON.stringify(item)}`))
          found.add(`${generalize(`${name}[]`, ` = ${JSON.stringify(item)}`)} = ${JSON.stringify(item)}`);
      }
      return;
    }
    const tag = DISCRIMINANTS.find((key) => typeof value[key] === 'string');
    /* A view names no `kind` in an App's config: a `table` makes it a list and `sections` a dashboard (servedViewKind). */
    const implied = !tag && /^views\.[^.]+$/.test(name) ? servedViewKind(value)?.replace('public form', 'form') : undefined;
    const here = tag ? `${path}[${tag}=${value[tag]}]` : implied ? `${path}[kind=${implied}]` : path;
    if ((tag || implied) && path && hit(bare(here))) return void found.add(generalize(bare(here)));
    for (const [key, child] of Object.entries(value)) walk(child, here ? `${here}.${key}` : key, depth + 1);
  };
  walk(app, '', 0);
  return [...found];
}

/** The Preview command inputs a registry's commands use (PREVIEW_COMMAND_FIELDS), named as the inventory names them.
 * A field is any object in a command's `input` with a `type`; a group's `fields` are walked too. */
export function previewFieldsUsed(commands: unknown): string[] {
  const preview = new Set(PREVIEW_COMMAND_FIELDS);
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (!container(value) || seen.has(value) || depth > MAX_DEPTH) return;
    seen.add(value);
    if (!Array.isArray(value) && typeof value.type === 'string') {
      const base = `field.${value.type}`;
      if (preview.has(base)) found.add(base);
      for (const [key, option] of Object.entries(value)) {
        if (key === 'type' || option === undefined || option === null || option === false) continue;
        const name = `${base}.${key}`;
        if (preview.has(name)) found.add(name);
        const said = typeof option === 'string' || typeof option === 'number' ? `${name} = ${JSON.stringify(option)}` : undefined;
        if (said && preview.has(said)) found.add(said);
      }
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const command of Object.values((commands ?? {}) as Record<string, unknown>))
    walk((command as { input?: unknown } | undefined)?.input, 0);
  return [...found].sort();
}
