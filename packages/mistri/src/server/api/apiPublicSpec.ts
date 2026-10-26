/** The App API's whole OpenAPI document, as `--export openapi` prints it and,
 * when the App sets `api.publicSpec`, as `…/$openapi` answers a request that
 * presents no credential. A token's own document stays narrowed to what it
 * may do (apiNarrowedReadOpenApi.ts); this one describes every declared
 * operation, and nothing about who may call it: the eligible roles and the
 * views' standing questions are the operator's, so the published copy drops
 * them, as a token's copy does. Publishing the shape grants nothing — every
 * operation it lists still needs a token whose scope includes it. */
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { checkApiCommandCatalog } from './apiCommandCatalog.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { renderApiOpenApi } from './apiOpenApiDocument.js';
import { apiExposesCommands, withApiWrites } from './apiGenericWrites.js';
import { readApiApp } from './appApiValidation.js';

type Json = Record<string, unknown>;
/** Per operation: who may call it and the views' authored questions. */
const OPERATOR_ONLY = ['x-mistri-eligible-roles', 'x-mistri-standing-contract'];

/**
 * The App's whole document: its reads, and its commands and generic writes
 * when it exposes any (then `commands`, its registry, is required). `tenant`:
 * a tenant App's two catalogs, from its owner's trusted routing.
 */
export function renderAppApiOpenApi(
  app: AppDef,
  schema: DatabaseSchema,
  options: Readonly<{
    integers: 'decimal-string' | 'number';
    commands?: BusinessCommandRegistry;
    evidence?: Parameters<typeof checkApiCommandCatalog>[4];
    tenant?: Readonly<{ reads: ReturnType<typeof checkApiReadCatalog>; commands?: ReturnType<typeof checkApiCommandCatalog> }>;
  }>,
): Json {
  if (!app.api) throw new Error('The App API document requires an explicit api declaration.');
  if (!apiExposesCommands(app.api))
    return renderApiReadOpenApi(readApiApp(app), schema, { integers: options.integers }, options.tenant?.reads).document as Json;
  if (!options.evidence) throw new Error('The App API document needs its command evidence.');
  if (options.tenant) {
    if (!options.commands || !options.tenant.commands) throw new Error('The App API document needs its commands module.');
    return renderApiOpenApi(
      app,
      schema,
      options.commands,
      options.evidence,
      { integers: options.integers },
      {
        reads: options.tenant.reads,
        commands: options.tenant.commands,
      },
    ).document as Json;
  }
  // Generic writes are the platform's commands, described as the owner serves them.
  const served = withApiWrites(app, schema, options.commands);
  if (!served.registry) throw new Error('The App API document needs its commands module.');
  return renderApiOpenApi(served.app, schema, served.registry, options.evidence, { integers: options.integers }).document as Json;
}

/** The document as anyone may read it: every operation, without its roles or standing questions. */
function publicApiOpenApi(document: Json): string {
  const copy = JSON.parse(JSON.stringify(document)) as Json;
  const paths = copy.paths;
  if (!paths || typeof paths !== 'object') throw new Error('The App API document is unavailable.');
  for (const entry of Object.values(paths as Json)) {
    if (!entry || typeof entry !== 'object') throw new Error('The App API document is unavailable.');
    for (const operation of Object.values(entry as Json)) {
      if (!operation || typeof operation !== 'object') continue;
      for (const key of OPERATOR_ONLY) delete (operation as Json)[key];
    }
  }
  return JSON.stringify(copy);
}

/**
 * `api.publicSpec` for one serving lifetime: renders on first request and
 * keeps the body while what it was rendered from is the same. `render`
 * returns the object the document is rendered from (the App's runtime
 * resources, kept per opened catalog, or its tenant routing) and how to
 * render it, so a refreshed schema renders again rather than publishing a
 * stale shape.
 */
export function createApiPublicSpec(render: () => Promise<Readonly<{ from: object; document(): Json }>>) {
  let kept: { from: object; body: string } | undefined;
  return Object.freeze({
    async read(): Promise<string> {
      const rendered = await render();
      if (kept?.from !== rendered.from) kept = { from: rendered.from, body: publicApiOpenApi(rendered.document()) };
      return kept.body;
    },
  });
}
export type ApiPublicSpec = ReturnType<typeof createApiPublicSpec>;
