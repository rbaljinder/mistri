/**
 * Which of a free-form page's named loaders this browser saw it ask as it opened, by the page's inside address.
 *
 * A tenant page's first reads come with its entry (shared/tenantBoot.ts), and the host reads a page's `loader`
 * with them unasked, since the page always asks it. Its other `loaders` it cannot: a page may hold one back
 * (`useLoader(name, { enabled: false })`) until it has settled a parameter, and only the page's own code says
 * which. So the page says, the next time: each `useLoader` notes here whether it asked as it was first drawn, and
 * the entry sends the names that did (tenantTransport.ts). A wish and no more: the host reads only loaders the
 * page itself lists, for a reader it serves the page to, and an answer is taken only by the very request it
 * answers. A loader held back as its page opened is taken off, and is not read ahead.
 *
 * Kept in this browser alone, names and addresses of the App's own pages, nothing a reader read: a few pages'
 * worth, the oldest dropped.
 */
import { TENANT_BOOT_LOADERS_MOST } from '../shared/tenantBoot.js';

const KEY = 'mistri.pageLoads';
/* As many pages as are remembered. */
const PAGES_MOST = 32;

type Held = Record<string, string[]>;

function held(): Held {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Held) : {};
  } catch {
    return {};
  }
}

/** The loaders to ask for with the page at `path`, as an entry's or a boot's body says them: nothing where none is noted. */
export function pageLoadHints(path: string): { loaders?: string[] } {
  const names = held()[path];
  const said = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name).slice(0, TENANT_BOOT_LOADERS_MOST) : [];
  return said.length ? { loaders: said } : {};
}

/** Note that the page at `path` asked `loader` as it was first drawn, or held it back. */
export function notePageLoad(path: string, loader: string, asked: boolean): void {
  try {
    const all = held();
    const before = Array.isArray(all[path]) ? all[path] : [];
    if (before.includes(loader) === asked) return;
    const names = asked ? [...before, loader].slice(-TENANT_BOOT_LOADERS_MOST) : before.filter((name) => name !== loader);
    delete all[path];
    if (names.length) all[path] = names;
    const kept = Object.entries(all).slice(-PAGES_MOST);
    if (kept.length) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
    else localStorage.removeItem(KEY);
  } catch {
    /* No storage, or a full one: the page asks its loaders itself, as it did. */
  }
}
