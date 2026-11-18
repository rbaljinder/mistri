/**
 * The assistant's proposal on an ordinary App's host: one code path whatever the App's shape, so the assistant
 * proposes the same way with a row policy or without. Kept for the person the turn is for, under the grant their own
 * run of the command would need, and in their rows: with a row policy, through the context the policy issues for this
 * person's request (personPolicy.ts), the one every route under the policy runs in; without one, through the binding
 * their own execute would use (commandRoutes.ts). A tenant App's host proposes through the tenant door's own step
 * (tenant/tenantHttp.ts `propose`).
 */
import type { CommandProposalRow } from '../../adapters/commands/commandJournalTypes.js';
import { isRowPolicyApp } from '../../shared/app.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { proposeBusinessCommand } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import type { ProposalDraft } from '../commands/proposals.js';
import type { GatedContext } from '@mistriwork/engine/server/http/context.js';
import { sessionCommandActor } from './commandRoutes.js';
import { withPersonPolicy } from './personPolicy.js';

export async function createAssistantProposal(ctx: GatedContext, draft: ProposalDraft): Promise<CommandProposalRow> {
  const { req, identity, signedIn, commands, policy, policyUnavailable, appHosts, registry } = ctx;
  // As a command request is refused (commandRoutes.ts): a person signed in, at the App whose commands these are.
  if (!signedIn?.auth || !identity.id) throw new BusinessCommandExecutionError('unauthenticated');
  if (!commands || commands.appId !== signedIn.app.app.id) throw new BusinessCommandExecutionError('forbidden');
  if (policyUnavailable || policy || appHosts?.some((host) => isRowPolicyApp(host.app.app))) {
    if (policyUnavailable || !policy || appHosts?.length !== 1 || !policy.matches(signedIn.app.app))
      throw new BusinessCommandExecutionError('temporarily_unavailable');
    return withPersonPolicy({ req, identity, signedIn, policy }, async (context) => {
      if (!context.commands?.propose) throw new BusinessCommandExecutionError('forbidden');
      return context.commands.propose(draft);
    });
  }
  const connection = appEntrypoint(signedIn, registry);
  if (!connection) throw new BusinessCommandExecutionError('forbidden');
  return proposeBusinessCommand({
    registry,
    app: signedIn.app.app,
    commands: commands.registry,
    ...(commands.events ? { events: commands.events } : {}),
    connection,
    actor: sessionCommandActor(identity, identity.id, signedIn.app.app.id),
    draft,
  });
}
