#!/usr/bin/env node
/**
 * The tarballs have what they need and nothing they should not.
 *
 * Reads the JSON `npm pack --workspaces --dry-run --json` printed (a file
 * named on the command line) after `npm run build`: a pack builds nothing
 * (each package's prepack refuses a missing dist/), so the build comes first.
 *
 * It runs in two places, the release's preflight and CI's package job, from
 * this one file. It lived only in the release once, inline, and kept asking
 * for files the tablewalk tarball had stopped shipping when the package
 * split; nothing ran it between releases, so the first tag after the split
 * would have failed there. CI runs it on every change now.
 */
import { readFileSync } from 'node:fs';

const report = process.argv[2];
if (!report) {
  console.error('usage: node scripts/check-tarballs.mjs <npm pack --json output>');
  process.exit(2);
}
const packs = Object.fromEntries(JSON.parse(readFileSync(report, 'utf8')).map((p) => [p.name, p.files.map((f) => f.path)]));
/* The client entry is named for its content, so it is found the way a browser
   finds it: by the module script index.html names. Its compressed copies are
   what the server sends, and its map is what a trace reads. Each product
   builds its own client (config/vite.tablewalk.config.ts,
   config/vite.mistri.config.ts). */
const client = (product) => {
  const html = readFileSync(`packages/${product}/dist/client/index.html`, 'utf8');
  const entry = /<script type="module"[^>]*\ssrc="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!entry) {
    console.error(`::error::${product}'s dist/client/index.html names no module entry under assets/`);
    process.exit(1);
  }
  return ['index.html', 'index.html.br', 'index.html.gz', entry, entry + '.br', entry + '.gz', entry + '.map'].map(
    (p) => 'dist/client/' + p,
  );
};
const common = ['package.json', 'README.md', 'LICENSE'];
/* `schema/` is in mistri's exports map (`@mistriwork/mistri/app`, the JSON
   schemas): a tarball without it installs and then fails at the first import.
   tablewalk ships dist/ alone (its `files`): the App schema and typings are
   mistri's since the split. */
const need = {
  '@mistriwork/engine': [...common, 'dist/server/connections.js'],
  '@mistriwork/kit': [...common, 'dist/clientFiles.js'],
  '@mistriwork/mistri': [
    ...common,
    ...client('mistri'),
    'dist/server/index.js',
    'dist/server/app/apps.js',
    'schema/app.d.ts',
    'schema/app.mjs',
    'schema/app.schema.json',
    'schema/page.schema.json',
    'skills/mistri/SKILL.md',
  ],
  'create-mistri': [...common, 'bin.js'],
  '@mistriwork/cloudflare': [...common, 'dist/index.js', 'dist/index.d.ts'],
  tablewalk: [...common, ...client('tablewalk'), 'dist/server/index.js'],
};
let failed = false;
for (const [name, files] of Object.entries(packs)) {
  const missing = (need[name] ?? common).filter((p) => !files.includes(p));
  if (missing.length) {
    console.error(`::error::${name} tarball is missing:`, missing.join(', '));
    failed = true;
  }
  const leak = files.filter((p) => /(^|\/)(\.env|credentials\.json|tablewalk\.json)$|(^|\/)\.demo\//.test(p));
  if (leak.length) {
    console.error(`::error::${name} tarball would ship something private:`, leak.join(', '));
    failed = true;
  }
  console.log(name, files.length, 'files');
}
const absent = Object.keys(need).filter((name) => !packs[name]);
if (absent.length) {
  console.error('::error::no tarball for', absent.join(', '));
  failed = true;
}
if (failed) process.exit(1);
console.log('dist present in every package, nothing private');
