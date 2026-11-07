/**
 * The facts that live in the code AND in prose, held together.
 *
 * CLAUDE.md keeps a list titled "facts that are written in more than one
 * place" — the CLI flags, the dialects, the current release — each with a
 * manual command to verify it, because each has drifted before. A manual
 * ritual is a rule that fails silently on the day it matters; these tests
 * are those rituals, run on every `npm test`. Same move as
 * check-client-geometry.mjs: prose into invariant.
 *
 * test-package: shared — the repository's prose: the site, the changelog, the docs. What the `mistri`
 * binary's README owes its own USAGE is test/prose-mistri.test.ts (through test/support/productProse.ts).
 * The database browser's facts — its MCP tool count, its flags, its dialect keywords — are held in its own
 * repository (https://github.com/rbaljinder/tablewalk).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { flagsIn } from '../scripts/public-surface.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/* The binary this repository ships, with its own USAGE and its own README, held to each other. */
const PRODUCTS = {
  mistri: { readme: read('packages/mistri/README.md'), cli: read('packages/mistri/src/server/cli/usage.ts') },
} as const;
const usageOf = (cli: string): string => {
  const usage = cli.match(/const USAGE = `([\s\S]*?)`/)?.[1];
  assert.ok(usage, 'USAGE moved — update the extraction here');
  return usage;
};

describe('the prose agrees with the code it describes', () => {
  test('the first line of the upgrade notes is the TypeScript peer, which stops npm install before anything else is read', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const notes = /^### Upgrading from [^\n]*\n\n- ([^\n]*)/m.exec(changelog.slice(changelog.indexOf('## 0.9.5')))?.[1] ?? '';
    assert.match(notes, /TypeScript 7 first/);
    const peer = JSON.parse(
      readFileSync(new URL('../packages/mistri/package.json', import.meta.url), 'utf8'),
    ).peerDependencies.typescript.split(' ')[0]; // the lower bound; the 0.9.5 entry predates the upper one
    assert.match(changelog, new RegExp(`peer is \`${peer.replace(/[>=]/g, (c: string) => `\\${c}`)}\``));
  });

  test('current-release prose names the latest completed changelog entry', () => {
    // The manifest may already name the next development version. Historical
    // release sections must remain historical, so check only current claims.
    const released = /^## (\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/m.exec(read('CHANGELOG.md'))?.[1];
    assert.ok(released, 'The changelog needs a completed release entry.');
    for (const [path, pattern] of [
      ['packages/mistri/README.md', /These App features ship in mistri (\d+\.\d+\.\d+(?:-[\w.]+)?)[;,. ]/],
      ['site/src/content/docs/docs/status.md', /This site describes \*\*mistri (\d+\.\d+\.\d+(?:-[\w.]+)?)\*\*/],
      // The page's front matter said 0.8.7 beside a body that said 0.8.8; it is the line search results show.
      ['site/src/content/docs/docs/status.md', /^description: The (\d+\.\d+\.\d+(?:-[\w.]+)?) scope/m],
    ] as const) {
      assert.equal(pattern.exec(read(path))?.[1], released, `${path}: update the current release statement`);
    }
  });

  /* Prose drift, the dangerous kind. Three near-misses in 0.5.1 were
     comments and published pages describing the slice that was *planned*
     rather than the one that shipped — a page promising support "may read the
     dealer it entered, and act on nothing" long after the write sink landed,
     and a comment saying writes "stay refused until the write trail is
     proven" after it was proven. Accurate about behaviour, stale in its
     reason, which is worse than wrong: satisfy the stated condition and you
     remove a refusal that should stay.

     No check can read intent. What it can do is hold prose to names that
     exist: a document or a comment that offers a flag the CLI does not take
     is describing a mistri that is not this one. */
  test("every flag named in the docs, the site and the code's own comments is one the CLI takes", () => {
    /* A line that names `mistri` offers its flags; one that names `npx tablewalk` is about the database browser, whose
       flags are held in its own repository. */
    const real = new Set(
      Object.values(PRODUCTS).flatMap(({ cli }) => [...usageOf(cli).matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0])),
    );
    /* Only what a line offers *after* naming the command. A design token is
       spelled `--surface` and Docker takes `--rm`; neither is a claim about
       this CLI, and a check that flags them is a check nobody keeps. What is
       left is the claim that matters: this is how you run mistri. */
    const offered = (text: string): string[] =>
      text.split('\n').flatMap((line) => {
        const at = line.search(/\bmistri\b/);
        if (at < 0) return [];
        return [...line.slice(at).matchAll(/(?<=\s)--[a-z][a-z-]+/g)].map((match) => match[0]);
      });
    const looked: Array<[string, string]> = [];
    const read = (file: string) => {
      try {
        return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      } catch {
        return '';
      }
    };
    for (const file of [
      'README.md',
      'packages/mistri/README.md',
      'docs/apps.md',
      'docs/architecture.md',
      'docs/design.md',
      'site/src/content/docs/index.mdx',
      'examples/apps/README.md',
    ]) {
      looked.push([file, read(file)]);
    }
    const problems: string[] = [];
    /* A flag a document offers on purpose because it is *not* one: a README
       may show `--prot 4111` to say that an unrecognised option is an error
       rather than a shrug. */
    const DELIBERATE = new Set(['--prot']);
    for (const [file, text] of looked) {
      if (!text) continue;
      for (const flag of offered(text)) {
        if (real.has(flag) || DELIBERATE.has(flag)) continue;
        problems.push(`${file} offers ${flag} to mistri, which the CLI does not take.`);
      }
    }
    assert.deepEqual([...new Set(problems)], [], 'Prose that names a flag the CLI does not take describes a mistri this is not.');
  });

  /* One rule for relative paths, stated where a reader of either looks: a path on the command line is from the current
     directory, a path in a file from that file's folder. `build --out` was the one that read as an exception. */
  test('the relative-path rule is stated once in USAGE and in the README, and build --out says it follows it', () => {
    /* The App framework's: build --out, a suite file and test hosts are its. */
    const { cli, readme: README } = PRODUCTS.mistri;
    const usage = cli.slice(cli.indexOf('export const USAGE'));
    const rule =
      /Paths: one typed on the command line[\s\S]*?relative to the current directory; one written in a file[\s\S]*?relative to that file's folder\./g;
    assert.equal(usage.match(rule)?.length, 1, 'USAGE states the path rule once');
    assert.match(
      README,
      /A path typed on the command line[\s\S]*?relative to the current directory; a path written in a file[\s\S]*?relative to that file's folder\./,
    );
    assert.match(usage, /--out <dir> {5}Where the build goes, from the current directory/);
    assert.match(README, /--out <dir> {13}with build: where the build goes, from the\s+current directory/);
  });

  test('the dialects are stated wherever they are stated', () => {
    for (const dialect of ['sqlite', 'postgres'])
      assert.match(PRODUCTS.mistri.readme.toLowerCase(), new RegExp(dialect), `packages/mistri/README.md does not mention ${dialect}`);
  });

  /* The author is in the United States and the docs say so: color, not colour.
     The list is words the docs have actually drifted to, plus their obvious
     siblings; add one when a new drift turns up. */
  test('the site docs and the README use American spellings', () => {
    const UK =
      /\b(colour\w*|centred|centres?|licence\w*|behaviour\w*|organis\w+|favour\w*|honour\w*|neighbour\w*|greys?|catalogues?|analyse[sd]?|initialis\w+|recognis\w+|customis\w+|optimis\w+|minimis\w+|normalis\w+|summaris\w+|synchronis\w+|authoris\w+|serialis\w+|visualis\w+|utilis\w+|prioritis\w+|labell\w+|modell\w+|defence|artefacts?|judgement|enquir\w+|whilst|amongst|programmes?)\b/gi;
    const ALLOWED: RegExp[] = [];
    const files = (dir: URL): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : /\.mdx?$/.test(entry.name) ? [new URL(entry.name, dir).pathname] : [],
      );
    const read = (path: string) => readFileSync(path, 'utf8');
    const docs = files(new URL('../site/src/content/docs/', import.meta.url));
    const found: string[] = [];
    for (const [name, text] of [
      ['README.md', read('README.md')],
      ['packages/mistri/README.md', PRODUCTS.mistri.readme],
      ...docs.map((path) => [path.split('/site/')[1], read(path)]),
    ] as Array<[string, string]>) {
      let clean = text;
      for (const allowed of ALLOWED) clean = clean.replace(allowed, '');
      for (const hit of clean.matchAll(UK)) found.push(`${name}: ${hit[0]}`);
    }
    assert.deepEqual([...new Set(found)], [], 'Use American English in the docs: color, centered, license, behavior, organize.');
  });
});

