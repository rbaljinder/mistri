#!/usr/bin/env node
/**
 * The public surface, as a checked-in inventory.
 *
 * From 1.0.0 the public surface is a promise (docs/compatibility.md): a public
 * name may be added, never renamed or removed before the next major version.
 * This script reads every public name from where it is declared and writes
 * them, sorted, to test/fixtures/public-surface.json; test/public-surface.test.ts
 * compares the live surface with that file. Every change, an addition too, is
 * the regenerated file in the same commit, so a review sees what moved.
 *
 *   node scripts/public-surface.mjs --write           regenerate the inventory
 *   node scripts/public-surface.mjs --write --major   ... and let a public name go (a major release only)
 *   node scripts/public-surface.mjs --check           diff it against the code (exit 1 on a difference)
 *
 * Once package.json's version is 1.0.0 or later, `--write` refuses to drop a
 * public name or demote one to preview unless `--major` says this is the
 * release that may; deprecate it instead (packages/mistri/src/shared/deprecations.ts).
 *
 * Each entry is `public` or `preview`. Preview is read from the two places the
 * project says it: the Preview rows of docs/status.md (hand-mapped to key paths
 * in PREVIEW below) and a JSDoc
 * `@preview` tag on an exported name.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { published } from './pack-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INVENTORY = join(ROOT, 'test/fixtures/public-surface.json');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/* ---------- preview status ---------- */

/* The one list of what stays Preview (packages/mistri/src/shared/preview.ts), shared with `mistri check`. */
const { PREVIEW_PATHS, PREVIEW_ENTRIES, PREVIEW_EXPORTS, PREVIEW_CLI } = await tsImport(
  '../packages/mistri/src/shared/preview.ts',
  import.meta.url,
);

/** Key paths (section 1) that the Status page lists as Preview. A path matches
 * when any rule matches it; everything else is public. Keep beside
 * the Preview rows of status.md.
 * Only a resource's `search`: its providers are packs that ship after 1.0, so nothing can be plugged in before then.
 * A new one is a rule here. */
export const PREVIEW = [...PREVIEW_PATHS];
/** Exported names of the preview features (status.md), where a JSDoc `@preview` tag would have to be repeated on types
 * in as many files. Keyed `entry: name`. None at 1.0, which promoted free-form pages' loaders and `renderPage`. */
const PREVIEW_EXPORT_NAMES = new Set(PREVIEW_EXPORTS);
/** A feature slice restates root keys, so `features[].api…` is as preview as `api…`. */
const previewTag = (path) => {
  const bare = path.replace(/^features\[\]\./, '');
  return PREVIEW.some((rule) => rule.test(bare)) ? 'preview' : 'public';
};

/* ---------- 1. the App DSL, from the schemas ---------- */

const schemas = new Map();
const readSchema = (name) => {
  if (!schemas.has(name)) schemas.set(name, JSON.parse(read(`packages/mistri/schema/${name}`)));
  return schemas.get(name);
};

/** Every property path in one schema, `$ref`s followed (a cycle is cut where it closes).
 * A `oneOf`/`anyOf` branch fixed by a constant (`kind`, `type`, …) puts that value in the path. */
