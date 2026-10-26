/** Inactive metadata foundation, not an executor or publication authority. */
import type { AppApiDef } from '../../shared/appApi.js';
import { isFormView, logicalResource, resolveAppAccess, type AppDef } from '../../shared/app.js';
import { commandTargets } from '../../shared/command.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { createBusinessCommandAuthorizer, type BusinessCommandAuthorizationOptions } from '../commands/businessCommandAuthorization.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { commandReferenceCatalogProblem } from '../commands/businessCommandReferenceChecks.js';
import { describeShape } from '../commands/commandShapes.js';
import { renderApiOutputSchema } from './apiOutputSchema.js';
import { genericWriteOf } from '../commands/genericWriteBrand.js';

type Evidence = Pick<BusinessCommandAuthorizationOptions, 'connectionFor' | 'writableConnection' | 'transactionalConnection'>;
type Authority = Evidence & Pick<BusinessCommandAuthorizationOptions, 'managedOwnership'>;
const fail = (id: string, message: string): never => {
  throw new Error(`api.commands.${id}: ${message}.`);
};

/** App/API are normalized, schema is logical, registry is declaration-only.
 * Evidence MUST come from trusted host binding metadata, never a request or
 * inferred dialect capability. This function checks the existing authorizer's
 * requirements; it cannot establish that the caller's attestations are true.
 * No command handler, validator, initial, availability or output parser runs.
 */
export function checkApiCommandCatalog(
  api: AppApiDef,
  app: AppDef,
  schema: DatabaseSchema,
  declaredRegistry: BusinessCommandRegistry,
  evidence: Evidence,
) {
  // A row-policy App's commands run in its deployment's scoped binding (policyApiOwner.ts); the checks are the same.
  if (app.auth?.rows !== 'all' && app.auth?.rows !== 'policy') fail('*', 'tenant contexts are unsupported by this foundation');
  // Explicit property selection prevents a structural options object from
  // overriding the App, registry, schema or supplying managed tenant authority.
  return scopedCommandCatalog(api, app, schema, declaredRegistry, {
    connectionFor: evidence?.connectionFor,
    writableConnection: evidence?.writableConnection,
    transactionalConnection: evidence?.transactionalConnection,
  });
}

/** The checks, for a caller that has settled the context: an ordinary App's
 * (above), or a tenant deployment's, whose managed ownership columns the
 * tenant runtime's own authorizer carries (apiTenantCommandCatalog). */
export function scopedCommandCatalog(
  api: AppApiDef,
  app: AppDef,
  schema: DatabaseSchema,
  declaredRegistry: BusinessCommandRegistry,
  authority: Authority,
) {
  if (!api.roles.length || api.roles.some((role) => !Object.hasOwn(app.auth?.roles ?? {}, role)))
    fail('*', 'every API role must be declared');
  const registry = defineCommands(declaredRegistry);
  validateBusinessCommandReferences(app, registry, { schema });
  const authorizer = createBusinessCommandAuthorizer({
    app,
    schema,
    registry,
    connectionFor: authority.connectionFor,
    writableConnection: authority.writableConnection,
    transactionalConnection: authority.transactionalConnection,
    ...(authority.managedOwnership === undefined ? {} : { managedOwnership: authority.managedOwnership }),
  });
  const operations = api.commands.map(({ command: ref }) => {
    const id = ref.id,
      command = registry[id];
    if (!command) return fail(id, 'unregistered command');
    if (command.public) fail(id, 'public commands cannot be API exposures');
    const resource = logicalResource(app, command.source, command.target);
    // The exposure was resolved from a registration when the App loaded; it must be this one's.
    if (ref.version !== command.version) fail(id, 'the App was loaded with another commands module');
    const targeted = 'target' in ref;
    const targets = targeted ? commandTargets(ref) : 'none';
    if (targeted) {
      if (authorizer.creates(id)) fail(id, 'targeted exposure conflicts with existing untargeted form semantics');
    } else {
      if (!authorizer.creates(id)) fail(id, 'API-only untargeted commands require future shared reference integration');
      // A generic create is the platform's own; any other names a signed-in form it shares.
      const forms = Object.values(app.views).filter((view) => isFormView(view) && !view.public && view.command.id === id);
      if (!forms.length && !genericWriteOf(command)) fail(id, 'untargeted exposure requires an existing signed-in form');
    }
    const read = command.read.map((local) => logicalResource(app, command.source, local));
    /* One App API request reads one connection. The authorizer keeps a
       command's reads and writes on its own; a lookup (`sources`) reads
       before the transaction and may reach another, which an exposed
       command may not. */
    const home = app.sources?.[command.source]?.connection;
    for (const source of Object.keys(command.sources ?? {})) {
      if (app.sources?.[source]?.connection !== home) {
        fail(id, `looks up source "${source}", on another connection; one App API request reads one connection [api-multi-source]`);
      }
    }
    const problem = commandReferenceCatalogProblem(app, command, ref, resource, schema);
    if (problem) fail(id, problem);
    const output = describeShape(command.output);
    const outputSchema = renderApiOutputSchema(command.output).schema;
    // Structural rendering is not canonical envelope validation or authority
    // to execute/publish a command; those gates remain separate.
    /* A table the command reads under its own authority (`elevate`) does not
       open the App API to a role that cannot read it: the API publishes a
       command as the role's own operation over the footprint it reads, so an
       API role must read the whole of it. Elevation stays an App-form matter,
       reviewed in `mistri check --design`. */
    const elevated = (command.elevate?.read ?? []).map((local) => logicalResource(app, command.source, local));
    const eligibleRoles = api.roles.filter((role) => {
      try {
        authorizer.authorize(id, { id: 'api-catalog-check', appId: app.id, roles: [role] });
      } catch (error) {
        if (error instanceof AppAccessDenied) return false;
        throw error;
      }
      return !elevated.length || elevated.every((table) => resolveAppAccess(app, schema, [role]).readable.has(table));
    });
    if (!eligibleRoles.length) fail(id, 'no declared API role authorizes the whole command footprint');
    return Object.freeze({
      id: `command:${id}`,
      command: id,
      version: ref.version,
      resource,
      targets,
      source: command.source,
      realm: command.realm ?? 'tenant',
      eligibleRoles: Object.freeze(eligibleRoles),
      read: Object.freeze(read),
      write: Object.freeze(command.write.map((local) => logicalResource(app, command.source, local))),
      output,
      outputSchema,
    });
  });
  return Object.freeze({
    stage: 'command-validation-foundation' as const,
    wireValidation: 'pending' as const,
    envelopeValidation: 'pending' as const,
    execution: 'pending' as const,
    publication: 'pending' as const,
    operations: Object.freeze(operations),
  });
}
