#!/usr/bin/env node
/*
 * The import boundary between the layers the repository is cut into (docs/boundary.md), one package each under
 * packages/: `engine` (@mistriwork/engine: adapters, server and shared rules, no React), `ui` (@mistriwork/ui: the standalone
 * primitives and the ruler their popups are placed by), `kit` (@mistriwork/kit: the shared React client), and the two products over them, `browser`
 * (the `tablewalk` package, the database browser) and `mistri` (the App framework). The direction is
 * engine ← kit ← {browser, mistri}, with ui beside the engine under the kit: the engine imports only the engine, ui
 * only ui, the kit the kit, ui and the engine, and neither product imports the other.
 *
 * A module's layer is the package it sits in (scripts/boundary/entries.json `packages`), so placing a file is choosing
 * its package. The check runs on every `npm run test:static`:
 *
 *   - every import is read off the TypeScript syntax tree: `import`, `export … from`, `import x = require()`, and
 *     `import()`/`require()` with a literal name. A relative name is resolved to its file; a workspace package's name
 *     (`@mistriwork/engine/shared/query.js`, `@mistriwork/mistri/ui`) through that package's `exports`, as Node resolves it in a
 *     checkout. Type-only imports count — a package has to resolve its types too — but are reported apart, because
 *     their fix is cheap;
 *   - an import the wrong way fails unless scripts/boundary/allow.json lists it. That list has been empty since 0.9.8
 *     and only shrinks: an entry the tree no longer has fails too;
 *   - a workspace package's name that its `exports` does not answer fails, with no list to excuse it: the engine, the
 *     kit and ui export each module another package imports by its path, never a `./*` pattern, so reaching one more
 *     module is a line in that package's manifest, seen in review, rather than anything its folder holds.
 *
 *   node scripts/check-boundary.mjs            check (test:static runs this)
 *   node scripts/check-boundary.mjs --report   modules by layer, crossings by layer pair and fix
 *   node scripts/check-boundary.mjs --write    drop allowlist entries that were fixed (it never adds one)
 *   node scripts/check-boundary.mjs --entries  check, and the package entry points too (test:static runs this)
 *
 * The entry points (scripts/boundary/entries.json) are the names each package is imported by. `--entries` holds each
 * to its layer: its source is a module of its package; everything it reaches — static, `import()` and type imports
 * alike — is a layer its layer may import, or it prints the path to the first module that is not; its package's
 * `exports` names it, from its source in a checkout and from what the build makes of that source in a package; and
 * the root's workspaces are the table's packages (scripts/boundary/entries.mjs). Every other name a package exports is one of its modules by its path (`./shared/
 * schema.js` → src/shared/schema.ts, built to dist/shared/schema.js), which needs no line in the table.
 *
 * `--root <dir>` reads another tree (the tests' fixtures).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { readEntries, splitName, workspaceProblems, ENTRIES } from './boundary/entries.mjs';
import { published } from './pack-manifest.mjs';

export const LAYERS = ['engine', 'ui', 'kit', 'browser', 'mistri', 'cloudflare'];
/** What each layer may import. */
const MAY = {
  engine: ['engine'],
  ui: ['ui'],
  kit: ['kit', 'ui', 'engine'],
  browser: ['browser', 'kit', 'ui', 'engine'],
  mistri: ['mistri', 'kit', 'ui', 'engine'],
  /* The Workers-side glue `mistri deploy` writes a Worker against: it imports nothing of the repository. */
  cloudflare: ['cloudflare'],
};
export const ALLOW = 'scripts/boundary/allow.json';
const WRITE = 'node scripts/check-boundary.mjs --write';

const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

/* ---- packages ---- */

/** The workspace packages: `{ name, dir, layer, manifest }`, from the table. */
export function packagesOf(root) {
  const table = readEntries(root);
  return Object.entries(table.packages).map(([name, { dir, layer }]) => {
    const at = join(root, dir, 'package.json');
    return { name, dir, layer, manifest: existsSync(at) ? JSON.parse(readFileSync(at, 'utf8')) : {} };
  });
}

/** The package a repository path is in. */
const packageAt = (packages, file) => packages.find(({ dir }) => file.startsWith(`${dir}/`));