/** `visit(path, node, file)` sees each key's own schema node as it is added, which is how scripts/dsl-reference.mjs reads descriptions from the one walk that names the keys. */
export function dslPaths(file, prefix, schemaFile, visit) {
  const out = new Set();
  const refTarget = (ref, from) => {
    const [name, pointer = ''] = ref.split('#');
    const file = name || from;
    let node = schemaFile(file);
    for (const part of pointer.split('/').filter(Boolean)) node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return [node, file];
  };
  const discriminants = (node, file, stack = []) => {
    if (!node || typeof node !== 'object') return {};
    if (node.$ref) {
      if (stack.includes(node.$ref)) return {};
      const [next, nextFile] = refTarget(node.$ref, file);
      return discriminants(next, nextFile, [...stack, node.$ref]);
    }
    const found = {};
    for (const [key, value] of Object.entries(node.properties ?? {})) if (value && value.const !== undefined) found[key] = value.const;
    for (const part of node.allOf ?? []) Object.assign(found, discriminants(part, file, stack));
    return found;
  };
  const listed = new Map(),
    done = new Set();
  const walk = (node, file, path, stack) => {
    if (!node || typeof node !== 'object') return;
    // A key typed by a named enum (an icon, a width, an offset) takes any value of that enum:
    // the values are listed once (icons in their own section), not at every key.
    const named = node.$ref?.match(/#\/\$defs\/([A-Za-z]+)$/)?.[1];
    if (named && NAMED_ENUMS.has(named)) {
      out.add(`${path} = <${named}>`);
      return;
    }
    /* A shape every place that takes one repeats (a message, a link target, a component) is
       listed once under its own name; each key that takes it says so with one `= <name>` entry. */
    const shape = named && SHARED_SHAPES[named];
    if (shape) {
      if (path !== `<${shape}>`) out.add(`${path} = <${shape}>`);
      if (!listed.has(shape)) listed.set(shape, refTarget(node.$ref.replace(/[A-Za-z]+$/, shape), file));
      return;
    }
    if (node.$ref) {
      const key = `${node.$ref.startsWith('#') ? file : ''}${node.$ref}`;
      if (stack.includes(key)) return;
      const [next, nextFile] = refTarget(node.$ref, file);
      return walk(next, nextFile, path, [...stack, key]);
    }
    for (const value of node.enum ?? []) out.add(`${path} = ${JSON.stringify(value)}`);
    if (node.const !== undefined && path) out.add(`${path} = ${JSON.stringify(node.const)}`);
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      const next = path ? `${path}.${key}` : key;
      out.add(next);
      visit?.(next, value, file);
      walk(value, file, next, stack);
    }
    if (node.items) walk(node.items, file, `${path}[]`, stack);
    for (const item of Array.isArray(node.prefixItems) ? node.prefixItems : []) walk(item, file, `${path}[]`, stack);
    if (node.additionalProperties && typeof node.additionalProperties === 'object')
      walk(node.additionalProperties, file, `${path}.*`, stack);
    for (const value of Object.values(node.patternProperties ?? {})) walk(value, file, `${path}.*`, stack);
    for (const key of ['allOf', 'then', 'else']) for (const part of [].concat(node[key] ?? [])) walk(part, file, path, stack);
    for (const key of ['oneOf', 'anyOf'])
      for (const branch of node[key] ?? []) {
        const fixed = discriminants(branch, file);
        const tag = ['kind', 'type', 'realm'].find((name) => name in fixed);
        walk(branch, file, tag ? `${path}[${tag}=${fixed[tag]}]` : path, stack);
      }
  };
  walk(schemaFile(file), file, prefix, []);
  /* A shape is listed once, wherever the walk found it first; its own keys may take another shape. */
  for (let pending = [...listed]; pending.length; pending = [...listed].filter(([name]) => !done.has(name))) {
    for (const [name, [node, nodeFile]] of pending) {
      done.add(name);
      walk(node, nodeFile, `<${name}>`, []);
    }
  }
  return out;
}

/** Enum definitions referenced from many keys, listed once by name. */
const NAMED_ENUMS = new Set(['appIcon', 'offset', 'width', 'region']);

/** Shapes defined once and used at many keys, by `$defs` name: a message that may be translated, a link
 * target (the static one differs only in what its values may be), a component declaration. */
const SHARED_SHAPES = {
  presentationCopy: 'presentationCopy',
  appTarget: 'appTarget',
  appTargetStatic: 'appTarget',
  component: 'component',
};

/** Subtrees the schemas declare twice over one definition, as [copy, original]. Each is
 * checked on every run: when the copy's keys equal the original's, the copy is one
 * `… mirrors …` entry; when they part, the copy is listed in full and the inventory moves.
 * A feature slice restates the App's own content keys; a page file is one `pages` entry;
 * a custom theme is the theme file; a dashboard's aside takes the sections it does. */
function mirrors(schemaFile) {
  const feature = schemaFile('app.schema.json').$defs.feature.properties;
  return [
    ...Object.keys(feature)
      .filter((key) => key !== 'id')
      .map((key) => [`app: features[].${key}`, `app: ${key}`]),
    ['page: page', 'app: pages.*'],
    ['app: ui.customThemes[]', 'theme: theme'],
    ['app: views.*[kind=dashboard].aside[]', 'app: views.*[kind=dashboard].sections[]'],
  ];
}

/** The keys every kind of a section list shares (title, width, offsets, region…) are written once per
 * kind in the schemas. A key under at least this many kinds of one list is listed once for all of them. */
const COMMON_KIND_KEYS = 7;

