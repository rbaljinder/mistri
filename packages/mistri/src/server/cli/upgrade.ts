/**
 * `mistri upgrade`: an App's source brought to the names this mistri reads.
 *
 * The import of the package's old name becomes `@mistriwork/mistri/*`, and the keys and names the CHANGELOG renamed
 * are rewritten where they read the same wherever they stand (upgradeRenames.ts, the one table), as are the looks'
 * renamed tokens in sources and stylesheets. A rename is a text
 * edit at a token the file's own words place: this reads source as tokens, skipping strings, comments and templates,
 * and never as a parse, so it needs no TypeScript installed and cannot be fooled by a name inside a string. What it
 * cannot place with certainty it does not touch: it names the file and line and exits 1, for a person to change.
 *
 * A key is renamed only where what stands around it says which word it is (upgradeRenames.ts `Guards`): the object a
 * call is given, an object that declares its `kind`, the key an object is the value of, and for a kit component's
 * prop the `<Name …>` it is written on, where `Name` is imported from the kit under whatever local name. A spread, a
 * variable or an App module's re-export can hide the word, so those are refused with the file and line.
 *
 * `--check` writes nothing and exits 1 when a run would change a file or refuse something, for CI. A second run
 * finds nothing to change (the rewrites never produce their own input), and the refusals stay until they are fixed.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { dependencyDeclarations } from './upgradeDependencies.js';
import {
  GENERIC_TOKENS,
  KEYS,
  KIT_MODULES,
  NAMES,
  REFUSED,
  THIRD_PARTY_SELECTOR,
  TOKENS,
  VALUES,
  renamedModule,
  type Guards,
} from './upgradeRenames.js';

const UPGRADE_USAGE = 'mistri upgrade [--app <dir>] [--check]';

interface Token {
  kind: 'id' | 'string' | 'punct' | 'number';
  /** An identifier or punctuation as written; a string's contents without its quotes. */
  text: string;
  start: number;
  end: number;
  line: number;
}

/* After one of these a `/` starts a regular expression; after anything else it divides. */
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** The file as tokens, with strings, comments, templates and regular expressions read whole so what is in them is never a name. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  /* A `${` inside a template opens a code run that the matching `}` hands back to the template. */
  const templates: number[] = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  const readTemplate = () => {
    while (i < source.length) {
      const c = source[i]!;
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        return;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        templates.push(depth++);
        return;
      } else {
        if (c === '\n') line++;
        i++;
      }
    }
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '/' && source[i + 1] === '/') while (i < source.length && source[i] !== '\n') i++;
    else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : close + 2;
      line += source.slice(i, end).split('\n').length - 1;
      i = end;
    } else if (c === '"' || c === "'") {
      const start = i++;
      while (i < source.length && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      tokens.push({ kind: 'string', text: source.slice(start + 1, i), start: start + 1, end: i, line });
      i++;
    } else if (c === '`') {
      i++;
      readTemplate();
    } else if (c === '}' && templates.length && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth--;
      i++;
      readTemplate();
    } else if (
      c === '/' &&
      (!tokens.length || (tokens.at(-1)!.kind === 'punct' && BEFORE_REGEX.has(tokens.at(-1)!.text)) || tokens.at(-1)!.text === 'return') &&
      /* `/>` ends a tag and `</` opens a closing one: after a `}` or a `<` neither is a regular expression. */
      source[i + 1] !== '>' &&
      !(tokens.at(-1)?.text === '<' && tokens.at(-1)!.end === i)
    ) {
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n' && (source[i] !== '/' || inClass)) {
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i += source[i] === '\\' ? 2 : 1;
      }
      i++;
      while (/[a-z]/.test(source[i] ?? '')) i++;
      tokens.push({ kind: 'number', text: '/regex/', start: i, end: i, line });
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (/[\w$]/.test(source[i] ?? '')) i++;
      tokens.push({ kind: 'id', text: source.slice(start, i), start, end: i, line });
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (/[\w.]/.test(source[i] ?? '')) i++;
      tokens.push({ kind: 'number', text: source.slice(start, i), start, end: i, line });
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      tokens.push({ kind: 'punct', text: c, start: i, end: i + 1, line });
      i++;
    }
  }
  return tokens;
}

