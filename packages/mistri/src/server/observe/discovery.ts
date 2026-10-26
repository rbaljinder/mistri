/**
 * Where `mistri observe` finds a running dev server: one small file per
 * `--dev` process — its pid and address, nothing observed — written with the
 * owner's permissions only and removed when the process exits.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function observerDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mistri', 'observers');
}
