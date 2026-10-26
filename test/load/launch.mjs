import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fixed repository artifacts only; no caller-selected executable or target. */
export function serverLaunch(production = false, stat = statSync) {
  if (typeof production !== 'boolean') throw new Error('Invalid production mode');
  if (!production) return { mode: 'source-dev-vite', entry: ['--import', 'tsx', 'packages/mistri/src/server/index.ts'] };
  for (const artifact of [
    'packages/mistri/dist/server/index.js',
    'packages/engine/dist/server/devclient.js',
    'packages/mistri/dist/client/index.html',
  ]) {
    const path = fileURLToPath(new URL(`../../${artifact}`, import.meta.url));
    try {
      if (!stat(path).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(
        `--production requires existing built artifact ${artifact}. Build separately before running; the harness never builds or installs.`,
      );
    }
  }
  /* The built packages import each other by name; in a checkout their exports answer from dist/ under this condition. */
  return { mode: 'production-dist', entry: ['--conditions=mistri-built', 'packages/mistri/dist/server/index.js'] };
}
