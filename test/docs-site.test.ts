/**
 * The site's own shape, held by tests: every page in the sidebar, no orphan
 * pictures, the how-to template, the generated reference and the screenshot
 * manifest. Link and anchor validation runs in the site build itself
 * (starlight-links-validator in site/astro.config.mjs), because it needs the
 * rendered pages.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOW_TO_PAGES, lintHowTo } from '../scripts/docs-lint.mjs';
import { build, OUT, owned } from '../scripts/dsl-reference.mjs';
import { build as buildCli, PAGES as CLI_PAGES } from '../scripts/cli-reference.mjs';
import { readInventory } from '../scripts/public-surface.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = join(ROOT, 'site');
const DOCS = join(SITE, 'src/content/docs');
const ASSETS = join(SITE, 'src/assets');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe('the sidebar', () => {
  const config = readFileSync(join(SITE, 'astro.config.mjs'), 'utf8');
  const slugs = [...config.matchAll(/slug: '([^']+)'/g)].map((match) => match[1]);
  const pages = walk(DOCS)
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => relative(DOCS, file).replace(/\.mdx?$/, ''));

  test('holds every page, once', () => {
    assert.deepEqual(
      pages.filter((page) => !slugs.includes(page)),
      [],
      'a page no sidebar entry reaches',
    );
    assert.deepEqual(
      slugs.filter((slug, i) => slugs.indexOf(slug) !== i),
      [],
      'a page in two places',
    );
  });

  test('names no page that is not there', () => {
    assert.deepEqual(
      slugs.filter((slug) => !pages.includes(slug)),
      [],
    );
  });

  test('has the target groups, in order', () => {
    const labels = [...config.matchAll(/^ {8}\{\s*label: '([^']+)',\s*items:/gm)].map((match) => match[1]);
    assert.deepEqual(labels, ['Start', 'Build', 'Behavior', 'Data', 'UI', 'Ship', 'Reference', 'Database browser']);
  });
});

describe('pictures', () => {
  const sources = walk(join(SITE, 'src'))
    .filter((file) => /\.(md|mdx|astro|ts|css)$/.test(file) && !file.startsWith(ASSETS))
    .map((file) => readFileSync(file, 'utf8'))
    .concat(readFileSync(join(SITE, 'astro.config.mjs'), 'utf8')) // the header logo is named there
    .join('\n');
  const manifest = JSON.parse(readFileSync(join(SITE, 'shots.json'), 'utf8')).shots as Array<{ file: string }>;

  test('no picture sits unreferenced', () => {
    const orphans = walk(ASSETS)
      .map((file) => relative(ASSETS, file))
      .filter((file) => !sources.includes(`assets/${file}`));
    assert.deepEqual(orphans, [], 'an image under site/src/assets no page uses; delete it or use it');
  });

  test("every screenshot the manifest makes is a page's picture", () => {
    for (const { file } of manifest) {
      assert.ok(existsSync(join(ASSETS, file)), `${file} is in site/shots.json but not on disk; run node scripts/docs-shots.mjs ${file}`);
      assert.ok(sources.includes(`assets/${file}`), `${file} is in site/shots.json but no page shows it`);
    }
  });

  test('every manifest entry names a sample App with a seed, a database the browser opens, or a library story, and a route', async () => {
    const { SEEDS, WORKBENCH, appDirectory } = await import('../scripts/docs-shots.mjs');
    for (const entry of manifest as Array<Record<string, any>>) {
      /* A story is the component library's own fixture, cut from the built library: it has no App and no route. */
      if (entry.story) {
        assert.match(entry.story, /^[a-z0-9-]+--[a-z0-9-]+$/, `${entry.file}: a story is a library story id`);
        assert.ok(!entry.app && !entry.workbench, `${entry.file}: a story names no App`);
        continue;
      }
      if (entry.workbench)
        assert.ok(entry.workbench in WORKBENCH && !entry.app, `${entry.file}: no database ${entry.workbench} for the browser`);
      else {
        assert.ok(entry.app in SEEDS, `${entry.file}: no seed for ${entry.app}`);
        assert.ok(existsSync(join(ROOT, appDirectory(entry.app))), `${entry.file}: no App ${appDirectory(entry.app)}`);
      }
      assert.match(entry.route, /^\//, `${entry.file}: a route starts with /`);
      assert.ok(['desk', 'phone'].includes(entry.viewport), `${entry.file}: viewport is desk or phone`);
    }
  });
});

