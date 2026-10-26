#!/usr/bin/env node
/** Ship the internal Console room and the host SDK export manifest.
 * Run after tsc, with the same installed React that Vite bundles into the client, and with
 * --conditions=mistri-built so the built modules' package imports land in the other packages' dist.
 * An installed server has no React: its bridges use these captured names. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileConsole } from '@mistriwork/mistri/server/console/components.js';

/* A fresh production process avoids both the caller's NODE_ENV and any cached
   development React exports (act/captureOwnerStack are absent in the client). */
const sdkExports = execFileSync(
  process.execPath,
  [
    '--conditions=mistri-built',
    '--input-type=module',
    '-e',
    `
  import { createRequire } from 'node:module';
  import { PAGE_EXPORTS, SERVED_MODULES, UI_EXPORTS } from ${JSON.stringify(new URL('../packages/mistri/dist/shared/uiSdk.js', import.meta.url).href)};
  const require = createRequire(${JSON.stringify(import.meta.url)});
  const exports = Object.fromEntries(SERVED_MODULES.map(module => [module,
    module === '@mistriwork/mistri/ui' ? UI_EXPORTS : module === '@mistriwork/mistri/page' ? PAGE_EXPORTS : Object.keys(require(module))
      .filter(name => /^[A-Za-z_$][\\w$]*$/.test(name) && name !== 'default' && !name.startsWith('__'))]));
  console.log(JSON.stringify(exports));
`,
  ],
  { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
);
await writeFile(new URL('../packages/mistri/dist/server/app/component-sdk-exports.json', import.meta.url), sdkExports);
console.log('package-console: captured production host exports to packages/mistri/dist/server/app/component-sdk-exports.json');

const components = await compileConsole(
  fileURLToPath(new URL('../packages/mistri/src/', import.meta.url)),
  ['kit', 'ui', 'engine'].map((dir) => fileURLToPath(new URL(`../packages/${dir}/`, import.meta.url))),
);
await writeFile(new URL('../packages/mistri/dist/server/console/components.json', import.meta.url), JSON.stringify(components) + '\n');
console.log('package-console: compiled Console rooms to packages/mistri/dist/server/console/components.json');
