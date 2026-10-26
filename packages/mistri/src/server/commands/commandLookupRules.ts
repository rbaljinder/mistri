// A leaf: the tenant and feature bindings ask this without reaching the
// lookup's reader, so an edit to the reader does not select their suites.

import { logicalResource, type AppDef } from '../../shared/app.js';
import { isRowPolicyApp } from '../../shared/appModel.js';

/**
 * Why this App cannot run a command's lookup, or undefined. Asked when the
 * commands bind — every binding, so startup and mistri check too — and by
 * tenant startup before its deployment, so the refusal says why and what is
 * allowed rather than naming a stage.
 *
 * Decided, may be revisited: a tenant App (and its platform realm) looks up
 * only resources every tenant reads, `owner: 'global'`; tenant-owned rows
 * belong in the command's own transaction, and platform-owned rows are never
 * read in a tenant's context. A row-policy App looks up nothing: its rows are
 * scoped per actor, and that scope does not reach another source yet.
 */
export const TENANT_RULE =
  'A tenant App\'s command looks up only resources every tenant reads, "owner": "global" — reference data. ' +
  "Rows a tenant owns belong in the command's own transaction; rows the platform owns are never read in a tenant's context.";

export function commandLookupProblem(
  app: AppDef,
  id: string,
  sources: Readonly<Record<string, readonly string[]>> | undefined,
): string | undefined {
  if (!sources) return undefined;
  if (isRowPolicyApp(app)) {
    return (
      `Command "${id}" declares "sources" to look up, which a row-policy App ("auth.rows": "policy") does not do yet: ` +
      'its rows are scoped per actor, and that scope does not reach a lookup. Read what the command needs in its own transaction.'
    );
  }
  for (const [source, tables] of Object.entries(sources)) {
    if (!Object.hasOwn(app.sources ?? {}, source)) return `Command "${id}" looks up source "${source}", which the App does not declare.`;
    if (app.auth?.rows !== 'tenant') continue;
    for (const local of tables) {
      const logical = logicalResource(app, source, local);
      const owner = Object.hasOwn(app.resources ?? {}, logical) ? app.resources![logical].owner : undefined;
      if (owner !== 'global') {
        return `Command "${id}" looks up "${logical}", which is ${owner ? `"owner": "${owner}"` : 'not a resource the App declares'}. ${TENANT_RULE}`;
      }
    }
  }
  return undefined;
}
