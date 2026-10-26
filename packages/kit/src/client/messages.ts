/**
 * The shared vocabulary used by the framework itself. Feature-local App
 * catalogs are projected separately; keeping this module independent lets its
 * language choice be installed before navigation or an App is available.
 *
 * This module holds the words every room shares (`common.*`) and the ones
 * that came first. Every other module's words are a table of its own,
 * `copy/<room>/<the module's path>.ts`, made with `defineMessages` and keyed
 * by what each one means: the rooms are folders, and a module's table is
 * downloaded with the module, so a part loaded on demand brings its words
 * with it and no first page carries a table for rooms it does not draw.
 * `test/check-client-copy.mjs` fails on copy written anywhere else, and on
 * a key nothing says. A word two first-page tables would both carry is
 * `common.*` here instead, so it is downloaded once. The keys are for the
 * source's reader: the build shortens them (vite.config.ts,
 * `shortCatalogKeys`), which is why a key is always said as a string. Another
 * language's shared words are a chunk of their own (copy/es.ts), fetched
 * only for a reader said that language; Spanish is partial, and a word
 * without a translation is said in English.
 */
import { formatNumber } from './locale.js';
import { beginWork } from './pendingWork.js';
import { setHostCookie, shellRoot } from './shellHost.js';
import { localeCookieName } from '@mistriwork/engine/shared/appLocale.js';

type MessageLanguage = 'en' | 'es';

type MessageValue = string | { one: string; other: string };