/** A repository path without its package's folder: `packages/kit/src/client/core.js` → `src/client/core.js`. */
export const inPackage = (file) => file.replace(/^packages\/[^/]+\//, '');

/* ---- modules and their imports ---- */

const MODULE = /\.(?:ts|tsx|js|mjs)$/;
const NOT_A_MODULE = /\.(?:test|spec|stories)\.[^.]+$/;

/**
 * Every source module of every package, as repository paths: what is under `src/` (tests, stories and `.d.ts` files
 * aside), and the published types under `schema/` (their `.d.ts` and `.mjs`), which a package resolves like any module.
 */
export function modulesOf(root, packages = packagesOf(root)) {
  const out = [];
  for (const { dir } of packages) {
    for (const [sub, keep] of [
      ['src', (file) => MODULE.test(file) && !NOT_A_MODULE.test(file) && !file.endsWith('.d.ts')],
      ['schema', (file) => /\.(?:d\.ts|mjs)$/.test(file)],
    ]) {
      const base = join(root, dir, sub);
      if (!existsSync(base)) continue;
      for (const file of readdirSync(base, { recursive: true, encoding: 'utf8' }))
        if (keep(file)) out.push(`${dir}/${sub}/${file.split('\\').join('/')}`);
    }
  }
  return out.sort();
}

/* Literal module names only: `import(name)` with a computed name is a
   loader, which the owners of its targets answer for. */
const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

/** The specifiers one syntax tree names, each with whether it is only a type and only loaded on demand. */
function specifiersOf(source, text) {
  const found = [];
  const add = (node, type, lazy) => {
    const specifier = literal(node);
    if (specifier) found.push({ specifier, type, lazy });
  };
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const type =
        !!clause &&
        (clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (!clause.name &&
            !!bindings &&
            !ts.isNamespaceImport(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((item) => item.isTypeOnly)));
      add(node.moduleSpecifier, type, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const type =
        node.isTypeOnly ||
        (!!clause && !ts.isNamespaceExport(clause) && clause.elements.length > 0 && clause.elements.every((item) => item.isTypeOnly));
      add(node.moduleSpecifier, type, false);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly, false);
    }
  }
  /* The whole tree is walked only where a call or a type can name a module:
     the top level above is most files' every import, and walking every tree
     is what would make this check slow. */
  if (/\b(?:import|require)\s*\(/.test(text)) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
          add(node.arguments[0], false, true);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, true, false);
      }
      node.forEachChild(visit);
    };
    for (const statement of source.statements) visit(statement);
    /* A `.js` module names its types in JSDoc (`@type` with an `import` of a path),
       which the tree keeps as a comment. */
    for (const [comment] of text.matchAll(/\/\*\*[\s\S]*?\*\//g))
      for (const [, specifier] of comment.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ specifier, type: true, lazy: false });
  }
  return found;
}

/** The file a path names: itself, or the source a `.js` name stands for, or a folder's index. */
function fileFor(target, known) {
  const stem = target.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  for (const candidate of [
    stem + '.ts',
    stem + '.tsx',
    target,
    target.replace(/\.(?:js|mjs)$/, '.d.ts'),
    ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map((ext) => target + ext),
  ])
    if (known.has(candidate)) return candidate;
  return null;
}

/** An `exports` value's target in a checkout: the `default` branch, followed down. */
const checkoutTarget = (value) =>
  typeof value === 'string' ? value : value && typeof value === 'object' ? checkoutTarget(value.default) : null;

/** Where a package's `exports` sends a subpath in a checkout, as a path inside the package, or null. */
export function exportTarget(exports, subpath) {
  if (!exports || typeof exports !== 'object') return null;
  if (Object.hasOwn(exports, subpath)) return checkoutTarget(exports[subpath]);
  /* The longest pattern whose prefix matches, as Node picks it. */
  const patterns = Object.keys(exports)
    .filter((key) => key.endsWith('*') && subpath.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length);
  for (const key of patterns) {
    const target = checkoutTarget(exports[key]);
    if (target?.includes('*')) return target.replace('*', subpath.slice(key.length - 1));
  }
  return null;
}

