#!/usr/bin/env node
/**
 * The client's size, held to a ceiling. Run by `npm run build`, after Vite.
 *
 * What a first visit must download before anything paints is the page's
 * entry script, the surface chunk the page preloads, everything that script imports statically, and its
 * stylesheet; parts loaded on demand (components/onDemand.tsx) come later and
 * are not counted. That weight only ever grew: it reached 3.4 MB unminified
 * before anyone looked, and was still 1.4 MB minified when a review measured
 * it again. `test/built-client-browser.mjs` measured and asserted nothing.
 *
 * The targets are round numbers about 3% above what ships, so an ordinary
 * change passes and a new dependency pulled into the entry does not. A target
 * moves only in a release's budget commit, with its reason beside it (see
 * BUDGET), and comes down when a release measures more than 5% under it;
 * moving new weight behind `onDemand` is usually the better answer.
 *
 * What the page then does with those bytes — how late its largest paint is,
 * whether anything moves under the reader, how long a click takes to answer —
 * has budgets of its own beside these, in test/built-client-vitals.mjs.
 *
 * @mistriwork/mistri/react (dist/embed) has ceilings of its own, `EMBED_BUDGET` below,
 * and must hold no require() at all (`embedRequires`): it is ES modules a
 * host's bundler or browser takes in, where a CommonJS call has nothing to
 * call. One left by a bundled dependency stopped the built embed starting.
 *
 *   node scripts/bundle-budget.mjs          check the kit's dist/client and mistri's dist/embed
 *   node scripts/bundle-budget.mjs --print  say the sizes, check nothing
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The binary's built client (config/vite.mistri.config.ts), held to its own ceilings. The database browser's
    Workbench and its ceilings live in its own repository (https://github.com/rbaljinder/tablewalk). */
export const CLIENTS = {
  mistri: join(ROOT, 'packages/mistri/dist/client'),
};
const EMBED = join(ROOT, 'packages/mistri/dist/embed/react');

/* Targets, in bytes, per first page. Brotli is what a browser is sent (the server prefers the `.br` beside each
   file) and is the figure that matters; raw is what it parses and compiles, held as a guard.

   THE RULE. A target is a deliberate number, not the last measurement plus the room a feature happened to need.
   Each is a round figure about 3% above what the build measured when it was set. A target moves only in a
   release's budget commit, with its reason written beside it (below) and a CHANGELOG line; never in a feature's
   commit. A feature that would cross its target pays the bytes back (move the weight behind components/onDemand.tsx,
   or remove something) or waits for that commit. When a release measures more than 5% under a target, the target
   comes down to the measurement plus about 3%. The build prints each figure's headroom (the --print output).

   Each surface is its own first page (vite.config.ts `surfaces`): the entry, the chunks its page preloads and what
   those import statically. The stylesheet is one for every surface.

   HISTORY, condensed. At 0.8.0, before the split, every page was one 1,416,155 raw / 352,764 br script and one
   285,932 / 40,465 stylesheet; the split into surfaces took the public script to 647,899 / 176,299 and the App's to
   1,204,892 / 322,970, and the App manifest parser leaving first paint (test/repo/structure.test.ts) brought them
   down again. Each opt-in look's own rules left the first stylesheet (they are fetched where worn) and left what every
   look shares plus the default. Since then the first paint has grown only by named work, each time with its ceiling
   moved by the amount measured: the shared list work, forms' review step, the inbox bell, the built-in looks and their
   palettes (rc.2, rc.3: +12,367 raw / +1,416 br on the public script, +5,892 / +968 for Ledger), the one-request tenant
   entry (rc2), the live-refresh client (rc/storm: a write's refresh files the tables it read), the clean break's
   renamed keys (brotli packs the new spellings 100 to 150 bytes worse), the phone drawer's rules, the primary-action
   color, rc.11's money, documents and review fixes, and rc.15's inputs (time, rating, scan, color, files, signature),
   reactions, copy cells, week and day calendar, grouped grid and tree picker. The Workbench left for its own
   repository, and its ceilings with it. rc.16's plumbing replaced the old ceilings, each about 250 bytes above the
   measure, with the targets below.

   Set at rc.16, measured on that build (raw / br): public script 680,330 / 189,816, style 395,803 / 53,137; App script
   1,415,725 / 388,229, style 395,684 / 53,108. */
export const BUDGET = {
  mistri: {
    public: { script: { raw: 700_000, br: 196_000 }, style: { raw: 408_000, br: 55_000 } },
    app: { script: { raw: 1_460_000, br: 400_000 }, style: { raw: 408_000, br: 55_000 } },
  },
};

