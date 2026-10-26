/**
 * The modules a custom component imports by bare name — `react`, its JSX
 * runtime, `react-dom`, `@mistriwork/mistri/ui`, `@mistriwork/mistri/page` — as the browser receives them: a few
 * lines each over the page's own copy, which the page puts on one frozen
 * global when it first draws a component (components/sdk/host.tsx). A
 * component's bare imports are written as these paths when it is served
 * (http/componentRoutes.ts), so no page needs an import map for them.
 *
 * Why not the real modules: the published client is one bundle whose React is
 * inside it, and a second React loaded beside it would be a second set of
 * hooks. Source hosting reads export names from its installed packages. The
 * published host reads the names captured from those same packages in production
 * mode at build time (scripts/package-console.mjs): React lives only in the
 * browser bundle, never in the server's runtime dependencies. `@mistriwork/mistri/ui`'s
 * and `@mistriwork/mistri/page`'s names remain the SDK's own (shared/uiSdk.ts), pinned by a test.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { HOST_GLOBAL, HOST_MODULES, PAGE_EXPORTS, SERVED_MODULES, UI_EXPORTS, type HostModule } from '../../shared/uiSdk.js';
import { FROM_SOURCE } from '@mistriwork/engine/server/devclient.js';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const made = new Map<string, string>();
let packagedNames: Readonly<Record<HostModule, readonly string[]>> | undefined;

function packagedExports(): Readonly<Record<HostModule, readonly string[]>> {
  if (packagedNames) return packagedNames;
  try {
    const value: unknown = JSON.parse(readFileSync(new URL('./component-sdk-exports.json', import.meta.url), 'utf8'));
    const modules = SERVED_MODULES;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== modules.length)
      throw new Error('Expected exactly the host modules.');
    const manifest = value as Record<HostModule, unknown>;
    for (const module of modules) {
      const names = manifest[module];
      if (
        !Object.hasOwn(manifest, module) ||
        !Array.isArray(names) ||
        !names.length ||
        !names.every((name) => typeof name === 'string' && IDENTIFIER.test(name) && name !== 'default' && !name.startsWith('__')) ||
        new Set(names).size !== names.length
      )
        throw new Error(`Invalid exports for ${module}.`);
    }
    if (
      JSON.stringify(manifest['@mistriwork/mistri/ui']) !== JSON.stringify(UI_EXPORTS) ||
      JSON.stringify(manifest['@mistriwork/mistri/page']) !== JSON.stringify(PAGE_EXPORTS)
    )
      throw new Error('The SDK exports do not match this build.');
    return (packagedNames = manifest as Record<HostModule, string[]>);
  } catch (cause) {
    throw new Error('mistri: component SDK refused: component-sdk-exports.json is missing or invalid. Rebuild the package.', { cause });
  }
}

/** A host module's value exports, as a component's named imports read them. */
export function exportNames(module: HostModule): readonly string[] {
  if (!FROM_SOURCE) return packagedExports()[module];
  if (module === '@mistriwork/mistri/ui') return UI_EXPORTS;
  if (module === '@mistriwork/mistri/page') return PAGE_EXPORTS;
  /* The CommonJS exports object: what the page's bundle hands a named import.
     React's `__…INTERNALS…` are not a component's to reach. */
  return Object.keys(createRequire(import.meta.url)(module) as object).filter(
    (name) => IDENTIFIER.test(name) && name !== 'default' && !name.startsWith('__'),
  );
}

/** The served module for one host file name (`react.js`), or undefined when it names none. */
export function hostModuleSource(file: string): string | undefined {
  const module = SERVED_MODULES.find((name) => HOST_MODULES[name] === file);
  if (!module) return undefined;
  let source = made.get(module);
  if (source === undefined) {
    const names = exportNames(module);
    source = [
      `// ${module}, the page's own copy, for a custom component. Served by mistri; see packages/mistri/src/server/app/componentSdk.ts.`,
      `const m = globalThis.${HOST_GLOBAL}?.modules?.[${JSON.stringify(module)}];`,
      `if (!m) throw new Error(${JSON.stringify(`mistri: ${module} is the page's, and the page has not provided it; a custom component is loaded by the section that draws it.`)});`,
      'export default m.default ?? m;',
      `export const { ${names.join(', ')} } = m;`,
      '',
    ].join('\n');
    made.set(module, source);
  }
  return source;
}