/** The module a specifier names, or null; `unexported` is told a workspace package's name its `exports` does not answer. */
function resolveSpecifier(from, specifier, known, packages, unexported = () => {}) {
  if (specifier.startsWith('.')) return fileFor(posix.normalize(posix.join(posix.dirname(from), specifier)), known);
  const { pkg, subpath } = splitName(specifier);
  const owner = packages.find(({ name }) => name === pkg);
  if (!owner) return null;
  const target = exportTarget(owner.manifest.exports, subpath);
  if (!target) unexported(pkg);
  return target ? fileFor(posix.normalize(posix.join(owner.dir, target)), known) : null;
}

/**
 * Every module and, for each, the modules it imports: `{ type, lazy }` per target, each true only when every reference
 * is. And for each module, and each of `extra` (files read for their imports that are no package's module, such as a
 * build config), the names of packages it imports (`named`).
 */
export function graphOf(root, packages = packagesOf(root), extra = []) {
  const modules = modulesOf(root, packages);
  const known = new Set(modules);
  /* An importer named by its folder is read for every script in it. */
  const others = extra
    .filter((path) => existsSync(join(root, path)))
    .flatMap((path) =>
      statSync(join(root, path)).isDirectory()
        ? readdirSync(join(root, path), { recursive: true, encoding: 'utf8' })
            .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !file.split('/').includes('node_modules'))
            .map((file) => `${path}/${file}`)
        : [path],
    )
    .filter((file) => !known.has(file));
  const directory = mkdtempSync(join(tmpdir(), 'mistri-boundary-'));
  const api = new API({ cwd: root });
  try {
    const config = join(directory, 'tsconfig.json');
    const absolute = [...modules, ...others].map((file) => resolve(root, file));
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, jsx: 'preserve', target: 'esnext' },
        files: absolute,
      }),
    );
    const program = api.updateSnapshot({ openProject: config }).getProject(config).program;
    const edges = new Map();
    const unexported = [];
    const named = new Map();
    [...modules, ...others].forEach((file, index) => {
      const source = program.getSourceFile(absolute[index]);
      if (!source) throw new Error(`check-boundary: typescript did not parse ${file}`);
      const specifiers = specifiersOf(source, readFileSync(absolute[index], 'utf8'));
      /* A test that mocks a module depends on its name as much as one that imports it: the host's copy of the test
         mocks that name from the installed package, so it is read here (and only here: a mock is no edge of the graph). */
      const mocked = [...readFileSync(absolute[index], 'utf8').matchAll(/\bvi\.(?:do)?[Mm]ock\(\s*['"]([^'"]+)['"]/g)].map(
        ([, name]) => name,
      );
      named.set(file, [
        ...new Set([...specifiers.map(({ specifier }) => specifier), ...mocked].filter((specifier) => !specifier.startsWith('.'))),
      ]);
      if (index >= modules.length) return;
      const out = new Map();
      for (const { specifier, type, lazy } of specifiers) {
        const target = resolveSpecifier(file, specifier, known, packages, (pkg) => unexported.push({ from: file, specifier, pkg }));
        if (!target || target === file) continue;
        const before = out.get(target);
        out.set(target, before ? { type: before.type && type, lazy: before.lazy && lazy } : { type, lazy });
      }
      edges.set(file, out);
    });
    return { modules, edges, unexported, named };
  } finally {
    api.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Each module's layer, the layer of the package it sits in; and a package the table gives no layer this check knows. */
export function ownersOf(packages, modules) {
  const problems = [];
  const owner = new Map();
  for (const { name, layer } of packages)
    if (!MAY[layer]) problems.push(`${ENTRIES}: package ${name} names layer "${layer}", which is not one of ${LAYERS.join(', ')}.`);
  for (const file of modules) owner.set(file, packageAt(packages, file)?.layer);
  return { owner, problems };
}

/* ---- the host list ---- */

/**
 * What a product outside this repository imports of the engine, the kit and ui, held to the host list
 * (entries.json `host`): it builds from the packages as published, so each name it imports must be on the list and in
 * its package's manifest as an install reads it (scripts/pack-manifest.mjs `published`), never a module the package
 * does not export to an install. A name on the list must be published, and imported by the host: a name nothing
 * imports any more is taken off, in a release that says so. An importer the tree does not have (a fixture's) is not
 * read.
 */
export function hostProblems(root, host, packages, named) {
  if (!host) return [];
  const problems = [];
  const at = `${ENTRIES} host`;
  const listed = Object.fromEntries(Object.entries(host.exports ?? {}).map(([name, subpaths]) => [name, new Set(subpaths)]));
  const shipped = new Map(packages.map(({ name, manifest }) => [name, published(manifest, listed).exports ?? {}]));
  const used = new Set();
  let reading = false;
  for (const [importer, paths] of Object.entries(host.importers ?? {})) {
    const present = paths.filter((path) => existsSync(join(root, path)));
    if (!present.length) continue;
    reading = true;
    for (const [file, specifiers] of named) {
      if (!present.some((path) => file === path || file.startsWith(`${path}/`))) continue;
      for (const specifier of specifiers) {
        const { pkg, subpath } = splitName(specifier);
        if (!listed[pkg]) continue;
        used.add(`${pkg}\0${subpath}`);
        if (!listed[pkg].has(subpath))
          problems.push(
            `${file} imports ${specifier}, which is not on the host list: ${importer} builds from the published ` +
              `packages, so each name it imports of ${pkg} is reviewed. Import a name on it, or add this one to ${at}.exports.`,
          );
      }
    }
  }
  for (const [pkg, subpaths] of Object.entries(listed)) {
    if (!shipped.has(pkg)) {
      problems.push(`${at}.exports names ${pkg}, which is not a package the table names.`);
      continue;
    }
    for (const subpath of subpaths) {
      const name = subpath === '.' ? pkg : `${pkg}/${subpath.slice(2)}`;
      if (!Object.hasOwn(shipped.get(pkg), subpath))
        problems.push(`${at}.exports names ${name}, which ${pkg} as published does not export.`);
      else if (reading && !used.has(`${pkg}\0${subpath}`))
        problems.push(`${at}.exports names ${name}, which no importer imports any more: take it off, in a release that says so.`);
    }
  }
  return problems;
}

/* ---- the fix each crossing waits for ---- */

/* By where the crossing starts and where it lands (each read inside its package), the cut from docs/boundary.md
   that removes it. The first match names it. */
const FIXES = [
  [
    'props',
    'a ui primitive takes its labels, hooks and answers as props; what reads the walk, the address or the copy stays in the kit',
    (from, to, a) => a === 'ui',
  ],
  [
    'two-mains',
    'two binaries, each with its own main: browserMain and mistriMain, each importing only its own layer',
    (from) => /^src\/server\/(?:index|cli)\.ts$|^src\/server\/cli\//.test(from),
  ],
  [
    'two-shells',
    'two shells over the kit shell: each shell names its own rooms and chrome',
    (from) => /^src\/client\/(?:app|boot|shellStart|startup|surfaces)\.js$|^src\/client\/components\/Content\.tsx$/.test(from),
  ],
  [
    'dispatcher',
    'an engine router and data routes with read/write gate hooks; each product mounts its own dispatcher',
    (from) => /^src\/server\/(?:http\/|clientHttp\.ts$|clientSurface\.ts$|recordWriteOperations\.ts$|resourceReadHttp\.ts$)/.test(from),
  ],
  [
    'store-host',
    'a StoreHost seam: the App stores leave the dialect adapters and become mistri modules over it',
    (from) => from.startsWith('src/adapters/'),
  ],
  [
    'app-targets',
    "a target registry: migrate and seed take an App's databases and stores from what mistri registers",
    (from) => /^src\/server\/(?:migrate|seed)\//.test(from),
  ],
  [
    'config-sections',
    'a config-section registry: the engine reads connections, mistri registers its sections',
    (from) => /^src\/server\/(?:connections|httpConnection)\.ts$/.test(from),
  ],
  [
    'move',
    'a small move: the shared piece moves down, or the caller reads it through a seam',
    (from, to, a, b) => (a === 'browser' && b === 'mistri') || (a === 'mistri' && b === 'browser'),
  ],
  [
    'rules-down',
    "the page, list and view rules move down into the engine; what stays the App's is not read by them",
    (from) => from.startsWith('src/shared/'),
  ],
  [
    'mode-seam',
    'a shell-mode seam answers the visitor, tenant transport and account state; the kit default is none',
    (from, to) => from.startsWith('src/client/') && /\/(?:tenant|public|account|appState|appFlags)\w*\.\w+$/.test(to),
  ],
  /* A kit module reading a shared rule the App owns waits for the rule to move down, not for a slot. */
  [
    'rules-down',
    "the page, list and view rules move down into the engine; what stays the App's is not read by them",
    (from, to) => from.startsWith('src/client/') && to.startsWith('src/shared/'),
  ],
  ['slots', 'a renderer registry or a record-page slot the product fills', (from) => from.startsWith('src/client/')],
  ['move', 'a small move: the shared piece moves down, or the caller reads it through a seam', () => true],
];
export const fixFor = (from, to, a, b) => FIXES.find(([, , test]) => test(inPackage(from), inPackage(to), a, b))[0];
const fixText = (fix) => FIXES.find(([name]) => name === fix)[1];

/* ---- the check ---- */

const key = (from, to) => `${from} -> ${to}`;

/** Every import that goes the wrong way: `{ from, to, pair, type, lazy, fix }`. */
export function crossingsOf(edges, owner) {
  const out = [];
  for (const [from, targets] of edges) {
    const a = owner.get(from);
    if (!MAY[a]) continue;
    for (const [to, { type, lazy }] of targets) {
      const b = owner.get(to);
      if (!MAY[b] || MAY[a].includes(b)) continue;
      out.push({ from, to, pair: `${a} -> ${b}`, type, lazy, fix: fixFor(from, to, a, b) });
    }
  }
  return out.sort((x, y) => key(x.from, x.to).localeCompare(key(y.from, y.to)));
}

const allowValue = (crossing) => crossing.fix + (crossing.type ? ', type-only' : '');

/** The whole check over one tree: the problems, and what the report needs. */
export function check(root) {
  const packages = packagesOf(root);
  const host = readEntries(root).host;
  const { modules, edges, unexported, named } = graphOf(root, packages, Object.values(host?.importers ?? {}).flat());
  const { owner, problems: owned } = ownersOf(packages, modules);
  const placement = [...owned];
  const problems = [...placement, ...hostProblems(root, host, packages, named)];
  for (const { from, specifier, pkg } of unexported)
    problems.push(
      `${from} imports ${specifier}, which ${pkg}'s exports do not name: import a name it exports, or add the module to ` +
        `its package.json "exports" by its path.`,
    );
  const crossings = crossingsOf(edges, owner);
  const allowPath = join(root, ALLOW);
  const allow = existsSync(allowPath) ? readJson(root, ALLOW) : null;
  const fresh = [];
  const stale = [];
  if (allow) {
    const found = new Map(crossings.map((crossing) => [key(crossing.from, crossing.to), crossing]));
    for (const crossing of crossings) {
      const allowed = allow[key(crossing.from, crossing.to)];
      /* An allowance for a type is not one for a value: the cheap fix it was
         listed under would no longer remove it. */
      if (allowed === undefined) fresh.push(crossing);
      else if (allowed.endsWith('type-only') && !crossing.type) fresh.push({ ...crossing, wasType: true });
    }
    for (const entry of Object.keys(allow)) if (!found.has(entry)) stale.push(entry);
  } else problems.push(`${ALLOW} is missing; write it once with \`${WRITE}\`.`);
  for (const crossing of fresh)
    problems.push(
      `${crossing.from} -> ${crossing.to}: ${crossing.pair} goes the wrong way` +
        (crossing.wasType
          ? ' (it was allowed as a type-only import and now imports a value)'
          : crossing.type
            ? ' (type-only: move the type down, or import it from where it will live)'
            : '') +
        '. ' +
        `The fix for this kind is ${crossing.fix}: ${fixText(crossing.fix)}.`,
    );
  if (stale.length)
    problems.push(
      `${stale.length} ${ALLOW} ${stale.length === 1 ? 'entry is' : 'entries are'} no longer in the tree; remove ${stale.length === 1 ? 'it' : 'them'} with \`${WRITE}\`:\n` +
        stale.map((entry) => `  ${entry}`).join('\n'),
    );
  return {
    root,
    packages,
    modules,
    edges,
    owner,
    crossings,
    allow,
    fresh,
    stale,
    placement,
    problems,
  };
}

/* ---- the entry points ---- */

/**
 * Everything one entry reaches, by every kind of import, from its source and its types: the modules, the
 * allowlisted crossings on the way (not followed), and each module of a layer the entry's layer may not import,
 * with the shortest path to it.
 */
export function closureOf(entry, { edges, owner, allow }) {
  const may = MAY[entry.layer] ?? [];
  const start = [...new Set([entry.source, entry.types].filter((file) => file && edges.has(file)))];
  const parent = new Map(start.map((file) => [file, null]));
  const pathTo = (file) => {
    const path = [];
    for (let at = file; at !== null && at !== undefined; at = parent.get(at)) path.unshift(at);
    return path;
  };
  const queue = [...start];
  const allowed = new Set();
  const wrong = new Map();
  while (queue.length) {
    const from = queue.shift();
    for (const [to] of edges.get(from) ?? []) {
      const edge = key(from, to);
      const layer = owner.get(to);
      if (!may.includes(layer)) {
        if (allow && Object.hasOwn(allow, edge)) allowed.add(edge);
        else if (!wrong.has(to)) wrong.set(to, { layer, path: [...pathTo(from), to] });
        continue;
      }
      if (parent.has(to)) continue;
      parent.set(to, from);
      if (edges.has(to)) queue.push(to);
    }
  }
  return { modules: parent.size, allowed: [...allowed].sort(), wrong: [...wrong.values()] };
}

/* Inside a package, a tsc-built entry is dist/<path>.js from src/<path>.ts; a Vite library build names its source in
   its config, which sits at the workspace root. */
const VITE_LIBRARIES = { 'dist/ui/': 'config/vite.ui.config.ts', 'dist/embed/': 'config/vite.embed.config.ts' };
const conditionsOf = (value) => (value && typeof value === 'object' ? value : { default: value });
function builtFrom(root, target, source) {
  const file = target.replace(/^\.\//, '');
  if (!file.startsWith('dist/')) return file === source;
  if (file.endsWith('.d.ts')) return file.replace(/^dist\//, 'src/').replace(/\.d\.ts$/, '.ts') === source;
  const library = Object.keys(VITE_LIBRARIES).find((prefix) => file.startsWith(prefix));
  if (library) {
    const name = file.slice(library.length).replace(/\.js$/, '');
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const base = escape(posix.basename(source));
    const at = join(root, VITE_LIBRARIES[library]);
    if (!existsSync(at)) return false;
    return new RegExp(`['"]?${escape(name)}['"]?\\s*:\\s*resolve\\(\\s*\\w+\\s*,\\s*'${base}'\\s*\\)`).test(readFileSync(at, 'utf8'));
  }
  return file.endsWith('.js') && file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts') === source;
}

/** One entry's export in its package: the checkout's target is its source, and a package's is built from it. */
function exportProblems(root, at, entry, owning) {
  const problems = [];
  const value = owning.manifest.exports?.[splitName(entry.name).subpath];
  if (value === undefined) return [`${at}: ${owning.dir}/package.json "exports" does not have it.`];
  const local = (file) => (file && file.startsWith(`${owning.dir}/`) ? file.slice(owning.dir.length + 1) : null);
  const source = local(entry.source);
  const types = local(entry.types);
  const top = conditionsOf(value);
  const checkout = checkoutTarget(value)?.replace(/^\.\//, '');
  if (checkout !== source) problems.push(`${at}: in a checkout it resolves to ${checkout}, not its source ${source}.`);
  if (top.types && top.types.replace(/^\.\//, '') !== types) problems.push(`${at}: its types are ${top.types}, not ${types}.`);
  if (top['mistri-built'] !== undefined) {
    const built = conditionsOf(top['mistri-built']);
    if (!built.default || !builtFrom(root, built.default, source))
      problems.push(`${at}: built, it serves ${built.default}, which is not built from ${source}.`);
    if (built.types && !builtFrom(root, built.types, types))
      problems.push(`${at}: built, its types are ${built.types}, not built from ${types}.`);
  }
  return problems;
}

/* The packages whose every export is named: no `./*`. */
const EXPLICIT = ['engine', 'ui', 'kit'];

/**
 * Null when an export is one of its package's modules by its path: `./a/b.js` answers from src/a/b.ts (or .tsx, or the
 * file itself, a stylesheet), or `./schema/b.js` from the published types schema/b.d.ts, and built from dist/a/b.js
 * (or the stylesheet the build copies there). Else why it is not.
 */
function byPathProblem(root, dir, subpath, value) {
  const name = subpath.replace(/^\.\//, '');
  const stem = name.replace(/\.js$/, '');
  const checkout = checkoutTarget(value)?.replace(/^\.\//, '');
  const sources = name.startsWith('schema/') ? [`${stem}.d.ts`] : [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${name}`];
  if (!checkout || !sources.includes(checkout) || !existsSync(join(root, dir, checkout)))
    return `it does not answer from the module its path names (${sources.join(' or ')})`;
  const built = conditionsOf(value)['mistri-built'];
  if (built !== undefined && conditionsOf(built).default !== `./dist/${name}`) return `built, it does not answer from dist/${name}`;
  return null;
}

/** The entry points' problems, and a line per entry for the report. */
export function checkEntries(result) {
  const { root, owner, packages } = result;
  const problems = [];
  const lines = [];
  if (!existsSync(join(root, ENTRIES))) return { problems: [`${ENTRIES} is missing.`], lines };
  const table = readEntries(root);
  const named = new Map(packages.map((pkg) => [pkg.name, new Set()]));
  for (const [name, entry] of Object.entries(table.entries)) {
    const at = `${ENTRIES}: ${name}`;
    if (!MAY[entry.layer]) {
      problems.push(`${at} names layer "${entry.layer}", which is not one of ${LAYERS.join(', ')}.`);
      continue;
    }
    const { pkg: owningName, subpath } = splitName(name);
    const owning = packages.find((pkg) => pkg.name === owningName);
    if (!owning) {
      problems.push(`${at} belongs to ${owningName}, which is not a package the table names.`);
      continue;
    }
    if (owning.layer !== entry.layer) problems.push(`${at} is ${entry.layer}'s, but its package ${owningName} is ${owning.layer}'s.`);
    for (const field of ['source', 'types']) {
      const file = entry[field];
      if (file === null && field === 'types' && subpath === '.' && owning.manifest.bin) continue;
      if (!file || !existsSync(join(root, file))) problems.push(`${at}: its ${field} ${file} is not a file.`);
      else if (owner.get(file) !== entry.layer)
        problems.push(`${at}: its ${field} ${file} is ${owner.get(file) ?? 'in no package'}'s, not ${entry.layer}'s.`);
    }
    if (subpath === '.' && owning.manifest.bin) {
      /* A product's main is its bin, not an import. */
      /* The bin is the package's name without its scope: `@mistriwork/mistri` runs as `mistri`. */
      const binName = owningName.replace(/^@[^/]+\//, '');
      const bin = owning.manifest.bin?.[binName];
      const local = entry.source?.slice(owning.dir.length + 1);
      if (!bin) problems.push(`${at}: ${owning.dir}/package.json has no bin "${binName}".`);
      else if (!builtFrom(root, bin, local)) problems.push(`${at}: ${owning.dir}/package.json's bin ${bin} is not built from ${local}.`);
    } else {
      named.get(owningName).add(subpath);
      problems.push(...exportProblems(root, at, { ...entry, name }, owning));
    }
    const closure = closureOf(entry, result);
    for (const { layer, path } of closure.wrong)
      problems.push(
        `${at} (${entry.layer}) reaches ${path.at(-1)}, which is ${layer ?? 'in no package'}'s; ${/^[aeiou]/.test(entry.layer) ? 'an' : 'a'} ${entry.layer} package may import only ${MAY[entry.layer].join(', ')}:\n` +
          path.map((file) => `    ${file}`).join('\n'),
      );
    lines.push(
      `  ${name.padEnd(28)} ${entry.layer.padEnd(7)} ${String(closure.modules).padStart(5)} modules` +
        (closure.allowed.length
          ? `, ${closure.allowed.length} allowlisted crossing${closure.allowed.length === 1 ? '' : 's'} on the way`
          : ''),
      ...closure.allowed.map((edge) => `      ${edge}`),
    );
  }
  /* Every name a package exports is an entry, or a file that moves with it (the schemas, package.json, and the
     package's modules by path). */
  for (const { name, dir, layer, manifest } of packages)
    for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
      if (subpath.includes('*')) {
        if (EXPLICIT.includes(layer))
          problems.push(`${dir}/package.json exports the pattern ${subpath}: ${name} names each module it exports by its path.`);
        continue;
      }
      if (subpath === './package.json' || named.get(name).has(subpath)) continue;
      const byPath = byPathProblem(root, dir, subpath, value);
      if (byPath === null) continue;
      problems.push(`${dir}/package.json exports ${subpath}, which no entry in ${ENTRIES} names and ${byPath}; say what it is.`);
    }
  problems.push(...workspaceProblems(root, table));
  return { problems, lines };
}

/** The allowlist file for a set of crossings, one entry per line so a diff shows each removal. */
export function allowText(crossings) {
  const lines = crossings.map(
    (crossing) => `  ${JSON.stringify(key(crossing.from, crossing.to))}: ${JSON.stringify(allowValue(crossing))}`,
  );
  return lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n';
}

function report(result) {
  const { modules, owner, crossings, allow } = result;
  const count = (items, keyOf) => items.reduce((map, item) => map.set(keyOf(item), (map.get(keyOf(item)) ?? 0) + 1), new Map());
  const byLayer = count(modules, (file) => owner.get(file) ?? 'none');
  console.log(`modules: ${modules.length}`);
  for (const layer of [...LAYERS, 'none'])
    if (byLayer.get(layer)) console.log(`  ${layer.padEnd(8)} ${String(byLayer.get(layer)).padStart(5)}`);
  console.log(`\ncrossings: ${crossings.length} (allowlisted ${allow ? Object.keys(allow).length : 0})`);
  const pairs = count(crossings, (crossing) => crossing.pair);
  for (const [pair, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
    const these = crossings.filter((crossing) => crossing.pair === pair);
    const type = these.filter((crossing) => crossing.type).length;
    const fixes = [...count(these, (crossing) => crossing.fix)].sort((a, b) => b[1] - a[1]);
    console.log(`  ${pair.padEnd(18)} ${String(n).padStart(4)}  type-only ${type}; ${fixes.map(([f, m]) => `${f} ${m}`).join(', ')}`);
  }
}

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? resolve(argv[at + 1]) : fileURLToPath(new URL('..', import.meta.url));
  const result = check(root);
  if (argv.includes('--write')) {
    /* Crossings are counted against the packages, so placement comes first. */
    if (result.placement.length) {
      for (const problem of result.placement) console.error(`check-boundary: ${problem}`);
      return 1;
    }
    /* The list only shrinks: once it exists, --write drops what was fixed and
       never takes in a new crossing. */
    const fresh = new Set(result.fresh.map((crossing) => key(crossing.from, crossing.to)));
    const keep = result.allow ? result.crossings.filter((crossing) => !fresh.has(key(crossing.from, crossing.to))) : result.crossings;
    writeFileSync(join(root, ALLOW), allowText(keep));
    console.log(`check-boundary: wrote ${ALLOW}: ${keep.length} entries${result.allow ? `, ${result.stale.length} removed` : ''}.`);
    if (result.allow && result.fresh.length) {
      for (const crossing of result.fresh)
        console.error(`check-boundary: not allowlisted, fix it: ${crossing.from} -> ${crossing.to} (${crossing.pair}, ${crossing.fix})`);
      return 1;
    }
    return 0;
  }
  if (argv.includes('--report')) report(result);
  let entries = 0;
  if (argv.includes('--entries')) {
    const { problems, lines } = checkEntries(result);
    result.problems.push(...problems);
    if (argv.includes('--report')) console.log(`\nentries:\n${lines.join('\n')}`);
    entries = Object.keys(readEntries(result.root).entries).length;
  }
  if (result.problems.length) {
    for (const problem of result.problems) console.error(`check-boundary: ${problem}`);
    return 1;
  }
  const allowed = Object.keys(result.allow).length;
  const layers = new Set(result.packages.map(({ layer }) => layer)).size;
  console.log(
    `check-boundary: ${result.modules.length} modules in ${result.packages.length} packages (${layers} layers), ${allowed} allowlisted crossing${allowed === 1 ? '' : 's'}, nothing new` +
      (entries ? `; ${entries} entries inside their layers, their stubs current.` : '.'),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
