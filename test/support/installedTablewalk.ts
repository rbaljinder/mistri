/**
 * tablewalk as `npm install` leaves it in a project's node_modules, for a
 * test that typechecks an App importing `@mistriwork/mistri/commands`.
 *
 * An install is four packages: `tablewalk`, whose `@mistriwork/mistri/commands` is a
 * stub re-exporting `@mistriwork/mistri/commands`, and mistri, @mistriwork/kit and
 * @mistriwork/engine beneath it. Each installed manifest is the one a pack ships
 * (scripts/pack-manifest.mjs): its exports name dist/, where the server
 * entries' declarations are, and only `npm run build` writes dist/. A
 * developer's checkout usually has one — often a stale one — and CI's
 * `npm test` runs on a clean `npm ci` tree that has none, so the same test
 * passed here and failed there with "Cannot find module '@mistriwork/mistri/commands'".
 * This builds each package directory instead (scripts/install-packages.mjs),
 * its `dist/` holding the declarations emitted fresh from
 * `tsconfig.commands.json`, as `npm run build` does, each package's share in
 * its own dist/. Nothing at run time reads those `dist/`
 * folders: an App's commands module is loaded against the running server's
 * own modules.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPackages } from '../../scripts/install-packages.mjs';
import { project, typecheck } from './tsc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

/** Installs every workspace package into `nodeModules`; returns the `tablewalk` package's folder there. */
export function installTablewalk(nodeModules: string): string {
  mkdirSync(nodeModules, { recursive: true });
  const stage = join(nodeModules, `.declarations-${randomUUID()}`);
  // --noCheck, as the build emits it: test:static has typechecked the source. No build info: parallel tests share the checkout's.
  /* At the checkout's root, where `types: ["node"]` is found. */
  const config = join(ROOT, `.tsc-declarations-${randomUUID()}.json`);
  try {
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(ROOT, 'tsconfig.commands.json'),
        compilerOptions: { outDir: stage, noCheck: true, incremental: false, tsBuildInfoFile: null },
      }),
    );
    const emitted = spawnSync(process.execPath, [TSC, '-p', config, '--pretty', 'false'], { encoding: 'utf8', timeout: 300_000 });
    if (emitted.status !== 0) throw new Error(`tablewalk declarations were not emitted: ${emitted.stdout}${emitted.stderr}`);
    installPackages(nodeModules, { distOf: (dir) => join(stage, dir, 'src') });
  } finally {
    rmSync(config, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
  return join(nodeModules, 'tablewalk');
}

/**
 * A consumer's source checked against the declarations the package publishes,
 * and the names one of them exports: what a project that installed tablewalk
 * sees through `tablewalk/<entry>`. `types` is the entry's declarations as an
 * install's node_modules holds them (`@mistriwork/mistri/dist/server/commands.d.ts`), the
 * path its published exports map gives under the package's name.
 */
export function publishedDeclarations(consumer: string, types: string): { report: string; exports: string[] } {
  /* Real, as the compiler names files: /var is a link to /private/var on macOS. */
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'tablewalk-consumer-')));
  try {
    installTablewalk(join(work, 'node_modules'));
    mkdirSync(join(work, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(work, 'node_modules', '@types', 'node'), 'dir');
    const file = join(work, 'consumer.ts');
    const options = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2023',
      lib: ['es2023'],
      types: ['node'],
    };
    writeFileSync(file, consumer);
    writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: options, files: [file] }));
    const report = typecheck(file, { options: { target: 'ES2023' } });
    const { program, checker } = project(join(work, 'tsconfig.json'));
    const entry = program.getSourceFile(join(work, 'node_modules', types));
    const symbol = entry && checker.getSymbolAtLocation(entry);
    if (!symbol) throw new Error(`${types} is not in the consumer's program`);
    return {
      report,
      exports: checker
        .getExportsOfModule(symbol)
        .map((exported) => exported.name)
        .sort(),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
