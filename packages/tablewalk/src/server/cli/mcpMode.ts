/**
 * `--mcp`: no HTTP server at all. The process is spawned by the agent's
 * client, speaks MCP on stdio, and exits when stdin closes — stdout is the
 * protocol, so every startup line was sent to stderr before this runs.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { serveMcp, setAdvertiseOutputSchema, setToolProfile } from '../mcp.js';
import { layoutsFor, pagesPath } from '@mistriwork/engine/server/layouts.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import { startTelemetry } from '@mistriwork/engine/adapters/telemetry/start.js';

export async function serveMcpMode(
  opts: Options,
  registry: Registry,
  shelf: { queries: SavedQuery[]; pages: PageDef[] },
  packageVersion: () => Promise<string>,
): Promise<void> {
  /* The version is what the package says it is, best-effort — serverInfo is
     a courtesy field. */
  const version = await packageVersion();
  /* Before the server starts answering, and fatal if it does not name a
     profile: a typo that silently fell back to every tool would be a
     surprise measured in tokens rather than in errors. */
  try {
    setToolProfile(opts.tools);
  } catch (err) {
    console.error(`tablewalk: ${startupReport(err)}`);
    process.exit(1);
  }
  setAdvertiseOutputSchema(opts.outputSchema);
  /* OpenTelemetry, when OTEL_* says so: a span per tool call, and the
     statements beneath it. Nothing is loaded otherwise. */
  const telemetry = await startTelemetry(process.env, version, undefined, 'tablewalk');
  process.stdin.once('close', () => {
    void telemetry.shutdown();
  });
  serveMcp(registry, version, {
    /* The same config the browser reads, so the shelf an agent sees is the
       shelf the team keeps — not a second list that drifts. */
    queries: shelf.queries,
    pages: shelf.pages,
    savedPages: (connection) => layoutsFor(connection, pagesPath()),
  });
  console.log('tablewalk: speaking MCP on stdio');
}
