/**
 * An App's words: `messages/<locale>.ts`, one catalog per locale, each
 * `export default defineMessages('es', { 'lead.title': 'Prospecto' })`, found
 * by the loader the way `pages/*.page.tsx` is. The source catalog is the App's
 * own language (`ui.locale`'s, else English); every other one translates some
 * of its keys, and a key it leaves out says the source text.
 *
 * Captions are said here, on the server, before anything is parsed: the
 * definition's `msg()` references are replaced by strings in one locale
 * (`localizeDefinition`), and that definition is parsed as any other, so a
 * parser, a payload and a browser only ever see words. A caption that is
 * filled per record keeps its `{column}` places — a record's name, a
 * transition's `{to}`, a landing's branding slots — as the template it always
 * was, in that locale's order; a notify title keeps the reference, and is
 * said per recipient after the write (inbox.ts).
 *
 * ICU MessageFormat (intl-messageformat) is imported only by an App that has
 * catalogs: never on --mcp, never by the CLI's start (test/cli-startup.test.ts).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAMEWORK_ARGS, isMessageRef, MESSAGE_KEY, type AppMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import type IntlMessageFormatClass from 'intl-messageformat';

type Formatter = InstanceType<typeof IntlMessageFormatClass>;
/** A message parsed: what the browser's formatter takes (appPayload `messages`). */
type MessageAst = ReturnType<Formatter['getAst']>;
type Element = MessageAst[number];

/** A catalog file's name: its locale, then the module suffix. */
const CATALOG_FILE = /^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.(ts|mts|mjs|js)$/;
/** Literal, argument, number, date, time, select, plural, pound, tag (the parser's element types). */
const LITERAL = 0;
const ARGUMENT = 1;
const POUND = 7;

/** The language of a tag: `es-MX` → `es`. */
export const languageOf = (tag: string) => tag.split('-')[0]!.toLowerCase();

/** Every locale's words, checked, with the formatter that says them. */
export interface AppCatalogs {
  /** The source catalog's locale: the keys every other one translates. */
  readonly source: string;
  /** Each locale's entries, by its file's tag. */
  readonly locales: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Each locale's file, from the App directory: `messages/es.ts`. */
  readonly files: Readonly<Record<string, string>>;
  /** Advisories the load does not refuse: a translation's key the source lacks (`message-unused`). */
  readonly advisories: readonly string[];
  /** The formatter class, imported for this App. */
  readonly Format: typeof IntlMessageFormatClass;
}

