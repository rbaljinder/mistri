/**
 * Where a config file may live, in order.
 *
 * Project-local first, because a repo that ships a `mistri.json` (`tablewalk.json` for the browser) should win
 * for anyone working in it; the user's own file is the fallback.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFileName, product } from '../product.js';

export function configLocations(explicit?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (explicit) return [explicit];
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return [join(process.cwd(), configFileName()), join(process.cwd(), `.${configFileName()}`), join(xdg, product(), 'connections.json')];
}
