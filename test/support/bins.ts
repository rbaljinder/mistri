/**
 * Which binary owns a start, for a suite that spawns both: an App's start (`--app`, `--scaffold-app`, an App's
 * export, or a command only the App framework has) is mistri's, and a database's is the database browser's. Each
 * refuses the other's starts by name (packages/engine/src/server/cli/bin.ts), so a suite that sent every start to one
 * binary would be testing a refusal.
 *
 * test-package: dispatch — a suite that imports this is owned by what else it reaches (scripts/test-owners.mjs).
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISTRI_COMMANDS } from '../../packages/mistri/src/server/cli/mistriCommands.js';
import { BROWSER_COMMANDS } from '../../packages/tablewalk/src/server/cli/browserCommands.js';
import { APP_COMMAND_WORDS } from '../../packages/tablewalk/src/server/cli/usage.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_EXPORTS = new Set(['types', 'brief', 'openapi', 'asyncapi']);

/** `tablewalk` or `mistri`, by what the arguments start. */
export function binFor(args: readonly string[]): 'tablewalk' | 'mistri' {
  const [first] = args;
  if (first && (first in MISTRI_COMMANDS || APP_COMMAND_WORDS.includes(first)) && !(first in BROWSER_COMMANDS)) return 'mistri';
  /* Both have migrate and seed; an App's stores and files, and an App's own reading of either, are mistri's. */
  if (first === 'migrate' && (args[1] === 'stores' || args[1] === 'files')) return 'mistri';
  if (args.includes('--suite')) return 'mistri';
  if (args.some((arg) => arg === '--app' || arg.startsWith('--app=') || arg === '--scaffold-app')) return 'mistri';
  const exported = args.indexOf('--export');
  if (exported >= 0 && APP_EXPORTS.has(args[exported + 1] ?? '')) return 'mistri';
  return 'tablewalk';
}

/** The source entry of the binary that owns the start these arguments make. */
export const entryFor = (args: readonly string[]): string => join(ROOT, 'packages', binFor(args), 'src', 'server', 'index.ts');