const catalog = {
  en: {
    'navigation.menu': 'Menu',
    'navigation.closeMenu': 'Close menu',
    'navigation.search': 'Search',
    'navigation.collapse': 'Collapse',
    'navigation.expand': 'Expand',
    'preferences.title': 'Preferences',
    'preferences.language': 'Language',
    'preferences.languageHint': 'Saved in this browser.',
    'preferences.languageHintPerson': 'Saved to your profile.',
    'preferences.visualTheme': 'Visual theme',
    'preferences.appTheme': 'This App’s theme',
    'preferences.resetTheme': 'Reset to the App’s theme',
    'preferences.palette': 'Palette',
    'preferences.paletteHint': 'colors for the selected theme',
    'preferences.colorMode': 'Color mode',
    'preferences.colorModeDarkOnly': 'This theme is dark only.',
    'preferences.system': 'System',
    'preferences.light': 'Light',
    'preferences.dark': 'Dark',
    'preferences.density': 'Density',
    'preferences.comfortable': 'Comfortable',
    'preferences.defaultHint': 'the default',
    'preferences.spacious': 'Spacious',
    'preferences.spaciousHint': 'largest — more room still',
    'preferences.compact': 'Compact',
    'preferences.compactHint': 'tightest — the most rows',
    'preferences.typography': 'Typography',
    'preferences.appDefault': 'App default',
    'preferences.mono': 'Mono',
    'preferences.monoHint': 'values as things you compare',
    'preferences.sans': 'Sans',
    'preferences.sansHint': 'a reading face; code stays code',
    'preferences.rowsPerList': 'Rows per list',
    'preferences.rowsPerListHint': 'grids and app lists',
    'preferences.rowsPerRelatedList': 'Rows per related list',
    'preferences.rowsPerRelatedListHint': 'the lists on a page',
    'common.close': 'Close',
    'common.reading': 'Reading…',
    'common.submitting': 'Submitting…',
    'common.details': 'Details →',
    'common.rows2': { one: '{count} row', other: '{count} rows' },
    'common.schema': 'Schema',
    'common.columns2': { one: '{count} column', other: '{count} columns' },
    'common.filtersButton': 'Filters',
    'common.thePasswordsDoNotMatch': 'The passwords do not match.',
    'common.backToSign': 'Back to sign in',
    'common.signIn': 'Sign in',
    'common.applicationRuntimeIsUnavailable': 'Application runtime is unavailable. Reload to try again.',
    'common.noReceiptWasFound': 'No receipt was found. The original change may still complete. Keep this attempt and check again.',
    'common.statusCouldNotBeVerified': 'Status could not be verified. The original change remains unconfirmed.',
    'common.accessCouldNotBeRefreshed': 'Access could not be refreshed. Any unconfirmed attempt is still retained.',
    'common.requestFailed': 'Request failed ({status})',
    'common.reload': 'Reload',
    'common.thisCommandFormIsNoLonger': 'This command form is no longer current.',
    'common.settings': 'Settings',
    'common.more': 'More',
    'common.theBrowserRefusedClipboard': 'The browser refused clipboard access, so nothing was copied.',
    'common.thatRecordIsNoLonger': 'That record is no longer there.',
    'common.chooseARecordOrClear': 'Choose a record or clear the field.',
    'common.enterAValidValue': 'Enter a valid value.',
    'common.isNotATable': '"{base}" is not a table here.',
    'common.dismiss': 'Dismiss',
    'common.saveChanges': 'Save changes',
    'common.delete': 'Delete…',
    'common.records2': { one: '{count} record', other: '{count} records' },
    'common.theRecordVersionIsUnavailable': 'The record version is unavailable.',
    'common.invalidCommandPath': 'Invalid command path.',
    'common.actions': 'Actions for {label}',
    'common.keyFacts': 'Key facts',
    'common.view': 'View {noun}',
    'common.patternEGWh': 'Pattern, e.g. Wh% or _a%',
    'common.noYet': 'No {things} yet.',
    'common.listPresentation': 'List presentation',
    'common.table': 'Table',
    'common.ofTotal': ' of {total}',
    'common.thatIsNoLonger': 'This {spoken} no longer exists. It may have been deleted.',
    'common.where': 'Where you were',
    'common.tables': { one: '{count} table', other: '{count} tables' },
    'common.couldNotSaveThisBrowser': 'Could not save — this browser is not allowing local storage.',
    'common.savedFilters': 'Saved filters',
    'common.remove2': 'Remove {text}',
    'common.removeName': 'Remove "{name}"',
    'common.filters': 'Filters · {narrowed}',
    'common.filter2': 'Filter by {label}',
    'common.matchesAnywhereInTheValue': 'Matches anywhere in the value, any case. Start with = for an exact match.',
    'common.only': 'Only {label}',
    'common.clear2': 'Clear {label}',
    'common.any': 'Any',
    'common.showResults': 'Show results',
    'common.openThisRecordToCheck': '{message} Open this record to check its stored values.',
    'common.favorites': 'Favorites',
    'common.connections': 'Connections',
    'common.runtimeMetadataIsUnavailable': 'Runtime metadata is unavailable.',
    'common.documentTitle': '{title} — tablewalk',
    'common.tables2': 'Tables',
    'common.agentConsole': 'Agent console',
    'common.loading': 'Loading…',
    'common.done': 'Done',
    'common.rows': 'rows',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.clear': 'Clear',
    'common.today': 'Today',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.apply': 'Apply',
    'common.undo': 'Undo',
    'common.required': 'Required',
    'common.all': 'All',
    'common.add': 'Add',
    'common.nothingMatches': 'Nothing matches.',
    'common.noValue': 'No value',
    'common.next': 'Next',
    'common.back': 'Back',
    'common.saving': 'Saving…',
    'common.checking': 'Checking…',
    'common.key': 'key',
    'common.remove': 'Remove',
    'common.moveUp': 'Move up',
    'common.moveDown': 'Move down',
    'common.untitled': 'Untitled',
    'common.page': 'Page',
    'common.name': 'Name',
    'common.password': 'Password',
    'common.email': 'Email',
    'common.status': 'Status',
    'common.added': 'Added',
    'common.filter': 'Filter',
    'common.records': 'Records',
    'common.rename': 'Rename',
    'common.columns': 'Columns',
    'common.nextArrow': 'Next →',
    'list.viewAll': 'View all',
    'list.empty': 'No rows',
    'list.nothing': 'Nothing here right now.',
    'list.rows': { one: '{count} row', other: '{count} rows' },
    'list.clearAll': 'Clear all',
    'filter.and': '{first} and {last}',
    'filter.or': '{first} or {last}',
    'filter.comma': '{first}, {next}',
    'filter.noMatches': 'No {things} match {conditions}.',
    'filter.noMatchesPlain': 'No {things} match the search and filters.',
    'problem.retry': 'Try again',
    'problem.offline': 'You are offline. Check your connection, then try again.',
    'problem.notDrawn': 'This section could not be drawn. Try again, or reload the page if it keeps happening.',
    'problem.roomNotDrawn': 'This page could not be drawn. Try again, or reload the page if it keeps happening.',
    'problem.sameAbove': 'Not loaded, for the reason above.',
  },
} as const satisfies { en: Record<string, MessageValue> };

