/**
 * This runtime's version, read from its own package.json: what `--version`
 * prints, what MCP's serverInfo says and what a build is pinned to. A module
 * of its own so a start that only needs the number does not load the build.
 */
import { readFileSync } from 'node:fs';

let version: string | undefined;

export function runtimeVersion(): string {
  version ??= (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return version;
}