/** A tenant's words over the App's (`ui.messages: fromRecord`): key → locale → text, already checked. */
export type MessageOverrides = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The catalog files an App directory holds, by name; none without a messages/ folder. */
export async function catalogFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'messages'))).filter((file) => CATALOG_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The argument names a message reads, its own and the framework's: `{name}`, `{n, plural, …}`, `{v, select, …}`. */
export function messageArgs(ast: MessageAst): Set<string> {
  const names = new Set<string>();
  const walk = (elements: MessageAst) => {
    for (const element of elements as Element[]) {
      const value = (element as { value?: unknown }).value;
      if (element.type !== LITERAL && element.type !== POUND && typeof value === 'string' && element.type !== 8) names.add(value);
      const options = (element as { options?: Record<string, { value: MessageAst }> }).options;
      if (options) for (const option of Object.values(options)) walk(option.value);
      const children = (element as { children?: MessageAst }).children;
      if (children) walk(children);
    }
  };
  walk(ast);
  return names;
}

/** Whether a message is literal text and `{name}` places only: a template a record fills (no plural, select, number or date). */
function simple(ast: MessageAst): boolean {
  return (ast as Element[]).every((element) => element.type === LITERAL || element.type === ARGUMENT);
}

/**
 * Read and check an App's catalogs. `evaluate` imports one module graph and
 * hands back its default export (apps.ts's throwaway worker); every file is
 * imported in one worker. Throws naming the file and the fix:
 * `[message-syntax]` for a file that is not a catalog or a text ICU cannot
 * parse, `[message-missing]` for catalogs without the source,
 * `[message-placeholder]` for a translation reading an argument its source
 * does not.
 */
export async function readCatalogs(
  dir: string,
  files: readonly string[],
  sourceLocale: string,
  evaluate: (href: string) => Promise<unknown>,
): Promise<AppCatalogs | undefined> {
  if (!files.length) return undefined;
  const hrefs = files.map((file) => pathToFileURL(join(dir, 'messages', file)).href);
  const entry = `data:text/javascript,${encodeURIComponent(
    `${hrefs.map((href, i) => `import m${i} from ${JSON.stringify(href)};`).join('\n')}\nexport default [${hrefs.map((_, i) => `m${i}`).join(', ')}];`,
  )}`;
  const modules = (await evaluate(entry)) as unknown[];
  const { default: Format } = await import('intl-messageformat');
  const locales: Record<string, Record<string, string>> = {};
  const named: Record<string, string> = {};
  const parsed: Record<string, Record<string, MessageAst>> = {};
  for (const [i, file] of files.entries()) {
    const at = `messages/${file}`;
    const tag = CATALOG_FILE.exec(file)![1];
    const catalog = modules[i];
    if (!plain(catalog) || catalog.kind !== 'messages' || typeof catalog.locale !== 'string' || !plain(catalog.entries))
      throw new Error(
        `[message-syntax] ${at} has no default export made by defineMessages: export default defineMessages('${tag}', { … }).`,
      );
    if (catalog.locale !== tag)
      throw new Error(
        `[message-syntax] ${at} says defineMessages('${catalog.locale}'); a catalog's file is named for its locale: messages/${catalog.locale}.ts.`,
      );
    if (Object.hasOwn(locales, tag)) throw new Error(`[message-syntax] messages/ has two catalogs for "${tag}"; keep one.`);
    const entries: Record<string, string> = Object.create(null);
    parsed[tag] = Object.create(null);
    for (const [key, text] of Object.entries(catalog.entries)) {
      if (!MESSAGE_KEY.test(key) || typeof text !== 'string' || !text.trim())
        throw new Error(`[message-syntax] ${at}: "${key}" is not a key like "lead.title" with text.`);
      try {
        parsed[tag][key] = new Format(text, tag).getAst();
      } catch (error) {
        throw new Error(
          `[message-syntax] ${at}: "${key}" is not ICU MessageFormat (${(error as Error).message}): ${JSON.stringify(text)}.`,
        );
      }
      entries[key] = text;
    }
    locales[tag] = Object.freeze(entries);
    named[tag] = at;
  }
  const source = Object.hasOwn(locales, sourceLocale)
    ? sourceLocale
    : Object.hasOwn(locales, languageOf(sourceLocale))
      ? languageOf(sourceLocale)
      : undefined;
  if (!source)
    throw new Error(
      `[message-missing] messages/ has ${Object.values(named).join(', ')}, and no catalog for the App's own language "${sourceLocale}" (ui.locale): add messages/${languageOf(sourceLocale)}.ts with every key.`,
    );
  const advisories: string[] = [];
  for (const [tag, entries] of Object.entries(locales)) {
    if (tag === source) continue;
    for (const key of Object.keys(entries)) {
      const original = parsed[source][key];
      if (!original) {
        advisories.push(`[message-unused] ${named[tag]}: "${key}" is not in ${named[source]}, so nothing says it.`);
        continue;
      }
      const allowed = messageArgs(original);
      const extra = [...messageArgs(parsed[tag][key])].filter((name) => !allowed.has(name));
      if (extra.length)
        throw new Error(
          `[message-placeholder] ${named[tag]}: "${key}" reads {${extra.join('}, {')}}, which ${named[source]}'s text does not; a translation says the source's arguments.`,
        );
    }
  }
  return Object.freeze({ source, locales: Object.freeze(locales), files: Object.freeze(named), advisories, Format });
}

/**
 * One way of saying an App's messages: a locale, the catalogs, and a
 * tenant's overrides. Each (locale, key) is compiled once.
 */
export class MessageSayer {
  private readonly compiled = new Map<string, Formatter>();
  private readonly sourceNames = new Map<string, Set<string>>();
  constructor(
    readonly catalogs: AppCatalogs,
    /** The reader's resolved tag: `es-MX`. Words come from the nearest catalog; figures from the tag itself. */
    readonly locale: string,
    readonly overrides?: MessageOverrides,
  ) {}

  /** Where a key's text comes from, nearest first: the tenant's row for the locale, then its language, then the catalogs. */
  private found(key: string): { text: string; locale: string } | undefined {
    const tried = [this.locale, languageOf(this.locale)];
    const tenant = this.overrides?.get(key);
    for (const tag of tried) {
      const text = tenant?.get(tag);
      if (text !== undefined) return { text, locale: tag };
    }
    const { locales, source } = this.catalogs;
    for (const tag of [...tried, source]) {
      const text = Object.hasOwn(locales, tag) ? locales[tag][key] : undefined;
      if (text !== undefined) return { text, locale: tag };
    }
    return undefined;
  }

  /** Whether the source catalog has the key: what `msg` may name. */
  has(key: string): boolean {
    return Object.hasOwn(this.catalogs.locales[this.catalogs.source], key);
  }

  private formatter(key: string): Formatter {
    const found = this.found(key);
    if (!found) throw new Error(`[message-missing] msg('${key}') names no message in ${this.catalogs.files[this.catalogs.source]}.`);
    const id = `${found.locale}\n${key}\n${found.text}`;
    let compiled = this.compiled.get(id);
    if (!compiled) this.compiled.set(id, (compiled = new this.catalogs.Format(found.text, this.locale)));
    return compiled;
  }

  /** The message in this locale, parsed: what travels to a browser that says it with arguments. */
  ast(key: string): MessageAst {
    return this.formatter(key).getAst();
  }

  /** The arguments the source text reads: what an override and a binding are held to. */
  sourceArgs(key: string): Set<string> {
    let names = this.sourceNames.get(key);
    if (!names) {
      names = messageArgs(new this.catalogs.Format(this.catalogs.locales[this.catalogs.source][key]!, this.catalogs.source).getAst());
      this.sourceNames.set(key, names);
    }
    return names;
  }

  /** Say a message with its values; a value it lacks says nothing rather than failing a write's notice. */
  format(key: string, values: Readonly<Record<string, unknown>> = {}): string {
    const formatter = this.formatter(key);
    const filled: Record<string, string | number | Date | null> = {};
    const types = argumentTypes(formatter.getAst());
    for (const name of messageArgs(formatter.getAst())) {
      const value = values[name];
      const kind = types.get(name);
      /* A column's value as its ICU type reads it: a stored date's text a Date, a decimal's text a number. */
      if (kind === 'date' && (typeof value === 'string' || typeof value === 'number') && !Number.isNaN(new Date(value).getTime()))
        filled[name] = new Date(value);
      else if (kind === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
        filled[name] = Number(value);
      else if (typeof value === 'bigint') filled[name] = value.toString();
      else
        filled[name] =
          typeof value === 'number' || value instanceof Date ? value : value === null || value === undefined ? '' : String(value);
    }
    return String(formatter.format(filled));
  }

  /**
   * A caption filled per record, as a template in this locale's order: each
   * `{name}` becomes the `{path}` it binds (`args`, else the name itself);
   * undefined where the text is more than literal text and places.
   */
  template(ref: AppMessageRef): string | undefined {
    const ast = this.formatter(ref.message).getAst();
    if (!simple(ast)) return undefined;
    return (ast as Element[])
      .map((element) => {
        const value = (element as { value: string }).value;
        return element.type === LITERAL ? value : `{${ref.args?.[value] ?? value}}`;
      })
      .join('');
  }
}

/* ---------- what a load keeps to say itself again ---------- */

/** What a definition was parsed from and the catalogs that say it (apps.ts `localizedApp`). */
export interface Localizer {
  /** apps.ts's DefinitionInput: the manifest, its pages/ JSON and its command catalog. */
  readonly definition: unknown;
  readonly catalogs: AppCatalogs;
  /** Each reader's definition, by locale and tenant words: at most LOCALES_PER_DEFINITION. */
  held?: Map<string, unknown>;
}
/* Keyed by the definition a load parsed: a request's copies of the host keep it, a reload is a new one. A tenant
   host serves a captured copy of the definition (evidence.ts), which is found by the App's id: the latest load's. */
const byDefinition = new WeakMap<object, Localizer>();
const byApp = new Map<string, Localizer>();

/** Keep what a load was parsed from, for its readers' languages (and a build's app.json). */
export function holdLocalizer(app: { id: string }, localizer: Localizer, latest = true): void {
  byDefinition.set(app, localizer);
  if (latest) byApp.set(app.id, localizer);
}

/** What a definition was parsed from, by the definition or, for a captured copy, its App's latest load. */
export const localizerOf = (app: { id: string }): Localizer | undefined => byDefinition.get(app) ?? byApp.get(app.id);

/** The App's catalogs, where it has any: a light import, for whatever resolves a locale. */
export const appCatalogs = (app: { id: string }): AppCatalogs | undefined => localizerOf(app)?.catalogs;

/**
 * The App's whole catalog in one reader's words, parsed, for its custom
 * components (`useMessage` in @mistriwork/mistri/ui, appPayload `messages`): a
 * component is code the server never says, so it is handed the words and
 * says them itself. Kept per locale and per tenant's words, as a reader's
 * definition is (`localizedApp`); undefined for an App without catalogs.
 */
export function componentMessages(
  app: { id: string },
  locale: string | undefined,
  overrides?: { stamp: string; words: MessageOverrides },
): Readonly<Record<string, MessageAst>> | undefined {
  const localizer = localizerOf(app);
  if (!localizer) return undefined;
  const { catalogs } = localizer;
  const tag = locale ?? catalogs.source;
  const key = JSON.stringify([tag, overrides?.words.size ? overrides.stamp : null]);
  let byReader = saidCatalogs.get(localizer);
  if (!byReader) saidCatalogs.set(localizer, (byReader = new Map()));
  let said = byReader.get(key);
  if (!said) {
    const sayer = new MessageSayer(catalogs, tag, overrides?.words);
    said = Object.freeze(Object.fromEntries(Object.keys(catalogs.locales[catalogs.source]).map((name) => [name, sayer.ast(name)])));
    if (byReader.size >= 32) byReader.delete(byReader.keys().next().value!);
    byReader.set(key, said);
  }
  return said;
}
const saidCatalogs = new WeakMap<Localizer, Map<string, Readonly<Record<string, MessageAst>>>>();

/* ---------- a definition, said in one locale ---------- */

type Path = ReadonlyArray<string | number>;
const said = (path: Path) => path.map((step, i) => (typeof step === 'number' ? `[${step}]` : i ? `.${step}` : step)).join('');

/** The branding slots a landing's words may hold (withBrandingLanding). */
const LANDING_SLOTS = ['name', 'heading', 'tagline', 'hours', 'about'];

/**
 * Where a caption is filled per record or by the framework, by its place in
 * the definition: a resource's `recordLabel` (its columns), a notify rule's
 * `title` (said per recipient), a machine's labels (`{to}`), and a landing's
 * copy (its branding slots). Everywhere else a caption is said once.
 */
function argumentSite(path: Path, landing: boolean): 'record' | 'notify' | 'to' | 'landing' | 'count' | 'plural' | undefined {
  const n = path.length;
  const resource = (back: number) => path[n - back] === 'resources';
  if (resource(3) && path[n - 1] === 'recordLabel') return 'record';
  /* A stock refusal is said from the parent's columns as the write lands (appConsumes.ts): its template names them, `{part_id.on_hand}`. */
  if (path[n - 1] === 'message') {
    const listed = typeof path[n - 2] === 'number';
    const rule = path[n - (listed ? 3 : 2)];
    if ((rule === 'consumes' || rule === 'restocks') && resource(listed ? 5 : 4)) return 'record';
  }
  /* An action's label is said by the browser for the records it takes (client bulkActions.ts countedLabel): {count}. */
  if (resource(5) && path[n - 3] === 'actions' && path[n - 1] === 'label') return 'count';
  /* A resource's noun, and the word after a fact's value, are said for one and for many: the plural a rule would make, or the translation's own. */
  if (resource(3) && path[n - 1] === 'noun') return 'plural';
  if (path[n - 1] === 'after' && typeof path[n - 2] === 'number' && (path[n - 3] === 'facts' || path[n - 3] === 'footer')) return 'plural';
  if (resource(5) && path[n - 3] === 'notify' && path[n - 1] === 'title') return 'notify';
  const machine = path.lastIndexOf('machine');
  if (machine >= 2 && path[machine - 2] === 'resources' && path[n - 1] === 'label') return 'to';
  if (landing) return 'landing';
  return undefined;
}

/**
 * The definition with every `msg()` said in the sayer's locale: a caption
 * said once becomes its words; one filled per record becomes its template;
 * a notify title stays a reference with every argument bound. Copies only
 * what it changes. Throws `[message-missing]` for a key the source lacks and
 * `[message-arg]` for arguments where nothing supplies them, with the path.
 */
export function localizeDefinition<T>(raw: T, sayer: MessageSayer | undefined, where = ''): T {
  const visit = (value: unknown, path: Path, landing: boolean): unknown => {
    if (isMessageRef(value)) return sayRef(value, path, landing);
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item, i) => {
        const next = visit(item, [...path, i], landing);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }
    if (!plain(value)) return value;
    const inLanding = landing || value.kind === 'landing';
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = visit(item, [...path, key], inLanding);
      if (next !== item) (out ??= { ...value })[key] = next;
    }
    return out ?? value;
  };
  const sayRef = (ref: AppMessageRef, path: Path, landing: boolean): unknown => {
    const at = `${where}${where ? ': ' : ''}${said(path)}`;
    if (!sayer) throw new Error(`[message-missing] ${at}: msg('${ref.message}') names a message, and the App has no messages/ catalogs.`);
    if (!sayer.has(ref.message))
      throw new Error(`[message-missing] ${at}: msg('${ref.message}') names no message in ${sayer.catalogs.files[sayer.catalogs.source]}.`);
    const names = sayer.sourceArgs(ref.message);
    for (const bound of Object.keys(ref.args ?? {}))
      if (!names.has(bound)) throw new Error(`[message-arg] ${at}: msg('${ref.message}') binds {${bound}}, which its text does not say.`);
    const site = argumentSite(path, landing);
    if (!names.size) return sayer.format(ref.message);
    const argued = [...names].map((name) => `{${name}}`).join(', ');
    if (site === 'notify') {
      const args: Record<string, string> = {};
      for (const name of names) {
        if (name === 'message') continue;
        if ((FRAMEWORK_ARGS as readonly string[]).includes(name) && !ref.args?.[name])
          throw new Error(
            `[message-arg] ${at}: msg('${ref.message}') says {${name}}, which a notice does not supply; a notice says {message} and the record's columns.`,
          );
        args[name] = ref.args?.[name] ?? name;
      }
      return Object.freeze({ message: ref.message, args: Object.freeze(args) });
    }
    /* Said for one record here; the browser says it again for a selection, from the parsed message (countedLabels). */
    if (site === 'count' && [...names].every((name) => name === 'count') && !ref.args?.count)
      return sayer.format(ref.message, { count: 1 });
    /* {count} in a plural: said once for one and once for the rest, the two forms a noun or a fact's word is served in. */
    if (site === 'plural' && [...names].every((name) => name === 'count') && !ref.args?.count)
      return Object.freeze({ one: sayer.format(ref.message, { count: 1 }), many: sayer.format(ref.message, { count: 5 }) });
    const allowed =
      site === 'to' ? ['to'] : site === 'landing' ? LANDING_SLOTS : site === 'count' || site === 'plural' ? ['count'] : undefined;
    if (!site || (allowed && [...names].some((name) => !allowed.includes(name) || ref.args?.[name])))
      throw new Error(
        `[message-arg] ${at}: msg('${ref.message}') says ${argued}, and this caption is said as it is${
          allowed ? `: it takes only {${allowed.join('}, {')}}` : ', with no record to fill it'
        }.`,
      );
    const template = sayer.template(ref);
    if (template === undefined)
      throw new Error(
        `[message-arg] ${at}: msg('${ref.message}') says ${argued} with plural, select, number or date; this caption is a template, so it takes plain {name} places.`,
      );
    return template;
  };
  return visit(raw, [], false) as T;
}

