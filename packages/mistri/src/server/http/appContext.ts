/**
 * What a request carries for an App, in the App framework's own types: the
 * engine's request (context.ts) passes these along under names it reads no
 * further than its own `Register` says, and this module registers the App's
 * types there — the App hosts, an App's resources and its reader's grants,
 * the command host, the row policy and its context, the job host, a tenant's
 * words and a command's refusal codes — so every App module reads them whole.
 *
 * Here too are the App's own parts of a request that the engine never names:
 * the command and job hosts' shapes, and the Console's owners.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppDef } from '../../shared/app.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import type { AppHost } from '../app/apps.js';
import type { ResourceAccess } from '../app/appAccess.js';
import type { MessageOverrides } from '../app/appMessages.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { ReadinessCheckInput } from '../operations/operations.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import type { HttpAppPolicy } from '../policy/appPolicyHttp.js';
import type { WorkflowOperator } from '../workflows/workflowOperator.js';
import type { RequestContext, ResolvedSource } from '@mistriwork/engine/server/http/context.js';

declare module '@mistriwork/engine/server/http/context.js' {
  interface Register {
    readonly host: AppHost;
    readonly resources: RuntimeResources;
    readonly access: ResourceAccess;
    readonly commands: CommandHosting;
    readonly policy: HttpAppPolicy;
    readonly policyContext: AppPolicyContext;
    readonly jobs: JobsReadiness;
    readonly messages: MessageOverrides;
    readonly refusal: CommandRefusalCode;
  }
}

/** `events`: the App-scope event source startup issued for an App whose
 * commands declare events (commands/appCommandEvents.ts). */
export interface CommandHosting {
  appId: string;
  registry: BusinessCommandRegistry;
  events?: CommandJournalAppScope;
}

/** The job host, as the operations routes read it: its readiness checks. */
export interface JobsReadiness {
  readiness(): readonly ReadinessCheckInput[];
  /** The durable workflows the host runs, for the operations room. */
  readonly workflows?: WorkflowOperator;
}

export type CommandRefusalCode = ConstructorParameters<typeof BusinessCommandExecutionError>[0];

/** Internal Console owner only. These capabilities are installed by server
 * composition, keyed by object identity; no URL/header can register one. The
 * source callback is request-bound, including the renderer's first-paint reads. */
export const consoleSourceOwners = new WeakMap<AppDef, (ctx: RequestContext, host: AppHost) => Promise<ResolvedSource>>();
export const consoleDispatchOwners = new WeakMap<
  Server,
  (req: IncomingMessage, res: ServerResponse, dispatch: (reply: ServerResponse) => Promise<void>) => Promise<void>
>();
