/**
 * The shipped reference: the site's pages, read offline.
 *
 * The package once shipped `dist`, `schema` and the README, and every link the
 * README and `--help` gave for Apps pointed at files that stayed in the
 * repository. An author holding only the package could not read how access,
 * relationships or dates work. The site's Markdown is the one source: `npm run
 * build` copies it to dist/docs (scripts/package-docs.mjs), and this module
 * reads it there — or, under tsx in a checkout, straight from the site's
 * folder — for `mistri docs` and the MCP shelf.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { shippedPath } from './shipped.js';

/**
 * The reference topics, in reading order: one screen each, the names errors
 * point at (`see mistri docs relationships`). A topic is a page's file
 * name, except where an existing page already covers it under another.
 */
export const DOC_TOPICS: ReadonlyArray<{ topic: string; page: string }> = [
  { topic: 'getting-started', page: 'getting-started' },
  { topic: 'access-model', page: 'access-model' },
  { topic: 'secrets', page: 'secrets' },
  { topic: 'relationships', page: 'relationships' },
  { topic: 'dates-and-types', page: 'dates-and-types' },
  { topic: 'vocabularies', page: 'vocabularies' },
  { topic: 'conventions', page: 'conventions' },
  { topic: 'lists', page: 'lists' },
  { topic: 'segments', page: 'segments' },
  { topic: 'icons', page: 'icons' },
  { topic: 'stock', page: 'stock' },
  { topic: 'dashboards', page: 'dashboards' },
  { topic: 'pages', page: 'pages' },
  { topic: 'forms', page: 'forms' },
  { topic: 'nav-and-shell', page: 'nav-and-shell' },
  /* How to compose each kind of page: rules of "when X, use Y", each pointing at one worked example. */
  { topic: 'compose-record-page', page: 'compose-record-page' },
  { topic: 'compose-form', page: 'compose-form' },
  { topic: 'compose-overview', page: 'compose-overview' },
  { topic: 'compose-list', page: 'compose-list' },
  { topic: 'compose-dashboard', page: 'compose-dashboard' },
  { topic: 'compose-shell', page: 'compose-shell' },
  { topic: 'sources', page: 'sources' },
  { topic: 'migrate', page: 'change-your-schema' },
  { topic: 'schema-sql', page: 'schema-sql' },
  { topic: 'email', page: 'email' },
  { topic: 'identity-providers', page: 'identity-providers' },
  { topic: 'saml', page: 'saml' },
  { topic: 'scim', page: 'scim' },
  { topic: 'reload-and-restart', page: 'reload-and-restart' },
  { topic: 'build-an-api', page: 'build-an-api' },
  { topic: 'check-codes', page: 'check-codes' },
  { topic: 'design', page: 'design-lint' },
  { topic: 'theme-contract', page: 'theme-contract' },
  { topic: 'status', page: 'status' },
];

interface DocPage {
  /** The file name without `.md`: what `mistri docs <name>` and the site's /docs/<name>/ say. */
  name: string;
  title: string;
  description: string;
  /** The Markdown after the front matter. */
  body: string;
}

/* dist/server/docs.js reads dist/docs; packages/mistri/src/server/docs.ts, run by tsx in a
   checkout, reads the site's own folder, so a page edited there is the page
   the CLI prints without a build. */
const PLACES = [new URL('../docs/', import.meta.url), new URL('../../../../site/src/content/docs/docs', import.meta.url)];

export function docsDir(): string | undefined {
  for (const place of PLACES) {
    const dir = fileURLToPath(place);
    if (existsSync(join(dir, 'getting-started.md'))) return dir;
  }
  return undefined;
}

