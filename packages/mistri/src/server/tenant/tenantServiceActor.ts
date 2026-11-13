/**
 * A test host's service actor in a tenant App (testing/host.ts `service`): a
 * command run in one tenant as one service role, through the binding a job's
 * principal runs through (tenantJobs.ts `serve`) — the role's grant, the
 * tenant's anchors read now and fenced to COMMIT, the job door — so what a
 * test asserts is what the App's own background work would be allowed.
 *
 * Only a service role acts: one declared `service: true`, or held by a
 * principal of the jobs module, in the tenant realm, granting no generic write
 * and no operations. Any other is refused by name before anything is bound.
 * It is reached only through the test control (http/testControl.ts), which
 * exists only under a test host.
 */
import { randomBytes } from 'node:crypto';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { serviceRoleRefusal } from '../commands/businessCommandAuthorization.js';
import { executeBusinessCommand, isBusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { businessCommandHttpError } from '../commands/businessCommandHttp.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import { tenantServiceRuntime } from './tenantJobs.js';

/** What a test asks its service actor to run (TEST_CONTROL_PATHS.service). */
export interface TenantServiceRequest {
  readonly tenant: string;
  readonly role: string;
  readonly command: string;
  readonly input: unknown;
  readonly key?: Readonly<Record<string, string | number>>;
  /** The command's contract version; the one the App declares now when not said. */
  readonly version?: number;
  readonly idempotencyKey?: string;
}

/** An answer as the command door says it: the receipt with 200, else the refusal's status and body. */
export interface TenantServiceAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The principal a test's service actor is: its receipts and audit name `service:test`, never a job's own principal. */
const TEST_PRINCIPAL = 'test';

/** Why `role` is not one a service actor may hold, or undefined when it is. */
function notServiceRole(runtime: NonNullable<ReturnType<typeof tenantServiceRuntime>>, role: string): string | undefined {
  const grants = runtime.app.auth?.roles ?? {};
  const grant = Object.hasOwn(grants, role) ? grants[role] : undefined;
  if (!grant) return `role "${role}" is not defined in the App.`;
  if (grant.realm === 'platform') return `role "${role}" is a platform role; a service actor acts in one tenant.`;
  const held = [...runtime.principals.values()].some((roles) => roles.includes(role));
  if (grant.service !== true && !held)
    return `role "${role}" is held by people: a service role says service: true, or is held by a principal of the jobs module.`;
  const refused = serviceRoleRefusal(runtime.app, [role]);
  return refused ? `${refused[0]!.toUpperCase()}${refused.slice(1)}, which no service role may.` : undefined;
}

/**
 * The test control's service actor over a tenant deployment's enrollment, or undefined when it was enrolled without
 * jobs: the binding it runs through is the jobs runtime's.
 */
export function tenantServiceActor(
  enrollment: object,
  renderLinks?: (value: unknown, tenantId: string) => Promise<unknown>,
): ((request: TenantServiceRequest) => Promise<TenantServiceAnswer>) | undefined {
  const runtime = tenantServiceRuntime(enrollment);
  if (!runtime) return undefined;
  const refusal = (error: unknown): TenantServiceAnswer =>
    businessCommandHttpError(error instanceof AppAccessDenied || isBusinessCommandExecutionError(error) ? error : new Error());
  return async (request) => {
    const named = notServiceRole(runtime, request.role);
    if (named) return { status: 403, body: { code: 'not_a_service_role', error: named, message: named, outcome: 'refused' } };
    const command = Object.hasOwn(runtime.commands, request.command) ? runtime.commands[request.command] : undefined;
    const actor = serviceActor(runtime.app.id, TEST_PRINCIPAL, [request.role]);
    const idempotencyKey = request.idempotencyKey ?? randomBytes(18).toString('base64url');
    return asBackgroundWork(async () => {
      let bound: Awaited<ReturnType<typeof runtime.serve>>;
      try {
        bound = await runtime.serve(request.role, request.tenant);
      } catch (error) {
        return refusal(error);
      }
      try {
        bound.binding.authorize(request.command, actor);
        const flags = await commandFlagsOnce(() => bound.captureFlags?.(actor))();
        const result = await executeBusinessCommand(
          bound.binding,
          actor,
          {
            command: request.command,
            commandVersion: request.version ?? command?.version ?? 1,
            key: request.key ?? {},
            expectedVersion: 0,
            idempotencyKey,
            input: request.input,
          },
          { door: 'job', flags, requestId: 'test:service', now: () => appTime(Date.now()) },
        );
        return { status: 200, body: renderLinks ? await renderLinks(result, request.tenant) : result };
      } catch (error) {
        return refusal(error);
      } finally {
        bound.release();
      }
    });
  };
}
