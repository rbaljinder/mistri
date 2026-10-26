/**
 * The same folder in every workspace package, for a test that reads the sources as the one tree did: `src/client`
 * is packages/kit/src/client, packages/mistri/src/client and packages/tablewalk/src/client, relative to the
 * repository's root as the test's own paths are (scripts/workspace.mjs walks them for the check scripts).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `packages/<name>/<sub>` for each package that has it, relative to the repository's root. */
export function inPackages(sub: string): string[] {
  return readdirSync(join(ROOT, 'packages'))
    .sort()
    .map((name) => `packages/${name}/${sub}`)
    .filter((dir) => existsSync(join(ROOT, dir)));
}