/** `P[kind=*]key` stands for `P[kind=a]key`, `P[kind=b]key`… where one list of kinds (`sections[]`) repeats it. */
function commonKeys(entries) {
  const found = new Map();
  for (const name of Object.keys(entries)) {
    const match = /^(.*(?:sections|aside)\[\])\[kind=([^\]]+)\](.*)$/.exec(name);
    if (!match || match[3] === '.kind' || match[3].startsWith('.kind ')) continue;
    const key = `${match[1]}[kind=*]${match[3]}`;
    found.set(key, [...(found.get(key) ?? []), name]);
  }
  for (const [key, names] of found) {
    if (names.length < COMMON_KIND_KEYS) continue;
    entries[key] = names.some((name) => entries[name] === 'public') ? 'public' : 'preview';
    for (const name of names) delete entries[name];
  }
}

/** `schemaFile` reads a schema by file name; a test passes an edited copy. */
export function dslSection(schemaFile = readSchema) {
  const entries = {};
  for (const [file, prefix] of [
    ['app.schema.json', ''],
    ['page.schema.json', 'page'],
    ['theme.schema.json', 'theme'],
  ]) {
    for (const path of dslPaths(file, prefix, schemaFile)) {
      if (path.startsWith('$')) continue;
      entries[`${file.split('.')[0]}: ${path}`] = previewTag(path);
    }
  }
  for (const file of ['app.schema.json', 'page.schema.json']) {
    for (const [name, def] of Object.entries(schemaFile(file).$defs ?? {})) {
      if (!NAMED_ENUMS.has(name) || name === 'appIcon') continue;
      for (const value of def.enum) entries[`${file.split('.')[0]}: <${name}> = ${JSON.stringify(value)}`] = 'public';
    }
  }
  commonKeys(entries);
  const under = (prefix) =>
    Object.keys(entries)
      .filter((name) => name === prefix || (/^[.[ ]/.test(name.slice(prefix.length)) && name.startsWith(prefix)))
      .map((name) => name.slice(prefix.length));
  for (const [copy, original] of mirrors(schemaFile)) {
    const copied = under(copy),
      kept = new Set(under(original));
    if (!copied.length || copied.length !== kept.size || !copied.every((rest) => kept.has(rest))) continue;
    for (const rest of copied) delete entries[copy + rest];
    entries[`${copy} mirrors ${original.replace(/^[a-z]+: /, '')}`] = copied.some((rest) => entries[original + rest] === 'public')
      ? 'public'
      : 'preview';
  }
  return entries;
}

/** The names an icon key accepts. Removing one is a break once frozen. */
export function iconsSection(schemaFile = readSchema) {
  const names = schemaFile('app.schema.json').$defs.appIcon.enum;
  if (!Array.isArray(names) || !names.length) throw new Error('public-surface: $defs/appIcon is no longer an enum');
  return Object.fromEntries(names.map((name) => [`icon ${name}`, 'public']));
}

/* ---------- 2. package entry points and their exports ---------- */

/** dist/server/x.d.ts is built from src/server/x.ts; read the source so nothing has to be built first. */
const sourceOf = (types) => (types.startsWith('./dist/') ? types.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts') : types);

async function packageSection() {
  /* TypeScript 7 has no in-process `createProgram`: its API client (unstable until the compiler's API settles) opens a project and asks the checker. */
  const { API, SymbolFlags } = await import('typescript/unstable/sync');
  const api = new API({ cwd: ROOT });
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-surface-'));
  try {
    /* The names the `mistri` package answers as an install reads them (scripts/pack-manifest.mjs): each entry by its
       name, and the JSON schemas its `./schema/*` pattern carries. A pattern is no name an App writes. */
    const pkg = published(JSON.parse(read('packages/mistri/package.json')));
    const named = Object.entries(pkg.exports).filter(([key]) => !key.includes('*'));
    for (const schema of ['app', 'page', 'theme', 'check'])
      named.push([`./schema/${schema}.schema.json`, `./schema/${schema}.schema.json`]);
    const entries = {};
    /* Whole entry points the Status page calls Preview: none since 1.0 promoted the last (mounting in a host's server,
       free-form pages and embedding in a React app). A new one is named here beside its Preview row. */
    const previewEntries = new Set(PREVIEW_ENTRIES);
    let count = 0;
    for (const [key, target] of named) {
      entries[`export ${key}`] = previewEntries.has(key) ? 'preview' : 'public';
      const types = typeof target === 'object' ? target.types : undefined;
      if (!types) continue;
      const file = join(ROOT, 'packages/mistri', sourceOf(types));
      const config = join(directory, `tsconfig.${count++}.json`);
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            types: [],
          },
          files: [file],
        }),
      );
      const { program, checker } = api.updateSnapshot({ openProject: config }).getProject(config);
      const source = program.getSourceFile(file);
      const symbol = source && checker.getSymbolAtLocation(source);
      if (!symbol) throw new Error(`public-surface: cannot read the exports of ${file}`);
      for (const exported of checker.getExportsOfModule(symbol)) {
        const real = exported.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const tagged = checker.getJsDocTagsOfSymbol(real).some((tag) => tag.name === 'preview');
        const name = `${key}: ${exported.name}`;
        entries[name] = tagged || previewEntries.has(key) || PREVIEW_EXPORT_NAMES.has(name) ? 'preview' : 'public';
      }
    }
    return entries;
  } finally {
    api.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/* ---------- 2b. the packages the tree is to be cut into ---------- */

/** One section per package (scripts/boundary/entries.json): the names it is imported by. An App's names (`mistri/*`)
 * are public unless the Status page calls the entry Preview, and so is the database browser's binary; mistri's own
 * main and the scoped packages' names (the engine's, the ui's, the kit's) are Preview. */
function packageEntrySections() {
  const { entries } = JSON.parse(read('scripts/boundary/entries.json'));
  const previewEntries = new Set(PREVIEW_ENTRIES);
  const sections = {};
  for (const name of Object.keys(entries)) {
    const pkg = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
    const subpath = name === pkg ? '.' : `.${name.slice(pkg.length)}`;
    const open = name === 'tablewalk' || (pkg === '@mistriwork/mistri' && subpath !== '.' && !previewEntries.has(subpath));
    (sections[`package ${pkg}`] ??= {})[`entry ${name}`] = open ? 'public' : 'preview';
  }
  return Object.fromEntries(Object.entries(sections).map(([section, names]) => [section, sorted(names)]));
}

/* ---------- 3. the CLI ---------- */

/** The flags a text offers: the extraction test/prose.test.ts holds the README to. */
export const flagsIn = (text) => new Set([...text.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]));
/** A binary's USAGE: the database browser's (`tablewalk`) or the App framework's (`mistri`). */
export const usageText = (bin = 'mistri') => read(`packages/${bin}/src/server/cli/usage.ts`).match(/const USAGE = `([\s\S]*?)`/)?.[1];
export const BINS = ['tablewalk', 'mistri'];

