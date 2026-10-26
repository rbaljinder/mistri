/**
 * The files an install carries beside the code: the sample Apps (examples/) and the agent skill (skills/). They ship in
 * the `mistri` package, the one an App's author installs (`node_modules/@mistriwork/mistri/examples`, agentInit.ts), carried in
 * when it is packed (scripts/pack-manifest.mjs). So the App framework finds them in its own package, or, in a
 * checkout where nothing was packed, at the repository's root.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* This package's root and the repository's, from src/server or dist/server of packages/mistri. */
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const CHECKOUT = fileURLToPath(new URL('../../../../', import.meta.url));

function roots(): string[] {
  return [PACKAGE, CHECKOUT];
}

/** `path` (`skills/mistri`, `examples/apps/tick/app.ts`) where an install or this checkout has it, or undefined. */
export function shippedPath(path: string): string | undefined {
  return roots()
    .map((root) => join(root, path))
    .find((at) => existsSync(at));
}