describe('the how-to template', () => {
  test('every page that has opted in follows it', () => {
    for (const page of HOW_TO_PAGES as string[]) {
      const problems = lintHowTo(readFileSync(join(DOCS, 'docs', `${page}.md`), 'utf8'));
      assert.deepEqual(problems, [], `${page}.md breaks the how-to template`);
    }
  });

  test('a page in the shape passes, and one that breaks it fails for each part', () => {
    const fixtures = join(ROOT, 'test/fixtures/docs');
    assert.deepEqual(lintHowTo(readFileSync(join(fixtures, 'howto-good.md'), 'utf8')), []);
    const found = lintHowTo(readFileSync(join(fixtures, 'howto-bad.md'), 'utf8')).join('\n');
    for (const part of [
      /description is \d+ words/,
      /first paragraph must be the description/,
      /no example/,
      /no picture/,
      /out of order|needs a "## When to use it/,
      /Common mistakes/,
      /Related/,
    ]) {
      assert.match(found, part);
    }
  });

  test('a task done at the command line or in mistri.json may lead with that command or entry', () => {
    const good = readFileSync(join(ROOT, 'test/fixtures/docs/howto-good.md'), 'utf8');
    const lead = /```ts title="[^"]+"\n[\s\S]*?```\n\n\[See it in the sample\]\([^)]+\)\.\n/;
    assert.match(good, lead, 'the good fixture changed shape; update this test');
    const cli = good.replace(lead, '```sh\nnpx mistri migrate up --app .\n```\n');
    const config = good.replace(
      lead,
      '```ts\nauth: { providers: [oidc(\'staff\')] },\n```\n\n```json\n{ "name": "staff", "kind": "oidc" }\n```\n',
    );
    assert.deepEqual(lintHowTo(cli), []);
    assert.deepEqual(lintHowTo(config), []);
    /* An App fragment alone is not cut from anything: it still needs its sample. */
    const loose = good.replace(lead, "```ts\nauth: { providers: ['email'] },\n```\n");
    assert.match(lintHowTo(loose).join('\n'), /needs title="examples\/apps/);
  });
});

