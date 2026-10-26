#!/usr/bin/env node
/**
 * The command-line reference, generated from the help text.
 *
 * Each binary's `--help` (USAGE in packages/tablewalk/src/server/cli/usage.ts, the database browser's, and
 * packages/mistri/src/server/cli/usage.ts, the App framework's) is the one statement of its commands and
 * flags; test/prose.test.ts already holds each README to it. This lays the same text out as a page per binary: the commands, every server flag as a row,
 * each later section (check, shot, migrate, build, …) as its own heading with
 * its text as written, and an index naming the section of every flag. It
 * fails when a CLI name the public-surface inventory lists has no entry, so a
 * flag cannot ship without a line here.
 *
 *   node scripts/cli-reference.mjs           regenerate site/src/content/docs/docs/cli.md and cli-browser.md
 *   node scripts/cli-reference.mjs --check   fail if the committed page differs (test/docs-site.test.ts runs this)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { readInventory, usageText } from './public-surface.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Each binary's page: the App framework's is the reference's Command line, the database browser's beside it. */
export const PAGES = {
  mistri: join(ROOT, 'site/src/content/docs/docs/cli.md'),
  tablewalk: join(ROOT, 'site/src/content/docs/docs/cli-browser.md'),
};
const WHAT = { mistri: 'the App framework', tablewalk: 'the database browser' };

/** The column the lead's descriptions start at. */
const SAYS = 34;
const FLAG = /^( {2}| {6})((?:-[a-zA-Z], )?--[a-z][a-z-]*(?: (?:<[^>]+>|\[[^\]]+\]))*)(?:\s+(.*))?$/;
const flagsOf = (text) => [...new Set([...text.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]))];
const cell = (text) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const code = (text) => `\`${text.replace(/`/g, "'")}\``;

/** USAGE as its parts: the command lines, the Options block, then each titled section. */
function parse(usage) {
  const lines = usage.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const isHeading = (line, i) => /^\S.*:$/.test(line) && /^\s+\S/.test(lines.slice(i + 1).find((next) => next.trim()) ?? '');
  const parts = [];
  let current = { title: '', lines: [] };
  lines.forEach((line, i) => {
    if (isHeading(line, i)) {
      parts.push(current);
      current = { title: line.slice(0, -1), lines: [] };
    } else current.lines.push(line);
  });
  parts.push(current);
  return parts;
}

/** The lead's `<bin> …` lines with what each says, continuation lines joined. */
function commands(lines, bin) {
  const found = [];
  for (const line of lines) {
    /* What a command says starts at the help's description column, even where the usage runs up to it. */
    const command = new RegExp(`^ {2}(${bin}(?: \\S+)*?)(?: {2,}(.*))?$`).exec(
      line.length > SAYS && line[SAYS - 1] === ' ' ? `${line.slice(0, SAYS - 1).trimEnd()}  ${line.slice(SAYS)}` : line,
    );
    if (command) {
      found.push({ usage: command[1], says: command[2] ?? '' });
      continue;
    }
    if (found.length && /^ {10,}\S/.test(line)) found.at(-1).says += ` ${line.trim()}`;
  }
  return found;
}

/** The Options block as one row per flag, its description lines joined. */
function options(lines) {
  const found = [];
  for (const line of lines) {
    const flag = FLAG.exec(line);
    if (flag) {
      found.push({ spec: flag[2], says: flag[3] ?? '' });
      continue;
    }
    if (found.length && line.trim()) found.at(-1).says += ` ${line.trim()}`;
  }
  return found;
}

const dedent = (lines) => {
  const body = lines
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .split('\n');
  const indent = Math.min(...body.filter((line) => line.trim()).map((line) => /^ */.exec(line)[0].length));
  return body.map((line) => line.slice(Math.min(indent, /^ */.exec(line)[0].length)));
};