type MessageKey = keyof typeof catalog.en;
/** Another language's shared words, said over the English: a chunk of its own (copy/<language>.ts). */
export type Translation = Partial<Record<MessageKey, MessageValue>>;
/**
 * Each language past English, fetched the first time a reader is said it:
 * an English first page carries no other language's words, and a Spanish
 * one has its chunk named beside the entry (server/clientSurface.ts).
 */
const TRANSLATIONS: Record<Exclude<MessageLanguage, 'en'>, () => Promise<{ default: Translation }>> = {
  es: () => import('./copy/es.js'),
};
const translations: Partial<Record<MessageLanguage, Translation>> = {};
const arriving = new Map<MessageLanguage, Promise<void>>();
/** A language's shared words; a word it does not translate is said in English. */
const sharedIn = (lang: MessageLanguage): Translation => translations[lang] ?? {};
type MessageParams = Record<string, string | number>;

/** The `{name}` holes a template asks for. */
type Holes<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Holes<Rest> : never;
type HolesOf<V> = V extends string
  ? Holes<V>
  : V extends { one: infer One; other: infer Other }
    ? Holes<One> | Holes<Other> | 'count'
    : never;
/** Nothing for a message without holes; otherwise a value for every hole, and only those. */
type ParamsOf<V> = [HolesOf<V>] extends [never] ? [] : [params: Record<HolesOf<V>, string | number>];
type Shared = typeof catalog.en;

/** What the server says about an App's reader: the tag it resolved, and whether it chose among the App's own catalogs. */
export interface ServedLanguage {
  /** The reader's resolved tag (`ui.locale` as served). */
  locale?: string | undefined;
  /** The App has words in several languages (`ui.languages`): the server's answer is the language, chrome included. */
  offered?: readonly string[] | undefined;
}

const STORAGE_PREFIX = 'mistri.messages.language.';
let scope: string | undefined;
let served: ServedLanguage = {};
/** The language on screen; `wanted` is the one asked for, which `language` becomes once its words are here. */
let language: MessageLanguage = 'en';
let wanted: MessageLanguage = 'en';
const listeners = new Set<() => void>();
const picked = new Set<(tag: string) => void>();
const unsaved = new Map<string, MessageLanguage>();
const pluralRules = { en: new Intl.PluralRules('en'), es: new Intl.PluralRules('es') };

function storageKey(appId: string | undefined): string {
  return `${STORAGE_PREFIX}${appId === undefined ? 'workbench' : `app.${encodeURIComponent(appId)}`}`;
}

/** The nearest language the framework has words in, for a tag: `es-MX` is Spanish; anything it has none for, English. */
function chromeLanguage(value: unknown): MessageLanguage {
  if (value === 'en' || value === 'es') return value;
  return typeof value === 'string' && /^es(?:-|_)/i.test(value) ? 'es' : 'en';
}

/** The language this browser chose for a scope, or undefined where it chose none. */
function savedLanguage(appId: string | undefined): MessageLanguage | undefined {
  const key = storageKey(appId);
  if (unsaved.has(key)) return unsaved.get(key)!;
  try {
    const saved = window.localStorage.getItem(key);
    return saved === null ? undefined : chromeLanguage(saved);
  } catch {
    return undefined;
  }
}

