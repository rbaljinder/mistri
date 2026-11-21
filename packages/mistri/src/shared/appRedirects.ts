/**
 * An App's moved addresses (`ui.redirects: { '/old/:id': '/new/:id' }`): a page that was renamed or folded into
 * another keeps answering at its old address, with a 308 that keeps the query. One pattern grammar for the three who
 * read it: the parser (shape), the server (matching, in serveShell) and `mistri check --routes` (what each one means
 * against the App's routes), so a redirect the check passes is one the server follows.
 *
 * A pattern is an in-App path of literal segments and `:name` segments, each matching one segment of the address. The
 * first redirect (in the order written) whose source matches is the one followed.
 */
import { readAppSegments, RESERVED_PATHS, type AddressBook } from './appAddress.js';

type AppRedirects = Readonly<Record<string, string>>;

const MAX_REDIRECTS = 100;
const SEGMENT = /^(?:[A-Za-z0-9._~%-]+|:[A-Za-z_][A-Za-z0-9_]*)$/;

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean);
const isParam = (segment: string): boolean => segment.startsWith(':');

/** Whether `text` is an in-App path pattern: a leading `/`, no query, fragment, empty or odd segment, no trailing `/`. */
function patternProblem(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text.startsWith('/')) return 'is not a path starting with "/"';
  if (text === '/') return undefined;
  if (text.endsWith('/')) return 'ends with "/"';
  if (
    !text
      .slice(1)
      .split('/')
      .every((segment) => SEGMENT.test(segment))
  )
    return 'has a segment that is not a word, an id or a ":name" (no "?", "#", empty segment or spaces)';
  return undefined;
}

/** `ui.redirects`, read: each source and target an in-App path pattern, a source never the home, a source's names its own. */
export function parseRedirects(raw: unknown, where: string): AppRedirects {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error(`${where}: "ui.redirects" is not an object of old path → new path: { '/old/:id': '/new/:id' }.`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_REDIRECTS)
    throw new Error(
      `${where}: "ui.redirects" holds ${entries.length ? `more than ${MAX_REDIRECTS}` : 'none'}; say one to ${MAX_REDIRECTS} moved addresses.`,
    );
  for (const [source, target] of entries) {
    const bad = patternProblem(source);
    if (bad || source === '/') throw new Error(`${where}: ui.redirects "${source}" ${bad ?? 'is the home, which cannot be moved'}.`);
    const wrong = patternProblem(target);
    if (wrong) throw new Error(`${where}: ui.redirects "${source}" goes to ${JSON.stringify(target)}, which ${wrong}.`);
    const names = new Set(segmentsOf(source).filter(isParam));
    const stray = segmentsOf(target as string).find((segment) => isParam(segment) && !names.has(segment));
    if (stray) throw new Error(`${where}: ui.redirects "${source}" goes to "${target}", which names ${stray} the source does not hold.`);
  }
  return Object.freeze({ ...(raw as Record<string, string>) });
}

/** The values a pattern's `:name` segments take in an address, or undefined where the address is not the pattern's. */
function matchPattern(pattern: string, segments: readonly string[]): Map<string, string> | undefined {
  const parts = segmentsOf(pattern);
  if (parts.length !== segments.length) return undefined;
  const taken = new Map<string, string>();
  for (const [at, part] of parts.entries()) {
    if (isParam(part)) taken.set(part, segments[at]);
    else if (part !== segments[at]) return undefined;
  }
  return taken;
}

/**
 * Where an address (the segments after the App's id, still escaped) has moved to: the first redirect whose source it
 * matches, said as an in-App path, or undefined where none does. The caller adds the App's id and the query.
 */
export function redirectedTo(redirects: AppRedirects | undefined, segments: readonly string[]): string | undefined {
  if (!redirects) return undefined;
  for (const [source, target] of Object.entries(redirects)) {
    const taken = matchPattern(source, segments);
    if (taken)
      return `/${segmentsOf(target)
        .map((part) => (isParam(part) ? taken.get(part)! : part))
        .join('/')}`.replace(/^\/$/, '');
  }
  return undefined;
}

/** A pattern as an address that would match it, each `:name` standing as `1`: what the check asks the routes about. */
const sample = (pattern: string): string[] => segmentsOf(pattern).map((part) => (isParam(part) ? '1' : part));

/**
 * What `mistri check --routes` refuses in `ui.redirects`, one sentence each: a target that is not a route the App
 * answers to, a redirect to a redirect (a chain, or a cycle), and a source that is a live route's address, which the
 * redirect would shadow.
 */
export function redirectProblems(redirects: AppRedirects | undefined, book: AddressBook): string[] {
  if (!redirects) return [];
  const problems: string[] = [];
  const sources = Object.keys(redirects);
  const live = new Set<string>([...book.routes.keys(), ...book.tables.keys(), ...book.pageBase.keys(), ...RESERVED_PATHS]);
  for (const [source, target] of Object.entries(redirects)) {
    const first = segmentsOf(source)[0]!;
    if (isParam(first))
      problems.push(
        `ui.redirects "${source}": its first segment is a ":name", which would move every address of the App. Start it with the word that moved.`,
      );
    else if (live.has(first))
      problems.push(
        `ui.redirects "${source}": "/${first}" is an address the App answers to (${describe(book, first)}), so the redirect would hide it. Remove the redirect, or move the page first.`,
      );
    const there = sample(target);
    const onward = sources.find((other) => matchPattern(other, there));
    if (onward)
      problems.push(
        onward === source || chainReaches(redirects, source, onward)
          ? `ui.redirects "${source}" goes round in a circle through "${onward}". A moved address goes to where it ends up, once.`
          : `ui.redirects "${source}" goes to "${target}", which is itself moved on by "${onward}": a redirect of a redirect. Point it at the final address.`,
      );
    else if (there.length && !book.routes.has(there[0]) && !readAppSegments(book, there))
      problems.push(
        `ui.redirects "${source}" goes to "${target}", which is not an address the App answers to. Point it at a route listed by "mistri check --routes".`,
      );
  }
  return problems;
}

const describe = (book: AddressBook, segment: string): string =>
  book.routes.has(segment)
    ? 'a view or page'
    : book.tables.has(segment) || book.pageBase.has(segment)
      ? 'a resource or page of that name'
      : 'reserved';

/** Whether following `from`'s target and then each next redirect comes back to `from`. */
function chainReaches(redirects: AppRedirects, from: string, through: string): boolean {
  const seen = new Set<string>();
  for (
    let at: string | undefined = through;
    at && !seen.has(at);
    at = Object.keys(redirects).find((other) => matchPattern(other, sample(redirects[at!]!)))
  ) {
    if (at === from) return true;
    seen.add(at);
  }
  return false;
}