/* @mistriwork/mistri/react, measured without React and the routers (the host's) and in brotli as this script compresses it:
   the package's files are a host bundler's input, not served as they are, so they carry no .br of their own.
   `provider` is what a host's page pays for importing @mistriwork/mistri/react at all — the entry, its Provider and
   elements, the navigator, the session and the protocol check — and is held small on purpose: the shell is a chunk
   of its own, loaded by an effect the first time an element is on screen. `adapter` is the largest router adapter
   with what it imports (the navigator). `shell` is that chunk with its static imports: the served client's shell,
   built once more with the embed's seams and its stylesheets as scoped text (config/vite.embed.config.ts). It is library
   output, whose whitespace Vite leaves for the host's minifier, so its raw size is larger than the served
   client's for the same code; what loads after it is the same split into parts loaded on demand as when served.
   The rule is the first paint's (see BUDGET): round targets about 3% above the measure, moved only in a release's budget
   commit. The first measure, when @mistriwork/mistri/react arrived: provider 13,112 / 4,678, adapter 3,452 / 1,332,
   shell 514,833 / 80,881. Its shell has since taken the served shell's growth (the Lumen refresh, theme waves, the
   states and phone passes, rc.11's fixes) and rc.15's scoping class, `.mistri-root` named twice in every rule
   (scripts/embed-css.mjs: about 31 KB raw, 368 bytes in brotli, raw text a host's bundler compresses).
   Set at rc.16, measured: provider 14,413 / 5,157, adapter 3,475 / 1,368, shell 629,214 / 88,746. */
export const EMBED_BUDGET = {
  provider: { raw: 15_000, br: 5_300 },
  adapter: { raw: 3_600, br: 1_400 },
  shell: { raw: 650_000, br: 91_500 },
};

/* The chrome's words in a language besides English (vite.config.ts LOCALE_GROUP, src/client/copy/<lang>.ts), one chunk
   each, which only a reader of that language fetches — preloaded beside the entry (clientSurface.ts localePreloads).
   English stays in the entry, so these are no surface's first paint; each is held on its own instead, so a language
   cannot grow into a second catalog unnoticed. First measure, the shared words only (Spanish): 2,453 / 881; rc.16 measures 2,711 / 958, and the
   targets sit about 3% above, as every other does. */
export const LOCALE_BUDGET = { raw: 2_800, br: 990 };

/** Each language's words chunk in one binary's client, raw and in brotli. */
export function localeSizes(client = CLIENTS.mistri) {
  const sizes = {};
  for (const file of readdirSync(join(client, 'assets'))) {
    const language = /^copy\.([a-z]{2,3})-[\w-]+\.js$/.exec(file)?.[1];
    if (!language) continue;
    const bytes = readFileSync(join(client, 'assets', file));
    sizes[language] = { raw: bytes.length, br: brotliCompressSync(bytes).length };
  }
  return sizes;
}

/** A file and everything it imports statically, as the library build writes imports (`from "./x.js"`). */
function staticClosure(roots) {
  const files = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*"(\.\.?\/[^"]+\.js)"/g)) {
      pending.push(join(dirname(file), path));
    }
  }
  return [...files];
}

/** @mistriwork/mistri/react's three measures, raw and in brotli. */
export function embedSizes(embed = EMBED) {
  const measure = (files) =>
    files.reduce(
      (sum, file) => {
        const bytes = readFileSync(file);
        return { raw: sum.raw + bytes.length, br: sum.br + brotliCompressSync(bytes).length };
      },
      { raw: 0, br: 0 },
    );
  const shell = readdirSync(join(embed, 'chunks')).find((file) => /^shell-[\w-]{8}\.js$/.test(file));
  if (!shell) throw new Error('The embed build has no shell chunk.');
  const adapters = ['next', 'react-router', 'tanstack-router'].map((name) => measure(staticClosure([join(embed, `${name}.js`)])));
  return {
    provider: measure(staticClosure([join(embed, 'index.js')])),
    adapter: adapters.reduce((largest, next) => (next.br > largest.br ? next : largest)),
    shell: measure(staticClosure([join(embed, 'chunks', shell)])),
  };
}

/**
 * The files under dist/embed that still call require(), each with the first
 * call in it. config/vite.embed.config.ts says why there must be none, and how there
 * came to be one: a CommonJS dependency's `require("react")` that
 * esmExternalRequirePlugin did not rewrite, left to rolldown's runtime shim
 * (`typeof require` and its "doesn't expose the `require` function" throw).
 */
export function embedRequires(embed = dirname(EMBED)) {
  const call = /(?<![\w$.])require\s*\(|typeof require\b/;
  /** @type {Array<{ file: string, excerpt: string }>} */
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.m?js$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        const at = text.search(call);
        if (at >= 0) found.push({ file: path.slice(ROOT.length + 1), excerpt: text.slice(Math.max(0, at - 40), at + 40) });
      }
    }
  };
  walk(embed);
  return found;
}

/** Each surface's first page, the binary whose client it is, and the chunks past it that it loads at once. Each
    page names its own (vite.config.ts PAGES): an App's preloads the shell with the App's chrome. */
export const SURFACES = {
  public: { bin: 'mistri', page: 'index.public.html', chunks: [] },
  app: { bin: 'mistri', page: 'index.html', chunks: [] },
};
/** A surface's ceilings: its binary's. */
export const ceilingOf = (surface) => BUDGET[SURFACES[surface].bin][surface];

/**
 * A first visit's files: the page's entry, the chunks it preloads and any
 * named here, what they import statically, and the page's stylesheets.
 * @param {keyof typeof SURFACES} surface
 */