describe('the install line', () => {
  /* Until 1.0.0 ships, npm's `latest` tag on @mistriwork/mistri and create-mistri is a placeholder (0.0.0, "coming
     soon"), and the release candidates are on `next`: an untagged `npm create mistri` installed the placeholder (an
     external assessment). Once the version is not a prerelease, `latest` is the release and `@next` must go again. */
  test('a cold install says @next while the version is a release candidate, and only then', () => {
    const version: string = JSON.parse(read('packages/mistri/package.json')).version;
    const candidate = version.includes('-');
    const pages = (readdirSync(new URL('../site/src/content/docs/', import.meta.url), { recursive: true }) as string[])
      .filter((name) => /\.mdx?$/.test(name))
      .map((name) => `site/src/content/docs/${name}`);
    const skills = (readdirSync(new URL('../skills/', import.meta.url), { recursive: true }) as string[])
      .filter((name) => name.endsWith('.md'))
      .map((name) => `skills/${name}`);
    const found: string[] = [];
    for (const file of ['README.md', 'packages/mistri/README.md', 'packages/create-mistri/README.md', ...pages, ...skills]) {
      const text = read(file);
      const untagged =
        /\bnpm create mistri(?!@next)\b|\bnpm (?:install|i|add)(?: (?:-D|--save-dev|-g|--global))* @mistriwork\/mistri(?![@\w/-])/g;
      const tagged = /\bmistri@next\b/g;
      for (const hit of text.matchAll(candidate ? untagged : tagged)) found.push(`${file}: ${hit[0]}`);
    }
    assert.deepEqual(
      found,
      [],
      candidate ? `${version} is a release candidate: install it as @next` : `${version} is a release: drop @next`,
    );
  });
});

