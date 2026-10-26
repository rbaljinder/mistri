#!/usr/bin/env node
/*
 * Exports nobody imports. An `export` on a name that no other file in the
 * repository mentions is either dead code or a module boundary drawn in the
 * wrong place, and tsc's noUnusedLocals cannot see either: an export counts
 * as used. This builds one token index over every source, test, spec,
 * schema and example file (each read once, so it runs in about a second)
 * and reports every name a non-test module under a package's src/ exports that appears
 * in no other file.
 *
 * The allowlist (audit-exports.allow) is today's findings. It may only
 * shrink: a new finding fails, and so does an entry that is no longer a
 * finding, so the list never keeps a name that was since fixed. Mentions
 * are words, not resolved imports — a name spoken in another file's comment
 * counts as used — so the audit undercounts and never reports a name that
 * something reaches.
 *
 *   node scripts/audit-exports.mjs          check (npm test runs this)
 *   node scripts/audit-exports.mjs --prune  drop allowlist entries that are fixed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowFile = fileURLToPath(new URL('./audit-exports.allow', import.meta.url));
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|js|mjs)$/;

const files = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '--', 'packages', 'test', 'e2e', 'examples', 'scripts', '*.ts'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  // A file deleted in the working tree is still in the index until the commit.
  .filter((file) => CODE.test(file) && !file.startsWith('e2e/.tmp/') && existsSync(root + file));

const text = new Map(files.map((file) => [file, readFileSync(root + file, 'utf8')]));
const mentions = new Map();
for (const [file, source] of text) {
  for (const token of new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const seen = mentions.get(token);
    if (seen) seen.add(file);
    else mentions.set(token, new Set([file]));
  }
}

/* What a module declares as exported. Re-exports (`export … from`) are a
   barrel's business: the name is the other module's, audited there. */
const exportedNames = (source) => {
  const names = new Set();
  for (const m of source.matchAll(
    /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(m[1]);
  for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?!from)(?:;|$)/gm)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return names;
};

const findings = [];
for (const [file, source] of text) {
  if (!/^packages\/[^/]+\/src\//.test(file) || TEST.test(file) || file.endsWith('.d.ts')) continue;
  for (const name of exportedNames(source)) {
    const where = mentions.get(name);
    if (![...(where ?? [])].some((other) => other !== file)) findings.push(`${file} ${name}`);
  }
}
findings.sort();

const allowText = readFileSync(allowFile, 'utf8');
const allowed = new Set(
  allowText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);
const found = new Set(findings);
const fresh = findings.filter((entry) => !allowed.has(entry));
const fixed = [...allowed].filter((entry) => !found.has(entry));

if (process.argv.includes('--prune')) {
  writeFileSync(
    allowFile,
    allowText
      .split('\n')
      .filter((line) => !fixed.includes(line.trim()))
      .join('\n'),
  );
  console.log(`audit-exports: pruned ${fixed.length} fixed entr${fixed.length === 1 ? 'y' : 'ies'}.`);
  process.exit(fresh.length ? 1 : 0);
}
if (fresh.length) {
  console.error(`audit-exports: ${fresh.length} exported name(s) no other file mentions. Drop the export, delete the name, or use it:`);
  for (const entry of fresh) console.error(`  ${entry}`);
}
if (fixed.length) {
  console.error(
    `audit-exports: ${fixed.length} allowlist ${fixed.length === 1 ? 'entry is no longer a finding' : 'entries are no longer findings'}; run \`node scripts/audit-exports.mjs --prune\`:`,
  );
  for (const entry of fixed) console.error(`  ${entry}`);
}
if (fresh.length || fixed.length) process.exit(1);
console.log(`audit-exports: ${files.length} files, ${allowed.size} allowlisted names, nothing new.`);
