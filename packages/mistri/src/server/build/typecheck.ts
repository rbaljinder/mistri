/**
 * The typecheck step of `mistri build`. Node's type stripping runs an App
 * without checking a single type, which is right for the authoring loop and
 * wrong for a production build: this is the step that makes a type error
 * fail it.
 *
 * With a tsconfig.json in the App directory, that file decides what is
 * checked and how. Without one, the explicit check the agent guide already
 * documents runs over the manifest and the server entries. TypeScript comes
 * from the App's project only: not a dependency of the runtime, and not the
 * one beside mistri, whose version the project never chose and a CI
 * install of the project would not have. When it is missing the step says it
 * was skipped and the build manifest records that, rather than calling an
 * unchecked build checked.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

interface TypecheckResult {
  status: 'passed' | 'failed' | 'skipped' | 'none';
  /** One line for the build's output. */
  detail: string;
  /** What tsc said, when it failed. */
  output?: string;
}

/* The flags build-with-an-agent.md gives for an App with no tsconfig.
   `--skipLibCheck` because checking the declarations the App only reads —
   Node's, React's (reached through @mistriwork/mistri/app's component types), the DOM
   — was about 70% of a typecheck, and none of them is the App's to fix; its
   own files are checked as before. No DOM: a manifest and its server entries
   run in Node. */
const WITHOUT_TSCONFIG = [
  '--ignoreConfig',
  '--strict',
  '--target',
  'ES2023',
  '--lib',
  'ES2023',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--allowImportingTsExtensions',
  '--verbatimModuleSyntax',
  '--skipLibCheck',
];

/* TypeScript 7, the native compiler, is the minimum and the only one: there is no matrix of older compilers to keep
   working. It ships a `tsc` and no in-process JS API, so a check runs the `tsc` that is installed and reads the
   definition path of an error through its API client (checkProblems.ts). An older one is refused with the one fix. */
export const TYPESCRIPT_FIX = 'npm i -D typescript';
export const meetsMinimum = (version: string) => Number(version.split('.')[0]) >= 7;

function locateTypeScript(appDir: string): { bin: string; version: string } | undefined {
  try {
    const manifest = createRequire(join(appDir, 'package.json')).resolve('typescript/package.json');
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    return { bin: join(dirname(manifest), 'bin', 'tsc'), version };
  } catch {
    // Not installed where the App's project resolves it.
    return undefined;
  }
}

function run(bin: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    // A typecheck that never finishes must not hang a CI job forever.
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, output });
    });
  });
}

/** Typecheck the App directory; `files` are its manifest and server entries. */
export async function typecheckApp(appDir: string, files: string[]): Promise<TypecheckResult> {
  const tsconfig = join(appDir, 'tsconfig.json');
  const hasConfig = existsSync(tsconfig);
  const typescript = files.filter((file) => /\.(m?ts|tsx)$/.test(file));
  /* A free-form page (pages/<path>.page.tsx) is drawn in a browser: with one, the check reads JSX and the DOM too. */
  const browser = typescript.some((file) => file.endsWith('.tsx'));
  if (!hasConfig && !typescript.length) return { status: 'none', detail: 'no TypeScript to check' };
  const ts = locateTypeScript(appDir);
  if (!ts) {
    return {
      status: 'skipped',
      detail: `TypeScript is not installed in the App's project; ${TYPESCRIPT_FIX} to check types`,
    };
  }
  if (!meetsMinimum(ts.version)) {
    return { status: 'failed', detail: `TypeScript ${ts.version} is older than 7, which mistri check needs; ${TYPESCRIPT_FIX}` };
  }
  const args = hasConfig
    ? ['-p', tsconfig, '--noEmit', '--pretty', 'false']
    : /* Named from the App directory, where tsc runs, so its report says app.ts(4,6) and not a climb of ../ */
      [
        '--noEmit',
        '--pretty',
        'false',
        ...(browser
          ? [...WITHOUT_TSCONFIG.map((flag, i) => (WITHOUT_TSCONFIG[i - 1] === '--lib' ? 'ES2023,DOM' : flag)), '--jsx', 'react-jsx']
          : WITHOUT_TSCONFIG),
        ...typescript.map((file) => (relative(appDir, file).startsWith('..') ? file : relative(appDir, file))),
      ];
  const { code, output } = await run(ts.bin, args, appDir);
  /* Named from where the command ran, unless that climbs out of it: then the whole path, not a ladder of ../. */
  const near = relative(process.cwd(), tsconfig);
  const what = hasConfig
    ? near && !near.startsWith('..')
      ? near
      : tsconfig
    : `${typescript.length} file${typescript.length === 1 ? '' : 's'}, no tsconfig.json`;
  return code === 0
    ? { status: 'passed', detail: `tsc ${ts.version}, ${what}` }
    : { status: 'failed', detail: `tsc ${ts.version}, ${what}`, output: output.trim() };
}