describe('what each kind of App can do', () => {
  /* One table, in two places: the site's row-access page and docs/apps.md, which link where the other links to the
     site. Scattered sentences ("not in a tenant App", "under a row policy … refused") point at it rather than
     repeating it, so a change to a capability changes this table, and this keeps the two copies one table. */
  const tableIn = (file: string) => {
    const text = read(file);
    const start = text.indexOf('<!-- capability-table:start -->');
    const end = text.indexOf('<!-- capability-table:end -->');
    assert.ok(start >= 0 && end > start, `${file} lost its capability table markers`);
    return text.slice(start, end);
  };
  test('docs/apps.md holds the row-access page’s capability table, its links pointed at the same pages', () => {
    const site = tableIn('site/src/content/docs/docs/row-access.md');
    const pages = '../site/src/content/docs/docs/';
    const repo = site
      .replace(/\]\(#([\w-]+)\)/g, `](${pages}row-access.md#$1)`)
      .replace(/\]\(\/docs\/([\w-]+)\/#([\w-]+)\)/g, `](${pages}$1.md#$2)`)
      .replace(/\]\(\/docs\/([\w-]+)\/\)/g, `](${pages}$1.md)`);
    assert.equal(tableIn('docs/apps.md'), repo);
    for (const row of [
      'File fields of a public form',
      'Forms saved on every step',
      'Database triggers',
      'generic writes',
      'event feed',
      'check --pending',
      'exports',
      'assistant',
      'Live sync',
    ])
      assert.ok(site.includes(row), `the capability table has no "${row}" row`);
  });
});

describe('the default look', () => {
  /* An App wears Workshop unless it names another (packages/engine/src/shared/themeLooks.ts). A guide that still called Mono the
     default sent an agent to set a preset it believed was the fallback. */
  test('no guide or skill names another look the default', () => {
    const roots = [new URL('../site/src/content/docs/docs/', import.meta.url), new URL('../skills/mistri/', import.meta.url)];
    const stale: string[] = [];
    for (const root of roots)
      for (const name of readdirSync(root, { recursive: true }) as string[]) {
        if (!name.endsWith('.md')) continue;
        const text = readFileSync(new URL(name, root), 'utf8');
        for (const match of text.matchAll(
          /the default \((lumen|mono|sage|canvas|iris|ink|signal|tray)\)|\b(lumen|mono|sage),? (?:is |as )?the default\b|\b(?:lumen|mono|sage),? \(the default\b/gi,
        ))
          stale.push(`${name}: ${match[0]}`);
      }
    assert.deepEqual(stale, []);
  });
});

describe('the short help', () => {
  for (const [bin, { cli }] of Object.entries(PRODUCTS))
    test(`${bin}'s names every command its USAGE names, and spells only flags its USAGE has`, () => {
      const usage = usageOf(cli);
      const short = cli.match(/const SHORT_USAGE = `([\s\S]*?)`/)?.[1];
      assert.ok(short, 'SHORT_USAGE moved — update the extraction here');
      const commands = [...new Set([...usage.matchAll(new RegExp(`^ {2}${bin} ([a-z][a-z-]*)(?=\\s|$)`, 'gm'))].map((match) => match[1]))];
      for (const command of commands)
        assert.match(short!, new RegExp(`(${bin} |[ ,])${command}\\b`), `USAGE has ${bin} ${command}; the short help does not`);
      const flags = new Set(flagsIn(usage));
      for (const flag of flagsIn(short!)) assert.ok(flags.has(flag), `${bin}'s short help has ${flag}; its USAGE does not`);
    });
});

describe('the short help', () => {
  test("mistri's says where the pool and lock flags are, and they are in --help all", () => {
    const cli = readFileSync(new URL('../packages/mistri/src/server/cli/usage.ts', import.meta.url), 'utf8');
    const short = cli.match(/export const SHORT_USAGE = `([\s\S]*?)`/)?.[1] ?? '';
    assert.match(
      short,
      /--help all\s+every command and option, in full: the connection pool\s+sizes \(--read-pool, --write-pool\), lock timeouts/,
    );
    assert.match(cli.replace(short, ''), /--read-pool <n>[\s\S]*--write-pool[\s\S]*--lock-timeout/);
  });
});

describe('the repository', () => {
  /* Private Apps that report gaps are credited as field reports, not named. Built from parts so this file passes too. */
  const NAME = ['ost', 'ler'].join('');
  test('names no private App that reported a gap', () => {
    const root = new URL('../', import.meta.url);
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
      .toString()
      .split('\0')
      .filter(Boolean);
    const found: string[] = [];
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(new URL(file, root));
      } catch {
        continue; // tracked but deleted in the working tree
      }
      if (bytes.includes(0)) continue; // binary
      if (bytes.toString('utf8').toLowerCase().includes(NAME)) found.push(file);
    }
    assert.deepEqual(found, []);
  });
});