function applyDocumentLanguage(): void {
  if (typeof document === 'undefined') return;
  shellRoot().lang = language;
  shellRoot().dir = 'ltr';
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** A language's words, fetched once; counted as work, so a first page's veil and a navigation wait for them (pendingWork.ts). */
function fetchWords(lang: MessageLanguage): Promise<void> {
  if (lang === 'en' || translations[lang]) return Promise.resolve();
  let coming = arriving.get(lang);
  if (!coming) {
    const settled = beginWork();
    coming = TRANSLATIONS[lang]()
      .then(
        (module) => {
          translations[lang] = module.default;
        },
        (error: unknown) => {
          /* Said in English rather than not at all; the next ask tries again. */
          console.error(`The ${lang} words did not load.`, error);
          arriving.delete(lang);
        },
      )
      .finally(settled);
    arriving.set(lang, coming);
  }
  return coming;
}

/** Ask for a language: it is on screen once its words are here, never half in another. */
function want(next: MessageLanguage, changed: boolean): Promise<void> {
  wanted = next;
  const show = () => {
    if (wanted !== next || (language === next && !changed)) return;
    language = next;
    applyDocumentLanguage();
    notify();
  };
  if (next === 'en' || translations[next]) {
    show();
    return Promise.resolve();
  }
  if (changed) notify();
  return fetchWords(next).then(show);
}

/**
 * Select the current App (undefined is the Workbench) and what the server
 * said about its reader. An App with words in several languages is said in
 * the language the server resolved (its words were said there too); any
 * other scope in the one this browser chose for it, else the nearest to its
 * `ui.locale`. Resolves once that language's words are here. Calling this
 * again with nothing new does not create a render.
 */
export function setMessageScope(appId?: string, language?: ServedLanguage): Promise<void> {
  const nextScope = appId || undefined;
  served = language ?? {};
  const next = served.offered?.length ? chromeLanguage(served.locale) : (savedLanguage(nextScope) ?? chromeLanguage(served.locale));
  const moved = scope !== nextScope;
  scope = nextScope;
  if (!moved && wanted === next) return arriving.get(next) ?? Promise.resolve();
  return want(next, moved);
}

/** The active framework language, always one the framework catalog supports. */
export function messageLanguage(): MessageLanguage {
  return language;
}

/** The App's languages a reader may pick among, where the server says its words in several; empty elsewhere. */
export function offeredLanguages(): readonly string[] {
  return served.offered ?? [];
}

/** The tag the server says this App's reader in, as served (`ui.locale`). */
export function servedLanguage(): string | undefined {
  return served.locale;
}

/**
 * Persist and publish a reader's choice for the current scope. Where the App
 * has words in several languages the server says them, so the choice goes
 * where it reads it — a cookie, read as the reader's own preference
 * (server/app/readerLocale.ts) — and whoever reloads the App's words is
 * told (`onLanguagePicked`); anywhere else it is this browser's, kept in its
 * storage. Resolves once the chosen language's words are here.
 */
export function setMessageLanguage(tag: string): Promise<void> {
  const next = chromeLanguage(tag);
  if (scope !== undefined && served.offered?.length) {
    setHostCookie(localeCookieName(scope), tag);
    for (const listener of picked) listener(tag);
  } else {
    const key = storageKey(scope);
    try {
      window.localStorage.setItem(key, next);
      unsaved.delete(key);
    } catch {
      unsaved.set(key, next);
    }
  }
  return want(next, false);
}

/** Told the tag a reader picked where the server says the App's words: the App's payload is asked for again (appnav.js). */
export function onLanguagePicked(listener: (tag: string) => void): () => void {
  picked.add(listener);
  return () => picked.delete(listener);
}

/** Subscribe React's useSyncExternalStore (or vanilla consumers) to language changes. */
export function subscribeMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

function say(value: MessageValue, params: MessageParams | undefined): string {
  if (typeof value === 'string') return interpolate(value, params);
  const count = params?.count;
  const template = value[pluralRules[language].select(Number(count)) === 'one' ? 'one' : 'other'];
  /* A count is written in the reader's locale, as locale.ts's `plural` wrote it. */
  return interpolate(template, typeof count === 'number' ? { ...params, count: formatNumber(count) } : params);
}

/** Say a framework message, selecting plural text from its language's rules. */
export function message(key: MessageKey, params?: MessageParams): string {
  return say(sharedIn(language)[key] ?? catalog.en[key], params);
}

/**
 * A room's catalog: its English, and whatever of it is translated. The
 * function it returns says one of the room's keys, or one of the shared keys
 * above, in the current language — English where the room has no
 * translation — with each `{name}` hole filled from `params`, which the key's
 * text types: a hole left out, or one it does not have, is a compile error.
 * A `{ one, other }` value is chosen by `count`, by the language's rules.
 */
export function defineMessages<const T extends Record<string, MessageValue>>(
  en: T,
  translated: { [L in Exclude<MessageLanguage, 'en'>]?: { [K in keyof T]?: MessageValue } } = {},
) {
  return function roomMessage<K extends (keyof T & string) | MessageKey>(
    key: K,
    ...params: ParamsOf<K extends keyof T ? T[K] : K extends keyof Shared ? Shared[K] : never>
  ): string {
    const own = language === 'en' ? undefined : translated[language]?.[key as keyof T];
    const value = own ?? (Object.hasOwn(en, key) ? en[key] : (sharedIn(language)[key as MessageKey] ?? catalog.en[key as MessageKey]));
    /* The types rule an unknown key out; should one arrive anyway, the key is said rather than a section failing. */
    return value === undefined ? key : say(value as MessageValue, params[0] as MessageParams | undefined);
  };
}
