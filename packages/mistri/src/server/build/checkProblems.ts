/**
 * `mistri check --json`: every finding of every step as one record an
 * agent can act on without reading prose — a stable code, where it was
 * written (file, line, column, and the DSL path where it can be told), what
 * is wrong and, where the check knows it, the fix.
 *
 * The steps still speak in sentences (the text output is theirs); this reads
 * those sentences once more for their structure. A code is the step's own
 * where it has one — tsc's `TS2322`, a design rule's, a per-role rule's
 * bracketed `[outside-ceiling]` — and otherwise the kind of mistake the
 * sentence names, from the table below, which check-codes.md documents code
 * for code (test/check-json.test.ts holds the two together). A sentence
 * that matches none is still a problem, as `invalid-app`: the list is how an
 * agent finds the fix, never what decides whether the App is wrong.
 *
 * The output is described by packages/mistri/schema/check.schema.json; its codes and fields
 * are the contract, its sentences are not.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContractPromise } from './themeContract.js';

export type CheckStep =
  | 'pending'
  | 'themes'
  | 'fonts'
  | 'files'
  | 'schema types'
  | 'typecheck'
  | 'validation'
  | 'indexes'
  | 'components'
  | 'routes'
  | 'design'
  | 'elevations'
  | 'segments'
  | 'defaults'
  | 'fix'
  | 'deploy'
  | 'check';
export type CheckSeverity = 'error' | 'warning' | 'info';

export interface CheckProblem {
  code: string;
  severity: CheckSeverity;
  step: CheckStep;
  /** Where it was written, from where the command ran; absent where no one file says it. */
  file?: string;
  line?: number;
  column?: number;
  /** Where in the App definition: `views.tasks.query`, `resources.task.actions.close.when`, `pages.order.sections[0].primary`. */
  path?: string;
  message: string;
  fix?: string;
  /** The theme contract's promise the code holds (themeContract.ts), C1 to C13; absent for a code that holds none. */
  promise?: ContractPromise;
  /** The page that explains the code. */
  docs: string;
}

const SITE = 'https://mistriwork.dev/docs';
export const docsFor = (code: string, step: CheckStep): string =>
  step === 'design'
    ? `${SITE}/design-lint/#${code}`
    : step === 'typecheck'
      ? `${SITE}/check-codes/#typecheck`
      : `${SITE}/check-codes/#${code}`;

/**
 * The codes a sentence of the validation step is read for, first match wins.
 * Each is listed in check-codes.md; a new kind of refusal that deserves its
 * own code is added here and there together.
 */