/* ---------- tsc, said so a person (or an agent) can act on it ----------

   tsc's own report of a DSL mistake is a structural dump: the whole App's
   type, four hundred characters of it, with the useful part — the name that
   is not a column — at the bottom of the elaboration. What `mistri check`
   prints instead is where (file:line:col), the headline, the innermost
   elaboration when it says something the headline does not, each with long
   types cut down; and for the mistakes the DSL makes common, one line
   saying what to do. The raw output stays one command away: tsc itself. */

interface TscError {
  file?: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
  /** The elaboration lines, outermost first. */
  detail: string[];
}

export function parseTsc(output: string): TscError[] {
  const errors: TscError[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const located = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    const global = located ? undefined : /^error (TS\d+): (.*)$/.exec(raw);
    if (located)
      errors.push({
        file: located[1],
        line: Number(located[2]),
        column: Number(located[3]),
        code: located[4],
        message: located[5],
        detail: [],
      });
    else if (global) errors.push({ code: global[1], message: global[2], detail: [] });
    else if (/^\s+\S/.test(raw) && errors.length) errors.at(-1)!.detail.push(raw.trim());
  }
  return errors;
}

/** A long quoted type cut to its start: `'{ name: string; views: …'`. */
export const shorten = (text: string) => text.replace(/'([^']{90,})'/g, (_, inner: string) => `'${inner.slice(0, 70)}…'`);

/** One line saying what to do about the commonest DSL mistakes, or nothing. */
export function hint(error: TscError, columns: ReadonlySet<string>, hidden: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  const all = [error.message, ...error.detail].join('\n');
  /* A column no reader is served, named where a column is shown: not a typo,
     and the fix is the other place, not the spelling. */
  const said = /Type '"([^"]*)"' is not assignable/.exec(all)?.[1];
  const hiddenOn = said === undefined ? [] : [...hidden].filter(([, names]) => names.has(said)).map(([table]) => table);
  const judged = /(?:LabelPath|OneHopPath|ReferencePath|ReferencePathTo|SortOf)<[^,]+, [^,]+, "([^"]+)"/.exec(all)?.[1];
  if (
    said !== undefined &&
    hiddenOn.length &&
    (judged === undefined ? !columns.has(said) : hiddenOn.includes(judged)) &&
    ['TS2322', 'TS2820', 'TS2345'].includes(error.code)
  ) {
    return (
      `"${said}" is a column of ${judged ?? hiddenOn.join(', ')} that no reader is served (\`hidden\`, or outside every role's \`fields\`), ` +
      'so nothing shows, sorts or writes it. Only `hidden` and the access rules name it; a command reads it through `Rows`.'
    );
  }
  if (error.code === 'TS2307' && /'@mistriwork\/mistri\/app'/.test(all)) {
    return "mistri is not installed where this App can import it: run npm install in the App's project (its package.json lists @mistriwork/mistri), or keep the App inside a mistri checkout. See `mistri docs getting-started`.";
  }
  if (error.code === 'TS2307' && /mistri-schema/.test(all)) {
    return "the schema types are missing: mistri check writes mistri-schema.d.ts when it can reach the App's database.";
  }
  if (/^TS(1295|1286|1287|1479)$/.test(error.code) || /CommonJS/.test(all)) {
    return 'the App is read as CommonJS: its package.json needs "type": "module".';
  }
  if (error.code === 'TS5097' || error.code === 'TS2691') {
    return 'importing ./x.ts needs "allowImportingTsExtensions": true — add a tsconfig.json like the scaffold\'s.';
  }
  if ((error.code === 'TS2305' || error.code === 'TS2724') && /mistri\/app/.test(all)) {
    return '@mistriwork/mistri/app has no export by that name: check the spelling, and the mistri version the App depends on.';
  }
  if (error.code === 'TS2353' || error.code === 'TS2561') {
    const key = /'([^']+)' does not exist in type/.exec(all)?.[1];
    return `${key ? `"${key}" is` : 'that is'} not a key this place takes — the App DSL reference lists each place's keys, and the validation step names them too.`;
  }
  if (error.code === 'TS2554' || error.code === 'TS2555' || error.code === 'TS2556') {
    return "the helper takes other arguments — its signature is in the App DSL reference (and in your editor's hover).";
  }
  if (error.code === 'TS2741') {
    const key = /Property '([^']+)' is missing/.exec(all)?.[1];
    return `a required key is missing${key ? `: add "${key}"` : ''}.`;
  }
  /* A label path names its kind and its table in the type tsc prints — `LabelPath<Tables, References, "task">` —
     so the hint can say which table the name was judged against. */
  const path =
    /Type '"([^"]*)"' is not assignable to type '(LabelPath|OneHopPath|ReferencePath|ReferencePathTo)<[^,]+, [^,]+, "([^"]+)"/.exec(all);
  if (path && ['TS2322', 'TS2820', 'TS2345'].includes(error.code)) {
    const [, name, kind, table] = path;
    const what =
      kind === 'LabelPath'
        ? `a column of ${table}, nor a label path from it through its references (a reference, then .name)`
        : kind === 'OneHopPath'
          ? `a column of ${table}, nor a label path one reference long`
          : kind === 'ReferencePath'
            ? `a reference of ${table}, nor a path of references from it`
            : `a path of references from ${table} to the page's record (or to the record its \`about\` names)`;
    return `"${name}" is not ${what}. mistri-schema.d.ts lists each table's columns (Tables) and references (References).`;
  }
  /* A query-language string the schema types read (packages/mistri/schema/query.d.ts) carries its fault in the type, as a key
     beside the string or as the parameter a group-by must be; the hint says it plainly, and where the names are. */
  const fault =
    /& \{ "((?:[^"\\]|\\.)*)": true;/.exec(all) ??
    /parameter of type '"((?:[^"\\]|\\.)*(?:is not a (?:column|reference|period)|is not a date)[^"]*)"'/.exec(all);
  if (fault && ['TS2322', 'TS2345', 'TS2769'].includes(error.code)) {
    return `${fault[1].replace(/\\"/g, '"')}. A query string is read against its table's columns in mistri-schema.d.ts (Columns: each one's kind and declared values).`;
  }
  const literal = /Type '"([^"]*)"' is not assignable to type '"/.exec(all);
  /* A column where a reference goes — `whose: 'site_code'` — is a text key
     the database declares no foreign key for, not a typo: the accepted names
     are references or paths of them (`"technician_id.region_id"`). */
  const expected = /is not assignable to type '("[^']*)'/.exec(all)?.[1] ?? '';
  if (literal && columns.has(literal[1]) && /"[^"]*(_id|\.)[^"]*"/.test(expected) && ['TS2322', 'TS2820', 'TS2345'].includes(error.code)) {
    return (
      `"${literal[1]}" is a column, but not a foreign key: this place takes a reference, and a reference is a declared foreign key. ` +
      'See `mistri docs relationships`.'
    );
  }
  if (literal && ['TS2322', 'TS2820', 'TS2345'].includes(error.code)) {
    return (
      `"${literal[1]}" is not a name this place accepts — a table, a column or a word of the DSL. Compare its spelling with ` +
      'mistri-schema.d.ts; after a migration, mistri check regenerates that file.'
    );
  }
  return undefined;
}

