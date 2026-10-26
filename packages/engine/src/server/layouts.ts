/**
 * Record layouts, on disk.
 *
 * A layout is bound to a table and applies to every record of it, which makes
 * it the longest-lived thing tablewalk holds: a query is asked once, a filter
 * tab lasts a session, but "this is how a work order is laid out" is a
 * decision made once and relied on afterwards. Keeping it in localStorage
 * meant it lived exactly as long as the browser profile that made it — a
 * different browser, a cleared site setting, or a second machine and the
 * work was gone with no way to get it back.
 *
 * So layouts are stored server-side, in a file the user can read, diff, copy
 * between machines and check into a repo if they want to share them. Two
 * things follow from that choice and are deliberate:
 *
 *   - The file holds *only* layouts. It is written by the app, so it must not
 *     be a file the user also hand-maintains; connections stay in
 *     tablewalk.json, which the app never writes.
 *   - Layouts are keyed by connection id and then table id, because the same
 *     table name means different things on different databases and a layout
 *     built for one should not quietly apply to another.
 *
 * Unlike credentials there is no secret here, so there is no permission
 * discipline to enforce — a layout is a preference, and a readable file is
 * the point rather than a risk.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { product } from './product.js';

/** One stored entry, as the client wrote it. Opaque here on purpose: the
    store round-trips any JSON value — layout objects, filter lists. */
export type StoredLayout = unknown;

/** connection id → table id → layout. */
type LayoutFile = Record<string, Record<string, StoredLayout>>;

const configPath = (name: string) => {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, product(), name);
};

function layoutsPath(): string {
  return configPath('layouts.json');
}

/**
 * Saved pages live in a sibling file with the same shape — connection id,
 * then page id. The same shape because it earns the same machinery: pages
 * were the one piece of built work that lived only in localStorage, so a
 * page assembled in one browser was invisible to every other, while the
 * record layout beside it travelled. Same store, same guarantees.
 */
export function pagesPath(): string {
  return configPath('pages.json');
}

/**
 * Saved list filters, the third sibling — connection id, then table id, to
 * a list of `{name, query}`. The same argument as pages: a filter someone
 * saved is work, and work that lives only in one browser's localStorage is
 * work that vanishes with the browser.
 */
export function filtersPath(): string {
  return configPath('filters.json');
}

/**
 * Where a request's saved filters live, in that one file. An App without
 * sign-in (and the plain browser) keeps one list per connection, shared. An
 * App that signs people in keeps each account's own, in a section keyed by
 * the connection and the account the verified session established — never
 * by anything the client sends — so one account's list is a key no other
 * account's request can name; the separator is a character no connection or
 * account id carries. Null where nothing may be kept: no verified account,
 * or rows scoped by a policy, whose principals write only through it.
 */
export function filtersSection(connection: string, reader: { signIn: boolean; account?: string; rowPolicy: boolean }): string | null {
  if (!reader.signIn) return connection;
  const account = reader.account?.trim();
  return account && !reader.rowPolicy ? `${connection}\u0000${account}` : null;
}

/**
 * Read every stored layout.
 *
 * A missing file is the normal case — most connections have never had a
 * layout saved — and an unreadable one falls back to empty rather than
 * refusing to serve the page. A record with its derived layout is a working
 * page; a record that will not render because a preferences file has a stray
 * comma in it is not.
 */
export async function readLayouts(path = layoutsPath()): Promise<LayoutFile> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // No file is the normal case: nothing has been saved yet.
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as LayoutFile;
    throw new Error('not an object');
  } catch {
    /* A file that exists but does not parse is someone's saved work in a
       shape this build cannot read — treating it as empty was the quiet
       step before the next save PERSISTED the emptiness. Quarantine the
       original beside the store, say so out loud, and start empty; the
       person still holds the bytes. */
    const kept = `${path}.corrupt-${Date.now()}`;
    try {
      await rename(path, kept);
      console.error(`${product()}: ${path} could not be read and was moved to ${kept} — starting empty rather than overwriting it.`);
    } catch {
      console.error(`${product()}: ${path} could not be read; it will be overwritten by the next save.`);
    }
    return {};
  }
}

/** Every layout for one connection. */
export async function layoutsFor(connection: string, path = layoutsPath()): Promise<Record<string, StoredLayout>> {
  return (await readLayouts(path))[connection] ?? {};
}

/**
 * Store or remove one table's layout.
 *
 * Read-modify-write on the whole file rather than a patch, because the file
 * is small and the alternative is a format that supports partial updates —
 * complexity bought with nothing. Passing `null` removes the entry, which is
 * what "Reset to default" means: not an empty layout, but no layout, so the
 * derived one takes over again.
 */
/**
 * One write at a time.
 *
 * Saving a layout is read-the-whole-file, change one key, write the whole file
 * back. Two saves that overlap both read the same file, and the second write
 * lands on top of the first — so a layout saved in one tab disappeared when a
 * layout was saved in another, with nothing to say it had. The window is
 * small and the loss is silent, which is the combination that makes it a bug
 * report nobody can reproduce.
 *
 * A promise chain rather than a lock: each write waits for the one before it,
 * so the read that decides what to write always sees the previous write's
 * result.
 *
 * One chain *per file*, not one per process. The race is two writes to the
 * same file, and a single chain also made every unrelated file wait — layouts
 * behind pages, this connection's behind another's, and a write that is slow
 * or stuck on one path holding up every path. The invariant is about a file,
 * so the queue is about a file.
 */
const writing = new Map<string, Promise<unknown>>();

export function writeLayout(connection: string, table: string, layout: StoredLayout | null, path = layoutsPath()): Promise<void> {
  /* Chained off the previous write to *this file* whether it succeeded or
     not: one failed save must not stop every later one, which is what
     chaining off a rejected promise would do. */
  const queued = (writing.get(path) ?? Promise.resolve()).catch(() => {}).then(() => writeLayoutNow(connection, table, layout, path));
  writing.set(path, queued);
  /* Cleared when it is the last write to that path, so a long-lived process
     does not accumulate an entry per file it has ever written. */
  void queued
    .catch(() => {})
    .then(() => {
      if (writing.get(path) === queued) writing.delete(path);
    });
  return queued;
}

async function writeLayoutNow(connection: string, table: string, layout: StoredLayout | null, path: string): Promise<void> {
  const all = await readLayouts(path);
  const forConnection = { ...(all[connection] ?? {}) };
  /* defineProperty, not assignment: a table named "__proto__" would go
     through the prototype setter, vanish, and the endpoint would still say
     ok — a lying 200. Defined as a plain own property it round-trips. */
  if (layout) {
    Object.defineProperty(forConnection, table, {
      value: layout,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else delete forConnection[table];

  if (Object.keys(forConnection).length) all[connection] = forConnection;
  else delete all[connection];

  await mkdir(dirname(path), { recursive: true });
  /* Atomic: written beside, renamed over. A crash mid-writeFile left half
     a JSON document where every saved page and filter used to be — and the
     read path then served empty, which the next save made permanent. The
     rename is the commit. */
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`);
  await rename(tmp, path);
}
