// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/**
 * The agent skill (skills/mistri), held to what it names.
 *
 * A skill is prose an agent obeys without checking, so every claim in it that
 * a machine can check is checked here: its frontmatter is what the Agent
 * Skills format reads; every `tablewalk` command, flag and `mistri docs`
 * topic it names is one this tablewalk has; every sample line it links still
 * exists and still says what the rule beside it names (the line is opened,
 * not only the file); every screenshot it names ships; and its rubric is the
 * agent guide's, word for word. Then `mistri agent init` is run into a
 * scratch project to hold what it promises: a copy where each agent reads,
 * idempotence, an edited copy left alone, and one AGENTS.md block.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docPage } from '../packages/mistri/src/server/docs.js';
import { runAgent } from '../packages/mistri/src/server/cli/agentInit.js';
import { BROWSER_COMMANDS } from '../packages/tablewalk/src/server/cli/browserCommands.js';
import { MISTRI_COMMANDS } from '../packages/mistri/src/server/cli/mistriCommands.js';

const ROOT = new URL('../', import.meta.url);
/* A copy's sample links are re-aimed at node_modules; the rest of it is the shipped file. */
const unaimed = (text: string) => text.replace(/(?:\.\.\/)+(?:node_modules\/@mistriwork\/mistri\/)?examples\/apps\//g, 'EXAMPLES/');
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const SKILL = 'skills/mistri/';
const files = ['SKILL.md', ...readdirSync(new URL(`${SKILL}references/`, ROOT)).map((name) => `references/${name}`)];
const texts = files.map((file) => ({ file, text: read(`${SKILL}${file}`) }));

/* Both binaries' words: the skill names an App's commands (mistri's) and the database browser's. */
const USAGE = ['tablewalk', 'mistri']
  .map((bin) => /const USAGE = `([\s\S]*?)`/.exec(read(`packages/${bin}/src/server/cli/usage.ts`))![1])
  .join('\n');
const FLAGS = new Set([...USAGE.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]));
/* The subcommands are the words a main reads before any flag: its table's, and the two the App framework's main
   reads itself (`dev`, `schema --brief`). */
const SUBCOMMANDS = new Set([
  ...Object.keys(BROWSER_COMMANDS),
  ...Object.keys(MISTRI_COMMANDS),
  ...[...read('packages/mistri/src/server/cli/mistriMain.ts').matchAll(/process\.argv\[2\] === '([a-z-]+)'/g)].map((match) => match[1]),
]);

/** Every piece of code in a Markdown text: fenced blocks and inline spans. */
function code(text: string): string[] {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const inline = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline];
}

/** A Markdown text as its items: a bullet, a numbered step, a table row or a paragraph, with its continuation lines. */
function items(text: string): string[] {
  const out: string[] = [];
  let blank = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      blank = true;
      continue;
    }
    if (blank || /^\s*(- |\d+\. |\|)/.test(line)) out.push(line);
    else out[out.length - 1] += `\n${line}`;
    blank = false;
  }
  return out;
}

/** What a text names that this tablewalk does not have: a command, a flag, a docs topic or a guide screenshot. */
function unknownNames(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const piece of code(text)) {
    for (const match of piece.matchAll(/(?:^|[\s(])(tablewalk|mistri)\s+([^\s`]+)(?:\s+([^\s`]+))?/g)) {
      const [, bin, word, next] = match;
      // A database path or URL is the start form, `tablewalk <sqlite-file>`, not a subcommand.
      const database = /^(\.{0,2}\/|[a-z]+:\/\/)|\.(db|sqlite3?)$/.test(word);
      if (!word.startsWith('-') && !database && !SUBCOMMANDS.has(word)) problems.push(`${file}: "${bin} ${word}" is not a command`);
      if (word === 'docs' && next && !next.startsWith('-') && !next.startsWith('<') && !docPage(next))
        problems.push(`${file}: mistri docs ${next} has no page`);
      if (word === 'agent' && next !== 'init') problems.push(`${file}: "mistri agent ${next}" is not a command`);
    }
    const at = piece.search(/\b(tablewalk|mistri)\b/);
    const flags =
      at >= 0 ? [...piece.slice(at).matchAll(/(?<=\s)--[a-z][a-z-]+/g)].map((m) => m[0]) : /^--[a-z][a-z-]+$/.test(piece) ? [piece] : [];
    for (const flag of flags) if (!FLAGS.has(flag)) problems.push(`${file}: ${flag} is not a flag either binary takes`);
    if (/^compose-[a-z-]+$/.test(piece) && !docPage(piece)) problems.push(`${file}: ${piece} is not a docs topic`);
  }
  for (const match of text.matchAll(/mistri docs ([a-z][a-z0-9-]+)/g)) {
    if (!docPage(match[1])) problems.push(`${file}: mistri docs ${match[1]} has no page`);
  }
  for (const match of text.matchAll(/`([a-z-]+\.webp)`/g)) {
    if (!existsSync(new URL(`site/src/assets/guide/${match[1]}`, ROOT))) problems.push(`${file}: no guide screenshot ${match[1]}`);
  }
  return problems;
}