interface Upgraded {
  text: string;
  /** What was rewritten, one line each, for the report. */
  changes: Array<{ line: number; said: string }>;
  refusals: Array<{ line: number; said: string }>;
  /** The modules the file imports, as it says them once rewritten: which stylesheets an App module reads. */
  modules: string[];
}

/** What one file's upgrade needs to know beyond its own text. */
interface UpgradeContext {
  /** The custom properties the App's own files set. */
  declared?: ReadonlySet<string>;
  /** The package among the App's own dependencies whose stylesheets declare this property, if one does. */
  declaredBy?: (token: string) => string | undefined;
  /** A source that is not .ts or .tsx (a .js, .mjs) is not one a generic token is rewritten in. */
  typescript?: boolean;
  /** A stylesheet only: mistri's theme or styles, which an App module that imports mistri reads. */
  owned?: boolean;
}

/**
 * The enclosing selectors of the text at `at`, innermost first: what stands before each `{` that is still open. In a
 * source file this reads object braces the same way and finds nothing that looks like a class.
 */
function enclosingSelectors(source: string, at: number): string[] {
  const found: string[] = [];
  let i = at - 1;
  while (i >= 0 && found.length < 8) {
    let depth = 0;
    while (i >= 0) {
      const c = source[i]!;
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) break;
        depth--;
      }
      i--;
    }
    if (i < 0) break;
    let start = i - 1;
    while (start >= 0 && !';{}'.includes(source[start]!)) start--;
    found.push(source.slice(start + 1, i));
    i = start;
  }
  return found;
}

/**
 * The looks' tokens renamed before 1.0, where a source or stylesheet reads one: `var(--text)` and `useToken('--text')`.
 * Neither is ever code, so this reads the text whole.
 *
 * A name unique to mistri (`--text-dim`) is rewritten wherever it is read, unless the App declares it itself. A generic
 * one (`--border`, `--text`, `--bg`: GENERIC_TOKENS) is common in a third party's CSS, so it is rewritten only where
 * nothing else could have set it: in a file mistri owns (`foreign` says why not), that no stylesheet the App declares or
 * depends on sets the property in, and that is not read inside a selector aimed at a library's class. Otherwise it is
 * refused with the line, the token and who else declares it.
 */
