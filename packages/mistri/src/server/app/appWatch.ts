/**
 * What an App's watcher watches, and what counts as a change to the App: the
 * directories its load read from, the files it read, and the debounced
 * `fs.watch` the server reloads on. Split from apps.ts, which loads and
 * answers for the App; this is the part that stands beside it while it serves.
 */
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { AppHost, LoadedApp } from './apps.js';

/**
 * The directories an App's custom components were compiled from, for its
 * watcher: a save to a widget, or to a module or stylesheet it imports,
 * recompiles it (appComponents.ts) wherever in the App directory it lives.
 */
function componentWatchDirs(loaded: LoadedApp): string[] {
  if (!loaded.dir || !loaded.components) return [];
  return [
    ...new Set(
      Object.values(loaded.components.entries).flatMap((entry) => entry.sources.map((source) => dirname(join(loaded.dir!, source)))),
    ),
  ];
}

/**
 * The directories an App's look is kept in beyond its root, watched so an edit
 * to a theme reloads the page as an edit to the manifest does: the folders its
 * themes' font files sit in (appFonts.ts), and a `theme/` or `themes/` folder
 * of theme modules (a palette per file) where the App keeps one.
 */
function themeWatchDirs(loaded: LoadedApp): string[] {
  if (!loaded.dir) return [];
  const fonts = [...Object.values(loaded.fonts?.sources ?? {}), ...Object.values(loaded.brand?.sources ?? {})].map((source) =>
    dirname(join(loaded.dir!, source)),
  );
  const folders = ['theme', 'themes']
    .map((name) => join(loaded.dir!, name))
    .filter((folder) => {
      try {
        return statSync(folder).isDirectory();
      } catch {
        return false;
      }
    });
  return [...new Set([...fonts, ...folders])].filter((folder) => folder !== loaded.dir);
}

/**
 * The folders a served App's watcher takes beyond its root, `pages/` and `features/` (`watchApp`'s `extra`). After a
 * load that failed on its components, these include the folders their modules were declared in and each folder between
 * those and the App's: a component's manifest is often saved before its module, in a folder that does not exist yet,
 * and a watcher that knew only the last good load's folders never saw the module written, so it took a restart.
 * A folder not there yet is skipped by the watcher and attached when its making is seen in the one above.
 */
export function watchedDirs(host: AppHost): string[] {
  const root = host.app.dir === undefined ? undefined : resolve(host.app.dir);
  const declared = (host.loadFailure?.error as { componentModules?: readonly string[] } | undefined)?.componentModules ?? [];
  const pending = root
    ? declared.flatMap((module) => {
        const dirs: string[] = [];
        for (let at = dirname(module); at !== root && at.startsWith(`${root}${sep}`); at = dirname(at)) dirs.push(at);
        return dirs;
      })
    : [];
  return [
    ...new Set([
      ...componentWatchDirs(host.app),
      ...themeWatchDirs(host.app),
      ...(host.app.entry ? [dirname(host.app.entry)] : []),
      ...pending,
    ]),
  ];
}

/* What a write to a database leaves in a directory: the file, and SQLite's journals beside it. */
const DATABASE_FILE = /(?:\.(?:db|db3|sqlite|sqlite3)|-(?:wal|shm|journal))$/i;
/* Code can be imported by anything the loader runs (the commands module, a component), so any module file is a change. */
const CODE_FILE = /\.[cm]?[jt]sx?$/i;
/* What the loader reads without importing: stylesheets, JSON, the authority lock, a theme's fonts, the App's pictures.
   Of these only a file beside a subfolder's others counts when the loader did not say it read it (below). */
const DATA_FILE = /\.(?:json|css|lock|woff2?|ttf|otf|png|jpe?g|webp|gif|avif|svg|ico)$/i;

/**
 * The files an App's load read, for its watcher: the manifest, each page's and catalog's file, the commands module,
 * the fonts and pictures it serves, the components' sources, and the module graph its definition, pages and catalogs
 * imported (`LoadedApp.modules`). Absolute paths. `undefined` when a module manifest's load gave no graph, and the
 * watcher then judges by file type alone.
 */
