/* Shared by every loader of trusted App code (a row or tenant policy, a
   commands module, a jobs module): what failed is said to the operator, once,
   with a credential in a URL masked on the way. */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Why a module did not load, and where: the loader's words, and the module's line that imported or threw. */
export function moduleFailure(file: string, error: unknown): string {
  const said = (error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error))
    .split('\n')[0]
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@]+@/gi, '$1••••••@');
  let line: number | undefined,
    where = file;
  const missing = /Cannot find (?:package|module) '([^']+)'/.exec(said)?.[1];
  if (missing) {
    // The import that names it: in the module, or the file of its own the loader says imported it.
    const importer = / imported from (\S+)$/.exec(said)?.[1];
    if (importer) where = importer.startsWith('file:') ? fileURLToPath(importer) : importer;
    try {
      const at = readFileSync(where, 'utf8')
        .split('\n')
        .findIndex((text) =>
          new RegExp(`(?:from|import|require\\()\\s*['"]${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(text),
        );
      if (at >= 0) line = at + 1;
    } catch {
      /* unread: said without its line */
    }
  } else if (error instanceof Error && error.stack) {
    const frame = error.stack.split('\n').find((text) => text.includes(pathToFileURL(file).href) || text.includes(file));
    const found = frame && /:(\d+):\d+\)?\s*$/.exec(frame);
    if (found) line = Number(found[1]);
  }
  return `${said}${line ? ` (${basename(where)}:${line})` : ''}`;
}
