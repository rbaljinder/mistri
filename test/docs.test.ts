// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/**
 * The reference the package ships: the site's Markdown, read by `tablewalk
 * docs` and the MCP shelf, and every pointer at it that must land.
 *
 * An author holding only the npm package once found every App link in the
 * README and `--help` naming a file the package does not carry, and
 * `mistri docs` opened a SQLite file called "docs". The pages are one
 * source (site/src/content/docs/docs, copied to dist/docs by the build); the
 * checks here hold that each topic exists and fits a screen, that the command
 * lists, prints and searches them, and that every "see `mistri docs X`" in
 * the code, the README and USAGE names a page that is there.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_TOPICS, docPage, docPages, docsDir, renderDoc, runDocs, searchDocs } from '../packages/mistri/src/server/docs.js';
import { listResources, readResource } from '../packages/tablewalk/src/server/mcp/shelf.js';
import { DOC_TEMPLATE, docResources, docTopicNames, readDoc } from '../packages/mistri/src/server/observe/docShelf.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { inPackages } from './support/packages.js';

const capture = (argv: string[]) => {
  let out = '';
  let err = '';
  const code = runDocs(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
};

describe('the shipped reference', () => {
  test('is read from the site in a checkout, and every topic is a page with a title and a purpose', () => {
    assert.match(docsDir() ?? '', /site[\\/]src[\\/]content[\\/]docs[\\/]docs[\\/]?$/);
    for (const { topic } of DOC_TOPICS) {
      const page = docPage(topic);
      assert.ok(page, `mistri docs ${topic} has no page`);
      assert.ok(page!.title && page!.description, `${topic} needs a title and a description`);
    }
  });

  test('a topic written for it fits one screen', () => {
    /* The long guides keep their length; the topics are the page an error
       points at, and a page an error points at is read at once or not at all. */
    for (const { topic, page } of DOC_TOPICS) {
      /* getting-started is a walkthrough, a step a section, run top to bottom. check-codes is the table every problem's `docs` link lands in, a row per code: looked up, not read through.
         design-lint is the same for the design and grade codes `mistri explain` points at. dashboards is the
         reference for every dashboard section (a row a kind) and for the grid a layout places them on. */
      if (
        page === 'getting-started' ||
        page === 'status' ||
        page === 'check-codes' ||
        page === 'design-lint' ||
        page === 'theme-contract' ||
        page === 'dashboards'
      )
        continue;
      const lines = docPage(topic)!.body.split('\n').length;
      assert.ok(lines <= 70, `${topic} is ${lines} lines; a topic is one screen`);
    }
  });

  test('docs <topic> --brief is the page as its headings and the first sentence under each', () => {
    const full = capture(['commands']);
    for (const argv of [
      ['commands', '--brief'],
      ['--brief', 'commands'],
    ]) {
      const brief = capture(argv);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /^# Commands\n/);
      assert.match(brief.out, /^Who may run it: The server runs a command only for a role granted it/m);
      assert.match(brief.out, /mistri docs commands prints the whole page/);
      assert.ok(brief.out.length < full.out.length / 8, `${brief.out.length} vs ${full.out.length}`);
      assert.ok(brief.out.split('\n').length <= 40, 'one screen');
    }
    assert.equal(capture(['--brief']).code, 1, 'a summary of nothing is refused');
  });

  test('mistri docs lists, prints and searches', () => {
    const list = capture([]);
    assert.equal(list.code, 0);
    for (const { topic } of DOC_TOPICS) assert.match(list.out, new RegExp(`^ {2}${topic} `, 'm'));
    assert.match(list.out, /^ {2}app-dsl /m, 'the longer guides are listed after the topics');
    const one = capture(['relationships']);
    assert.equal(one.code, 0);
    assert.match(one.out, /^# Relationships\n/);
    assert.match(one.out, /\]\(mistri docs sources\)/, 'a site link is said as the command that opens it');
    assert.equal(capture(['getting-started']).out, renderDoc(docPage('getting-started')!));
    assert.equal(capture(['migrate']).out, renderDoc(docPage('change-your-schema')!), 'a topic may name an existing page');
    const missing = capture(['nope']);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no topic "nope"\. Topics: getting-started, access-model/);
    const found = capture(['--search', 'previous', 'period']);
    assert.equal(found.code, 0);
    assert.match(found.out, /^dashboards +/m);
    assert.equal(capture(['--search']).code, 1);
    assert.ok(searchDocs('zzzz-not-a-word').length === 0);
  });

  test("a guide page names its worked example's screenshot as a file that is there", () => {
    const out = capture(['compose-record-page']).out;
    const shot = /\]\(([^)]+\.webp)\)/.exec(out)?.[1];
    assert.ok(shot && existsSync(shot), `the screenshot is said as a file: ${shot}`);
  });

  /* The site links a sample line on GitHub, which a sandboxed agent cannot reach and which shows main, not the
     version installed; the samples' sources ship, so the CLI names the file. */
  test("a guide page names its sample lines as the package's files, not GitHub's", () => {
    const out = capture(['compose-list']).out;
    // Said as a path while the repository is private (a link to GitHub would 404), or as a link once it is public.
    const samples = [...out.matchAll(/(?:\]\(|`)([^)`\s]*examples\/apps\/[^)`#:\s]+)(?:#L\d+|:\d+(?:-\d+)?)?(?:\)|`)/g)].map(
      (match) => match[1],
    );
    assert.ok(samples.length >= 5, `compose-list links its sample lines: ${samples.length}`);
    for (const sample of samples) {
      assert.doesNotMatch(sample, /^https?:/, `a sample said as a URL: ${sample}`);
      assert.ok(existsSync(sample), `the sample is said as a file that is there: ${sample}`);
    }
  });

  test('a maintainer comment in a page is not printed', () => {
    const page = { ...docPage('secrets')!, body: `${docPage('secrets')!.body}\n\n<!-- TODO(maintainer): a note for the next edit. -->\n` };
    assert.doesNotMatch(renderDoc(page), /<!--|TODO|maintainer/);
  });

  test('every pointer at a topic in the code, the README and USAGE names a page that exists', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : [],
      );
    const texts = [
      ...inPackages('src/server').flatMap(files),
      ...inPackages('src/shared').flatMap(files),
      'packages/mistri/README.md',
      'packages/mistri/schema/app.d.ts',
      ...docPages().map((page) => join(docsDir()!, `${page.name}.md`)),
    ];
    const named = new Set<string>();
    for (const file of texts) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:tablewalk|mistri) docs ([a-z][a-z0-9-]+)/g)) named.add(match[1]);
    }
    assert.ok(named.has('relationships') && named.has('secrets'), 'the scan found the refusals');
    for (const name of named) assert.ok(docPage(name), `"mistri docs ${name}" names no shipped page`);
  });

  test("the App framework's agent server lists the topics and reads any page; the database MCP lists none", async () => {
    const uris = docResources().map((resource) => resource.uri);
    assert.ok(uris.includes('mistri://docs/topic/build-with-an-agent'));
    for (const { topic } of DOC_TOPICS) assert.ok(uris.includes(`mistri://docs/topic/${topic}`), topic);
    assert.equal(DOC_TEMPLATE.uriTemplate, 'mistri://docs/topic/{topic}');
    const read = (uri: string) => readDoc(uri) as { contents?: Array<{ text: string }>; error?: string };
    assert.match(read('mistri://docs/topic/access-model').contents![0].text, /^# Resources and fields/);
    assert.match(read('mistri://docs/topic/app-dsl').contents![0].text, /^# DSL reference/);
    assert.match(read('mistri://docs/topic/../README').error!, /No page at/);
    assert.ok(docTopicNames().includes('access-model'));
    // The database browser's server serves no App, so it shelves no App reference.
    const registry = new Registry();
    let listed: { resources: Array<{ uri: string }> } | undefined;
    listResources(registry, { queries: [], pages: [] }, (reply) => {
      listed = (reply as { result: typeof listed }).result;
    });
    assert.deepEqual(listed!.resources, []);
    let answered: { error?: { message: string } } | undefined;
    await readResource(registry, { queries: [], pages: [] }, { uri: 'mistri://docs/topic/access-model' }, (reply) => {
      answered = reply as typeof answered;
    });
    assert.match(answered!.error!.message, /No resource at/);
  });
});