function upgradeTokens(source: string, context: UpgradeContext = {}, foreign?: string): Upgraded {
  const declared = context.declared ?? new Set<string>();
  const changes: Upgraded['changes'] = [];
  const refusals: Upgraded['refusals'] = [];
  const text = source.replace(
    /(var\(\s*|useToken\(\s*['"`])(--[A-Za-z][\w-]*)(?![\w-])/g,
    (whole, lead: string, name: string, at: number) => {
      const to = Object.hasOwn(TOKENS, name) ? TOKENS[name]! : undefined;
      if (!to) return whole;
      const line = source.slice(0, at).split('\n').length;
      const refuse = (said: string) => {
        refusals.push({ line, said });
        return whole;
      };
      if (declared.has(name)) {
        return refuse(`${name} is the App's own property here as well as a token renamed ${to}; which one this reads takes a reader`);
      }
      if (GENERIC_TOKENS.has(name)) {
        const package_ = context.declaredBy?.(name);
        if (package_)
          return refuse(
            `${name} is a token renamed ${to}, and the stylesheets of ${package_}, a dependency of the App, declare ${name} too; which one this reads takes a reader`,
          );
        const library = enclosingSelectors(source, at).find((selector) => THIRD_PARTY_SELECTOR.test(selector));
        if (library)
          return refuse(
            `${name} is a token renamed ${to}, read inside a selector for a third-party class (${library.trim().split(/\s+/).join(' ')}); whose property it is takes a reader`,
          );
        if (foreign) return refuse(`${name} is a token renamed ${to}; this file ${foreign}, so the property may be another library's`);
      }
      changes.push({ line, said: `${name} -> ${to}` });
      return lead + to;
    },
  );
  return { text, changes, refusals, modules: [] };
}

/** A stylesheet's tokens upgraded; `context.owned` says it is one mistri reads (an App's theme or styles an App module imports). */
function upgradeStylesheet(source: string, context: UpgradeContext = {}): Upgraded {
  return upgradeTokens(
    source,
    context,
    context.owned ? undefined : "is not a stylesheet under the App's theme or styles that an App module imports",
  );
}

/** One bracket of the source and what it is the value or argument of. */
interface Frame {
  open: '(' | '[' | '{';
  /** The key this brace or bracket is the value of; `key[]` for an item of the array a key holds. */
  key: string | null;
  /** The call this brace is an argument of: `definePage({ … })`, `metric(title, from, { … })`; for a paren, the function it calls. */
  call: string | null;
  /** The token that opened it. */
  at: number;
  /** What `kind: '…'` the object declares itself, once asked for. */
  kind?: string | null;
}

const OPENERS: Readonly<Record<string, Frame['open']>> = { '(': '(', '[': '[', '{': '{' };
const CLOSERS: Readonly<Record<string, Frame['open']>> = { ')': '(', ']': '[', '}': '{' };

/** The local name of each import, to the module it is from (`import { Rows as Table } from '…'` is `Table`). */
function importedNames(tokens: readonly Token[]): Map<string, string> {
  const names = new Map<string, string>();
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t]!.kind !== 'id' || tokens[t]!.text !== 'import' || tokens[t - 1]?.text === '.') continue;
    const locals: string[] = [];
    let segment: string[] = [];
    let braces = false;
    let j = t + 1;
    for (; j < tokens.length && j < t + 400; j++) {
      const token = tokens[j]!;
      if (token.kind === 'punct' && ';(='.includes(token.text) && token.text !== '=') break;
      if (token.kind === 'id' && token.text === 'from' && !braces && tokens[j + 1]?.kind === 'string') break;
      if (token.kind === 'punct' && (token.text === '{' || token.text === '}' || token.text === ',')) {
        braces = token.text === '{' ? true : token.text === '}' ? false : braces;
        if (segment.length) locals.push(segment.at(-1)!);
        segment = [];
      } else if (token.kind === 'id') segment.push(token.text);
    }
    const module = tokens[j + 1];
    if (tokens[j]?.text !== 'from' || module?.kind !== 'string') continue;
    if (segment.length) locals.push(segment.at(-1)!);
    for (const local of locals) names.set(local, renamedModule(module.text) ?? module.text);
  }
  return names;
}

/** A module specifier the App's own code stands behind rather than a package. */
const isOwnModule = (specifier: string) => /^(?:\.|\/|#|~\/|@\/)/.test(specifier);
const isKitModule = (specifier: string) => KIT_MODULES.some((kit) => specifier === kit || specifier.startsWith(`${kit}/`));

/** One file's source brought up to date. Pure: the same source in, the same answer out. */
export function upgradeSource(source: string, context: UpgradeContext = {}): Upgraded {
  const tokens = tokenize(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const changes: Upgraded['changes'] = [];
  const refusals: Upgraded['refusals'] = [];
  const modules: string[] = [];
  const is = (index: number, text: string) => tokens[index]?.text === text && tokens[index]!.kind !== 'string';
  const imports = importedNames(tokens);
  const componentRows = KEYS.filter((each) => each.component);
  /* The calls a row names an object of: what is spread or computed into one of them can carry a renamed key unseen. */
  const guardedCalls = new Set(
    [...KEYS, ...REFUSED.flatMap((each) => (each.context ? [each.context] : []))].flatMap((each: Guards) =>
      [each.call, each.parent?.call].filter((call): call is string => call !== undefined),
    ),
  );
  /** The `}` that closes the `{` at `j`. */
  const closeOf = (j: number): number => {
    for (let depth = 0; j < tokens.length; j++) {
      if (is(j, '{')) depth++;
      else if (is(j, '}') && --depth === 0) break;
    }
    return j;
  };

  /* What each open bracket is the value or argument of, so `recipes: { head }` is told from a list's `head`. */
  const frames: Frame[] = [];

  /** The `kind: '…'` an object says of itself at its own level, if it does. */
  const kindOf = (frame: Frame): string | null => {
    if (frame.kind !== undefined) return frame.kind;
    frame.kind = null;
    for (let j = frame.at + 1, depth = 0; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (token.kind === 'punct' && token.text in OPENERS) depth++;
      else if (token.kind === 'punct' && token.text in CLOSERS) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && token.text === 'kind' && token.kind !== 'number' && is(j + 1, ':') && (is(j - 1, '{') || is(j - 1, ','))) {
        if (tokens[j + 2]?.kind === 'string') frame.kind = tokens[j + 2]!.text;
        break;
      }
    }
    return frame.kind;
  };

  /** Whether the object `frame` (inside `parent`) stands where `guards` say. */
  const holds = (guards: Guards, frame: Frame, parent: Frame | undefined): boolean => {
    if (guards.inside !== undefined && !(typeof guards.inside === 'string' ? [guards.inside] : guards.inside).includes(frame.key ?? ''))
      return false;
    if (guards.call !== undefined && frame.call !== guards.call) return false;
    if (guards.kind !== undefined && kindOf(frame) !== guards.kind) return false;
    if (guards.parent) {
      if (parent?.open !== '{') return false;
      if (guards.parent.call !== undefined && parent.call !== guards.parent.call) return false;
      if (guards.parent.kind !== undefined && kindOf(parent) !== guards.parent.kind) return false;
    }
    return true;
  };
  const guarded = (guards: Guards) =>
    guards.inside !== undefined || guards.call !== undefined || guards.kind !== undefined || guards.parent !== undefined;

  /** The first spread or computed key at an object's own level: a place a renamed word can be written without being seen. */
  const opaqueMember = (frame: Frame): Token | undefined => {
    for (let j = frame.at + 1, depth = 0; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (token.kind === 'punct' && token.text in CLOSERS && depth-- === 0) break;
      if (token.kind === 'punct' && token.text in OPENERS) {
        if (depth === 0 && token.text === '[' && (is(j - 1, '{') || is(j - 1, ','))) return token;
        depth++;
      } else if (depth === 0 && token.text === '.' && is(j + 1, '.') && is(j + 2, '.')) return token;
    }
    return undefined;
  };

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.kind === 'punct' && token.text in OPENERS) {
      const open = OPENERS[token.text]!;
      const parent = frames.at(-1);
      const before = tokens[t - 1];
      let key: string | null = null;
      let call: string | null = null;
      if (open === '(') call = before?.kind === 'id' ? before.text : null;
      else {
        if (before?.text === ':' && tokens[t - 2] && tokens[t - 2]!.kind !== 'punct') key = tokens[t - 2]!.text;
        else if (parent?.open === '[' && (before?.text === '[' || before?.text === ',') && parent.key !== null) key = `${parent.key}[]`;
        if (open === '{' && parent?.open === '(' && (before?.text === '(' || before?.text === ',')) call = parent.call;
      }
      const frame: Frame = { open, key, call, at: t };
      frames.push(frame);
      if (open === '{' && call && guardedCalls.has(call)) {
        const hidden = opaqueMember(frame);
        if (hidden)
          refusals.push({
            line: hidden.line,
            said: `a spread or computed key in the object ${call}(…) is given can carry a renamed word unseen; which it is takes a reader`,
          });
      }
      continue;
    }
    if (token.kind === 'punct' && token.text in CLOSERS) {
      const open = CLOSERS[token.text]!;
      let top = frames.length - 1;
      while (top >= 0 && frames[top]!.open !== open) top--;
      if (top >= 0) frames.length = top;
      continue;
    }

    if (token.kind === 'string') {
      const before = tokens[t - 1];
      const fromImport =
        before?.text === 'from' ||
        (before?.text === 'import' && before.kind === 'id') ||
        (before?.text === '(' && ['import', 'require'].includes(tokens[t - 2]?.text ?? '') && tokens[t - 2]!.kind === 'id');
      const renamed = fromImport ? renamedModule(token.text) : undefined;
      if (fromImport) modules.push(renamed ?? token.text);
      if (renamed) {
        edits.push({ start: token.start, end: token.end, text: renamed });
        changes.push({ line: token.line, said: `${token.text} -> ${renamed}` });
      }
      continue;
    }

    /* A tag: `<Name attr="…" {...spread}>` where an expression can begin, so `Array<Rows>` and `a < b` are not. */
    if (token.kind === 'punct' && token.text === '<' && tokens[t + 1]?.kind === 'id' && tokens[t + 1]!.start === token.end) {
      const before = tokens[t - 1];
      const expression = !before || (before.kind === 'punct' && !')]'.includes(before.text)) || before.text === 'return';
      if (expression) jsxElement(t);
      continue;
    }
    if (token.kind !== 'id') continue;

    if (token.text === 'definePage' && is(t + 1, '(') && !is(t + 2, '{') && !is(t + 2, ')') && !is(t - 1, '.')) {
      refusals.push({
        line: token.line,
        said: 'definePage is given something other than an object written here, so a renamed key in it takes a reader',
      });
    }

    /* Property position: after `{` or `,`, followed by `:` (or, shorthand, by `,` or `}`). A quoted key is a key too, but nothing renamed is written quoted. */
    const frame = frames.at(-1);
    const keyPosition = frame?.open === '{' && (is(t - 1, '{') || is(t - 1, ','));
    const keyed = keyPosition && is(t + 1, ':');
    const shorthand = keyPosition && (is(t + 1, ',') || is(t + 1, '}'));
    if ((keyed || shorthand) && frame) {
      const parent = frames.at(-2);
      const value = tokens[t + 2];
      /* A shorthand `{ title }` is `{ label: title }`, the name staying the variable's; only where the words around it place it. */
      const written = (to: string) => (shorthand ? `${to}: ${token.text}` : to);
      const rename = KEYS.find((each) => {
        if (each.from !== token.text || each.component) return false;
        if (shorthand && (!guarded(each) || each.shape || each.firstKey)) return false;
        if (!holds(each, frame, parent)) return false;
        if (each.shape === 'array' && value?.text !== '[') return false;
        if (each.shape === 'object' && value?.text !== '{') return false;
        if (each.firstKey && !(value?.text === '{' && tokens[t + 4]?.text === ':' && each.firstKey.includes(tokens[t + 3]?.text ?? '')))
          return false;
        return true;
      });
      if (rename) {
        edits.push({ start: token.start, end: token.end, text: written(rename.to) });
        changes.push({ line: token.line, said: `${rename.from} -> ${rename.to}` });
        continue;
      }
      const refusedKey = REFUSED.find((each) => each.context && each.name === token.text && holds(each.context, frame, parent));
      if (refusedKey) {
        refusals.push({ line: token.line, said: `${refusedKey.name} ${refusedKey.reason}` });
        continue;
      }
      const valued = keyed
        ? VALUES.find((each) => each.key === token.text && value?.kind === 'string' && value.text === each.from)
        : undefined;
      if (valued) {
        edits.push({ start: value!.start, end: value!.end, text: valued.to });
        changes.push({ line: token.line, said: `${valued.key}: '${valued.from}' -> '${valued.to}'` });
        continue;
      }
    }

    if (NAMES[token.text] && !is(t - 1, '.')) {
      edits.push({ start: token.start, end: token.end, text: NAMES[token.text]! });
      changes.push({ line: token.line, said: `${token.text} -> ${NAMES[token.text]}` });
      continue;
    }
    for (const refused of REFUSED) {
      if (refused.context || refused.name !== token.text || is(t - 1, '.')) continue;
      if (refused.imported) {
        /* Only a name inside `import { … } from '<the App entry point>'`. */
        let open = t;
        while (open > 0 && !is(open, '{') && !is(open, ';')) open--;
        let close = t;
        while (close < tokens.length && !is(close, '}') && !is(close, ';')) close++;
        const module = tokens[close + 2];
        const importList = is(open, '{') && is(open - 1, 'import') && is(close + 1, 'from') && module?.kind === 'string';
        const entry = importList ? (renamedModule(module!.text) ?? module!.text) : '';
        if (entry !== '@mistriwork/mistri/app') continue;
      }
      refusals.push({ line: token.line, said: `${refused.name} ${refused.reason}` });
    }
  }

  /** A kit component's renamed props: only on a tag whose name is imported from the kit, through whatever local name it has. */
  function jsxElement(open: number): void {
    let j = open + 1;
    const name = [tokens[j]!.text];
    while (is(j + 1, '.') && tokens[j + 2]?.kind === 'id') {
      name.push(tokens[j + 2]!.text);
      j += 2;
    }
    const specifier = imports.get(name[0]!);
    const kit = specifier !== undefined && isKitModule(specifier);
    const own = specifier !== undefined && isOwnModule(specifier);
    if (!kit && !own) return;
    const shown = name.join('.');
    for (j++; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (is(j, '>') || (is(j, '/') && is(j + 1, '>'))) return;
      if (is(j, '{')) {
        /* `{...props}` among the attributes: any word could be in it. */
        if (kit && is(j + 1, '.') && is(j + 2, '.') && is(j + 3, '.')) {
          refusals.push({
            line: token.line,
            said: `<${shown} {...spread}> spreads props into a kit component, so ${componentRows.map((each) => `\`${each.from}\` (now \`${each.to}\`)`).join(', ')} may be in it; which it is takes a reader`,
          });
        }
        j = closeOf(j);
        continue;
      }
      if (token.kind !== 'id') return;
      let attribute = token.text;
      const first = j;
      while ((is(j + 1, '-') || is(j + 1, ':')) && tokens[j + 2]?.kind === 'id') {
        attribute += tokens[j + 1]!.text + tokens[j + 2]!.text;
        j += 2;
      }
      const rename = componentRows.find((each) => each.from === attribute);
      if (rename && kit) {
        edits.push({ start: tokens[first]!.start, end: tokens[first]!.end, text: rename.to });
        changes.push({ line: token.line, said: `<${shown} ${rename.from}> -> ${rename.to}` });
      } else if (rename && own) {
        refusals.push({
          line: token.line,
          said: `<${shown} ${rename.from}=…> is imported from the App's own module, which may stand for a kit component (\`${rename.from}\` is now \`${rename.to}\` there); which it is takes a reader`,
        });
      }
      if (is(j + 1, '=')) {
        j += 2;
        if (is(j, '{')) j = closeOf(j);
        else if (tokens[j]?.kind !== 'string') return;
      }
    }
  }

  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  /* After the keys: no rename above adds a line, so the token pass's lines are the file's. */
  const owned = modules.some((module) => module.startsWith('@mistriwork/'));
  const foreign = context.typescript === false ? 'is not a .ts or .tsx file' : owned ? undefined : 'does not import @mistriwork/*';
  const tokened = upgradeTokens(text, context, foreign);
  return {
    text: tokened.text,
    changes: [...changes, ...tokened.changes].sort((a, b) => a.line - b.line),
    refusals: [...refusals, ...tokened.refusals].sort((a, b) => a.line - b.line),
    modules,
  };
}