/**
 * Each resource action whose label counts (`msg('timesheet.approve')` reading
 * `{count}`), parsed in the sayer's locale: what the browser says again for a
 * selection of records (client components/CountedLabel.tsx), by resource and
 * action id. Only these travel parsed; every other caption arrives as words.
 */
export function countedLabels(raw: unknown, sayer: MessageSayer): Map<string, Map<string, MessageAst>> {
  const found = new Map<string, Map<string, MessageAst>>();
  const resources = plain(raw) && plain(raw.resources) ? raw.resources : {};
  for (const [name, resource] of Object.entries(resources)) {
    const actions = plain(resource) && plain(resource.actions) ? resource.actions : {};
    for (const [id, action] of Object.entries(actions)) {
      const label = plain(action) ? action.label : undefined;
      if (!isMessageRef(label) || !sayer.has(label.message) || !sayer.sourceArgs(label.message).has('count')) continue;
      let own = found.get(name);
      if (!own) found.set(name, (own = new Map()));
      own.set(id, sayer.ast(label.message));
    }
  }
  return found;
}

/* ---------- what check says about the words ---------- */

/** Every msg() a definition holds, with where: the manifest, the pages/ files and the commands' fields. */
function messageRefsIn(raw: unknown, base: Path = []): Array<{ ref: AppMessageRef; path: Path }> {
  const found: Array<{ ref: AppMessageRef; path: Path }> = [];
  const visit = (value: unknown, path: Path) => {
    if (isMessageRef(value)) found.push({ ref: value, path });
    else if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i]));
    else if (plain(value)) for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  };
  visit(raw, base);
  return found;
}