function parse(name: string, text: string): DocPage {
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  /* A value with a colon in it is quoted in the front matter (the generated reference's "App: views"); said, it is not. */
  const field = (key: string) =>
    front?.[1]
      .split('\n')
      .find((line) => line.startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1') ?? '';
  return {
    name,
    title: field('title') || name,
    description: field('description'),
    body: (front ? text.slice(front[0].length) : text).trim(),
  };
}

/** Every shipped page, the reference topics first in their order, then the rest by name. */
export function docPages(dir = docsDir()): DocPage[] {
  if (!dir) return [];
  const names = readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
    .sort();
  const topical = DOC_TOPICS.map(({ page }) => page).filter((page) => names.includes(page));
  return [...topical, ...names.filter((name) => !topical.includes(name))].map((name) =>
    parse(name, readFileSync(join(dir, `${name}.md`), 'utf8')),
  );
}

/** One page by topic or page name, or undefined. */
export function docPage(name: string, dir = docsDir()): DocPage | undefined {
  if (!dir) return undefined;
  const wanted = name.trim().toLowerCase().replace(/\.md$/, '');
  const page = DOC_TOPICS.find((entry) => entry.topic === wanted)?.page ?? wanted;
  if (!/^[a-z0-9-]+$/.test(page)) return undefined;
  const file = join(dir, `${page}.md`);
  return existsSync(file) ? parse(page, readFileSync(file, 'utf8')) : undefined;
}

/** A guide screenshot on disk: beside the shipped pages (dist/docs/assets/guide), or in the site's assets in a checkout. */
function guideImage(file: string, dir = docsDir()): string | undefined {
  if (!dir) return undefined;
  return [join(dir, 'assets', file), join(dir, '..', '..', '..', 'assets', file)].find((path) => existsSync(path));
}

/** A sample App's source in the install (the `mistri` package's `files` ships examples/apps' .ts, .tsx and .md, not its tests), or undefined. */
function sampleFile(path: string): string | undefined {
  if (!/\.(ts|tsx|md)$/.test(path) || path.endsWith('.test.tsx')) return undefined;
  return shippedPath(path);
}

/**
 * A page as a terminal or an agent reads it: its title and purpose, then the
 * body with the site's own links (`/docs/relationships/`) said as the command
 * that opens them offline.
 */
export function renderDoc(page: DocPage): string {
  const topic = DOC_TOPICS.find((entry) => entry.page === page.name)?.topic ?? page.name;
  /* A maintainer's comment and an anchor kept for old links are the site's,
     not the reader's. */
  const body = page.body
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .replace(/<span id="[^"]*"><\/span>\n?/g, '')
    /* A worked example's screenshot ships beside the pages (scripts/package-docs.mjs): said as the file, an agent
       holding only the package can open it. */
    .replace(/\]\((?:\.\.\/)+assets\/(guide\/[a-z0-9-]+\.webp)\)/g, (whole, file: string) => {
      const at = guideImage(file);
      return at ? `](${at})` : whole;
    })
    /* A sample line is linked on GitHub for the site's reader; the sample ships in the package (package.json
       `files`), so the CLI says it as the file — reachable offline, and the version installed, not main's. */
    .replace(
      /\]\(https:\/\/github\.com\/rbaljinder\/(?:mistri|tablewalk)\/blob\/main\/(examples\/apps\/[^)#\s]+)(#L\d+)?\)/g,
      (whole, file: string, line = '') => {
        const at = sampleFile(file);
        return at ? `](${at}${line})` : whole;
      },
    )
    .replace(/\]\(\/docs\/([a-z0-9-]+)\/?(#[^)]*)?\)/g, (_, name: string, anchor = '') => {
      const named = DOC_TOPICS.find((entry) => entry.page === name)?.topic ?? name;
      return `](mistri docs ${named}${anchor})`;
    });
  return `# ${page.title}\n\n${page.description ? `${page.description}\n\n` : ''}${body.replace(/\n{3,}/g, '\n\n')}\n\n(mistri docs ${topic}; online at https://mistriwork.dev/docs/${page.name}/)\n`;
}

/** Each line of every page holding every one of `words`, as `topic: line`. */
export function searchDocs(words: string, dir = docsDir()): Array<{ page: string; line: string }> {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  if (!wanted.length) return [];
  const found: Array<{ page: string; line: string }> = [];
  for (const page of docPages(dir)) {
    const topic = DOC_TOPICS.find((entry) => entry.page === page.name)?.topic ?? page.name;
    for (const line of [page.title, page.description, ...page.body.split('\n')]) {
      const lower = line.toLowerCase();
      if (wanted.every((word) => lower.includes(word))) found.push({ page: topic, line: line.trim() });
    }
  }
  return found;
}

/**
 * `docs <topic> --brief`: the page as its outline, one screen whatever its length: the title and purpose, then each
 * heading with the first sentence under it. The long topics (commands, choose) are ~48k characters, an agent's whole
 * budget for a lookup; this says which section to read, and `mistri docs <topic>` prints the rest.
 */
function briefDoc(page: DocPage): string {
  const topic = DOC_TOPICS.find((entry) => entry.page === page.name)?.topic ?? page.name;
  const sections: Array<{ heading: string; prose: string[]; done: boolean }> = [];
  let fenced = false;
  for (const raw of page.body.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const found = /^(#{2,3}) (.+)$/.exec(raw);
    if (found) {
      sections.push({ heading: `${found[1] === '###' ? '  ' : ''}${found[2].trim()}`, prose: [], done: false });
      continue;
    }
    const section = sections.at(-1);
    if (!section || section.done) continue;
    /* The first paragraph of prose only: a table, a list or a quote before it is skipped, one after it ends it. */
    const item = /^\s*(?:[*-]|\d+\.)\s+(.*)$/.exec(raw);
    if (!raw.trim() || /^\s*[|>]/.test(raw) || item) {
      /* A section that is a list says its first item; one with prose before the list, the prose. */
      if (item && !section.prose.length) {
        section.prose.push(item[1]);
        section.done = true;
      } else if (section.prose.length) section.done = true;
      continue;
    }
    section.prose.push(raw.trim());
  }
  const said = sections.map(({ heading, prose }) => {
    const text = prose
      .join(' ')
      .replace(/`|\*\*/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
    return `${heading}${sentence ? `: ${sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence}` : ''}`;
  });
  return [
    `# ${page.title}`,
    ...(page.description ? [page.description] : []),
    '',
    ...said,
    '',
    `(mistri docs ${topic} prints the whole page; --search finds a line.)`,
    '',
  ].join('\n');
}

const DOCS_USAGE = 'mistri docs [topic [--brief]] | mistri docs --search <words>';

/** `mistri docs …`, as the command line runs it. Returns the exit code. */
export function runDocs(
  argv: string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
  fail: (text: string) => void = (text) => process.stderr.write(text),
): number {
  const dir = docsDir();
  if (!dir) {
    fail('mistri docs: this installation has no dist/docs. Read them at https://mistriwork.dev/docs/getting-started/\n');
    return 1;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    write(
      `${DOCS_USAGE}\n\nWith no topic, lists the reference topics and every other shipped page. With one, prints it;\nwith --brief, its headings and the first sentence under each, one screen.\n`,
    );
    return 0;
  }
  if (argv[0] === '--search') {
    const words = argv.slice(1).join(' ');
    if (!words.trim()) {
      fail(`mistri docs: --search needs a word. ${DOCS_USAGE}\n`);
      return 1;
    }
    const found = searchDocs(words, dir);
    if (!found.length) {
      write(`Nothing in the shipped docs says "${words}".\n`);
      return 1;
    }
    const width = Math.max(...found.map((hit) => hit.page.length));
    write(
      `${found
        .slice(0, 60)
        .map((hit) => `${hit.page.padEnd(width)}  ${hit.line.length > 140 ? `${hit.line.slice(0, 139)}…` : hit.line}`)
        .join('\n')}\n` + `${found.length > 60 ? `…and ${found.length - 60} more lines.\n` : ''}`,
    );
    return 0;
  }
  const brief = argv.includes('--brief');
  if (brief) argv = argv.filter((arg) => arg !== '--brief');
  if (brief && !argv.length) {
    fail(`mistri docs: --brief summarizes one topic. ${DOCS_USAGE}\n`);
    return 1;
  }
  if (argv.length > 1 || argv[0]?.startsWith('-')) {
    fail(`mistri docs: expected one topic. ${DOCS_USAGE}\n`);
    return 1;
  }
  const pages = docPages(dir);
  if (!argv.length) {
    const topics = DOC_TOPICS.filter(({ page }) => pages.some((p) => p.name === page));
    const others = pages.filter((page) => !DOC_TOPICS.some((entry) => entry.page === page.name));
    const width = Math.max(...[...topics.map((t) => t.topic), ...others.map((p) => p.name)].map((name) => name.length));
    const line = (name: string, text: string) => `  ${name.padEnd(width)}  ${text}`;
    write(
      [
        'The App reference, one screen a topic:',
        '',
        ...topics.map(({ topic, page }) => line(topic, pages.find((p) => p.name === page)!.description)),
        '',
        'The longer guides:',
        '',
        ...others.map((page) => line(page.name, page.description)),
        '',
        `Read one with mistri docs <topic>; search with mistri docs --search <words>.`,
        '',
      ].join('\n'),
    );
    return 0;
  }
  const page = docPage(argv[0], dir);
  if (!page) {
    fail(
      `mistri docs: no topic "${argv[0]}". Topics: ${DOC_TOPICS.map((entry) => entry.topic).join(', ')}. ` +
        'mistri docs lists every page.\n',
    );
    return 1;
  }
  write(brief ? briefDoc(page) : renderDoc(page));
  return 0;
}
