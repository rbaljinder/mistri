/**
 * `mistri agent init`: the package's agent skill, copied into a project
 * where each coding agent looks for skills, and a pointer at it in AGENTS.md.
 *
 * The skill (skills/mistri, shipped beside dist) is a decision guide an
 * agent loads when it builds an App. An agent reads skills from its project,
 * not from node_modules, so the skill has to be copied — and a copy invites
 * two failures this command is written against: a re-run that overwrites what
 * the project changed in its copy, and a copy that silently goes stale. So
 * each copy carries a manifest of what was installed (the version and a hash
 * of every file); a re-run updates a copy that still matches it, says a copy
 * is up to date when it is, and leaves an edited one alone unless --force.
 *
 * Where each tool reads project skills, as each documents it (September
 * 2026): Claude Code reads .claude/skills/<name>/SKILL.md; Codex, Cursor and
 * GitHub Copilot all read .agents/skills/<name>/SKILL.md, the Agent Skills
 * format's shared place. Copilot reads .claude/skills too, so a project
 * given both copies may see the skill twice there; they are the same file.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { moduleTypeProblem, typescriptProblem } from './projectSetup.js';
import { shippedPath } from '../shipped.js';

const AGENT_USAGE = 'mistri agent init [--dir <project>] [--tool claude|codex|cursor|copilot|all] [--force]';

/* Every tool and the directory it reads project skills from. */
const SKILL_HOMES = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  cursor: '.agents/skills',
  copilot: '.agents/skills',
} as const;
type Tool = keyof typeof SKILL_HOMES;

const MANIFEST = '.mistri-skill.json';
const BLOCK_START = '<!-- mistri:skill:start (written by mistri agent init; edits inside are replaced) -->';
const BLOCK_END = '<!-- mistri:skill:end -->';

/* skills/ ships beside the sample Apps (shipped.ts); named where an install would have it when neither place does, so
   the refusal below says where it looked. */
const SKILL_SOURCE = shippedPath('skills/mistri') ?? fileURLToPath(new URL('../../../../../skills/mistri', import.meta.url));

class Refusal extends Error {}

interface AgentOptions {
  dir: string;
  tools: Tool[];
  force: boolean;
}

function readFlags(argv: string[]): AgentOptions | 'help' {
  if (argv.length === 0 || argv.some((arg) => arg === '--help' || arg === '-h')) return 'help';
  const [verb, ...rest] = argv;
  if (verb !== 'init') throw new Refusal(`unknown agent command "${verb}"; the one command is init.`);
  const options: AgentOptions = { dir: process.cwd(), tools: [], force: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined || next.startsWith('-')) throw new Refusal(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--dir') options.dir = resolve(value());
    else if (arg === '--tool') {
      for (const tool of value().split(',')) {
        if (tool === 'all') options.tools.push(...(Object.keys(SKILL_HOMES) as Tool[]));
        else if (tool in SKILL_HOMES) options.tools.push(tool as Tool);
        else throw new Refusal(`--tool "${tool}" is not one of ${Object.keys(SKILL_HOMES).join(', ')} or all.`);
      }
    } else if (arg === '--force') options.force = true;
    else throw new Refusal(`unknown option "${arg}".`);
  }
  if (options.tools.length === 0) options.tools = Object.keys(SKILL_HOMES) as Tool[];
  return options;
}

/** Every file under a directory, as paths relative to it, the manifest aside. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .filter((path) => path !== MANIFEST)
    .sort();
}

const sha = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(filesUnder(dir).map((path) => [path, sha(readFileSync(join(dir, path)))]));
}

/**
 * The skill links its sample files relative to where it ships
 * (`../../../examples/apps/lintel/views.ts#L98`, from references/ inside the
 * package). A copy sits in the project, where that path points at the project's
 * own tree, so a copied Markdown file's links are re-aimed at the package's
 * examples under node_modules, with their #L anchors untouched.
 */