export function firstPaint(surface = 'app', client = CLIENTS[SURFACES[surface].bin]) {
  const { page, chunks } = SURFACES[surface];
  const html = readFileSync(join(client, page), 'utf8');
  const local = (path) => join(client, path.replace(/^\//, ''));
  const scripts = new Set();
  const pending = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => local(match[1]));
  pending.push(...[...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => local(match[1])));
  const assets = readdirSync(join(client, 'assets'));
  for (const name of chunks) {
    const file = assets.find((file) => new RegExp(`^${name}-[\\w-]{8}\\.js$`).test(file));
    if (!file) throw new Error(`The build has no ${name} chunk.`);
    pending.push(join(client, 'assets', file));
  }
  while (pending.length) {
    const file = pending.pop();
    if (scripts.has(file)) continue;
    scripts.add(file);
    /* Static imports only, as the minifier writes them (`from"./x.js"`,
       `import"./x.js"`); `import("./x.js")` is a part loaded on demand. */
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*"(\.\/[^"]+\.js)"/g)) {
      pending.push(join(dirname(file), path));
    }
  }
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => local(match[1]));
  const measure = (files) =>
    files.reduce(
      (sum, file) => ({
        raw: sum.raw + statSync(file).size,
        br: sum.br + (existsSync(`${file}.br`) ? statSync(`${file}.br`) : statSync(file)).size,
      }),
      { raw: 0, br: 0 },
    );
  return { scripts: [...scripts], styles, script: measure([...scripts]), style: measure(styles) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [bin, client] of Object.entries(CLIENTS))
    if (!existsSync(join(client, 'index.html'))) {
      console.error(`Build the client first: npm run build (${bin}'s is missing).`);
      process.exit(1);
    }
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  /* What is left of a target, and a word when the release measures more than 5% under it: the rule (see BUDGET)
     brings such a target down in that release's budget commit. */
  const room = (size, target) =>
    `${(((target - size) / target) * 100).toFixed(1)}% room${size < target / 1.05 ? ', over 5% under: lower it' : ''}`;
  const over = [];
  for (const surface of /** @type {Array<keyof typeof SURFACES>} */ (Object.keys(SURFACES))) {
    const shipped = firstPaint(surface);
    for (const kind of ['script', 'style']) {
      for (const measure of ['raw', 'br']) {
        const size = shipped[kind][measure],
          ceiling = ceilingOf(surface)[kind][measure];
        console.log(`${SURFACES[surface].bin} ${surface} ${kind} ${measure}: ${kb(size)} of ${kb(ceiling)} (${room(size, ceiling)})`);
        if (size > ceiling)
          over.push(
            `the ${surface} first paint's ${kind} is ${kb(size)} ${measure === 'br' ? 'in brotli' : 'raw'}, over its ${kb(ceiling)} target`,
          );
      }
    }
  }
  for (const [bin, client] of Object.entries(CLIENTS))
    for (const [language, sizes] of Object.entries(localeSizes(client))) {
      for (const measure of /** @type {const} */ (['raw', 'br'])) {
        console.log(`${bin} words ${language} ${measure}: ${kb(sizes[measure])} of ${kb(LOCALE_BUDGET[measure])}`);
        if (sizes[measure] > LOCALE_BUDGET[measure])
          over.push(
            `${bin}'s ${language} words are ${kb(sizes[measure])} ${measure === 'br' ? 'in brotli' : 'raw'}, over their ${kb(LOCALE_BUDGET[measure])} target`,
          );
      }
    }
  if (!existsSync(join(EMBED, 'index.js'))) {
    console.error('Build @mistriwork/mistri/react first: npm run build.');
    process.exit(1);
  }
  const embedded = embedSizes();
  for (const part of /** @type {Array<keyof typeof EMBED_BUDGET>} */ (Object.keys(EMBED_BUDGET))) {
    for (const measure of /** @type {const} */ (['raw', 'br'])) {
      const size = embedded[part][measure],
        ceiling = EMBED_BUDGET[part][measure];
      console.log(`@mistriwork/mistri/react ${part} ${measure}: ${kb(size)} of ${kb(ceiling)} (${room(size, ceiling)})`);
      if (size > ceiling)
        over.push(
          `@mistriwork/mistri/react's ${part} is ${kb(size)} ${measure === 'br' ? 'in brotli' : 'raw'}, over its ${kb(ceiling)} target`,
        );
    }
  }
  const requires = embedRequires();
  for (const { file, excerpt } of requires) console.error(`${file} calls require(): …${excerpt.replace(/\s+/g, ' ')}…`);
  if (requires.length) {
    console.error(
      '@mistriwork/mistri/react must hold no require(): no browser or ESM host provides one. A CommonJS dependency reaching React is rewritten by esmExternalRequirePlugin in config/vite.embed.config.ts, which must be the only place those specifiers are made external.',
    );
    process.exitCode = 1;
  }
  if (over.length && !process.argv.includes('--print')) {
    console.error(
      `Bundle budget: ${over.join('; ')}. Move the new weight behind components/onDemand.tsx, or wait for the release's budget commit (the rule is in scripts/bundle-budget.mjs).`,
    );
    process.exitCode = 1;
  }
}