/** The ICU type an argument is read as, where its text says one: a plural or a number reads a number, a date or a time a date. */
function argumentTypes(ast: MessageAst): Map<string, 'number' | 'date' | 'select'> {
  const types = new Map<string, 'number' | 'date' | 'select'>();
  const walk = (elements: MessageAst) => {
    for (const element of elements as Element[]) {
      const value = (element as { value?: unknown }).value;
      if (typeof value === 'string') {
        if (element.type === 2 || element.type === 6) types.set(value, 'number');
        else if (element.type === 3 || element.type === 4) types.set(value, 'date');
        else if (element.type === 5) types.set(value, 'select');
      }
      const options = (element as { options?: Record<string, { value: MessageAst }> }).options;
      if (options) for (const option of Object.values(options)) walk(option.value);
    }
  };
  walk(ast);
  return types;
}

/**
 * `[message-arg]`: an argument a notify title or a record's name reads that
 * is no column of its resource, or a column of the wrong kind for how the text
 * says it — a plural of text, a date of a number. `kindOf` answers a
 * resource's column path with its kind, or undefined where it names none.
 */
export function messageArgProblems(
  raw: unknown,
  catalogs: AppCatalogs,
  kindOf: (resource: string, path: string) => 'number' | 'boolean' | 'date' | 'text' | 'other' | undefined,
): string[] {
  const problems: string[] = [];
  const sayer = new MessageSayer(catalogs, catalogs.source);
  for (const { ref, path } of messageRefsIn(raw)) {
    const n = path.length;
    const resourceAt = path.lastIndexOf('resources');
    if (resourceAt < 0 || !sayer.has(ref.message)) continue;
    const resource = String(path[resourceAt + 1]);
    const site = argumentSite(path, false);
    if (site !== 'notify' && site !== 'record') continue;
    const types = argumentTypes(new catalogs.Format(catalogs.locales[catalogs.source][ref.message]!, catalogs.source).getAst());
    for (const name of sayer.sourceArgs(ref.message)) {
      if (site === 'notify' && name === 'message' && !ref.args?.[name]) continue;
      const bound = ref.args?.[name] ?? name;
      const kind = kindOf(resource, bound);
      const at = `${said(path.slice(0, n))}: msg('${ref.message}')`;
      if (kind === undefined) {
        problems.push(`[message-arg] ${at} reads {${name}} from "${bound}", which is not a column of "${resource}" or a path from it.`);
        continue;
      }
      const wants = types.get(name);
      if ((wants === 'number' && kind !== 'number') || (wants === 'date' && kind !== 'date'))
        problems.push(`[message-arg] ${at} says {${name}} as a ${wants}, and "${bound}" is ${kind}.`);
    }
  }
  return problems;
}

/**
 * The advice a load does not refuse: `[message-untranslated]`, how many of
 * the source's keys each translation leaves to the source's words, and
 * `[message-unused]`, a key nothing names (or a translation's key the source
 * lacks).
 */
export function messageAdvisories(raw: unknown, catalogs: AppCatalogs): string[] {
  const out = [...catalogs.advisories];
  const keys = Object.keys(catalogs.locales[catalogs.source]);
  for (const [tag, entries] of Object.entries(catalogs.locales)) {
    if (tag === catalogs.source) continue;
    const missing = keys.filter((key) => !Object.hasOwn(entries, key));
    if (missing.length)
      out.push(
        `[message-untranslated] ${catalogs.files[tag]} translates ${keys.length - missing.length} of ${keys.length} messages; ${missing.length} say ${catalogs.files[catalogs.source]}'s words (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}).`,
      );
  }
  const named = new Set(messageRefsIn(raw).map(({ ref }) => ref.message));
  for (const key of keys)
    if (!named.has(key))
      out.push(`[message-unused] ${catalogs.files[catalogs.source]}: "${key}" is named by no msg(); name it or remove it.`);
  return out;
}
