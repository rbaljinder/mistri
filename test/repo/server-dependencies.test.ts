/*
 * What an install of the package pulls, and what the server may import.
 *
 * The client's libraries — React, Base UI, Phosphor, TanStack — are bundled
 * into dist/client at `npm run build`, and nothing in dist/server imports
 * them. As runtime `dependencies` they were most of what `npx tablewalk`
 * downloaded, some 97 MB, for files the package never loads. They are
 * devDependencies now, so the server must never reach for one: a bare import
 * of a package an install does not bring works in this checkout and fails
 * for everyone who installed it. The server may import Node's own modules,
 * the package itself, and the optional dependencies it loads with a clear
 * refusal when absent (a driver, better-auth, rolldown for `mistri build`).
 *
 * `@mistriwork/mistri/ui` (dist/ui) is the one published file set that imports a
 * client library: an App author's component tests run it, over their own
 * React and Testing Library, so those are optional peers — declared, with the
 * versions the page runs, and never installed for anyone who does not write
 * components. That is the rule: dist/ui imports only optional peers.
 *
 * The source is read (every file tsc compiles to dist/server), and so is
 * dist/server when a build is present.
 */
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { parseFiles } from '../support/tsc.js';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
}
const read = (path: string): Manifest => JSON.parse(readFileSync(join(root, path), 'utf8')) as Manifest;
/** The workspace's devDependencies: the checkout's, which no install brings. */
const workspace = read('package.json');
/* Each package is installed on its own: what it may import is what its own manifest brings. */
const PACKAGES = readdirSync(join(root, 'packages'))
  .filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
  .sort()
  .map((dir) => {
    const pkg = read(`packages/${dir}/package.json`);
    const peers = Object.keys(pkg.peerDependencies ?? {});
    /** Peers npm does not install: the author's own project brings them when it uses what needs them. */
    const optionalPeers = new Set(peers.filter((name) => pkg.peerDependenciesMeta?.[name]?.optional));
    /** What an install of the package brings (a required peer npm installs beside it). */
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...peers.filter((name) => !optionalPeers.has(name)),
      pkg.name,
    ]);
    return { dir: join(root, 'packages', dir), pkg, optionalPeers, installed };
  });
const CLIENT_LIBRARIES = [
  'react',
  'react-dom',
  '@base-ui/react',
  '@phosphor-icons/react',
  '@tanstack/react-form',
  '@tanstack/react-query',
  '@tanstack/react-table',
  '@tanstack/react-virtual',
];
/* Loaded only while serving the source tree (FROM_SOURCE), where the checkout's devDependencies are present. */
const FROM_SOURCE_ONLY: Record<string, string> = { vite: 'devclient' };
const MISTRI = PACKAGES.find(({ pkg }) => pkg.name === '@mistriwork/mistri')!;
const DIST_UI = join(MISTRI.dir, 'dist/ui');
/* `@mistriwork/mistri/react` (dist/embed) is the client bundled for a host's own React: react and its routers are the host's,
   optional peers as @mistriwork/mistri/ui's are. */
const DIST_EMBED = join(MISTRI.dir, 'dist/embed');

/** The package a specifier names, or undefined for a relative path or a Node module. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return builtinModules.includes(name) ? undefined : name;
}

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every package each file imports, statically or by a literal `import()`; type-only imports are erased. The files are
    parsed as one program: a program each held every tree it had parsed, and with a build present (some 3,300 files)
    the test ran out of memory. */
function importedBy(paths: string[]): Map<string, string[]> {
  const parsed = parseFiles(paths);
  return new Map(paths.map((file) => [file, imported(parsed.get(resolve(file))!)] as const));
}

function imported(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.add(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.add(node.arguments[0].text);
    node.forEachChild(visit);
  };
  visit(source);
  return [...found].map(packageOf).filter((name): name is string => Boolean(name));
}

test('the client libraries are devDependencies: the bundle carries them, an install does not', () => {
  for (const name of CLIENT_LIBRARIES) {
    assert.ok(workspace.devDependencies?.[name], `${name} is a devDependency`);
    for (const { pkg, installed } of PACKAGES) assert.ok(!installed.has(name), `${name} is not installed with ${pkg.name}`);
  }
});

test('the server imports only what an install brings, or an optional peer it refuses without', () => {
  const stray = PACKAGES.flatMap(({ dir, installed, optionalPeers }) => {
    const sources = [
      ...['src/server', 'src/shared', 'src/adapters']
        .filter((sub) => existsSync(join(dir, sub)))
        .flatMap((sub) => files(join(dir, sub), /\.tsx?$/))
        .filter((file) => !/\.(test|spec)\.tsx?$/.test(file)),
      ...(existsSync(join(dir, 'dist/server'))
        ? files(join(dir, 'dist'), /\.js$/).filter(
            (file) => !file.startsWith(join(dir, 'dist/client')) && !file.startsWith(DIST_UI) && !file.startsWith(DIST_EMBED),
          )
        : []),
    ];
    const imports = importedBy(sources);
    return sources.flatMap((file) =>
      imports
        .get(file)!
        .filter((name) => (!installed.has(name) && !optionalPeers.has(name)) || CLIENT_LIBRARIES.includes(name))
        .filter((name) => !file.includes(FROM_SOURCE_ONLY[name] ?? '\0'))
        .map((name) => `${relative(root, file)}: ${name}`),
    );
  });
  assert.deepEqual(
    stray,
    [],
    'The server imports a package an install of its own package does not bring, or a client library the page bundles.',
  );
});

test('@mistriwork/mistri/ui and @mistriwork/mistri/react import only optional peers, which an author or a host installs', (t) => {
  if (!existsSync(DIST_UI)) return t.skip('no build: npm run build writes dist/ui');
  const ui = [DIST_UI, DIST_EMBED].filter((dir) => existsSync(dir)).flatMap((dir) => files(dir, /\.js$/));
  const imports = importedBy(ui);
  const stray = ui.flatMap((file) =>
    imports
      .get(file)!
      .filter((name) => !MISTRI.optionalPeers.has(name) && !MISTRI.installed.has(name))
      .map((name) => `${relative(root, file)}: ${name}`),
  );
  assert.deepEqual(
    stray,
    [],
    'dist/ui or dist/embed imports a package no author or host installs: bundle it (config/vite.ui.config.ts, config/vite.embed.config.ts), or declare it an optional peer.',
  );
});

test('@mistriwork/ui imports only optional peers: the page bundles them, a project drawing with ui installs them', () => {
  const UI = PACKAGES.find(({ pkg }) => pkg.name === '@mistriwork/ui')!;
  const sources = files(join(UI.dir, 'src'), /\.tsx?$/).filter((file) => !/\.(test|spec)\.tsx?$/.test(file));
  const imports = importedBy(sources);
  const stray = sources.flatMap((file) =>
    imports
      .get(file)!
      .filter((name) => name !== UI.pkg.name && !UI.optionalPeers.has(name))
      .map((name) => `${relative(root, file)}: ${name}`),
  );
  assert.deepEqual(stray, [], 'A ui primitive imports a package its manifest does not name as an optional peer.');
});