/** The commands and flags of the Status page's Preview rows: `--reindex`, which needs a search pack (after 1.0). A flag
 * several features share (`--export`, `--policy`, `--search`) stays public. */
const PREVIEW_CLI_NAMES = new Set(PREVIEW_CLI);

/** Both binaries' names, as one section: a flag or a command either takes is public. */
function cliSection() {
  const entries = {};
  for (const bin of BINS) {
    const usage = usageText(bin);
    if (!usage) throw new Error(`public-surface: USAGE moved in packages/${bin}/src/server/cli/usage.ts`);
    for (const flag of flagsIn(usage)) entries[`flag ${flag}`] = 'public';
    for (const match of usage.matchAll(new RegExp(`^ {2}${bin} ([a-z][a-z-]*)\\b`, 'gm'))) entries[`command ${match[1]}`] = 'public';
  }
  for (const name of PREVIEW_CLI_NAMES) {
    if (!(name in entries)) throw new Error(`public-surface: PREVIEW_CLI names "${name}", which USAGE no longer says`);
    entries[name] = 'preview';
  }
  return entries;
}

/* ---------- 4. MCP tools ---------- */

async function mcpSection() {
  const { toolNames } = await tsImport('../packages/tablewalk/src/server/mcp.ts', import.meta.url);
  const names = typeof toolNames === 'function' ? toolNames() : toolNames;
  return Object.fromEntries([...names].map((name) => [`tool ${name}`, 'public']));
}

/* ---------- 5. check finding codes ---------- */

async function checkCodesSection() {
  const { VALIDATION_CODES } = await tsImport('../packages/mistri/src/server/build/checkProblems.ts', import.meta.url);
  const codes = new Set(VALIDATION_CODES.map((entry) => entry.code));
  for (const match of read('site/src/content/docs/docs/check-codes.md').matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)) codes.add(match[1]);
  return Object.fromEntries([...codes].map((code) => [code, 'public']));
}

/* ---------- the inventory ---------- */