/** The custom properties an App's files set themselves (`--bg: …`, `'--bg': …`, `setProperty('--bg'`). */
function declaredProperties(texts: readonly string[]): Set<string> {
  const declared = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(/(?:^|[\s{;,])['"]?(--[A-Za-z][\w-]*)['"]?\s*:|setProperty\(\s*['"`](--[A-Za-z][\w-]*)/g))
      declared.add((match[1] ?? match[2])!);
  return declared;
}

/* What an App's source folder holds that is not the App's to rewrite. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', '.git', '.mistri', '.claude', '.agents']);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const STYLESHEET = /\.css$/;

function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sourcesIn(join(dir, entry.name));
      /* The generated types are rewritten by `check`, not by hand. */
      return (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) || STYLESHEET.test(entry.name) ? [join(dir, entry.name)] : [];
    })
    .sort();
}

/** A path under the App's own `theme` or `styles`: the stylesheets its theme and page modules read. */
const THEME_STYLES = new Set(['theme', 'themes', 'styles']);
const isThemeStyles = (path: string) => path.split(/[\\/]/).some((part) => THEME_STYLES.has(part.replace(/\.[^.]*$/, '')));

/**
 * The stylesheets mistri owns: under the App's `theme` or `styles`, and imported by a source that imports
 * `@mistriwork/*` (its theme or a page), directly or through an `@import` of one that is. A `var(--border)` anywhere
 * else may be a library's own.
 */
function ownedStylesheets(
  root: string,
  files: ReadonlyArray<{ file: string; text: string }>,
  results: ReadonlyMap<string, Upgraded>,
): Set<string> {
  const texts = new Map(files.filter((each) => STYLESHEET.test(each.file)).map((each) => [each.file, each.text]));
  const owned = new Set<string>();
  const queue: string[] = [];
  const reach = (from: string, specifier: string) => {
    const path = specifier.split(/[?#]/)[0]!;
    if (!path.startsWith('.') || !STYLESHEET.test(path)) return;
    const target = resolve(dirname(from), path);
    if (texts.has(target) && isThemeStyles(relative(root, target)) && !owned.has(target)) {
      owned.add(target);
      queue.push(target);
    }
  };
  for (const [file, result] of results)
    if (result.modules.some((module) => module.startsWith('@mistriwork/')) && /\.tsx?$/.test(file))
      for (const module of result.modules) reach(file, module);
  for (let next = queue.pop(); next; next = queue.pop())
    for (const match of texts.get(next)!.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) reach(next, match[1]!);
  return owned;
}

/**
 * Runs the command. Exit 0: nothing to change (or changed, without --check) and nothing refused; 1: with --check
 * something would change, or something was refused; 2: it could not run.
 */
export function runUpgrade(
  argv: string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
  err: (text: string) => void = (text) => process.stderr.write(text),
): number {
  let dir = '.';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') check = true;
    else if (arg === '--app') {
      const value = argv[++i];
      if (!value) {
        err(`mistri: --app needs a directory.\n${UPGRADE_USAGE}\n`);
        return 2;
      }
      dir = value;
    } else if (arg === '--help' || arg === '-h') {
      out(
        `${UPGRADE_USAGE}\n\nRewrites an App's source to the names this mistri reads: tablewalk/app and the other entry points of the\n` +
          'old package become @mistriwork/mistri/*, keys the CHANGELOG renamed are renamed where they mean one thing, and the\n' +
          "looks' renamed tokens are renamed in sources and stylesheets. What it\n" +
          'cannot place with certainty it leaves alone and names by file and line (exit 1). --check writes nothing and exits 1\n' +
          'when a run would change a file, for CI.\n',
      );
      return 0;
    } else {
      err(`mistri: upgrade does not take ${arg}.\n${UPGRADE_USAGE}\n`);
      return 2;
    }
  }
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    err(`mistri: ${dir} is not a directory.\n`);
    return 2;
  }
  let changed = 0;
  let refused = 0;
  const files = sourcesIn(root).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const declared = declaredProperties(files.map((each) => each.text));
  /* What the App's own dependencies' stylesheets declare is read once, and only if a generic token is met. */
  let dependencies: Map<string, string> | undefined;
  const declaredBy = (token: string) => (dependencies ??= dependencyDeclarations(root, GENERIC_TOKENS)).get(token);
  /* Sources first: which stylesheets mistri's sources import says which stylesheets are mistri's. */
  const results = new Map<string, Upgraded>();
  for (const { file, text } of files)
    if (!STYLESHEET.test(file)) results.set(file, upgradeSource(text, { declared, declaredBy, typescript: /\.tsx?$/.test(file) }));
  const owned = ownedStylesheets(root, files, results);
  for (const { file, text } of files)
    if (STYLESHEET.test(file)) results.set(file, upgradeStylesheet(text, { declared, declaredBy, owned: owned.has(file) }));
  for (const { file } of files) {
    const shown = relative(process.cwd(), file) || file;
    const result = results.get(file)!;
    if (result.changes.length) {
      changed++;
      if (!check) writeFileSync(file, result.text);
      out(
        `${check ? 'would change' : 'changed'} ${shown} (${result.changes.length}): ${[...new Set(result.changes.map((each) => each.said))].join('; ')}\n`,
      );
    }
    for (const refusal of result.refusals) {
      refused++;
      out(`refused ${shown}:${refusal.line}: ${refusal.said}\n`);
    }
  }
  if (!changed && !refused) out('Nothing to upgrade.\n');
  else if (refused) out(`${refused} ${refused === 1 ? 'place' : 'places'} to change by hand.\n`);
  return refused || (check && changed) ? 1 : 0;
}