/* A sample line, cited one of two ways: the skill links the shipped file's path (`../../../examples/apps/…`, which
   resolves inside node_modules/tablewalk, offline and at the installed version); the site's pages name it in a
   code span (`examples/apps/lintel/views.ts:65`), because the repository is private and a link would be a 404. */
const SAMPLE = /\[([^\]]+)\]\((?:(?:\.\.\/)+)examples\/apps\/([^)#]+)#L(\d+)\)|`examples\/apps\/([^`:]+):(\d+)(?:[–-]\d+)?`/g;
/** A match as [whole, label, path, line]; a code span is labelled by what it says. */
const cited = (match: RegExpMatchArray): [string, string, string, string] =>
  match[2] ? [match[0], match[1], match[2], match[3]] : [match[0], `${match[4]}:${match[5]}`, match[4], match[5]];
const STOP = new Set(['true', 'false', 'null']);

/**
 * Every sample line the texts link, opened: a problem for each that is gone
 * or no longer shows the code its rule names. `labelled` says whether a
 * link's words name where it points.
 */
function sampleLines(texts: ReadonlyArray<{ file: string; text: string }>, labelled: (label: string, at: string) => boolean) {
  const problems: string[] = [];
  let links = 0;
  for (const { file, text } of texts) {
    for (const item of items(text)) {
      const found = [...item.matchAll(SAMPLE)];
      const spans = (part: string) =>
        [...part.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1])
          .filter((span) => !span.endsWith('.webp') && !/^(npx )?tablewalk /.test(span) && !/^examples\/apps\/.*:\d+/.test(span));
      found.forEach((match, i) => {
        links++;
        const [whole, label, path, lineNo] = cited(match);
        const at = `${file}: ${label}`;
        if (!labelled(label, `${path}:${lineNo}`)) {
          problems.push(`${at} is labelled differently from where it points (${path}#L${lineNo})`);
        }
        const sample = new URL(`examples/apps/${path}`, ROOT);
        if (!existsSync(sample)) {
          problems.push(`${at}: examples/apps/${path} does not exist`);
          return;
        }
        const line = readFileSync(sample, 'utf8').split('\n')[Number(lineNo) - 1];
        if (line === undefined) {
          problems.push(`${at}: the file has no line ${lineNo}`);
          return;
        }
        /* What the rule names is the code beside this link — between the
           link before it and the one after — or, where that is bare, the
           whole rule's. */
        const from = i > 0 ? found[i - 1].index! + found[i - 1][0].length : 0;
        const to = i < found.length - 1 ? found[i + 1].index! : item.length;
        const near = spans(item.slice(from, match.index!) + item.slice(match.index! + whole.length, to));
        const named = near.length ? near : spans(item);
        if (!named.length) {
          problems.push(`${at}: the rule names no code for its line to show`);
          return;
        }
        const words = named.flatMap((span) => span.match(/[A-Za-z_][\w]+/g) ?? []).filter((word) => !STOP.has(word));
        const shows = named.some((span) => line.includes(span)) || words.some((word) => new RegExp(`\\b${word}\\b`).test(line));
        if (!shows)
          problems.push(`${at}: line ${lineNo} is "${line.trim()}", which shows none of ${named.map((span) => `\`${span}\``).join(', ')}`);
      });
    }
  }
  return { problems, links };
}

describe('the agent skill', () => {
  test('SKILL.md has the frontmatter the Agent Skills format reads', () => {
    const text = read(`${SKILL}SKILL.md`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, 'SKILL.md starts with YAML frontmatter');
    /* Parsed as the strict subset it is written in — flat `key: plain scalar`
       lines — so a colon-space or a # that YAML would read otherwise fails here. */
    const fields: Record<string, string> = {};
    for (const line of front![1].split('\n')) {
      const match = /^([a-z-]+): (.+)$/.exec(line);
      assert.ok(match, `not a flat key: value line: ${line}`);
      assert.doesNotMatch(match![2], /: | #|^[>|&*!%@`'"[{]/, `${match![1]} must be a plain scalar`);
      fields[match![1]] = match![2];
    }
    for (const key of Object.keys(fields)) {
      assert.ok(
        ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key),
        `${key} is not a frontmatter key of the format`,
      );
    }
    assert.equal(fields.name, 'mistri', "the name is the folder's");
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fields.description && fields.description.length <= 1024, 'a description of at most 1024 characters');
    assert.match(fields.description, /building or changing a mistri App/, 'the description says when to load it');
    assert.ok(!fields.compatibility || fields.compatibility.length <= 500);
    const body = text.slice(front![0].length);
    assert.ok(body.split('\n').length <= 80, `SKILL.md is ${body.split('\n').length} lines; keep it short and move detail to references/`);
  });

  test('SKILL.md links every reference file, one level deep, and each is there', () => {
    const skill = read(`${SKILL}SKILL.md`);
    const linked = new Set([...skill.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)].map((match) => match[1]));
    for (const file of files.filter((file) => file !== 'SKILL.md')) assert.ok(linked.has(file), `SKILL.md does not link ${file}`);
    for (const file of linked) assert.ok(existsSync(new URL(`${SKILL}${file}`, ROOT)), `SKILL.md links ${file}, which is missing`);
  });

  test('it routes to the reference rather than carrying a copy of it', () => {
    /* The intent-to-block rules are `mistri docs choose`; a references/
       file that restated them would go stale beside it. */
    assert.match(read(`${SKILL}SKILL.md`), /mistri docs choose/);
    const line = (match: RegExpMatchArray) => `${cited(match)[2]}#L${cited(match)[3]}`;
    const chooser = new Set([...read('site/src/content/docs/docs/choose.md').matchAll(SAMPLE)].map(line));
    for (const { file, text } of texts) {
      const copied = [...text.matchAll(SAMPLE)].filter((match) => chooser.has(line(match))).length;
      assert.ok(copied <= 5, `${file} cites ${copied} of the chooser's sample lines; point at mistri docs choose instead`);
    }
  });

  test('every command, flag and docs topic it names is one this tablewalk has', () => {
    assert.deepEqual(
      texts.flatMap(({ file, text }) => unknownNames(file, text)),
      [],
    );
  });

  /* The field report that moved them: every sample link pointed at GitHub, which a sandboxed agent could not reach and
     which shows main, not the tablewalk installed. The samples' sources ship (package.json `files`), so the skill
     links the file in the package, by a path relative to the skill's own file. */
  test('every sample it links is a file the package ships, linked by its path in the package', () => {
    const shipped: string[] = JSON.parse(read('packages/mistri/package.json')).files;
    assert.ok(shipped.includes('examples/apps/**/*.{ts,tsx,md}'), "package.json files ships the sample Apps' sources");
    const problems: string[] = [];
    let links = 0;
    for (const { file, text } of texts) {
      for (const [, target] of text.matchAll(/\]\(([^)\s]*examples\/apps\/[^)\s]*)\)/g)) {
        links++;
        const path = target.split('#')[0];
        if (/^https?:/.test(path)) {
          problems.push(`${file}: ${target} is a URL; link the shipped file (../../../examples/apps/…)`);
          continue;
        }
        const resolved = posix.join(posix.dirname(`${SKILL}${file}`), path);
        if (!resolved.startsWith('examples/apps/')) problems.push(`${file}: ${target} resolves to ${resolved}, outside examples/apps/`);
        else if (!existsSync(new URL(resolved, ROOT))) problems.push(`${file}: ${target} resolves to ${resolved}, which is missing`);
        else if (!/\.(ts|tsx|md)$/.test(resolved) || resolved.endsWith('.test.tsx'))
          problems.push(`${file}: ${target} is not a file the package ships (its sources: .ts, .tsx and .md, not tests)`);
      }
    }
    assert.ok(links >= 60, `found ${links} sample links; the extraction broke`);
    assert.deepEqual(problems, []);
  });

  test('every sample line it links is there and still shows what its rule names', () => {
    /* The intent-to-block rules the skill sends its agent to (`mistri docs
       choose`) are held here too, the way the skill's own once were. */
    const chooser = {
      file: 'site/src/content/docs/docs/choose.md',
      text: read('site/src/content/docs/docs/choose.md'),
    };
    const { problems, links } = sampleLines([...texts, chooser], (label, at) => label === at);
    assert.ok(links >= 60, `found ${links} sample links; the extraction broke`);
    assert.deepEqual(problems, []);
  });

  test("its rubric is the agent guide's, check for check", () => {
    const sections = (text: string) => {
      const out: Record<string, string[]> = {};
      let current = '';
      for (const item of items(text)) {
        const heading = /^\*\*([A-Z][a-z ]+)\*\*/.exec(item);
        if (heading) {
          current = heading[1];
          out[current] = [];
          continue;
        }
        if (current && item.startsWith('- ')) out[current].push(item.slice(2).replace(/\s+/g, ' '));
        else current = '';
      }
      return out;
    };
    const guide = read('site/src/content/docs/docs/build-with-an-agent.md');
    const rubric = /## 3\. Acceptance: the rubric\n([\s\S]*?)\n## /.exec(guide)?.[1];
    assert.ok(rubric, "the guide's rubric section moved; update the extraction here");
    const theirs = sections(rubric!);
    assert.ok(Object.keys(theirs).length >= 6, "the guide's rubric headings were not found");
    assert.deepEqual(sections(read(`${SKILL}references/rubric.md`)), theirs);
  });
});

