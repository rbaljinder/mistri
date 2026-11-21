/**
 * Said by `mistri check`: the project's dev script serves the App's source with plain `mistri --app`, not `mistri dev`.
 * That serves, but a save is not followed, the port is not held across a restart and nobody is signed in per role, so
 * an author (or an agent) who runs `npm run dev` works against a server that quietly lags the source (a field report).
 * A warning: serving the source that way is allowed, only rarely what a dev script means.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BUILD_MANIFEST } from '../app/appBuild.js';

/** A word that runs mistri: the bin by name or path, or the package `npx` resolves. */
const MISTRI_WORD = /^(?:.*\/)?(?:mistri|@mistriwork\/mistri(?:@\S+)?)$/;

/** The words of one command, quotes taken off; good enough for a package.json script, which is one line of shell. */
function wordsOf(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** The directory `--app` names in one invocation's words, or undefined when it names none. */
function appFlag(words: string[]): string | undefined {
  for (let at = 0; at < words.length; at++) {
    if (words[at] === '--app') return words[at + 1];
    if (words[at]!.startsWith('--app=')) return words[at]!.slice('--app='.length);
  }
  return undefined;
}

export function devScriptWarning(appDir: string): string | undefined {
  const app = resolve(appDir);
  for (let dir = app, up = 0; up < 4; up++, dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) return scriptWarning(manifest, app);
    if (dirname(dir) === dir) break;
  }
  return undefined;
}

function scriptWarning(manifest: string, app: string): string | undefined {
  let scripts: Record<string, unknown> | undefined;
  try {
    scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
  } catch {
    return undefined;
  }
  const name = typeof scripts?.dev === 'string' ? 'dev' : typeof scripts?.start === 'string' ? 'start' : undefined;
  if (!name) return undefined;
  const root = dirname(manifest);
  for (const command of (scripts![name] as string).split(/&&|\|\||[;|&]/)) {
    const words = wordsOf(command);
    const at = words.findIndex((word) => MISTRI_WORD.test(word));
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    /* A first word that is not a flag is a command (dev, check, build, …): only a serve is judged. */
    if (!rest[0]?.startsWith('-')) continue;
    const target = appFlag(rest);
    if (target === undefined || resolve(root, target) !== app) continue;
    /* Serving a build is what a production start does; it is the source this is about. */
    if (existsSync(join(app, BUILD_MANIFEST))) continue;
    return `package.json's ${name} script serves this App with mistri --app, not mistri dev: use mistri dev --app ${target}, which follows a save, keeps the port while the App starts again, and signs you in per role.`;
  }
  return undefined;
}
