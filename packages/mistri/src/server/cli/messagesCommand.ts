/**
 * `mistri messages extract [--app <dir>] [--locale <tag>]`: the App's
 * words, gathered for a translator. With a locale, the keys that catalog
 * lacks are appended to `messages/<tag>.ts` as comments holding the source's
 * text, to be translated and uncommented — the file is made when there is
 * none. Without one, the captions the definition still writes as literal text
 * are listed, each with a key it could have, to move into the source catalog
 * by hand. The App's own source is never rewritten: a caption becomes a
 * `msg()` where its author puts one.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { canonicalLocale } from '@mistriwork/engine/shared/appLocale.js';
import { isCaptionKey, isMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { loadApp, type DefinitionInput } from '../app/apps.js';
import { appCatalogs } from '../app/appMessages.js';

const usage = 'mistri messages extract [--app <dir>] [--locale <tag>]';

export async function runMessagesCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(
      `${usage}\nWith --locale, append the keys messages/<tag>.ts lacks, each as a comment with the source's text. Without, list the captions still written as literal text, with a key for each. Never rewrites the App's source; starts no server.`,
    );
    return;
  }
  if (args[0] !== 'extract') throw new Error(`Expected ${usage}`);
  let dir = '.';
  let locale: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== '--app' && flag !== '--locale') || !value || value.startsWith('-')) throw new Error(`Expected ${usage}`);
    if (flag === '--app') dir = value;
    else {
      locale = canonicalLocale(value);
      if (!locale) throw new Error(`--locale ${value} is not a locale tag like "es" or "pt-BR".`);
    }
    i++;
  }
  const home = resolve(dir);
  let input: DefinitionInput | undefined;
  const loaded = await loadApp(home, { lock: 'report', definition: (definition) => (input = definition) });
  if (locale) {
    const catalogs = appCatalogs(loaded.app);
    if (!catalogs)
      throw new Error(
        `${dir} has no messages/ catalogs. Write the source's first (messages/en.ts, with defineMessages), then extract for a locale.`,
      );
    if (locale === catalogs.source) throw new Error(`messages/${locale} is the source catalog: every key starts there.`);
    const sourceFile = basename(catalogs.files[catalogs.source] ?? `${catalogs.source}.ts`);
    console.log(
      await appendMissing(home, sourceFile, catalogs.source, catalogs.locales[catalogs.source]!, locale, catalogs.locales[locale] ?? {}),
    );
    return;
  }
  const found = literalCaptions(input?.raw ?? {});
  if (!found.length) {
    console.log('Every caption is a msg(): nothing written as literal text.');
    return;
  }
  const width = Math.min(48, Math.max(...found.map((item) => item.at.length)));
  console.log(`${found.length} caption${found.length === 1 ? '' : 's'} written as literal text, each with a key it could have:\n`);
  for (const item of found) console.log(`  ${item.at.padEnd(width)}  ${JSON.stringify(item.text)}  → ${item.key}`);
}

/** The source's keys a locale's catalog lacks, appended to its file as comments; the file made where there is none. */
async function appendMissing(
  home: string,
  /** The source catalog's file, which the new one is typed against: `en.ts`. */
  sourceFile: string,
  source: string,
  sourceWords: Readonly<Record<string, string>>,
  locale: string,
  have: Readonly<Record<string, string>>,
): Promise<string> {
  const file = join(home, 'messages', `${locale}.ts`);
  const text = existsSync(file) ? await readFile(file, 'utf8') : undefined;
  /* A key appended by an earlier run and not yet translated is still a comment: it is not appended twice. */
  const missing = Object.keys(sourceWords).filter((key) => !Object.hasOwn(have, key) && !text?.includes(`// ${quoted(key)}:`));
  if (!missing.length) return `messages/${locale}.ts has every key messages/${source} has, translated or waiting as a comment.`;
  const lines = missing.map((key) => `  // ${quoted(key)}: ${quoted(sourceWords[key]!)},`).join('\n');
  if (text === undefined) {
    await writeFile(
      file,
      `import { defineMessages } from '@mistriwork/mistri/app';\nimport type ${identifier(source)} from './${sourceFile}';\n\nexport default defineMessages<typeof ${identifier(source)}>('${locale}', {\n${lines}\n});\n`,
    );
    return `Wrote messages/${locale}.ts with ${missing.length} key${missing.length === 1 ? '' : 's'} to translate, each a comment holding the ${source} text.`;
  }
  /* Before the entries object's closing brace: the last `}` before the call's `)`. */
  const close = text.lastIndexOf('})');
  if (close < 0) throw new Error(`messages/${locale}.ts does not end its defineMessages('${locale}', { … }) call; add the keys by hand.`);
  const before = text.slice(0, close).replace(/\s*$/, '');
  await writeFile(file, `${before}\n${lines}\n${text.slice(close)}`);
  return `Appended ${missing.length} key${missing.length === 1 ? '' : 's'} to messages/${locale}.ts, each a comment holding the ${source} text.`;
}

/** A single-quoted string, as the catalogs are written. */
const quoted = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

const identifier = (tag: string) => tag.replace(/[^A-Za-z0-9]/g, '_');

/** A caption's place, its words, and the key it could have: `<owner>.<words in camel case>`. */
interface Literal {
  at: string;
  text: string;
  key: string;
}

/** Every caption the definition writes as literal text, in the order it holds them. */
export function literalCaptions(raw: unknown): Literal[] {
  const found: Literal[] = [];
  const keys = new Map<string, string>();
  const visit = (value: unknown, path: Array<string | number>, caption: boolean) => {
    if (isMessageRef(value)) return;
    if (typeof value === 'string') {
      if (caption && /\p{L}/u.test(value)) {
        /* Named for what holds it: the nearest resource, view or page (a feature's included), else the definition's top key. */
        const at = path.findLastIndex((part, i) => (part === 'resources' || part === 'views' || part === 'pages') && i + 1 < path.length);
        const owner = String(at >= 0 ? path[at + 1] : path[0]);
        const key = keys.get(value) ?? suggestKey(owner, value, new Set(keys.values()));
        keys.set(value, key);
        found.push({ at: path.join('.'), text: value, key });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], false));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        visit(item, [...path, key], isCaptionKey(key, path.at(-1)) || path.at(-1) === 'labels');
  };
  visit(raw, [], false);
  return found;
}

/** `tickets` + "Open tickets" → `tickets.openTickets`; a second of the same spelling numbered. */
function suggestKey(owner: string, text: string, taken: ReadonlySet<string>): string {
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f'’]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 4);
  const camel = words?.length ? words.map((word, i) => (i ? word[0]!.toUpperCase() + word.slice(1) : word)).join('') : 'text';
  const named = owner.replace(/[^A-Za-z0-9_]/g, '_');
  const scope = /^[A-Za-z]/.test(named) ? named : 'app';
  const base = `${scope}.${/^[0-9]/.test(camel) ? `n${camel}` : camel}`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}