/** One binary's page, and every flag and command it names (for the inventory check across both). */
function page(bin) {
  const usage = usageText(bin);
  if (!usage) throw new Error(`cli-reference: USAGE moved in packages/${bin}/src/server/cli/usage.ts`);
  const [lead, optionsPart, ...sections] = parse(usage);
  if (optionsPart.title !== 'Options')
    throw new Error(`cli-reference: expected "Options:" after the commands, found "${optionsPart.title}"`);
  const slugger = new GithubSlugger();
  const heading = (title) => title.split(' — ')[0];
  const anchors = new Map([
    ['Commands', slugger.slug('Commands')],
    ['Options', slugger.slug('Options')],
  ]);
  for (const section of sections) anchors.set(section.title, slugger.slug(heading(section.title)));

  const out = [
    '---',
    bin === 'mistri' ? 'title: Command line' : 'title: "Command line: database browser"',
    `description: "Every ${bin} command and flag, ${WHAT[bin]}'s, laid out from the help text the command prints: what each does, and where its section is."`,
    '---',
    '',
    `<!-- Generated by scripts/cli-reference.mjs from USAGE in packages/${bin}/src/server/cli/usage.ts. Do not edit by hand. -->`,
    '',
    `Every ${bin} command and flag — ${WHAT[bin]}'s — laid out from the help text the command`,
    `prints: what each does, and where its section is. \`npx ${bin} --help all\``,
    `prints the same text, \`npx ${bin} --help\` the commands and common options`,
    `on one screen, and \`npx ${bin} <command> --help\` one command's.`,
    bin === 'mistri'
      ? "Browsing a database with no App is the database browser's: [its command line](/docs/cli-browser/)."
      : "An App is the App framework's: [its command line](/docs/cli/).",
    '',
    `The first line of the help says it: *${cell(lead.lines.find((line) => line.trim()) ?? '')}*`,
    '',
    '## Commands',
    '',
    '| Command | What it does |',
    '| --- | --- |',
  ];
  for (const { usage: line, says } of commands(lead.lines, bin))
    out.push(`| ${code(line)} | ${cell(says) || 'Open it in the database browser.'} |`);
  out.push(
    '',
    '## Options',
    '',
    bin === 'mistri'
      ? "The server's flags: where the data is, how it is served, and what an App adds."
      : "The server's flags: where the data is, and how it is served.",
    '',
    '| Flag | What it does |',
    '| --- | --- |',
  );
  for (const { spec, says } of options(optionsPart.lines)) out.push(`| ${code(spec)} | ${cell(says)} |`);
  out.push('');
  for (const section of sections) {
    const [title, rest] = [heading(section.title), section.title.split(' — ').slice(1).join(' — ')];
    /* A flag in a heading is code, or the site's typography makes its two hyphens a dash and the anchor moves. */
    out.push(`## ${title.replace(/--[a-z][a-z-]*/g, (flag) => `\`${flag}\``)}`, '');
    if (rest) out.push(`${rest[0].toUpperCase()}${rest.slice(1)}.`, '');
    out.push('```text', ...dedent(section.lines), '```', '');
  }

  /* Each flag, and the sections that say it: the entry the inventory is held to. */
  const where = new Map();
  const note = (flag, title) => {
    if (!where.has(flag)) where.set(flag, []);
    if (!where.get(flag).includes(title)) where.get(flag).push(title);
  };
  for (const { spec } of options(optionsPart.lines)) for (const flag of flagsOf(spec)) note(flag, 'Options');
  for (const { usage: line } of commands(lead.lines, bin)) for (const flag of flagsOf(line)) note(flag, 'Commands');
  for (const section of sections) for (const flag of flagsOf(section.lines.join('\n'))) note(flag, section.title);
  for (const { says } of options(optionsPart.lines)) for (const flag of flagsOf(says)) if (!where.has(flag)) note(flag, 'Options');
  out.push('## Every flag, and where it is', '', '| Flag | Said in |', '| --- | --- |');
  for (const flag of [...where.keys()].sort()) {
    out.push(
      `| ${code(flag)} | ${where
        .get(flag)
        .map((title) => `[${heading(title)}](#${anchors.get(title)})`)
        .join(', ')} |`,
    );
  }
  out.push('');
  return { text: out.join('\n'), where };
}

/** Both pages, by binary; fails when a public CLI name is on neither. */
export function build() {
  const pages = Object.fromEntries(Object.keys(PAGES).map((bin) => [bin, page(bin)]));
  const missing = Object.keys(readInventory().sections.cli).filter((name) => {
    const [kind, value] = name.split(' ');
    return !Object.entries(pages).some(([bin, { text, where }]) =>
      kind === 'flag' ? where.has(value) : new RegExp(`\\b${bin} ${value}\\b`).test(text),
    );
  });
  if (missing.length) throw new Error(`cli-reference: public CLI names with no entry: ${missing.join(', ')}`);
  return Object.fromEntries(Object.entries(pages).map(([bin, { text }]) => [bin, text]));
}

function main() {
  const pages = build();
  if (process.argv.includes('--check')) {
    for (const [bin, text] of Object.entries(pages)) {
      if (!existsSync(PAGES[bin]) || readFileSync(PAGES[bin], 'utf8') !== text) {
        console.error('The generated CLI reference is stale. Run node scripts/cli-reference.mjs');
        process.exit(1);
      }
    }
    return;
  }
  for (const [bin, text] of Object.entries(pages)) {
    writeFileSync(PAGES[bin], text);
    console.log(`Wrote ${relative(ROOT, PAGES[bin])}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
