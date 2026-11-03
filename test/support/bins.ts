/**
 * The binary a suite spawns: `mistri`, from its source. A start only the
 * database browser serves (a database with no App) is refused by name
 * (packages/engine/src/server/cli/bin.ts), and the browser lives in its own
 * repository now (https://github.com/rbaljinder/tablewalk).
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The source entry of the binary these arguments start. */
export const entryFor = (_args: readonly string[]): string => join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
