/**
 * The row policy's context for one person's request, shared by the routes under the row policy (handler.ts) and what
 * the assistant does on that person's behalf (assistantProposal.ts).
 */
import type { IncomingMessage } from 'node:http';
import type { GatedContext } from '@mistriwork/engine/server/http/context.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import type { HttpAppPolicy } from '../policy/appPolicyHttp.js';

/**
 * The row policy's context for this request's person: the one the policy owner
 * issues for the request, checked against the gate's own reading of who is
 * asking. Every route under the row policy runs in it, and so does what the
 * assistant does on a person's behalf (assistantProposal.ts), so neither can
 * reach a row the other could not.
 */
export async function withPersonPolicy<T>(
  ctx: { req: IncomingMessage; identity: GatedContext['identity']; signedIn: NonNullable<GatedContext['signedIn']>; policy: HttpAppPolicy },
  run: (context: AppPolicyContext) => Promise<T>,
): Promise<T> {
  const { req, identity, signedIn, policy } = ctx;
  return policy.withContext(req, async (context) => {
    // Session verification belongs to the deployment. If it changed during
    // the outer auth check, do not mix its rows with the earlier account/UI.
    const roles = [
      ...new Set(
        (identity.role ?? '')
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean),
      ),
    ].sort();
    if (context.principal.kind === 'public') {
      /* The deployment answered this as a signed-out visitor at an App
         with `auth.public`. The same cross-check applies, in the only
         form it can take here: the gate must agree that nobody is
         signed in. A session that appeared between the two is a
         disagreement, and a disagreement is a denial. */
      if (identity.id !== undefined || roles.length || context.principal.appId !== signedIn.app.app.id) throw new AppAccessDenied();
    } else if (
      context.principal.id !== identity.id ||
      context.principal.appId !== signedIn.app.app.id ||
      JSON.stringify([...context.principal.roles].sort()) !== JSON.stringify(roles)
    )
      throw new AppAccessDenied();
    return run(context);
  });
}