/* The site's composition guides link the same sample lines by a shorter name
   ("opportunity.ts:15–34", "depot/views.ts:213"), and are held the same way:
   a sample edit that moves a line a guide points at fails here. */
describe('the composition guides', () => {
  const GUIDES = 'site/src/content/docs/docs/';
  const guides = readdirSync(new URL(GUIDES, ROOT))
    .filter((name) => /^compose-[a-z-]+\.md$/.test(name))
    .map((name) => ({
      file: `${GUIDES}${name}`,
      text: read(`${GUIDES}${name}`),
    }));

  test('every sample line a guide links is there and still shows what its rule names', () => {
    assert.ok(guides.length >= 6, 'the compose-*.md guides were not found');
    const { problems, links } = sampleLines(guides, (label, at) => {
      const named = label.replace(/[–-]\d+$/, '');
      return at === named || at.endsWith(`/${named}`);
    });
    assert.ok(links >= 40, `found ${links} sample links; the extraction broke`);
    assert.deepEqual(problems, []);
  });
});

describe('mistri agent init', () => {
  const run = (argv: string[]) => {
    let out = '';
    let err = '';
    const code = runAgent(
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

  test('copies the skill where each agent reads it, once, and points at it from AGENTS.md', () => {
    const project = mkdtempSync(join(tmpdir(), 'tablewalk-agent-'));
    try {
      writeFileSync(join(project, 'AGENTS.md'), '# House rules\n\nRun the tests.\n');
      const first = run(['init', '--dir', project]);
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /\.claude\/skills\/mistri \(claude\): installed/);
      assert.match(first.out, /\.agents\/skills\/mistri \(codex, cursor, copilot\): installed/);
      for (const home of ['.claude/skills/mistri', '.agents/skills/mistri']) {
        for (const file of files) {
          assert.equal(
            unaimed(readFileSync(join(project, home, file), 'utf8')),
            unaimed(read(`${SKILL}${file}`)),
            `${home}/${file} is the shipped file`,
          );
        }
      }
      const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
      assert.match(
        agents,
        /^# House rules\n\nRun the tests\.\n\n<!-- mistri:skill:start/,
        "the project's own words are kept, the block after them",
      );
      assert.match(agents, /`\.claude\/skills\/mistri\/SKILL\.md` or `\.agents\/skills\/mistri\/SKILL\.md`/);
      const block = agents.slice(agents.indexOf('<!-- mistri:skill:start'));
      assert.ok(block.split('\n').length <= 60, `the AGENTS.md block is ${block.split('\n').length} lines; it is a map, keep it at 60`);
      for (const command of ['schema --brief', 'check --app . --brief', 'explain <code>', '--text', '--both']) {
        assert.ok(block.includes(command), `the AGENTS.md block names ${command}`);
      }
      assert.deepEqual(unknownNames('AGENTS.md', block), []);

      const again = run(['init', '--dir', project]);
      assert.equal(again.code, 0);
      assert.equal((again.out.match(/up to date/g) ?? []).length, 3, 'a re-run changes nothing and says so');
      assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), agents, 'one block, not two');

      const edited = join(project, '.claude/skills/mistri/references/rubric.md');
      writeFileSync(edited, 'our own rubric\n');
      const kept = run(['init', '--dir', project, '--tool', 'claude']);
      assert.equal(kept.code, 1, 'a copy left alone is not success');
      assert.match(kept.out, /left alone: changed since it was installed \(references\/rubric\.md\); --force replaces it/);
      assert.equal(readFileSync(edited, 'utf8'), 'our own rubric\n');

      const forced = run(['init', '--dir', project, '--tool', 'claude', '--force']);
      assert.equal(forced.code, 0);
      assert.match(forced.out, /replaced \(--force\)/);
      assert.equal(unaimed(readFileSync(edited, 'utf8')), unaimed(read(`${SKILL}references/rubric.md`)));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('one tool writes its own place; a copy it did not install is left alone', () => {
    const project = mkdtempSync(join(tmpdir(), 'tablewalk-agent-'));
    try {
      const codex = run(['init', '--dir', project, '--tool', 'codex']);
      assert.equal(codex.code, 0, codex.err);
      assert.ok(existsSync(join(project, '.agents/skills/mistri/SKILL.md')));
      assert.ok(!existsSync(join(project, '.claude')), 'nothing for a tool not asked for');
      assert.match(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /follow its loop:\n`\.agents\/skills\/mistri\/SKILL\.md`\./);

      mkdirSync(join(project, '.claude/skills/mistri'), { recursive: true });
      writeFileSync(join(project, '.claude/skills/mistri/SKILL.md'), '---\nname: mistri\n---\nours\n');
      const theirs = run(['init', '--dir', project, '--tool', 'claude']);
      assert.equal(theirs.code, 1);
      assert.match(theirs.out, /a copy mistri did not install/);

      assert.match(run(['init', '--tool', 'vim']).err, /--tool "vim" is not one of claude, codex, cursor, copilot or all/);
      assert.match(run(['setup']).err, /unknown agent command "setup"/);
      assert.match(run([]).out, /^mistri agent init/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('re-aims the sample links at node_modules/@mistriwork/mistri, where each resolves to a real file', () => {
    const project = mkdtempSync(join(tmpdir(), 'tablewalk-agent-links-'));
    try {
      /* The package as an install lays it out: its own files, and the examples a pack carries in from the checkout. */
      const installed = join(project, 'node_modules', '@mistriwork', 'mistri');
      const own = join(fileURLToPath(ROOT), 'packages', 'mistri');
      mkdirSync(installed, { recursive: true });
      for (const entry of readdirSync(own)) symlinkSync(join(own, entry), join(installed, entry));
      symlinkSync(join(fileURLToPath(ROOT), 'examples'), join(installed, 'examples'), 'dir');
      assert.equal(run(['init', '--dir', project]).code, 0);
      let checked = 0;
      for (const home of ['.claude/skills/mistri', '.agents/skills/mistri']) {
        for (const file of files) {
          const copy = join(project, home, file);
          const text = readFileSync(copy, 'utf8');
          assert.ok(!/\]\((?:\.\.\/)+examples\//.test(text), `${home}/${file} keeps no link aimed at the package's own layout`);
          for (const match of text.matchAll(
            /\]\(([^)\s]*node_modules\/@mistriwork\/mistri\/examples\/apps\/[^)\s#]+)(#L\d+(?:-L\d+)?)?\)/g,
          )) {
            const target = resolve(dirname(copy), match[1]);
            assert.ok(existsSync(target), `${home}/${file} links ${match[1]}, which does not exist`);
            checked++;
          }
        }
      }
      assert.ok(checked > 0, 'the skill links sample files');
      const shipped = texts.reduce((n, { text }) => n + (text.match(/\]\((?:\.\.\/)+examples\/apps\//g) ?? []).length, 0);
      assert.equal(checked, shipped * 2, 'every sample link is re-aimed in both copies, anchors kept');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
