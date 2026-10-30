/**
 * A build's id: a hash of what the build READS, not of what it wrote.
 *
 * `mistri deploy` has to know which build is serving without trusting that two machines (the operator's, and the
 * Docker build stage) produce byte-identical bundles — they do not promise to (bundler output, node versions). So
 * the id is an input fingerprint both sides compute: the project's package.json and package-lock.json, the App's
 * files, the directories of any commands/jobs/policy entries outside it, and the mistri version. Those are exactly
 * what `mistri build --dockerfile` copies into its build stage (dockerfile.ts), so a clean working tree and the
 * image agree. `mistri build` stamps the value in the manifest; `/readyz` reports it from the image; deploy
 * computes it from the tree.
 *
 * The runtime config is left out on purpose: the image's build stage has no database and is never given it, so
 * it is not something the bundle reads. A config-only change still rolls — the deploy id is what a roll verifies.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { BUILD_ENTRY_KINDS } from '../app/appBuild.js';

/** The part of a build request the fingerprint reads. */
interface FingerprintRequest {
  app: string;
  out?: string;
  commands?: string;
  jobs?: string;
  policy?: string;
}

/* What a Docker context would not carry into the build stage or a build never reads: installed packages, VCS and
 * tool state, the image recipe itself (written beside the App the first time), local databases. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.mistri']);
const SKIPPED_FILES = new Set(['Dockerfile', '.dockerignore', '.DS_Store']);
const LOCAL_DATABASE = /\.(db|sqlite3?)(-wal|-shm|-journal)?$/;

/** The files under `dir` as POSIX paths relative to it, sorted, minus what a build never reads or `skip` names. */
async function filesIn(dir: string, skip: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (path === skip) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path);
      } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name) && !LOCAL_DATABASE.test(entry.name)) {
        found.push(relative(dir, path).split(sep).join('/'));
      }
    }
  }
  await walk(dir);
  return found.sort();
}

/**
 * The 16-hex input fingerprint for `request`, run from the project root (`root`, the directory holding
 * package.json). Paths are named the way the image sees them — App files under `app/`, entry directories by their
 * path from the root — so the root the App sits in does not matter.
 */
export async function buildInputId(request: FingerprintRequest, root = process.cwd(), version = runtimeVersion()): Promise<string> {
  const hash = createHash('sha256');
  const add = async (label: string, file: string) => {
    hash
      .update(`${label}\0`)
      .update(await readFile(file))
      .update('\0');
  };
  hash.update(`mistri ${version}\0`);
  for (const name of ['package.json', 'package-lock.json']) {
    const file = join(root, name);
    if (existsSync(file)) await add(name, file);
  }
  const given = resolve(root, request.app);
  const appDir = statSync(given).isDirectory() ? given : dirname(given);
  const skip = request.out ? resolve(root, request.out) : '';
  for (const file of await filesIn(appDir, skip)) await add(`app/${file}`, join(appDir, file));
  /* Entry directories the App does not contain, as the Dockerfile copies them (and not at all when the App is the root). */
  const atRoot = appDir === resolve(root);
  const outside = new Set<string>();
  for (const kind of BUILD_ENTRY_KINDS) {
    const entry = request[kind];
    if (!entry || atRoot) continue;
    const dir = resolve(root, posix.dirname(relative(root, resolve(root, entry)).split(sep).join('/')));
    if (dir !== resolve(root) && dir !== appDir && !dir.startsWith(appDir + sep)) outside.add(dir);
  }
  for (const dir of [...outside].sort()) {
    const label = relative(root, dir).split(sep).join('/');
    for (const file of await filesIn(dir, skip)) await add(`${label}/${file}`, join(dir, file));
  }
  return hash.digest('hex').slice(0, 16);
}
