/** Console is an internal App component, compiled by the ordinary App compiler.
 * Only an enabled Console loads it; packaged hosts need neither source nor the
 * optional compiler. The artifact path is fixed, never supplied by a request. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompiledComponents } from '../app/appComponents.js';
import { FROM_SOURCE } from '@mistriwork/engine/server/devclient.js';

let components: Promise<CompiledComponents> | undefined;

export function consoleComponents(): Promise<CompiledComponents> {
  return (components ??= load());
}

/**
 * The Console's rooms compiled from `source` (this package's src/), as the ordinary App compiler compiles an App's
 * components. A room draws with the kit's components, which reach the engine's shared rules: a checkout keeps both in
 * packages of their own rather than under node_modules, so each of `packages` (a package's folder) lends its src/ to
 * the rooms as their own — never its server code, which the compiler refuses wherever it is.
 */
export async function compileConsole(source: string, packages: readonly string[]): Promise<CompiledComponents> {
  const { compileComponents } = await import('../app/appComponents.js');
  const { consoleComponentList } = await import('./app.js');
  return (await compileComponents(source, new Map(consoleComponentList.map((component) => [component.id, component])), {
    minify: true,
    shared: packages.map((dir) => join(dir, 'src')),
  }))!;
}

async function load(): Promise<CompiledComponents> {
  if (FROM_SOURCE) {
    const require = createRequire(import.meta.url);
    const packages = ['@mistriwork/kit', '@mistriwork/ui', '@mistriwork/engine'].map((name) =>
      dirname(require.resolve(`${name}/package.json`)),
    );
    return compileConsole(fileURLToPath(new URL('../../', import.meta.url)), packages);
  }
  return JSON.parse(await readFile(new URL('./components.json', import.meta.url), 'utf8')) as CompiledComponents;
}
