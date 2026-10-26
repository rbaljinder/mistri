/**
 * The database browser's modes that answer and exit rather than serve: the schema in words (`--export md`,
 * `mermaid`, `json`), `--diff` and `--lint`. Each is a build step — its answer on stdout, every startup line
 * already sent to stderr — and a build step that starts a web server is one nobody wires into CI. An App's
 * exports (types, OpenAPI, AsyncAPI) are the App framework's (oneShot.ts). With Apps named, the App framework's main
 * loads and vets them first, then hands the mode back here (mistriMain.ts backToBrowser).
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';

/** `--export md | markdown | mermaid | json` (the formats startFor gives this main). */
export async function exportSchemaText(given: string, registry: Registry): Promise<void> {
  const format = given.toLowerCase();
  try {
    const { schema } = await registry.open(registry.active!);
    const { toMarkdown, toMermaid, toSchemaJson } = await import('@mistriwork/engine/shared/schematext.js');
    const text =
      format === 'mermaid' ? toMermaid(schema) : format === 'json' ? JSON.stringify(toSchemaJson(schema), null, 2) : toMarkdown(schema);
    process.stdout.write(`${text}\n`);
  } catch (error) {
    console.error(`tablewalk: ${startupReport(error)}`);
    process.exitCode = 1;
  } finally {
    await registry.closeAll();
  }
}

export async function diffConnections(other: string, registry: Registry): Promise<void> {
  const { diffSchemas, diffReport } = await import('../../shared/diff.js');
  const mine = await registry.open(registry.active!);
  let theirs;
  try {
    theirs = await registry.open(other);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const diff = diffSchemas(mine.schema, theirs.schema);
  process.stdout.write(`${diffReport(diff)}\n`);
  /* diff(1)'s convention, and the one a CI step wants: zero means the same,
     one means different. Anything else here would need a flag to mean what
     every other diff already means without one. */
  if (!diff.same) process.exit(1);
}

/* Print and exit, like --export: this is a build step, and a build step
   that starts a web server is one nobody wires into CI. */
export async function lintConnection(given: string, failOn: string | undefined, registry: Registry): Promise<void> {
  const { lintSchema, lintReport, lintCounts } = await import('../../shared/lint.js');
  const { schema } = await registry.open(registry.active!);
  const findings = lintSchema(schema);
  const format = given.toLowerCase();
  if (format !== 'text' && format !== 'json') {
    console.error(`--lint takes text or json — not "${given}".`);
    process.exit(1);
  }
  process.stdout.write(
    format === 'json'
      ? `${JSON.stringify({ connection: registry.active, counts: lintCounts(findings), findings }, null, 2)}\n`
      : `${lintReport(findings)}\n`,
  );
  if (failOn) {
    const levels = ['high', 'medium', 'low'];
    const at = levels.indexOf(failOn.toLowerCase());
    if (at === -1) {
      console.error(`--fail-on takes high, medium or low — not "${failOn}".`);
      process.exit(1);
    }
    /* At least this severe: `--fail-on medium` fails on medium *and* high,
       which is the reading that makes a threshold useful. */
    const worst = levels.slice(0, at + 1);
    if (findings.some((f) => worst.includes(f.severity))) process.exit(1);
  }
}