/* A name the schema types do not hold: a column, a rollup, a path. */
const TYPES_FILE = 'mistri-schema.d.ts';
const NAMES_A_NAME = /Type '"[^"]*"' is not assignable to type '(?:"|(?:LabelPath|OneHopPath|ReferencePath|ReferencePathTo)<)/;

/**
 * tsc's `--pretty false` output as lines a person reads: at most `limit`
 * errors, then how many more. `stale` says the schema types were not
 * regenerated because the App did not load: then a name they lack is most
 * likely one added since (a rollup, a column), and one load error drew a
 * screen of "not a column" for every one of them — so those are said once.
 */
export function readableTypeErrors(
  output: string,
  limit = 20,
  columns: ReadonlySet<string> = new Set(),
  stale = false,
  hidden: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): string[] {
  const parsed = parseTsc(output);
  if (!parsed.length) return output.trim() ? output.trim().split('\n') : [];
  const lines: string[] = [];
  const named = stale ? parsed.filter((error) => NAMES_A_NAME.test([error.message, ...error.detail].join('\n'))) : [];
  const errors = parsed.filter((error) => !named.includes(error));
  if (named.length) {
    const names = [
      ...new Set(
        named.map((error) => /Type '"([^"]*)"' is not assignable/.exec([error.message, ...error.detail].join('\n'))?.[1]).filter(Boolean),
      ),
    ];
    lines.push(
      `The App did not load, so ${TYPES_FILE} could not be brought up to date: ${named.length} error${named.length === 1 ? '' : 's'} naming ` +
        `${names
          .slice(0, 6)
          .map((name) => `"${name}"`)
          .join(', ')}${names.length > 6 ? ', …' : ''} may be only that. Fix what the validation step says, then check again.`,
    );
  }
  for (const error of errors.slice(0, limit)) {
    const where = error.file ? `${error.file}:${error.line}:${error.column}` : 'tsc';
    lines.push(`${where}  ${error.code}  ${shorten(error.message)}`);
    /* The innermost elaboration names the actual mismatch ("'subjet' is not
       assignable to '"subject" | …'"); the ones between are the path to it. */
    const inner = error.detail.at(-1);
    if (inner && inner !== error.message) lines.push(`    ${shorten(inner)}`);
    const help = hint(error, columns, hidden);
    if (help) lines.push(`    hint: ${help}`);
  }
  if (errors.length > limit) lines.push(`…and ${errors.length - limit} more; run tsc for all of them.`);
  return lines;
}
