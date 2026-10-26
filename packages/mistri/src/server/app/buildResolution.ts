/**
 * Where a build's `mistri/…` imports land: in the running server's own
 * modules, wherever the build sits.
 *
 * A build's server entries keep `@mistriwork/mistri/commands` and its siblings as bare
 * imports (bundle.ts): they must be the running server's own modules, since a
 * registry is branded in a module-private WeakSet and a handler's error is
 * tested with instanceof. Node resolved them from the bundle's own folder
 * upward, so a build served from a folder with no node_modules above it — an
 * image that copies the build and runs the mistri installed elsewhere, a
 * build written beside the App outside the project — did not start ("Cannot
 * find package 'tablewalk'"), and one beside another install of mistri
 * loaded that copy's classes. A build is pinned to the version that made it,
 * and that version is the one serving it (appBuild.ts), so its `mistri`
 * specifiers are answered from this package's exports map, here.
 *
 * The framework's own packages (`mistri`, `@mistriwork/*`), which the inlined
 * `@mistriwork/mistri/app` helpers import, are answered the same way: as this package
 * resolves them.
 *
 * Only a build's own files are answered: an App served from source resolves
 * from its project, as it always has.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* This file is src/server/app/ (from source, under tsx) or dist/server/app/ (installed): the App framework's package
   root is three up. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const OWN_MANIFEST = pathToFileURL(join(ROOT, 'package.json')).href;
const PACKAGE = '@mistriwork/mistri';
const FRAMEWORK = /^@mistriwork\//;

const builds = new Set<string>();
let registered = false;
let exportsMap: Record<string, unknown> | undefined;

/* An `exports` value's file: from source the checkout's (`default`, the source the server itself loaded); built, what
   the build made (`mistri-built`, or the `default` a published manifest already points at dist). */
function exportFile(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const branches = entry as Record<string, unknown>;
  return exportFile(
    FROM_SOURCE ? (branches.import ?? branches.default) : (branches['mistri-built'] ?? branches.import ?? branches.default),
  );
}

/** The file this package serves `specifier` (`@mistriwork/mistri/commands`, …) from, or undefined when it exports no such entry. */
export function mistriEntry(specifier: string): string | undefined {
  if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return undefined;
  exportsMap ??= (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> }).exports ?? {};
  const target = exportFile(exportsMap[`.${specifier.slice(PACKAGE.length)}`]);
  if (typeof target !== 'string') return undefined;
  return join(ROOT, target);
}

const insideBuild = (parentURL: string | undefined) => {
  if (!parentURL?.startsWith('file:')) return false;
  const file = fileURLToPath(parentURL);
  for (const dir of builds) if (file.startsWith(dir + sep)) return true;
  return false;
};

/** Answer `mistri/…` imports made from inside `dir`, a build, from this package. Idempotent. */
export function resolveMistriFromBuild(dir: string): void {
  builds.add(resolve(dir));
  /* Node names a module by its real path: a build under a symlinked folder (macOS's /var is /private/var) is both. */
  try {
    builds.add(realpathSync(dir));
  } catch {
    /* A build that is not there yet is answered by the path it was named by. */
  }
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (insideBuild(context.parentURL)) {
        const file = mistriEntry(specifier);
        if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
        /* What the inlined `@mistriwork/mistri/app` imports of the framework's own packages (`@mistriwork/engine/…`) is this
           server's too: resolved as this package resolves it, under the conditions the server runs with. */
        if (FRAMEWORK.test(specifier)) return nextResolve(specifier, { ...context, parentURL: OWN_MANIFEST });
      }
      return nextResolve(specifier, context);
    },
  });
}