describe('sample lines', () => {
  /* A how-to page's example is cut from a sample: its lines are there, in
     order (a `// …` line stands for lines left out), and the "See it in the
     sample" link after it lands on its first line, indentation aside (an
     excerpt may start at the left margin). A sample edit that moves
     or changes a quoted line fails here, so a page cannot drift from the App
     it quotes. test/dsl-tour.test.ts holds the tour to the same rule. */
  test('every titled fence on a how-to page is cut from its sample, at the linked line', () => {
    for (const page of HOW_TO_PAGES as string[]) {
      const text = readFileSync(join(DOCS, 'docs', `${page}.md`), 'utf8');
      const fences = [
        ...text.matchAll(
          /^```tsx? title="(examples\/apps\/[^"]+)"\n([\s\S]*?)^```\n\nSee it in the sample \(`(examples\/apps\/[^`:]+):(\d+)`\)/gm,
        ),
      ];
      for (const [, title, body, linked, at] of fences) {
        assert.equal(linked, title, `${page}.md: the link after a ${title} fence names ${linked}`);
        const file = readFileSync(join(ROOT, title), 'utf8')
          .split('\n')
          .map((text) => text.trim());
        const lines = body
          .replace(/\n$/, '')
          .split('\n')
          .map((text) => text.trim());
        let line = Number(at) - 1;
        assert.equal(file[line], lines[0], `${page}.md: ${title}#L${at} is not the fence's first line`);
        let skipping = false;
        for (const quoted of lines) {
          if (quoted === '// …') {
            skipping = true;
            continue;
          }
          const found = skipping ? file.indexOf(quoted, line) : file[line] === quoted ? line : -1;
          assert.ok(found >= 0, `${page}.md: ${title} no longer has, at or after line ${line + 1}:\n  ${quoted}`);
          line = found + 1;
          skipping = false;
        }
      }
    }
  });

  /* The chooser is the one copy of the intent-to-block rules: the agent
     skill sends its agent to it (`mistri docs choose`) rather than
     carrying its own. Each rule names the sample line that does what it
     says, and every line it cites is a line of the sample that is not blank
     (test/agent-skill.test.ts also holds each line to the code its rule names). */
  test('the chooser, which the agent skill routes to, cites sample lines that are there', () => {
    const cited = (text: string) =>
      new Set([...text.matchAll(/`(examples\/apps\/[^`:]+):(\d+)`/g)].map(([, path, line]) => `${path}#L${line}`));
    assert.match(readFileSync(join(ROOT, 'skills/mistri/SKILL.md'), 'utf8'), /mistri docs choose/, 'the skill routes to the chooser');
    const chooser = cited(readFileSync(join(DOCS, 'docs/choose.md'), 'utf8'));
    assert.ok(chooser.size >= 40, `the chooser cites ${chooser.size} sample lines; the extraction broke`);
    for (const link of chooser) {
      const [path, line] = link.split('#L');
      assert.ok(existsSync(join(ROOT, path)), `${path}: no such sample file`);
      if (line)
        assert.ok(readFileSync(join(ROOT, path), 'utf8').split('\n')[Number(line) - 1]?.trim(), `${link} is a blank line or past the end`);
    }
  });
});

describe('the new-App path', () => {
  /* The home shows it and Get started walks it, each step run for real: one copy of every file and command. */
  test("Get started's files and commands are the home page's, word for word", () => {
    const fences = (file: string) =>
      new Map(
        [...readFileSync(join(DOCS, file), 'utf8').matchAll(/```(\w+) title="([^"]+)"\n([\s\S]*?)```/g)].map((match) => [
          match[2],
          match[3],
        ]),
      );
    const home = fences('index.mdx');
    const guide = readFileSync(join(DOCS, 'docs/getting-started.md'), 'utf8');
    for (const file of ['schema.sql', 'mistri.json', 'app.ts'])
      assert.equal(fences('docs/getting-started.md').get(file), home.get(file), file);
    const commands = home
      .get('Terminal')!
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter(Boolean);
    assert.equal(commands.length, 5);
    for (const command of commands) assert.ok(guide.includes(`\`\`\`sh\n${command}\n\`\`\``), command);
  });
});

describe('the generated DSL reference', () => {
  test('is what the generator writes now', () => {
    const files = build() as Record<string, string>;
    const stale = Object.entries(files)
      .filter(([name, text]) => !existsSync(join(OUT, name)) || readFileSync(join(OUT, name), 'utf8') !== text)
      .map(([name]) => name);
    const extra = readdirSync(OUT).filter((name) => !(name in files) && owned(name));
    assert.deepEqual([...stale, ...extra], [], 'run node scripts/dsl-reference.mjs and commit the pages');
  });

  test('--check says so from the command line', () => {
    const ran = spawnSync(process.execPath, ['scripts/dsl-reference.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  });
});

describe('the generated CLI reference', () => {
  test("is what the generator writes from each binary's USAGE now", () => {
    const pages = buildCli();
    for (const [bin, path] of Object.entries(CLI_PAGES))
      assert.equal(readFileSync(path, 'utf8'), pages[bin], `run node scripts/cli-reference.mjs and commit ${bin}'s page`);
  });

  test('--check says so from the command line', () => {
    const ran = spawnSync(process.execPath, ['scripts/cli-reference.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  });
});

/* The DSL and CLI generators fail on a public name with no entry; the other
   inventory sections are written by hand, so each name is held to its page here. */
describe('every public name has an entry', () => {
  const inventory = readInventory().sections as Record<string, Record<string, string>>;
  const page = (name: string) => readFileSync(join(DOCS, 'docs', `${name}.md`), 'utf8');

  test('each check code is a row of mistri check, with the anchor its docs link lands on', () => {
    const text = page('check-codes');
    const missing = Object.keys(inventory.checkCodes).filter((code) => !text.includes(`<span id="${code}"></span>`));
    assert.deepEqual(missing, []);
  });

  test('each MCP tool is named on the MCP page', () => {
    const text = page('mcp');
    const missing = Object.keys(inventory.mcp)
      .map((name) => name.replace(/^tool /, ''))
      .filter((tool) => !text.includes(`\`${tool}\``));
    assert.deepEqual(missing, []);
  });
});

describe('the home and the quickstarts', () => {
  const home = readFileSync(join(DOCS, 'index.mdx'), 'utf8');
  const config = readFileSync(join(SITE, 'astro.config.mjs'), 'utf8');
  const title = (slug: string) => /^title: "?([^"\n]+)"?$/m.exec(readFileSync(join(DOCS, `docs/${slug}.md`), 'utf8'))![1];

  test('the home counts the sample Apps the Sample Apps page and the catalog ship', () => {
    const catalog = readFileSync(join(ROOT, 'examples/apps/README.md'), 'utf8');
    const shipped = readdirSync(join(ROOT, 'examples/apps'), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(shipped.length, 3, 'the home says three sample Apps');
    for (const entry of shipped) assert.match(catalog, new RegExp(`\\| ${entry.name}`, 'i'));
    assert.match(home, /<strong>Three sample Apps<\/strong>/);
    assert.doesNotMatch(home, /Nine sample Apps/);
  });

  test('Get started comes first after the home, and the App drafted from a database is titled by where it comes from', () => {
    assert.equal(title('getting-started'), 'Get started');
    assert.ok(config.includes("{ label: 'Home', slug: 'index' },\n            { label: 'Get started', slug: 'docs/getting-started' }"));
    assert.ok(readFileSync(join(DOCS, 'docs/getting-started.md'), 'utf8').includes('## From a schema of your own'));
    assert.equal(title('quickstart-app'), 'An App from your database');
    assert.ok(config.includes("label: 'An App from your database', slug: 'docs/quickstart-app'"));
  });

  test('the home has a header and a footer of its own, and the sidebar does not call it a thing it is not', () => {
    assert.match(config, /Header: '\.\/src\/components\/Header\.astro'/);
    assert.match(config, /Footer: '\.\/src\/components\/Footer\.astro'/);
    assert.ok(config.includes("label: 'Home', slug: 'index'"));
    assert.ok(!config.includes('What tablewalk is'));
  });
});

describe('the changelog page', () => {
  test('is in the sidebar beside the status page, and its route reads CHANGELOG.md', () => {
    const config = readFileSync(join(SITE, 'astro.config.mjs'), 'utf8');
    assert.match(config, /slug: 'docs\/status' \},\n.*\n\s*\{ label: 'Changelog', link: '\/docs\/changelog\/' \}/);
    const route = readFileSync(join(SITE, 'src/pages/docs/changelog.astro'), 'utf8');
    assert.ok(route.includes("CHANGELOG.md'"), 'the page is generated from the file, not a copy of it');
  });

  test('lists every release, repeats no anchor and has no h1 of its own', async () => {
    const { changelogPage } = await import('../site/src/changelog.mjs');
    const markdown = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const { html, headings } = changelogPage(markdown);
    const releases = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(
      headings.map((heading: { text: string }) => heading.text),
      releases,
    );
    assert.doesNotMatch(html, /<h1\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('sends a repository path to its site page or to GitHub', async () => {
    const { rewriteHref } = await import('../site/src/changelog.mjs');
    assert.equal(rewriteHref('site/src/content/docs/docs/build-an-api.md'), '/docs/build-an-api/');
    assert.equal(rewriteHref('site/src/content/docs/docs/themes.md#looks'), '/docs/themes/#looks');
    assert.equal(rewriteHref('docs/boundary.md'), 'https://github.com/rbaljinder/mistri/blob/main/docs/boundary.md');
    assert.equal(rewriteHref('https://tablewalk.dev/docs/themes/'), 'https://tablewalk.dev/docs/themes/');
  });
});