function rewriteExampleLinks(text: string, file: string, project: string, target: string): string {
  const examples = relative(dirname(join(target, file)), join(project, 'node_modules', '@mistriwork', 'mistri', 'examples', 'apps'));
  return text.replace(/(?:\.\.\/)+examples\/apps\//g, `${examples.split('\\').join('/')}/`);
}

/** Every file the copy at `target` holds: the skill's files, their sample links re-aimed at the project's node_modules. */
function rendered(project: string, target: string): Map<string, Buffer | string> {
  return new Map(
    filesUnder(SKILL_SOURCE).map((file) => {
      const content = readFileSync(join(SKILL_SOURCE, file));
      return [file, file.endsWith('.md') ? rewriteExampleLinks(content.toString('utf8'), file, project, target) : content];
    }),
  );
}

const renderedHashes = (files: Map<string, Buffer | string>): Record<string, string> =>
  Object.fromEntries([...files].map(([file, content]) => [file, sha(content)]));

const same = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function readManifest(dir: string): Record<string, string> | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as {
      files?: Record<string, string>;
    };
    return manifest.files && typeof manifest.files === 'object' ? manifest.files : undefined;
  } catch {
    return undefined;
  }
}

/** What differs between a copy and the manifest it was installed with. */
function editsIn(dir: string, installed: Record<string, string>): string[] {
  const now = hashes(dir);
  return [...new Set([...Object.keys(now), ...Object.keys(installed)])].filter((path) => now[path] !== installed[path]).sort();
}

function install(target: string, files: Map<string, Buffer | string>, source: Record<string, string>): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [file, content] of files) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), content);
  }
  writeFileSync(join(target, MANIFEST), `${JSON.stringify({ mistri: runtimeVersion(), files: source }, null, 2)}\n`);
}

/** One copy: installed, updated, already current, or left alone because the project changed it. */
function place(target: string, files: Map<string, Buffer | string>, force: boolean): { said: string; kept: boolean } {
  const source = renderedHashes(files);
  if (!existsSync(target) || filesUnder(target).length === 0) {
    install(target, files, source);
    return { said: 'installed', kept: false };
  }
  const installed = readManifest(target);
  const edits = installed ? editsIn(target, installed) : ['(a copy mistri did not install)'];
  if (edits.length > 0 && !force) {
    return {
      said: `left alone: changed since it was installed (${edits.join(', ')}); --force replaces it`,
      kept: true,
    };
  }
  if (edits.length === 0 && same(installed!, source)) return { said: 'up to date', kept: false };
  install(target, files, source);
  return {
    said: edits.length > 0 ? 'replaced (--force)' : 'updated',
    kept: false,
  };
}

/**
 * The AGENTS.md block, naming each copy the project now has. An agent reads
 * this file at every start, so it is a map, not a manual: where things live,
 * the few rules a mistake is costly against, and which command answers which
 * question in the fewest tokens. The judgement lives in the skill, the keys in
 * `mistri docs`; this block only points at them.
 */
function agentsBlock(copies: string[]): string {
  return [
    BLOCK_START,
    '## mistri',
    '',
    'This project builds a mistri App. Before creating or changing it (its pages,',
    'forms, access, sign-in or tenancy), load the mistri skill and follow its loop:',
    `${copies.map((copy) => `\`${copy}/SKILL.md\``).join(' or ')}.`,
    '',
    'Where things live:',
    '- `app.ts` and its modules: the App, from `@mistriwork/mistri/app`, typed `satisfies App`.',
    '- `mistri-schema.d.ts`: generated from the database by `check`; never edit it.',
    '- `commands.ts`, `--jobs`, `--policy` modules: server-only (`@mistriwork/mistri/commands`, `@mistriwork/mistri/policy`);',
    '  `commands.ts` ends `export default defineCommands({ … })`, every command by its id.',
    '- `package.json`: `"type": "module"`, and TypeScript 7 or later (`npm i -D typescript`).',
    '- `mistri.json`: connections, credentials as `${VARIABLE}` references.',
    '- Keys: `npx @mistriwork/mistri docs app-dsl`; blocks by intent: `npx @mistriwork/mistri docs choose`;',
    '  sample Apps: `npx @mistriwork/mistri docs examples`; every topic: `npx @mistriwork/mistri docs`.',
    '',
    'Commands, and when:',
    '- `npx @mistriwork/mistri schema --brief`: orient; one line per table.',
    '- `npx @mistriwork/mistri check --app . --brief`: after every edit, until it exits 0.',
    '- `npx @mistriwork/mistri explain <code>`: a check code you do not know.',
    '- `npx @mistriwork/mistri shot --app . <route> --text`: verify what a page shows.',
    '- `npx @mistriwork/mistri shot --app . <route> --both`: only for a question of layout.',
    '- `npx @mistriwork/mistri migrate stores up --app .`: once commands exist, server stopped; creates their journal and event store.',
    '',
    'Rules:',
    "- Import only `@mistriwork/mistri/app`, `@mistriwork/mistri/commands`, `@mistriwork/mistri/policy`; never mistri's `src/`.",
    '- Change the schema by migration (`npx @mistriwork/mistri migrate new <name> --app .`), never by hand.',
    '- Hiding is not protecting: `hidden`, `fields`, grants and row policies are; `show` and `when` are not.',
    '- Writes need `"writable": true` on the connection and `access: \'write\'` on the resource.',
    '- Never write to, reseed or migrate an existing database without asking.',
    '- Report the commands you ran and their exit codes; never claim a check you did not run.',
    BLOCK_END,
  ].join('\n');
}