export function loadedFiles(loaded: LoadedApp): ReadonlySet<string> | undefined {
  // A module manifest whose load gave no graph cannot say what it imported: judged by file type, as before.
  if (!loaded.dir || (!loaded.modules && /\.(?:mjs|ts)$/.test(loaded.path))) return undefined;
  const home = loaded.dir;
  const within = (file: string) => resolve(home, file);
  return new Set(
    [
      loaded.path,
      ...(loaded.modules ?? []),
      ...Object.values(loaded.sources),
      ...(loaded.entry ? [loaded.entry] : []),
      ...(loaded.commands ? [loaded.commands.file] : []),
      ...(loaded.pageFiles ?? []).map(within),
      ...(loaded.messageFiles ?? []).map(within),
      ...Object.values(loaded.fonts?.sources ?? {}).map(within),
      ...Object.values(loaded.brand?.sources ?? {}).map(within),
      ...Object.values(loaded.components?.entries ?? {}).flatMap((entry) => entry.sources.map(within)),
    ].flatMap((file) => [resolve(file), real(file)]),
  );
}

/* A path as the loader sees it, links followed: a module graph is resolved to real paths, an event is named by the watched spelling. */
function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

/** The folders under the App holding a file its load imported, so a module in `lib/` is watched where it lives. */
function importedDirs(read: ReadonlySet<string> | undefined, root: string): string[] {
  if (!read) return [];
  // The graph is in real paths and the App may be named by a link to its folder: each file is placed under the spelling given.
  const placed = (file: string): string | undefined => {
    const base = [real(root), root].find((spelled) => file === spelled || file.startsWith(`${spelled}${sep}`));
    return base === undefined ? undefined : join(root, relative(base, file));
  };
  return [...new Set([...read].flatMap((file) => placed(dirname(file)) ?? []))].slice(0, 256);
}

/**
 * Whether a write to `file` can change what the App loads. A log, a database's journal, an editor's swap file and
 * a JSON the App's own process writes beside its source are not: reloading for them told every open page the App
 * had changed, in a loop when the file was written by the server itself (output redirected into the App folder).
 * What the loader read, or imported, is a change; so is any module file (the commands module's imports are not
 * followed), and a data file in a folder of the App's own — a new `pages/` entry, a font, a stylesheet — but not
 * one loose in its root, which is read only when the manifest says so, and is then in `read`.
 */
function movesApp(file: string, root: string, read: ReadonlySet<string> | undefined): boolean {
  const name = basename(file);
  if (DATABASE_FILE.test(name)) return false;
  if (read?.has(file) || read?.has(real(file))) return true;
  if (CODE_FILE.test(name)) return true;
  if (name === 'authority.lock' || name === 'mistri.json') return true;
  /* A name with no type is a folder made or taken away (its files are the ones that matter, and a removed one may have
     held some) unless it is a file there now: a log called `out`, `.DS_Store`, an editor's probe. */
  if (!extname(name)) {
    try {
      return !statSync(file).isFile();
    } catch {
      return true;
    }
  }
  return DATA_FILE.test(name) && (read === undefined || dirname(file) !== root);
}

export function watchApp(
  target: string,
  onChange: () => void,
  debounceMs = 150,
  extra: () => readonly string[] = () => [],
  /** The files the last load read (`loadedFiles`), asked on every event: a write to any other file the loader does not
      read by type (`movesApp`) is not a change to the App. */
  read: () => ReadonlySet<string> | undefined = () => undefined,
): () => void {
  const root = (() => {
    try {
      return statSync(target).isDirectory() ? resolve(target) : dirname(resolve(target));
    } catch {
      return dirname(resolve(target));
    }
  })();
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const attach = (): void => {
    if (closed) return;
    let dirs: string[];
    try {
      dirs = statSync(target).isDirectory()
        ? [target, join(target, 'pages'), join(target, 'features'), ...extra(), ...importedDirs(read(), root)]
        : [dirname(target)];
    } catch {
      /* The target itself is gone. The last good app keeps serving; there is
         nothing left to watch until a restart points at something real. */
      return;
    }
    for (const [dir, watcher] of watchers) {
      /* A directory deleted out from under its watcher leaves the watcher
         alive and silent. Dropping it here lets the recreation re-attach. */
      try {
        statSync(dir);
      } catch {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (event, filename) => burst(event, filename, dir));
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // pages/ is not there yet. Its creation is an event on the parent,
        // which lands back here.
      }
    }
  };

  const burst = (_event: string, filename: string | Buffer | null, dir: string): void => {
    /* Only a file the App loads is a change to it. A SQLite database kept beside the source is written by every save
       (and its -wal and -journal with it), and a server started with its output redirected into the App folder writes
       its log on every request: reloading on those told each open page the App had changed, and a record mid-edit lost
       its editor and its saved note. A burst that names no file still counts. */
    attach();
    if (typeof filename === 'string' && !movesApp(resolve(dir, filename), root, read())) return;
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
  };

  attach();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
