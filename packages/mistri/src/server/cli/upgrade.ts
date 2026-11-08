/**
 * `mistri upgrade`: an App's source brought to the names this mistri reads.
 *
 * The import of the package's old name becomes `@mistriwork/mistri/*`, and the keys and names the CHANGELOG renamed
 * are rewritten where they read the same wherever they stand (upgradeRenames.ts, the one table). A rename is a text
 * edit at a token the file's own words place: this reads source as tokens, skipping strings, comments and templates,
 * and never as a parse, so it needs no TypeScript installed and cannot be fooled by a name inside a string. What it
 * cannot place with certainty it does not touch: it names the file and line and exits 1, for a person to change.
 *
 * `--check` writes nothing and exits 1 when a run would change a file or refuse something, for CI. A second run
 * finds nothing to change (the rewrites never produce their own input), and the refusals stay until they are fixed.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { KEYS, NAMES, REFUSED, VALUES, renamedModule } from './upgradeRenames.js';

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
      (!tokens.length || (tokens.at(-1)!.kind === 'punct' && BEFORE_REGEX.has(tokens.at(-1)!.text)) || tokens.at(-1)!.text === 'return')
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
}

/** One file's source brought up to date. Pure: the same source in, the same answer out. */
export function upgradeSource(source: string): Upgraded {
  const tokens = tokenize(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const changes: Upgraded['changes'] = [];
  const refusals: Upgraded['refusals'] = [];
  const is = (index: number, text: string) => tokens[index]?.text === text && tokens[index]!.kind !== 'string';

  /* The key each open brace is the value of, so `recipes: { head }` is told from a list's `head`. */
  const owners: Array<string | null> = [];
  /* Which module an `import { … }` list is from, found when its `from` is read; the list is checked then. */
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.kind === 'punct' && token.text === '{') {
      const named = tokens[t - 1]?.text === ':' && tokens[t - 2] && tokens[t - 2]!.kind !== 'punct' ? tokens[t - 2]!.text : null;
      owners.push(named);
      continue;
    }
    if (token.kind === 'punct' && token.text === '}') {
      owners.pop();
      continue;
    }

    if (token.kind === 'string') {
      const before = tokens[t - 1];
      const fromImport =
        before?.text === 'from' ||
        (before?.text === 'import' && before.kind === 'id') ||
        (before?.text === '(' && ['import', 'require'].includes(tokens[t - 2]?.text ?? '') && tokens[t - 2]!.kind === 'id');
      const renamed = fromImport ? renamedModule(token.text) : undefined;
      if (renamed) {
        edits.push({ start: token.start, end: token.end, text: renamed });
        changes.push({ line: token.line, said: `${token.text} -> ${renamed}` });
      }
      continue;
    }
    if (token.kind !== 'id') continue;

    /* Property position: after `{` or `,`, followed by `:`. A quoted key is a key too, but nothing renamed is written quoted. */
    const keyed = is(t + 1, ':') && (is(t - 1, '{') || is(t - 1, ','));
    if (keyed) {
      const value = tokens[t + 2];
      const owner = owners.at(-1) ?? null;
      const rename = KEYS.find((each) => {
        if (each.from !== token.text) return false;
        if (each.inside && each.inside !== owner) return false;
        if (each.shape === 'array' && value?.text !== '[') return false;
        if (each.shape === 'object' && value?.text !== '{') return false;
        if (each.firstKey && !(value?.text === '{' && tokens[t + 4]?.text === ':' && each.firstKey.includes(tokens[t + 3]?.text ?? '')))
          return false;
        return true;
      });
      if (rename) {
        edits.push({ start: token.start, end: token.end, text: rename.to });
        changes.push({ line: token.line, said: `${rename.from} -> ${rename.to}` });
        continue;
      }
      const valued = VALUES.find((each) => each.key === token.text && value?.kind === 'string' && value.text === each.from);
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
      if (refused.name !== token.text || is(t - 1, '.')) continue;
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

  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, changes: changes.sort((a, b) => a.line - b.line), refusals: refusals.sort((a, b) => a.line - b.line) };
}

/* What an App's source folder holds that is not the App's to rewrite. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', '.git', '.mistri', '.claude', '.agents']);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sourcesIn(join(dir, entry.name));
      /* The generated types are rewritten by `check`, not by hand. */
      return SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [join(dir, entry.name)] : [];
    })
    .sort();
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
          'old package become @mistriwork/mistri/*, and keys the CHANGELOG renamed are renamed where they mean one thing. What it\n' +
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
  for (const file of sourcesIn(root)) {
    const shown = relative(process.cwd(), file) || file;
    const result = upgradeSource(readFileSync(file, 'utf8'));
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
