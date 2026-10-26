/**
 * The formatter a scaffolded project starts with: the repository's own oxfmt
 * settings (`.oxfmtrc.json` at the root), minus what only the repository
 * ignores, so an App drafted by `--scaffold-app` or `mistri new --api` reads
 * the way the shipped examples do and `npm run format:check` holds it there.
 */
import { readFileSync } from 'node:fs';

/** The generated schema and command types are written by mistri, not by the author. */
const OXFMT_CONFIG = {
  printWidth: 140,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  tabWidth: 2,
  ignorePatterns: ['**/mistri-schema.d.ts', '**/mistri-commands.d.ts', '**/mistri-components.d.ts'],
};

/** The `.oxfmtrc.json` a project is written with. */
export const oxfmtConfigText = `${JSON.stringify(OXFMT_CONFIG, null, 2)}\n`;

/** The `format` and `format:check` scripts: quoted globs, which npm scripts run the same through cmd.exe and a POSIX shell. */
export const formatScripts = {
  format: 'oxfmt "**/*.ts"',
  'format:check': 'oxfmt --check "**/*.ts"',
};

/** The oxfmt this checkout formats with, so a project and its mistri agree on what formatted means. */
export function oxfmtRange(): string {
  try {
    const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    return own.devDependencies?.oxfmt ?? 'latest';
  } catch {
    return 'latest';
  }
}