const sorted = (entries) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export async function liveSurface() {
  return {
    note: 'Generated by scripts/public-surface.mjs --write. Do not edit by hand; regenerate in the commit that changes the surface.',
    sections: {
      dsl: sorted(dslSection()),
      icons: sorted(iconsSection()),
      package: sorted(await packageSection()),
      ...packageEntrySections(),
      cli: sorted(cliSection()),
      mcp: sorted(await mcpSection()),
      checkCodes: sorted(await checkCodesSection()),
    },
  };
}

/** On disk each section lists its names under their status, one per line: the file stays
 * small enough to read in a review. `readInventory` gives back the name → status map. */
export const render = (inventory) => {
  const sections = Object.fromEntries(
    Object.entries(inventory.sections).map(([section, entries]) => {
      const byStatus = {};
      for (const [name, status] of Object.entries(entries)) (byStatus[status] ??= []).push(name);
      return [section, byStatus];
    }),
  );
  return `${JSON.stringify({ ...inventory, sections }, null, 2)}\n`;
};

export function readInventory(path = INVENTORY) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const sections = Object.fromEntries(
    Object.entries(file.sections).map(([section, byStatus]) => [
      section,
      Object.fromEntries(Object.entries(byStatus).flatMap(([status, names]) => names.map((name) => [name, status]))),
    ]),
  );
  return { ...file, sections };
}

/** What changed, by section: names only in the code (added) and only in the file (removed), and status changes. */
export function diffSurface(recorded, live) {
  const result = {};
  for (const section of new Set([...Object.keys(recorded.sections), ...Object.keys(live.sections)])) {
    const before = recorded.sections[section] ?? {},
      after = live.sections[section] ?? {};
    const added = Object.keys(after).filter((name) => !(name in before));
    const removed = Object.keys(before).filter((name) => !(name in after));
    const changed = Object.keys(after).filter((name) => name in before && before[name] !== after[name]);
    if (added.length || removed.length || changed.length) result[section] = { added, removed, changed };
  }
  return result;
}

/** Frozen from the first major version: before 1.0.0 nothing was promised, and a release could rename what it liked. */
export const frozen = (version = JSON.parse(read('package.json')).version) => Number(String(version).split('.')[0]) >= 1;

/** What a difference takes away from authors: a public name removed (a rename removes one name and adds
 * another) or demoted to preview. Frozen, each is a break, made only in a major release. A preview name may
 * graduate or go, and any name may be added; those only need the regenerated inventory. */
export function breaks(difference, recorded) {
  const result = {};
  for (const [section, { removed, changed }] of Object.entries(difference)) {
    const gone = removed.filter((name) => recorded.sections[section]?.[name] === 'public');
    const demoted = changed.filter((name) => recorded.sections[section]?.[name] === 'public');
    if (gone.length || demoted.length) result[section] = { added: [], removed: gone, changed: demoted };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const major = process.argv.includes('--major');
  if ((mode !== '--write' && mode !== '--check') || (major && mode !== '--write')) {
    console.error('Usage: node scripts/public-surface.mjs --write [--major] | --check');
    process.exit(2);
  }
  const live = await liveSurface();
  if (mode === '--write') {
    const recorded = readInventory();
    const broken = frozen() && !major ? breaks(diffSurface(recorded, live), recorded) : {};
    if (Object.keys(broken).length) {
      for (const [section, { removed, changed }] of Object.entries(broken)) {
        for (const name of removed) console.error(`${section}: - ${name}`);
        for (const name of changed) console.error(`${section}: ~ ${name} (public to preview)`);
      }
      console.error(
        'A public name is promised until the next major version (docs/compatibility.md). Keep it working and deprecate it ' +
          '(packages/mistri/src/shared/deprecations.ts); only a major release regenerates with --major. The inventory is unchanged.',
      );
      process.exit(1);
    }
    writeFileSync(INVENTORY, render(live));
    console.log(
      Object.entries(live.sections)
        .map(([name, entries]) => `${name}: ${Object.keys(entries).length}`)
        .join(', '),
    );
  } else {
    const difference = diffSurface(readInventory(), live);
    for (const [section, { added, removed, changed }] of Object.entries(difference)) {
      console.error(`${section}: +${added.length} -${removed.length} ~${changed.length}`);
      for (const name of added.slice(0, 20)) console.error(`  + ${name}`);
      for (const name of removed.slice(0, 20)) console.error(`  - ${name}`);
      for (const name of changed.slice(0, 20)) console.error(`  ~ ${name}`);
    }
    if (Object.keys(difference).length) {
      console.error('Regenerate with: node scripts/public-surface.mjs --write');
      process.exit(1);
    }
    console.log('The public surface matches test/fixtures/public-surface.json.');
  }
}
