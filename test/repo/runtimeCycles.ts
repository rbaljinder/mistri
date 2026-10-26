/** Static runtime graph and its cycles; type syntax must not invent a cycle. */
import * as ts from 'typescript/unstable/ast';
import type { SourceFile } from 'typescript/unstable/ast';
import { parseTexts } from '../support/tsc.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, join } from 'node:path';

export type Graph = Map<string, Set<string>>;
/** Every strongly connected component with more than one file (or a self-import), and the edges inside each. */
export interface Cycles {
  components: string[][];
  edges: [string, string][];
}

/** `onDemand: false` leaves out `import()` and `require()`: what a module needs before it runs, not what it may fetch later. */
export interface GraphOptions {
  onDemand?: boolean;
}

export function runtimeSpecifiers(text: string, filename = 'module.ts', options: GraphOptions = {}): string[] {
  return specifiersOf(parseTexts({ [filename]: text }).get(filename)!, options);
}

function specifiersOf(source: SourceFile, { onDemand = true }: GraphOptions = {}): string[] {
  const result = new Set<string>();
  const add = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) result.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        !clause ||
        (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
          (clause.name ||
            !bindings ||
            ts.isNamespaceImport(bindings) ||
            bindings.elements.length === 0 ||
            bindings.elements.some((item) => !item.isTypeOnly)))
      )
        add(node.moduleSpecifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (
        !node.isTypeOnly &&
        (!clause || ts.isNamespaceExport(clause) || clause.elements.length === 0 || clause.elements.some((item) => !item.isTypeOnly))
      )
        add(node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
      return;
    }
    if (
      onDemand &&
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0]);
    node.forEachChild(visit);
  };
  visit(source);
  return [...result].sort();
}

/* A workspace package's module by its path (`@mistriwork/engine/shared/query.js`), as the repository path it is. */
const PACKAGE_DIRS: Record<string, string> = {
  '@mistriwork/engine': 'packages/engine',
  '@mistriwork/kit': 'packages/kit',
  '@mistriwork/ui': 'packages/ui',
  '@mistriwork/mistri': 'packages/mistri',
  tablewalk: 'packages/tablewalk',
};
function inWorkspace(specifier: string): string | undefined {
  const named = /^(@mistriwork\/[a-z]+|tablewalk)\/(.+)$/.exec(specifier);
  const dir = named && PACKAGE_DIRS[named[1]];
  return dir ? `${dir}/${named[2].startsWith('schema/') ? '' : 'src/'}${named[2]}` : undefined;
}

export function runtimeGraph(files: Record<string, string>, options: GraphOptions = {}): Graph {
  const graph: Graph = new Map(
    Object.keys(files)
      .sort()
      .map((file) => [file, new Set<string>()]),
  );
  const trees = parseTexts(files);
  for (const file of Object.keys(files)) {
    for (const specifier of specifiersOf(trees.get(file)!, options)) {
      const target = specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), specifier)) : inWorkspace(specifier);
      if (!target) continue;
      const stem = target.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
      const candidates = [
        stem + '.ts',
        stem + '.tsx',
        stem + '.mts',
        stem + '.cts',
        target,
        ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map((ext) => target + ext),
      ];
      const resolved = candidates.find((candidate) => graph.has(candidate));
      if (resolved) graph.get(file)!.add(resolved);
    }
  }
  return graph;
}

export function sourceGraph(root: string, options: GraphOptions = {}): Graph {
  const names = readdirSync(join(root, 'packages'))
    .filter((name) => existsSync(join(root, 'packages', name, 'src')))
    .flatMap((name) =>
      readdirSync(join(root, 'packages', name, 'src'), { recursive: true, encoding: 'utf8' }).map(
        (file) => `packages/${name}/src/` + file.split('\\').join('/'),
      ),
    )
    .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !/\.(?:test|d)\.[^.]+$/.test(file));
  return runtimeGraph(Object.fromEntries(names.map((file) => [file, readFileSync(join(root, file), 'utf8')])), options);
}

export function findCycles(graph: Graph): Cycles {
  let index = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index++);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (active.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let popped: string;
    do {
      popped = stack.pop()!;
      active.delete(popped);
      component.push(popped);
    } while (popped !== node);
    if (component.length > 1 || graph.get(node)?.has(node)) components.push(component.sort());
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  components.sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
  const edges: [string, string][] = [];
  for (const component of components) {
    const members = new Set(component);
    for (const from of component) for (const to of graph.get(from) ?? []) if (members.has(to)) edges.push([from, to]);
  }
  edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { components, edges };
}
