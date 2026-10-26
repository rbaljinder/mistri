/** Suite App administration and invitation acceptance. Native sign-in proves
 * the subject; every administration action rechecks that App's own grant. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { suiteAppRoles } from './suiteAppRoles.js';
import { SUITE_INVITATIONS_MAX_OFFSET } from '../../shared/suiteAdministration.js';
import type { LoadedApp } from '../app/apps.js';
import { readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { captureAppAuthRuntime, captureNativeStepUpProvider, type AppAuthRuntime } from './auth.js';
import type { SuiteGrants } from './suiteStores.js';
import { nativeAccountEmailOf } from './authAccounts.js';
import { sendSuiteInvitationEmail } from './suiteEmail.js';
import type { EmailTransport } from '../email/email.js';

type Deployment = { app: LoadedApp; basePath: string };
export async function suiteGrantHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    native: AppAuthRuntime;
    grants: SuiteGrants;
    bound: Bound;
    basePath: string;
    deployments: readonly Deployment[];
    target?: Deployment;
    action: 'grant' | 'issue' | 'revoke' | 'accept' | 'read' | 'list';
    current: () => boolean;
    mail?: EmailTransport;
    publicOrigin?: string;
  },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
  if (doorRefusal(req, options.bound, { writing: true })) return send(403, { error: 'Invalid origin.' });
  const auth = captureAppAuthRuntime(options.native),
    proof = await auth.sessionInstance(req);
  if (!proof) return send(401, { error: 'Sign in to continue.' });
  if (req.headers['x-mistri-account'] !== proof.identity.id) return send(409, { error: 'The signed-in account changed.' });
  const { grants, action } = options;
  // Issuers must prove authority before a request body or target account is read.
  // The administrator's authority is the session's (readForSession): a grant derived from claims counts only for its provider's sessions.
  const via = { provider: captureNativeStepUpProvider(options.native).provider(proof) };
  const actor = options.target ? await grants.readForSession(proof.identity.id, options.target.app.app.id, via) : undefined;
  if (action !== 'accept') {
    const allowed = options.target && suiteAppRoles(options.target.app.app);
    if (!actor?.roles.includes('admin') || !allowed || actor.roles.some((role) => !allowed.includes(role))) {
      return send(403, { error: 'This App requires its own administrator grant.' });
    }
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req, 16 * 1024);
  } catch {
    return send(400, { error: 'Invalid App grant request.' });
  }
  const target = options.target ?? options.deployments.find((item) => item.app.app.id === body.appId);
  if (!target) return send(404, { error: 'App invitation unavailable.' });
  const appId = target.app.app.id,
    declaredRoles = suiteAppRoles(target.app.app);
  const fields =
    action === 'accept'
      ? ['appId', 'token']
      : action === 'revoke'
        ? ['id']
        : action === 'read'
          ? ['subjectId']
          : action === 'list'
            ? ['subjectId', 'offset']
            : action === 'issue'
              ? ['subjectId', 'roles', 'expectedRevision', 'expiresAt']
              : ['subjectId', 'roles', 'expectedRevision'];
  if (
    Object.keys(body).some((key) => !fields.includes(key) && !(action === 'issue' && key === 'delivery')) ||
    fields.some((key) => !Object.hasOwn(body, key))
  ) {
    return send(400, { error: `Expected ${fields.join(', ')}.` });
  }
  const email = action === 'issue' && body.delivery === 'email';
  if (action === 'issue' && Object.hasOwn(body, 'delivery') && body.delivery !== 'email' && body.delivery !== 'link') {
    return send(400, { error: 'Delivery must be email or link.' });
  }
  if (email && (!options.mail || !options.publicOrigin)) return send(400, { error: 'Suite invitation email is not configured.' });
  if (action === 'read' || action === 'list') {
    if (
      typeof body.subjectId !== 'string' ||
      !body.subjectId.length ||
      body.subjectId.length > 1024 ||
      body.subjectId.trim() !== body.subjectId ||
      /[\p{Cc}\p{Cs}]/u.test(body.subjectId) ||
      (action === 'list' &&
        (!Number.isSafeInteger(body.offset) || (body.offset as number) < 0 || (body.offset as number) > SUITE_INVITATIONS_MAX_OFFSET))
    ) {
      return send(400, { error: 'Invalid account or invitation offset.' });
    }
  }
  if (action === 'grant' || action === 'issue') {
    if (
      typeof body.subjectId !== 'string' ||
      !Array.isArray(body.roles) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.roles.some((role) => typeof role !== 'string' || !declaredRoles.includes(role)) ||
      new Set(body.roles).size !== body.roles.length
    ) {
      return send(400, { error: 'Invalid App roles, account or revision.' });
    }
  }
  let eligible = true;
  if (action === 'grant' || action === 'issue' || action === 'read' || action === 'list') {
    eligible = Boolean(await auth.lookupEligibleAccountCurrent(body.subjectId as string));
  }
  const subjectEmail = email && eligible ? await nativeAccountEmailOf(options.native, body.subjectId as string) : null;
  await auth.observeSession(proof);
  auth.assertSessionCurrent(proof);
  if (!options.current() || req.aborted || res.destroyed) return;
  try {
    if (action === 'accept') {
      const grant = await grants.acceptInvitation({ appId, subjectId: proof.identity.id, token: body.token as string, declaredRoles });
      return send(200, grant);
    }
    const authority = { administratorRevision: actor!.revision };
    // Account observation and body parsing may yield. Recheck this App's exact
    // administrator revision before disclosing even a missing target account.
    const reading = grants.readForSession(proof.identity.id, appId, via);
    /* A SQLite read is decided on in this turn, as before. A PostgreSQL one is awaited, and the session observed
       afresh after it: the last await before the ledger's own transaction, which rechecks the revision again. */
    const currentActor = reading instanceof Promise ? await reading : reading;
    if (reading instanceof Promise) {
      await auth.observeSession(proof);
      auth.assertSessionCurrent(proof);
      if (!options.current() || req.aborted || res.destroyed) return;
    }
    if (
      currentActor.revision !== actor!.revision ||
      !currentActor.roles.includes('admin') ||
      currentActor.roles.some((role) => !declaredRoles.includes(role))
    )
      throw new Error('Administrator changed.');
    if ((action === 'grant' || action === 'issue' || action === 'read' || action === 'list') && auth.synchronous) {
      eligible = Boolean(auth.lookupEligibleAccount(body.subjectId as string));
    }
    if (!eligible) return send(404, { error: 'Suite account unavailable.' });
    if (email && !subjectEmail) return send(404, { error: 'Suite account email unavailable.' });
    const reader = { appId, subjectId: body.subjectId as string, actorId: proof.identity.id, declaredRoles };
    if (action === 'read') return send(200, await grants.readAdministration(reader, authority));
    if (action === 'list') return send(200, await grants.listInvitations({ ...reader, offset: body.offset as number }, authority));
    if (action === 'revoke') {
      await grants.revokeInvitation({ appId, id: body.id as string, actorId: proof.identity.id }, authority);
      return send(200, { revoked: true });
    }
    const change = {
      appId,
      subjectId: body.subjectId as string,
      roles: body.roles as string[],
      expectedRevision: body.expectedRevision as number,
      declaredRoles,
      actorId: proof.identity.id,
    };
    if (action === 'issue') {
      const invitation = await grants.issueInvitation({ ...change, expiresAt: body.expiresAt as number }, authority);
      // Issuance and its audit are already committed. Delivery is a separately
      // reported, awaited attempt, never a rollback or an automatic retry.
      const delivery = email
        ? await sendSuiteInvitationEmail(options.mail!, {
            subjectEmail: subjectEmail!,
            appName: target.app.app.name,
            publicOrigin: options.publicOrigin!,
            basePath: options.basePath,
            invitation,
          })
        : { status: 'not-requested' as const };
      return send(200, {
        ...invitation,
        appId,
        acceptUrl: `${options.basePath}/_mistri/apps#invite=${encodeURIComponent(appId)}.${invitation.token}`,
        delivery,
      });
    }
    send(200, await grants.change(change, authority));
  } catch {
    send(409, { error: 'The App grant or invitation changed or is unavailable.' });
  }
}