function writeAgents(project: string, copies: string[]): string {
  const file = join(project, 'AGENTS.md');
  const block = agentsBlock(copies);
  if (!existsSync(file)) {
    writeFileSync(file, `${block}\n`);
    return 'AGENTS.md: created, with a block pointing at the skill';
  }
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) {
    writeFileSync(file, `${text.replace(/\n*$/, '\n\n')}${block}\n`);
    return 'AGENTS.md: added a block pointing at the skill';
  }
  const next = text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  if (next === text) return 'AGENTS.md: up to date';
  writeFileSync(file, next);
  return 'AGENTS.md: updated its mistri block';
}

/**
 * Runs `mistri agent …`: 0 when every copy is in place, 1 when one was
 * left alone or the command could not run.
 */
export function runAgent(
  argv: string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
  err: (text: string) => void = (text) => process.stderr.write(text),
): number {
  let options: AgentOptions | 'help';
  try {
    options = readFlags(argv);
  } catch (error) {
    err(`mistri: ${(error as Error).message}\n${AGENT_USAGE}\n`);
    return 1;
  }
  if (options === 'help') {
    out(
      `${AGENT_USAGE}\n\nCopies mistri's agent skill into the project: .claude/skills/mistri for Claude Code,\n` +
        '.agents/skills/mistri for Codex, Cursor and Copilot (the default, --tool all, writes both), and\n' +
        'points at it from a marked block in AGENTS.md. A re-run updates a copy mistri installed and\n' +
        'leaves one the project changed alone unless --force.\n',
    );
    return 0;
  }
  if (!existsSync(join(SKILL_SOURCE, 'SKILL.md'))) {
    err(`mistri: the skill is not beside this mistri (${SKILL_SOURCE}); reinstall the package.\n`);
    return 1;
  }
  if (!existsSync(options.dir)) {
    err(`mistri: --dir ${options.dir} does not exist.\n`);
    return 1;
  }
  const homes = [...new Set(options.tools.map((tool) => SKILL_HOMES[tool]))];
  let kept = false;
  for (const home of homes) {
    const readers = (Object.keys(SKILL_HOMES) as Tool[]).filter((tool) => SKILL_HOMES[tool] === home && options.tools.includes(tool));
    const result = place(join(options.dir, home, 'mistri'), rendered(options.dir, join(options.dir, home, 'mistri')), options.force);
    kept ||= result.kept;
    out(`${home}/mistri (${readers.join(', ')}): ${result.said}\n`);
  }
  /* Every copy the project has now, this run's or an earlier one's, so a later --tool adds to the block. */
  const copies = [...new Set(Object.values(SKILL_HOMES))]
    .map((home) => `${home}/mistri`)
    .filter((copy) => existsSync(join(options.dir, copy, 'SKILL.md')));
  out(`${writeAgents(options.dir, copies)}\n`);
  /* What the project needs before check can run, each with its fix; a project not yet made has nothing to say. */
  if (existsSync(join(options.dir, 'package.json'))) {
    for (const note of [moduleTypeProblem(options.dir, (path) => relative(options.dir, path) || path), typescriptProblem(options.dir)]) {
      if (note) out(`note: ${note}\n`);
    }
  }
  return kept ? 1 : 0;
}
