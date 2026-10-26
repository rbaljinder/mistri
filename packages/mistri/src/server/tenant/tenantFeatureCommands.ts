/**
 * A tenant App's --commands registry at startup and enrollment: lookups the App
 * can run, one resultReferences extractor per command, authorizer-valid
 * definitions, and the command journal enrollment attests.
 */
import { assertSqliteCommandJournal } from '../../adapters/commands/commandJournal.js';
import { assertPostgresCommandJournal } from '../../adapters/commands/postgresCommandJournal.js';
import { appCommandOccurrences } from '../../shared/appCommandOccurrences.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { BusinessCommandDefinitionError, CommandLookupRefusal } from '../commands/businessCommands.js';
import { MAX_COMMAND_IDS } from '../commands/commandLimits.js';
import { commandLookupProblem } from '../commands/commandLookupRules.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook, TenantStartupCheck, TenantStartupCommands } from './tenantFeatureContract.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

// Before the deployment, whose refusals name only a stage: a lookup the App cannot run says why and what is allowed.
export const commandLookupCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  run: ({ app, registry }) => {
    for (const [id, command] of Object.entries(registry ?? {})) {
      const problem = commandLookupProblem(app, id, command.sources);
      if (problem) throw new CommandLookupRefusal(problem);
    }
  },
});

// Diagnose authoring before enrollment's intentionally opaque failure boundary.
// These captured definitions contain no session, provider error or business row.
export const commandReferencesCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  run: ({ app, policy, registry, owned, configured, connection }) => {
    /* What the App asks of a registry, said before enrollment's opaque
       boundary: an action or a form that references a command, and a role that
       grants one, are authoring mistakes worth a sentence — not a refusal an
       operator cannot read. Ids are authored names, like the ones below. */
    const referenced = [...new Set(appCommandOccurrences(app).map((occurrence) => occurrence.reference.id))];
    const granted = Object.entries(app.auth?.roles ?? {}).flatMap(([role, grant]) =>
      [...(grant.commands ?? [])].map((id) => ({ role, id })),
    );
    const naming = (entries: readonly { readonly role: string; readonly id: string }[]) =>
      entries.map((entry) => `"${entry.id}" (role "${entry.role}")`).join(', ');
    if (!registry && policy.resultReferences !== undefined) {
      throw new TenantCommandStartupError(
        'The tenant policy declares resultReferences but no --commands registry was loaded: keep commands.ts beside the App or pass --commands, or drop resultReferences.',
      );
    }
    if (!registry && (referenced.length || granted.length)) {
      throw new TenantCommandStartupError(
        'This App runs commands, and no --commands registry was loaded.' +
          (referenced.length ? ` Referenced by an action or form: ${referenced.map((id) => `"${id}"`).join(', ')}.` : '') +
          (granted.length ? ` Granted to a role: ${naming(granted)}.` : '') +
          ' Start the deployment with --commands <file>, or drop the references and grants.',
      );
    }
    if (registry) {
      // Said here with the count: enrollment's own bound refuses opaquely, which once cost a desk App a patched evidence.js.
      const count = Object.keys(registry).length;
      if (count > MAX_COMMAND_IDS) {
        throw new TenantCommandStartupError(
          `The --commands registry holds ${count} commands; an App registers at most ${MAX_COMMAND_IDS}.`,
        );
      }
      const unknown = granted.filter((entry) => !Object.hasOwn(registry, entry.id));
      if (unknown.length) {
        throw new TenantCommandStartupError(
          `A role grants a command the --commands registry does not declare: ${naming(unknown)}.` +
            ` Registered: ${
              Object.keys(registry)
                .map((id) => `"${id}"`)
                .join(', ') || 'none'
            }.`,
        );
      }
      const ids = Object.keys(registry),
        references = Object.keys(policy.resultReferences ?? {});
      const missing = ids.filter((id) => !references.includes(id)),
        extra = references.filter((id) => !ids.includes(id));
      if (policy.resultReferences === undefined || missing.length || extra.length) {
        /* Why, and the shape: a result goes back to its caller and is kept with its receipt, so each command says which
           rows besides its target the result names, and each is checked to be one the caller may read
           (scopedBusinessCommandAccess.ts). */
        const example = missing[0] ?? ids[0];
        throw new TenantCommandStartupError(
          'The tenant policy must declare one resultReferences extractor for every registered command.' +
            (missing.length ? ` Missing: ${missing.join(', ')}.` : '') +
            (extra.length ? ` Unknown: ${extra.join(', ')}.` : '') +
            " A command's result goes back to its caller and is kept with its receipt, so each extractor names the rows other than" +
            " the command's target that its result mentions, as { table, key }, each checked to be one the caller may read;" +
            ' [] says it mentions none.' +
            (example === undefined ? '' : ` For example: resultReferences: { ${example}: () => [] }.`),
        );
      }
      try {
        createBusinessCommandAuthorizer({
          app,
          registry,
          schema: owned.schema,
          connectionFor: (resource) => (Object.hasOwn(owned.resources, resource) ? configured : ''),
          writableConnection: (candidate) => candidate === configured && connection.writable === true,
          transactionalConnection: (candidate) => candidate === configured,
          managedOwnership: Object.fromEntries(
            Object.entries(owned.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])),
          ),
        });
        validateBusinessCommandReferences(app, registry, { schema: owned.schema });
      } catch (error) {
        if (error instanceof BusinessCommandDefinitionError) throw new TenantCommandStartupError(error.message);
        throw error;
      }
      const problem = platformTenantParentProblem(registry, owned);
      if (problem) throw new TenantCommandStartupError(problem);
    }
  },
});

/* A platform command that acts in one named tenant inserts that tenant's rows with the owner placed for it, and a
   scoped insert proves every parent its row points at is a row the command reads. The ownership column always points
   somewhere (the profile, usually), so a footprint without that parent passed check and was refused on every run as
   "not available to this account" (a field report built on the docs' seedDesk). Said here, with the fix. */
function platformTenantParentProblem(
  registry: NonNullable<TenantStartupCommands['registry']>,
  owned: TenantStartupCommands['owned'],
): string | undefined {
  for (const [id, command] of Object.entries(registry)) {
    if (command.realm !== 'platform' || command.tenant === undefined) continue;
    for (const table of command.write) {
      const rule = owned.ownership[table];
      if (rule?.kind !== 'tenant') continue;
      const missing = owned.schema.foreignKeys.find(
        (fk) => fk.from.table === table && fk.from.columns.includes(rule.column) && !command.read.includes(fk.to.table),
      );
      if (missing)
        return (
          `Command "${id}" writes "${table}" in the tenant its "${command.tenant}" input names, and "${table}".${rule.column} ` +
          `references "${missing.to.table}", which the command does not read: a write proves the rows it points at are readable. ` +
          `Add read: ['${missing.to.table}'] to "${id}".`
        );
    }
  }
  return undefined;
}

export const commandJournalHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ policy, registry }) => {
    if ((!registry && policy.resultReferences !== undefined) || (registry && policy.resultReferences === undefined)) denyTenant();
  },
  sqlite: (db, { registry }) => {
    if (registry) assertSqliteCommandJournal(db);
  },
  postgres: async (client, { registry }) => {
    if (registry) await assertPostgresCommandJournal(client);
  },
});