export const VALIDATION_CODES: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  /* An App theme's failures (shared/themeFix.ts): each says the color, or the chart order, that passes. */
  { code: 'theme-chart', pattern: /^Theme "[^"]+" \((?:light|dark)\), \S+: .* are [\d.]+ apart;/ },
  /* A part's words on its ground, and a part style or stylesheet the contract refuses (themeParts.ts,
     themeStylesheet.ts): the same App in another look (C13). */
  { code: 'theme-part', pattern: /^Theme "[^"]+" \((?:light|dark)\), \S+: parts\.[\w.]+: |\.parts(?:\.[\w.]+)? (?:has no "|must be )/ },
  /* A package's theme: a contract this mistri does not read, a `from` without one, a chain too deep, a file
     outside its package (themeSpec.ts, appFonts.ts, appBrand.ts). */
  {
    code: 'theme-contract',
    pattern:
      /\.contract is |\.from (?:names|must be|reads)|\.extends is a theme that extends|(?:leads outside|is not a file in) its package/,
  },
  /* A theme's own stylesheet refused by its allowlist, named by its line and why, or a file it cannot be read from. */
  { code: 'theme-css', pattern: /\) stylesheet \S+ |\.stylesheet (?:must be|is a file)/ },
  /* Split by the promise each breaks (themeContract.ts): a control's edge C2, the focus ring C3, paper C12, words C1. */
  { code: 'theme-edge', pattern: /^Theme "[^"]+" \((?:light|dark)\), \S+\.lineControl: / },
  { code: 'theme-focus', pattern: /^Theme "[^"]+" \((?:light|dark)\), (?:\S+\.focus: |\S+: \S+ focus ring )/ },
  { code: 'theme-print', pattern: /^Theme "[^"]+" \((?:light|dark)\), \S+: \S+ on printed paper / },
  { code: 'theme-contrast', pattern: /^Theme "[^"]+" \((?:light|dark)\), \S+: / },
  { code: 'theme-budget', pattern: /past the \d+ KB budget/ },
  { code: 'theme-radius', pattern: /\) shape\.radius\.panel \S+ is squarer than / },
  { code: 'theme-band', pattern: /\) parts\.(?:status|tag)\.ground \S+ is opaque \(/ },
  { code: 'theme-shadow', pattern: /\) colors\.(?:light|dark)\.shadow \S+ is lighter than its ground / },
  { code: 'theme-type', pattern: /\) type\.roles\.\w+\.weight \d+ is past 700 in a face / },
  /* The App's own logo picture (server/app/appBrand.ts): one with no dark answer breaks C10; one that cannot be read. */
  { code: 'theme-dark', pattern: /ui\.logo\.src "[^"]*" has no dark: / },
  { code: 'app-logo', pattern: /ui\.logo(?:\.(?:src|dark|mark)\b| has no ")/ },
  /* A theme per audience (ui.theme.for) naming a theme the App does not offer, or a role it does not declare. */
  { code: 'theme-audience', pattern: /ui\.theme\.for\b/ },
  { code: 'theme-font', pattern: /type\.faces\[\d+\]|^the theme fonts? |\) ships the face "|type\.font\.\w+ leads with "/ },
  { code: 'unknown-key', pattern: /\bhas no "[^"]+"\.(?: Did you mean| "[^"]+" belongs|) ?[\s\S]*It takes:/ },
  {
    code: 'document',
    pattern:
      /, "document"|a document (?:draws|is one sheet|is addressed)|which is a document|is a document at|^document: "number"|paper has|on paper (?:fields|a list)|is a list of the record's lines on paper/,
  },
  { code: 'unknown-column', pattern: /is not a column (?:on|of)\b|has no column\b|is not one of the record's own columns/ },
  { code: 'not-a-reference', pattern: /has no reference called|is not a reference from|is a column, but not a foreign key/ },
  {
    code: 'unknown-view',
    pattern: /(?:names|opens|embeds) the view "[^"]+", which|which this App does not declare|is not one of this App's (?:list )?views/,
  },
  { code: 'unknown-action', pattern: /is not an action of|which resources\.[^.]+\.actions does not declare/ },
  { code: 'unknown-resource', pattern: /no resource "|no table "|names connection "[^"]+", which/ },
  { code: 'computed-column', pattern: /, computed "[^"]+"|which is computed:/ },
  {
    code: 'query-grammar',
    pattern:
      /\(at character \d+|is never true; say "is empty"|is not something to group by|needs exactly one "last N|has no dates to compare/,
  },
  {
    code: 'not-a-date',
    pattern: /so the time window cannot narrow by it|a timeline orders by a date column|a span runs between date columns/,
  },
  { code: 'needs-auth', pattern: /it needs "auth"/ },
  { code: 'authority-lock', pattern: /effective authority differs from the lock|authority\.lock/ },
  { code: 'env-not-passed', pattern: /which mistri\.json does not pass to it/ },
  { code: 'route-clash', pattern: /address(?:es)? (?:another App holds|is taken|collides)|already answers to/ },
  { code: 'money-minor', pattern: /minor units|the currency column "/ },
  { code: 'form-lines', pattern: /\bform\.lines\b/ },
  { code: 'form-live', pattern: /\bform\.live\b/ },
];

/** A code a sentence carries itself, `[outside-ceiling]`, or the one its words name. */
export function validationCode(message: string): string {
  const bracketed = /\[([a-z][a-z0-9-]+)\]/.exec(message)?.[1];
  if (bracketed) return bracketed;
  return VALIDATION_CODES.find((entry) => entry.pattern.test(message))?.code ?? 'invalid-app';
}

/** A component lint's finding, by the rule its words say. */
export function componentCode(message: string): string {
  const bracketed = /\[([a-z][a-z0-9-]+)\]/.exec(message)?.[1];
  if (bracketed) return bracketed;
  if (/markup|srcdoc/.test(message)) return 'component-markup';
  if (/runs text as code|runs its text as code|runs it as code/.test(message)) return 'component-code-from-text';
  if (/server environment/.test(message)) return 'component-environment';
  if (/is not a token the looks define/.test(message)) return 'component-token';
  if (/literal color/.test(message)) return 'component-color';
  if (/literal radius/.test(message)) return 'component-radius';
  if (/motion|transition|animation/.test(message)) return 'component-motion';
  if (/shadow/.test(message)) return 'component-shadow';
  if (/is not this component's/.test(message)) return 'component-class';
  if (/ruler/.test(message)) return 'component-ruler';
  return 'component';
}

/* ---------- the DSL path, from a sentence ---------- */

/**
 * The definition path a validation sentence names, as far as its words say:
 * `view "tasks": … named in this view's filters` → `views.tasks.filters`,
 * `resources "task", action "close", when: …` → `resources.task.actions.close.when`.
 * Pages are named by their label in sentences; `pageIds` turns one back into its key.
 */
export function pathOfMessage(message: string, pageIds: ReadonlyMap<string, string> = new Map()): string | undefined {
  const steps: string[] = [];
  let rest = message;
  const take = (pattern: RegExp, to: (match: RegExpExecArray) => string | undefined) => {
    const match = pattern.exec(rest);
    if (!match) return false;
    const said = to(match);
    if (said !== undefined) steps.push(said);
    rest = rest.slice(match[0].length).replace(/^(?:, |: | )/, '');
    return true;
  };
  const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
  for (let guard = 0; guard < 12 && rest; guard++) {
    const moved =
      take(/^features "([^"]+)"/, (m) => `features.${key(m[1])}`) ||
      take(/^views? "([^"]+)"/, (m) => `views.${key(m[1])}`) ||
      take(/^resources "([^"]+)"/, (m) => `resources.${key(m[1])}`) ||
      take(/^page "([^"]+)"/, (m) => `pages.${key(pageIds.get(m[1]) ?? m[1])}`) ||
      take(/^action "([^"]+)"/, (m) => `actions.${key(m[1])}`) ||
      take(/^computed "([^"]+)"/, (m) => `computed.${key(m[1])}`) ||
      take(/^rollups "([^"]+)"/, (m) => `rollups.${key(m[1])}`) ||
      take(/^display "([^"]+)"/, (m) => `display.${key(m[1])}`) ||
      take(/^"auth", role "([^"]+)"/, (m) => `auth.roles.${key(m[1])}`) ||
      take(/^role "([^"]+)"/, (m) => `auth.roles.${key(m[1])}`) ||
      take(/^nav entry (\d+)(?: \([^)]*\))?/, (m) =>
        steps.some((step) => step.startsWith('nav[')) ? `children[${Number(m[1]) - 1}]` : `nav[${Number(m[1]) - 1}]`,
      ) ||
      take(/^"home", rule (\d+)/, (m) => `home[${Number(m[1]) - 1}]`) ||
      take(/^section (\d+)/, (m) => `sections[${Number(m[1]) - 1}]`) ||
      take(
        /^"(fields|form|actions|computed|rollups|display|labels|search|import|notify|transitions|recordLabel|page|view)"(?=[,:. ]|$)/,
        (m) => m[1],
      ) ||
      take(/^"([a-z_][\w]*)"(?=, (?:read|write)\b)/, (m) => key(m[1])) ||
      take(/^(read|write|show|when|query|sort|filters|tabs)\b(?=[,:" ]|$)/, (m) => m[1]);
    if (!moved) break;
  }
  /* "named in this view's filters", "This view's show cannot be resolved": the key the sentence is about. */
  const named = /(?:named in this|\bThis) view's (show|filters|tabs|sort|query|search|columns|edit|group|order)\b/.exec(message)?.[1];
  if (named && steps[0]?.startsWith('views.') && !steps.includes(named)) steps.push(named);
  return steps.length
    ? steps
        .join('.')
        .replace(/\.\[/g, '[')
        .replace(/\.(\[\d+\])/g, '$1')
    : undefined;
}

/* ---------- the DSL path, from a place in a file ---------- */

type Sync = typeof import('typescript/unstable/sync');
type Ast = typeof import('typescript/unstable/ast');
type Node = import('typescript/unstable/ast').Node;
interface Compiler {
  api: InstanceType<Sync['API']>;
  ast: Ast;
}
let loaded: Compiler | null | undefined;

/* TypeScript 7 has no `createSourceFile`: its parser lives in the native compiler, which an API client reaches over a
   pipe. `typescript/unstable/sync` is that client (its name says what to expect of it across minor versions, which is
   why the one use here is a fixed, small walk and a failure means no path, never a failed check). Resolved from the
   App's project only, as the typecheck step finds it. One compiler process serves every lookup of
   a run; it holds no event-loop handle, so the CLI still exits when its work is done. */
async function typescript(appDir: string): Promise<Compiler | undefined> {
  if (loaded !== undefined) return loaded ?? undefined;
  try {
    const require = createRequire(`${appDir}/package.json`);
    const [sync, ast] = await Promise.all([
      import(pathToFileURL(require.resolve('typescript/unstable/sync')).href) as Promise<Sync>,
      import(pathToFileURL(require.resolve('typescript/unstable/ast')).href) as Promise<Ast>,
    ]);
    loaded = { api: new sync.API({ cwd: appDir }), ast };
    return loaded;
  } catch {
    // Not installed in the App's project, or too old to have the API.
  }
  loaded = null;
  return undefined;
}

/** A syntax tree of one file, parsed with nothing resolved: the file alone, no libraries, no imports. */
function parseOne(compiler: Compiler, file: string): import('typescript/unstable/ast').SourceFile | undefined {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-path-'));
  try {
    const config = join(directory, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, target: 'esnext' },
        files: [resolve(file)],
      }),
    );
    const project = compiler.api.updateSnapshot({ openProject: config }).getProject(config);
    return project?.program.getSourceFile(resolve(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The definition path at a line and column of an authored module: each
 * property the position sits inside, from the outermost object a definition
 * starts at (`defineApp(…)`, `defineFeature(…)`, a `satisfies` or an export),
 * with array indexes — `views.tasks.filters[0]`. A helper's call (`page(…)`,
 * `header({ … })`) is walked through, so a page's section reads
 * `pages.order[2].primary`: its sections are the helper's third argument.
 */
export async function pathAt(file: string, line: number, column: number, appDir: string): Promise<string | undefined> {
  const compiler = await typescript(appDir);
  if (!compiler) return undefined;
  const { ast } = compiler;
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let source;
  try {
    source = parseOne(compiler, file);
  } catch {
    return undefined;
  }
  if (!source) return undefined;
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const position = source.getPositionOfLineAndCharacter(line - 1, Math.max(0, column - 1));
  let node: Node | undefined;
  const find = (at: Node) => {
    if (position < at.getStart(source) || position >= at.getEnd()) return;
    node = at;
    at.forEachChild(find);
  };
  find(source);
  const steps: string[] = [];
  for (let at = node; at && !ast.isSourceFile(at); at = at.parent) {
    const parent = at.parent;
    if (ast.isPropertyAssignment(at) || ast.isShorthandPropertyAssignment(at)) {
      const name = at.name;
      const said = ast.isIdentifier(name) || ast.isStringLiteral(name) || ast.isNumericLiteral(name) ? name.text : undefined;
      if (said === undefined) return undefined;
      steps.unshift(/^[A-Za-z_$][\w$]*$/.test(said) ? said : JSON.stringify(said));
    } else if (parent && ast.isArrayLiteralExpression(parent)) {
      steps.unshift(`[${parent.elements.indexOf(at as import('typescript/unstable/ast').Expression)}]`);
    }
    if (ast.isCallExpression(at) && ast.isIdentifier(at.expression) && /^define(App|Feature)$/.test(at.expression.text)) break;
    if (ast.isVariableDeclaration(at) || ast.isExportAssignment(at)) break;
  }
  const path = steps.join('.').replace(/\.\[/g, '[');
  return path || undefined;
}

/**
 * The quoted words a finding names as the thing that is wrong: its suggestions
 * ("Did you mean "due_on"?", "Its actions: "done"") are left out, since they
 * name what is right, and are written elsewhere in the App.
 */
function wordsOf(message: string): string[] {
  const said = message.replace(/Did you mean[^)]*/g, '').replace(/\bIts [\w ]+: [^)]*/g, '');
  return [...new Set([...said.matchAll(/"([^"]{2,80})"/g)].map((match) => match[1]))];
}

/**
 * The line of an authored module a definition path was written on — the
 * inverse of `pathAt`. The path is walked from the object a definition starts
 * at (`defineApp(…)`, or the module's default export), through a helper's call
 * (`listView('Tasks', 'task', { … })`, `page('task', [ … ])`) to its object or
 * its array; inside what it reaches, the one line whose strings hold the
 * finding's words is the place, else the line of the path's own key. A path
 * that leaves the module — a value imported from another — is no place here.
 */
export async function placeOf(
  files: readonly string[],
  path: string,
  message: string,
  appDir: string,
): Promise<{ file: string; line: number } | undefined> {
  const steps = [...path.matchAll(/([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)"|\[(\d+)\]/g)].map((match) =>
    match[3] !== undefined ? Number(match[3]) : (match[1] ?? JSON.parse(`"${match[2]}"`)),
  );
  if (!steps.length) return undefined;
  const compiler = await typescript(appDir);
  if (!compiler) return undefined;
  const { ast } = compiler;
  const bare = (node: Node): Node => {
    let at = node;
    while (ast.isParenthesizedExpression(at) || ast.isSatisfiesExpression(at) || ast.isAsExpression(at)) at = at.expression;
    return at;
  };
  const words = wordsOf(message);
  /* A module parsed once per lookup: following an import may come back to one. */
  const parsed = new Map<string, ReturnType<typeof parseOne>>();
  const parse = (file: string) => {
    if (!parsed.has(file)) parsed.set(file, parseOne(compiler, file));
    return parsed.get(file);
  };
  type Source = NonNullable<ReturnType<typeof parseOne>>;
  type At = { node: Node; source: Source; file: string };
  /* A name a definition is written under rather than in place — `resources,` in defineApp's object, with
     `export const resources = { … }` in ./resources.ts — is followed to its value: a module-level const of the
     same module, or the one a relative import names. A name from a package, or written any other way, is no
     place here, and the text search below says the rest. */
  const follow = (name: string, from: At, hops = 0): At | undefined => {
    if (hops > 8) return undefined;
    for (const statement of from.source.statements) {
      if (ast.isVariableStatement(statement)) {
        const declared = statement.declarationList.declarations.find(
          (declaration) => ast.isIdentifier(declaration.name) && declaration.name.text === name,
        );
        if (declared?.initializer) {
          const value = bare(declared.initializer);
          return ast.isIdentifier(value) && value.text !== name
            ? follow(value.text, { ...from, node: value }, hops + 1)
            : { node: value, source: from.source, file: from.file };
        }
      }
      if (!ast.isImportDeclaration(statement) || !ast.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ast.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((each) => each.name.text === name);
      if (!element) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) return undefined;
      const target = moduleFile(resolve(dirname(from.file), specifier));
      const source = target && parse(target);
      if (!target || !source) return undefined;
      const exported = element.propertyName && ast.isIdentifier(element.propertyName) ? element.propertyName.text : name;
      return follow(exported, { node: source, source, file: target }, hops + 1);
    }
    return undefined;
  };
  for (const entry of files) {
    let source: Source | undefined;
    try {
      source = parse(entry);
    } catch {
      return undefined;
    }
    if (!source) continue;
    const top: Source = source;
    /* Where the definition starts: defineApp's object, or the default export's. */
    let root: Node | undefined;
    const seek = (at: Node) => {
      if (root) return;
      if (ast.isCallExpression(at) && ast.isIdentifier(at.expression) && at.expression.text === 'defineApp' && at.arguments[0]) {
        root = bare(at.arguments[0]);
        return;
      }
      if (ast.isExportAssignment(at) && ast.isObjectLiteralExpression(bare(at.expression))) root = bare(at.expression);
      at.forEachChild(seek);
    };
    seek(top);
    if (!root) continue;
    /* `keyed` is the property that holds the value reached: its line is the key's, in the module it is written in. */
    let value: At = { node: root, source: top, file: entry };
    let keyed: At = value;
    let reached = true;
    try {
      for (const step of steps) {
        let at = bare(value.node);
        if (ast.isIdentifier(at)) {
          const found = follow(at.text, value);
          if (!found) return undefined;
          value = found;
          at = bare(found.node);
        }
        if (ast.isCallExpression(at)) {
          const args = at.arguments.map((arg) => bare(arg));
          at =
            typeof step === 'number' || !args.some((arg) => ast.isObjectLiteralExpression(arg))
              ? (args.find((arg) => ast.isArrayLiteralExpression(arg)) ?? at)
              : args.findLast((arg) => ast.isObjectLiteralExpression(arg))!;
          /* A page's sections are its helper's array: `pages.order.sections[2]` is `page('order', [ … ])[2]`. */
          if (step === 'sections' && ast.isArrayLiteralExpression(at)) {
            value = { ...value, node: at };
            continue;
          }
        }
        let next: Node | undefined;
        if (typeof step === 'number' && ast.isArrayLiteralExpression(at)) next = at.elements[step];
        else if (typeof step === 'string' && ast.isObjectLiteralExpression(at)) {
          const property = at.properties.find((entry) => {
            const name = ast.isSpreadAssignment(entry) ? undefined : entry.name;
            return name && (ast.isIdentifier(name) || ast.isStringLiteral(name)) && name.text === step;
          });
          if (property && ast.isPropertyAssignment(property)) {
            keyed = { ...value, node: property };
            next = property.initializer;
          } else if (property && ast.isShorthandPropertyAssignment(property)) {
            keyed = { ...value, node: property };
            const found = ast.isIdentifier(property.name) ? follow(property.name.text, value) : undefined;
            if (!found) return undefined;
            value = found;
            continue;
          } else if (property) {
            /* A method: its value is computed, not written. */
            return undefined;
          }
        } else if (ast.isPropertyAccessExpression(at)) {
          /* A member of something else: the text search knows more than this walk. */
          return undefined;
        }
        if (!next) {
          reached = false;
          break;
        }
        value = { ...value, node: next };
      }
    } catch {
      return undefined;
    }
    /* Inside what the path reached, the strings that hold the finding's words; one line is the place. */
    const lines = new Map<number, number>();
    const patterns = words.map((word) => new RegExp(`(?<![\\w.])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`));
    const within = value.source;
    const look = (at: Node) => {
      if (ast.isStringLiteral(at) || ast.isNoSubstitutionTemplateLiteral(at)) {
        const score = patterns.filter((pattern) => pattern.test(at.text)).length;
        if (score) {
          const line = within.getLineAndCharacterOfPosition(at.getStart(within)).line + 1;
          lines.set(line, Math.max(lines.get(line) ?? 0, score));
        }
      }
      at.forEachChild(look);
    };
    if (reached || keyed.node !== root) look(value.node);
    const best = Math.max(0, ...lines.values());
    const top1 = [...lines].filter(([, score]) => score === best && best > 0);
    if (top1.length === 1) return { file: value.file, line: top1[0][0] };
    if (keyed.node === root) return undefined;
    return { file: keyed.file, line: keyed.source.getLineAndCharacterOfPosition(keyed.node.getStart(keyed.source)).line + 1 };
  }
  return undefined;
}

/* The file a relative import names: as written, or the TypeScript source a `.js` specifier stands for, or an
   extensionless one's module or index. */
function moduleFile(path: string): string | undefined {
  const candidates = [
    path,
    ...(/\.(m?)js$/.test(path) ? [path.replace(/\.(m?)js$/, '.$1ts')] : []),
    ...(/\.(m?[tj]s)$/.test(path) ? [] : ['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'].map((ext) => path + ext)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** A file as the check names it: from where the command ran, unless that climbs out of it. */
export const near = (path: string): string => {
  const said = relative(process.cwd(), path);
  return !said ? '.' : said.startsWith('..') ? path : said;
};

/* The modules that author the App: its manifest and the other modules at the root of its directory, its
   pages/ and features/, and every module those import. A test or a seed script kept beside them names the same
   tables, actions and words, and a finding placed there sends the author to a file the App never reads. Where
   the check knows the modules it loaded (`roots`: the manifest and its server entries), the walk starts from
   those instead of every module at the root, so a backup copy kept there (app-old.ts) is no place either. */
const SPEC = /\.(?:test|spec)\.m?[tj]s$/;
const IMPORTED = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
export function authored(dir: string, files: Array<{ path: string; lines: string[] }>, roots?: readonly string[]): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const rooted = roots?.map((root) => resolve(root)).filter((root) => byPath.has(root));
  const queue = files
    .filter((file) => {
      if (SPEC.test(file.path)) return false;
      const parts = relative(dir, file.path).split(/[\\/]/);
      if (parts[0] === 'pages' || parts[0] === 'features') return true;
      return rooted?.length ? rooted.includes(file.path) : parts.length === 1;
    })
    .map((file) => file.path);
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const match of byPath.get(path)!.lines.join('\n').matchAll(IMPORTED)) {
      const target = moduleFile(resolve(dirname(path), match[2]));
      if (target && byPath.has(target) && !seen.has(target)) queue.push(target);
    }
  }
  /* An App none of whose modules could be told apart keeps them all: a place found by its words beats none. */
  if (!seen.size) return;
  for (let i = files.length - 1; i >= 0; i--) if (!seen.has(files[i].path)) files.splice(i, 1);
}

/**
 * Where in the App's own files a validation finding's text was written.
 *
 * mistri check judges the loaded App, which no longer knows its source lines,
 * and a query, a sort or a `when` is a string tsc cannot parse. So the
 * finding's own words are looked for where they were typed: the first
 * quoted word it names ("orderd_on", "resolvd") inside a string literal of
 * an authored module. Said only when exactly one line holds it — a word on
 * two lines is not a place, and naming the wrong one is worse than none.
 */
export async function sourceLocator(
  dir: string,
  /** The modules the check loaded — the manifest, the commands, jobs and policy modules — where it knows them. */
  roots?: readonly string[],
): Promise<{
  files: string[];
  say: (line: string) => string;
  at: (line: string) => { file: string; line: number } | undefined;
  /** The line of the last quoted word the finding names that is written on one line only: the value a refusal
      quotes comes after the keys that lead to it (`views "tasks" has a "kind" of "lisst"`), and is the rarer word. */
  last: (line: string) => { file: string; line: number } | undefined;
}> {
  const files: Array<{ path: string; lines: string[] }> = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    /* Modules only: a JSON file beside them is configuration or a saved report (a `check --json` kept as
       check.json repeats every finding's words), never where the App says a thing. */
    if (!entry.isFile() || !/\.(m?ts|mjs|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.split(/[\\/]/).some((part) => part === 'node_modules' || part === 'dist')) continue;
    files.push({ path, lines: (await readFile(path, 'utf8')).split('\n') });
  }
  authored(dir, files, roots);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* The word inside a string literal on one line: where an author typed it, not where code names it. */
  const quoted = (word: string) => new RegExp(`(['"\`])[^'"\`\\n]*(?<![\\w.])${escape(word)}(?![\\w])[^'"\`\\n]*\\1`);
  /* A command is written where it is defined (`export const handOver = defineCommand({`, or a key of
     defineCommands), never where a page or a dashboard names it as a string: a finding about one is placed there. */
  const definedCommand = (name: string): { file: string; line: number } | undefined => {
    const written = new RegExp(
      `(?:(?<![\\w.$])['"]?${escape(name)}['"]?\\s*[:=]\\s*defineCommand\\b|defineCommand\\s*\\(\\s*['"]${escape(name)}['"])`,
    );
    const found = files.flatMap((file) =>
      file.lines.flatMap((text, i) => (written.test(text) ? [{ file: near(file.path), line: i + 1 }] : [])),
    );
    return found.length === 1 ? found[0] : undefined;
  };
  const declaredRole = (name: string): { file: string; line: number } | undefined => {
    const key = new RegExp(`^\\s*['"]?${escape(name)}['"]?\\s*:`);
    const found: Array<{ file: string; line: number }> = [];
    for (const file of files) {
      file.lines.forEach((text, i) => {
        if (!/\broles\s*[:=]\s*(?:\w+\s*\()?\{/.test(text)) return;
        const indent = text.length - text.trimStart().length;
        for (let j = i + 1; j < file.lines.length; j++) {
          const next = file.lines[j];
          if (!next.trim()) continue;
          if (next.length - next.trimStart().length <= indent) break;
          if (key.test(next)) found.push({ file: near(file.path), line: j + 1 });
        }
      });
    }
    return found.length === 1 ? found[0] : undefined;
  };
  const at = (line: string): { file: string; line: number } | undefined => {
    const command = /^(?:[^\s:]+\.(?:m?ts|mjs|js|json): )?(?:warning: )?[Cc]ommand "([A-Za-z_$][\w$]*)"/.exec(line);
    if (command) {
      const defined = definedCommand(command[1]);
      if (defined) return defined;
    }
    /* A role is written as a key of the roles declaration, never where a job or a policy names it as a string
       (`runAs: 'integration'`): a finding about one is placed at that key, or nowhere. */
    const role = /^(?:[^\s:]+\.(?:m?ts|mjs|js|json): )?(?:warning: )?(?:"auth", )?[Rr]ole "([^"]+)"/.exec(line);
    if (role) return declaredRole(role[1]);
    const words = wordsOf(line);
    /* A line that names a file, or already says where (policy.ts:2), is
       located: its words matched a tsconfig's paths, and sent the author there. */
    if (!words.length || words.some((word) => /\.(m?[tj]s|json)$/.test(word)) || /\.(m?[tj]s|json):\d+/.test(line)) return undefined;
    const patterns = words.map(quoted);
    /* The line that holds the most of the finding's words: a tab's label and
       its query sit together, while the view's key alone is also in the nav. */
    let best = 0;
    let found: Array<{ file: string; line: number }> = [];
    for (const file of files) {
      file.lines.forEach((text, i) => {
        const score = patterns.filter((pattern) => pattern.test(text)).length;
        if (!score || score < best) return;
        if (score > best) {
          best = score;
          found = [];
        }
        found.push({ file: near(file.path), line: i + 1 });
      });
    }
    return found.length === 1 ? found[0] : undefined;
  };
  const last = (line: string): { file: string; line: number } | undefined => {
    for (const word of wordsOf(line).reverse()) {
      if (/\.(m?[tj]s|json)$/.test(word)) continue;
      const pattern = quoted(word);
      const found = files.flatMap((file) =>
        file.lines.flatMap((text, i) => (pattern.test(text) ? [{ file: near(file.path), line: i + 1 }] : [])),
      );
      if (found.length === 1) return found[0];
    }
    return undefined;
  };
  return {
    /* The modules that could start the definition: only these are parsed. */
    files: files.filter((file) => file.lines.some((text) => /\bdefineApp\s*\(|^export default\b/.test(text))).map((file) => file.path),
    at,
    last,
    say: (line) => {
      const place = at(line);
      return place ? `${place.file}:${place.line}  ${line}` : line;
    },
  };
}
