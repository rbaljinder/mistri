import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { parseSync } from 'vite';
import { transpile, typecheck } from './support/tsc.js';
import { HOST_MODULES, LAZY_HOST_MODULES, SDK_MODULE_EXPORTS, SERVED_MODULES } from '../packages/mistri/src/shared/uiSdk.js';

// Inspect the actual production packages used by the client build, not a fixed
// list of React names and not the development-only exports of this test runner.
const reactExports = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import { createRequire } from 'node:module';
  const require = createRequire(${JSON.stringify(import.meta.url)});
  console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(SERVED_MODULES.filter((name) => !name.startsWith('@mistriwork/mistri/')))}
    .map(name => [name, Object.keys(require(name)).filter(key => /^[A-Za-z_$][\\w$]*$/.test(key) && key !== 'default' && !key.startsWith('__'))]))));
`,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
  ),
) as Record<string, string[]>;
/* The SDK's own modules are their lists, in their order: what the build captures and the server checks. */
const expected = {
  ...reactExports,
  ...SDK_MODULE_EXPORTS,
};

/** The engine as an install holds it beside the package: its exports answer from dist/, and dist/ has the one module asked for. */
async function installEngine(dir: string) {
  const engine = join(dir, 'node_modules/@mistriwork/engine');
  await mkdir(join(engine, 'dist/server'), { recursive: true });
  await writeFile(
    join(engine, 'package.json'),
    JSON.stringify({ name: '@mistriwork/engine', type: 'module', exports: { './*': './dist/*' } }),
  );
  const source = await readFile(new URL('../packages/engine/src/server/devclient.ts', import.meta.url), 'utf8');
  await writeFile(join(engine, 'dist/server/devclient.js'), transpile(source, { module: 'esnext' }));
  const product = await readFile(new URL('../packages/engine/src/server/product.ts', import.meta.url), 'utf8');
  await writeFile(join(engine, 'dist/server/product.js'), transpile(product, { module: 'esnext' }));
}

async function installed(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-sdk-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'dist/server/app'), { recursive: true });
  await mkdir(join(dir, 'dist/shared'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await installEngine(dir);
  for (const file of ['server/app/componentSdk', 'shared/uiSdk']) {
    const source = await readFile(new URL(`../packages/mistri/src/${file}.ts`, import.meta.url), 'utf8');
    await writeFile(join(dir, `dist/${file}.js`), transpile(source, { module: 'esnext' }));
  }
  const manifest = join(dir, 'dist/server/app/component-sdk-exports.json');
  const moduleUrl = pathToFileURL(join(dir, 'dist/server/app/componentSdk.js')).href;
  const run = (code: string) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
  return { dir, manifest, moduleUrl, run };
}

test('packaged SDK bridges use only the captured host exports without installed React', async (t) => {
  const { dir, manifest, moduleUrl, run } = await installed(t);
  await writeFile(manifest, JSON.stringify(expected));
  run(`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readdirSync, unlinkSync } from 'node:fs';
    const require = createRequire(${JSON.stringify(moduleUrl)});
    /* The engine beneath the package, and nothing else: no React for a bridge to reach. */
    assert.deepEqual(readdirSync(${JSON.stringify(join(dir, 'node_modules'))}), ['@mistriwork']);
    for (const name of ${JSON.stringify(Object.keys(reactExports))}) assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
    const { hostModuleSource } = await import(${JSON.stringify(moduleUrl)});
    const expected = ${JSON.stringify(expected)};
    /* A module the page fetches on demand is asked for (\`load\`), and its bridge waits for it. */
    const lazy = ${JSON.stringify(LAZY_HOST_MODULES)};
    globalThis.__mistri = { modules: {}, load: {} };
    for (const [name, file] of Object.entries(${JSON.stringify(Object.fromEntries(SERVED_MODULES.map((name) => [name, HOST_MODULES[name]])))})) {
      const host = Object.fromEntries(expected[name].map(key => [key, { name, key }]));
      if (lazy.includes(name)) globalThis.__mistri.load[name] = async () => host;
      else globalThis.__mistri.modules[name] = host;
      const source = hostModuleSource(file);
      assert.equal(hostModuleSource(file), source);
      const bridge = await import('data:text/javascript,' + encodeURIComponent(source));
      assert.deepEqual(Object.keys(bridge).sort(), ['default', ...expected[name]].sort());
      assert.equal(bridge.default, host);
      for (const key of expected[name]) assert.equal(bridge[key], host[key]);
      if (name === 'react') unlinkSync(${JSON.stringify(manifest)}); // All other names come from the cached manifest.
    }
  `);
});

test('packaged SDK refuses missing or malformed manifests and never accepts a module path', async (t) => {
  const { manifest, moduleUrl, run } = await installed(t);
  const invalid = [
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...expected, extra: [] }),
    ...[[], 'useState', ['default'], ['__SECRET_INTERNALS'], ['useState', 'useState'], ['x } = m; console.log(1); //']].map((react) =>
      JSON.stringify({ ...expected, react }),
    ),
    JSON.stringify({ ...expected, '@mistriwork/mistri/ui': ['unexpected'] }),
  ];
  run(`
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    const missing = await import(${JSON.stringify(moduleUrl)});
    for (const file of ['fs.js', '../react.js', 'react', 'node:fs', ${JSON.stringify(manifest)}, 'component-sdk-exports.json', '__proto__']) {
      assert.equal(missing.hostModuleSource(file), undefined);
    }
    assert.throws(() => missing.hostModuleSource('react.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
    let index = 0;
    for (const body of ${JSON.stringify(invalid)}) {
      writeFileSync(${JSON.stringify(manifest)}, body);
      const { hostModuleSource } = await import(${JSON.stringify(moduleUrl)} + '?case=' + index++);
      assert.throws(() => hostModuleSource('react.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
      assert.throws(() => hostModuleSource('ui.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
    }
  `);
});

test('the build captures exactly the production host module exports', async (t) => {
  const file = new URL('../packages/mistri/dist/server/app/component-sdk-exports.json', import.meta.url);
  if (!existsSync(file)) return t.skip('no build: npm run build captures the host SDK exports');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
});

test('generated UI SDK export lists and schema barrels match source modules', () => {
  execFileSync(process.execPath, [new URL('../scripts/sync-ui-sdk.mjs', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
  });
});

const SCHEMA_ENTRY_KEYS = ['ui', 'page', 'primitives', 'charts', 'views', 'behaviors'] as const;
const ALL_SCHEMA_KEYS = [...SCHEMA_ENTRY_KEYS, 'kit'] as const;

test('no exported component or type name collides across the six public client entry points', () => {
  const schemaRoot = new URL('../packages/mistri/schema/', import.meta.url).pathname;
  const schemaMap = new Map(
    ALL_SCHEMA_KEYS.map((key) => {
      const file = join(schemaRoot, `${key}.d.ts`);
      const text = readFileSync(file, 'utf8');
      return [key, { file, text, ast: parseSync(file, text) }] as const;
    }),
  );

  function resolveExports(key: string, visited = new Set<string>()): Map<string, string> {
    if (visited.has(key)) return new Map();
    visited.add(key);
    const entry = schemaMap.get(key as (typeof ALL_SCHEMA_KEYS)[number]);
    if (!entry) return new Map();
    const localDecls = new Map<string, string>();
    const imports = new Map<string, { from: string; imported: string }>();
    const exports = new Map<string, string>();

    for (const stmt of entry.ast.program.body as Array<Record<string, any>>) {
      if (stmt.type === 'ImportDeclaration' && typeof stmt.source?.value === 'string') {
        const match = stmt.source.value.match(/^\.\/(kit|ui|page|primitives|charts|views|behaviors)\.js$/);
        if (match) {
          for (const spec of stmt.specifiers ?? []) {
            if (spec.type === 'ImportSpecifier') {
              const imported = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
              imports.set(spec.local.name, { from: match[1]!, imported });
            }
          }
        }
      }
      if (stmt.type === 'ExportAllDeclaration' && typeof stmt.source?.value === 'string') {
        const match = stmt.source.value.match(/^\.\/(kit|ui|page|primitives|charts|views|behaviors)\.js$/);
        if (match) {
          for (const [name, origin] of resolveExports(match[1]!, new Set(visited))) exports.set(name, origin);
        }
      }
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.source?.value) {
          const match = String(stmt.source.value).match(/^\.\/(kit|ui|page|primitives|charts|views|behaviors)\.js$/);
          for (const spec of stmt.specifiers ?? []) {
            const exported = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
            const local = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value);
            if (match) {
              const target = resolveExports(match[1]!, new Set(visited));
              exports.set(exported, target.get(local) ?? `${match[1]}:${local}`);
            } else {
              exports.set(exported, `${stmt.source.value}:${local}`);
            }
          }
        } else if (stmt.declaration) {
          const decl = stmt.declaration;
          const names: string[] = decl.id?.name
            ? [decl.id.name]
            : decl.type === 'VariableDeclaration'
              ? decl.declarations.map((d: any) => d.id?.name).filter(Boolean)
              : [];
          for (const name of names) {
            const origin = `${key}:${name}@${stmt.start}`;
            localDecls.set(name, origin);
            exports.set(name, origin);
          }
        } else {
          for (const spec of stmt.specifiers ?? []) {
            const exported = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
            const local = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value);
            const imp = imports.get(local);
            if (imp) {
              const target = resolveExports(imp.from, new Set(visited));
              exports.set(exported, target.get(imp.imported) ?? `${imp.from}:${imp.imported}`);
            } else {
              exports.set(exported, localDecls.get(local) ?? `${key}:${local}`);
            }
          }
        }
      } else {
        const names: string[] = stmt.id?.name
          ? [stmt.id.name]
          : stmt.type === 'VariableDeclaration'
            ? stmt.declarations.map((d: any) => d.id?.name).filter(Boolean)
            : [];
        for (const name of names) localDecls.set(name, `${key}:${name}@${stmt.start}`);
      }
    }
    return exports;
  }

  const origins = new Map<string, { origin: string; entry: string }>();
  const collisions: string[] = [];
  for (const key of SCHEMA_ENTRY_KEYS) {
    for (const [name, origin] of resolveExports(key)) {
      if (!/^[A-Z]/.test(name)) continue;
      const seen = origins.get(name);
      if (!seen) origins.set(name, { origin, entry: key });
      else if (seen.origin !== origin) {
        collisions.push(`${name}: @mistriwork/mistri/${seen.entry} (${seen.origin}) vs @mistriwork/mistri/${key} (${origin})`);
      }
    }
  }
  assert.deepEqual(collisions, []);
});

test('all six client schema barrels enforce one prop vocabulary, Tone, className, JSDocs, and zero any', () => {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const schemaRoot = join(root, 'packages/mistri/schema');

  // 1. AST check: zero `any` keyword, zero `inlist` property, and 1-line JSDocs on all /primitives, /charts, /views exports
  const anyHits: string[] = [];
  const missingDocs: string[] = [];
  for (const key of ALL_SCHEMA_KEYS) {
    const file = join(schemaRoot, `${key}.d.ts`);
    const text = readFileSync(file, 'utf8');
    const ast = parseSync(file, text);

    const walkAny = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'TSAnyKeyword') anyHits.push(`${key}.d.ts@${node.start}`);
      if (node.type === 'TSPropertySignature') {
        const propName = node.key?.type === 'Identifier' ? node.key.name : node.key?.type === 'Literal' ? String(node.key.value) : '';
        if (propName === 'inlist') anyHits.push(`${key}.d.ts:inlist@${node.start}`);
      }
      for (const k of Object.keys(node)) {
        if (k === 'start' || k === 'end' || k === 'type') continue;
        const val = node[k];
        if (Array.isArray(val)) for (const item of val) walkAny(item);
        else if (val && typeof val === 'object') walkAny(val);
      }
    };
    walkAny(ast.program);

    if (key === 'kit' || key === 'primitives' || key === 'charts' || key === 'views') {
      const declDocs = new Map<string, boolean>();
      for (const stmt of ast.program.body as Array<Record<string, any>>) {
        const leading = text.slice(Math.max(0, stmt.start - 400), stmt.start);
        const hasDoc = /\/\*\*[\s\S]*?\*\/\s*$/.test(leading);
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
        if (decl) {
          const names: string[] = decl.id?.name
            ? [decl.id.name]
            : decl.type === 'VariableDeclaration'
              ? decl.declarations.map((d: any) => d.id?.name).filter(Boolean)
              : [];
          for (const name of names) declDocs.set(name, hasDoc);
        }
        if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration && !stmt.source) {
          for (const spec of stmt.specifiers ?? []) {
            if (spec.exportKind === 'type' || stmt.exportKind === 'type') continue;
            const exported = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
            const local = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value);
            if (!declDocs.get(local) && !hasDoc) missingDocs.push(`${key}:${exported}`);
          }
        } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
          const d = stmt.declaration;
          const names: string[] = d.id?.name
            ? [d.id.name]
            : d.type === 'VariableDeclaration'
              ? d.declarations.map((x: any) => x.id?.name).filter(Boolean)
              : [];
          for (const name of names) {
            if (d.type !== 'TSTypeAliasDeclaration' && d.type !== 'TSInterfaceDeclaration' && !declDocs.get(name)) {
              missingDocs.push(`${key}:${name}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(anyHits, []);
  assert.deepEqual(missingDocs, []);

  // 2. Compiler-checked prop vocabulary across every exported component on all 6 entry points
  const nonComponentExports = new Set([
    'React',
    'Fragment',
    'InCardContext',
    'UiSurfaceSeamContext',
    'ComponentStyleScope',
    'DEFAULT_COLOR_SWATCHES',
  ]);
  const lines = [
    `import type { ComponentProps, JSXElementConstructor } from 'react';`,
    `import type { Tone } from '@mistriwork/mistri/primitives';`,
    `type PropsOf<C> = ComponentProps<C extends JSXElementConstructor<any> ? C : never>;`,
    `type NotNever<Name extends string, P> = [P] extends [never] ? [Name, 'resolved-never'] : never;`,
    `type BannedProp<Name extends string, P> = P extends unknown ? (Extract<keyof P, 'onChange' | 'aria-label' | 'busy' | 'pending'> extends never ? never : [Name, Extract<keyof P, 'onChange' | 'aria-label' | 'busy' | 'pending'>]) : never;`,
    `type MissingClassName<Name extends string, P> = P extends unknown ? ('className' extends keyof P ? never : [Name, 'missing-className']) : never;`,
    `type BadTone<Name extends string, P> = P extends { tone?: infer T } ? ((Exclude<NonNullable<T>, Tone> | Exclude<Tone, NonNullable<T>>) extends never ? never : [Name, NonNullable<T>]) : never;`,
    `type AssertNever<V extends never> = V;`,
  ];

  const entries = [
    ['ui', '@mistriwork/mistri/ui'],
    ['page', '@mistriwork/mistri/page'],
    ['primitives', '@mistriwork/mistri/primitives'],
    ['charts', '@mistriwork/mistri/charts'],
    ['views', '@mistriwork/mistri/views'],
    ['behaviors', '@mistriwork/mistri/behaviors'],
  ] as const;

  let index = 0;
  for (const [short, pkg] of entries) {
    lines.push(`import type * as M_${short} from '${pkg}';`);
    for (const name of SDK_MODULE_EXPORTS[pkg]) {
      if (!/^[A-Z]/.test(name) || nonComponentExports.has(name)) continue;
      lines.push(`type P_${index} = PropsOf<(typeof M_${short})['${name}']>;`);
      lines.push(`type C_${index}_nev = AssertNever<NotNever<'${short}.${name}', P_${index}>>;`);
      lines.push(`type C_${index}_ban = AssertNever<BannedProp<'${short}.${name}', P_${index}>>;`);
      lines.push(`type C_${index}_cls = AssertNever<MissingClassName<'${short}.${name}', P_${index}>>;`);
      lines.push(`type C_${index}_tone = AssertNever<BadTone<'${short}.${name}', P_${index}>>;`);
      index++;
    }
  }
  assert.ok(index >= 300, `expected at least 300 component exports across the 6 entry points, got ${index}`);

  const probe = join(root, 'test/.sdk-prop-vocabulary-probe.ts');
  const diagnostics = typecheck(probe, {
    files: { [probe]: lines.join('\n') },
    options: {
      jsx: 'react-jsx',
      lib: ['es2023', 'dom'],
      paths: {
        '@mistriwork/mistri/*': [join(schemaRoot, '*.d.ts')],
        '@mistriwork/ui': [join(root, 'packages/ui/src/index.ts')],
        '@mistriwork/ui/*': [join(root, 'packages/ui/src/*')],
      },
    },
  });
  assert.equal(diagnostics, '');
});
