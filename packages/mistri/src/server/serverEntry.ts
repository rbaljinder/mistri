/**
 * The file a server process of this installation starts from: the `mistri` binary's own entry (index.ts), beside this
 * module. Built, the module asking starts the built entry; run from source (under tsx, which the caller keeps), the
 * entry's source.
 */
import { fileURLToPath } from 'node:url';

export function serverEntry(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.js') ? './index.js' : './index.ts', import.meta.url));
}
