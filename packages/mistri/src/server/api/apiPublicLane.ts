/**
 * A public command as an App API verb: the lane both API command owners take
 * when the verb a token names is a public form's. It runs as the form's
 * principal would — the door's grants, no role — under the token's own id
 * (`token:<id>`), so its receipts, row stamps and audit name the token and two
 * tokens never replay each other. It spends the door's submit budget, keyed
 * by the token in place of an address, and says a minted link once, as the
 * door does (commands/formHttp.ts).
 */
import { publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import type { AppDef } from '../../shared/app.js';
import { tokenActorId } from '../../shared/publicActor.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { BusinessCommandActor } from '../commands/businessCommands.js';
import { servesLinks, withLinkUrls } from '../links/linkLookup.js';
import { withAppPublicUrls } from '../links/publicLink.js';
import { holdsLinkRef } from '../links/linkToken.js';
import { publicFormOf } from './apiCommandCatalog.js';
import { apiTransportProblem } from './apiCommandResponse.js';

/** The public form whose door a command is, when the App exposes one; undefined for every other command. */
export function apiPublicForm(
  app: Pick<AppDef, 'views'>,
  commands: Readonly<Record<string, { public?: boolean } | undefined>>,
  id: string,
) {
  return commands[id]?.public === true ? publicFormOf(app, id) : undefined;
}

/** The principal a token calls a public verb as: the form's, under the token's id. */
export function apiPublicActor(appId: string, form: string, tokenId: string): BusinessCommandActor {
  return Object.freeze({ id: tokenActorId(tokenId), appId, roles: Object.freeze([]), kind: 'public' as const, form });
}

/** The door's submit budget, spent by the token: undefined when it holds, else the 429 to answer. */
export async function spendApiPublicBudget(tokenId: string) {
  // No colon: the limiter reads a key with one as an address and folds it to its network.
  const decision = await publicFormLimiter('submit').take(`token-${tokenId}`, 'both');
  if (decision.ok) return undefined;
  const problem = apiTransportProblem('rate_limited');
  return { status: problem.status, headers: Object.freeze({ 'retry-after': String(decision.retryAfterSeconds) }), value: problem.value };
}

/** A public verb's answer: a minted link rendered as its URL on the first answer alone; a replay, or a link that no
    longer renders, answers without one. A tenant deployment's answer has no resources to render through: its link,
    if any, is dropped on a replay all the same. */
export async function shapeApiPublicResult<T>(app: AppDef, resources: RuntimeResources | undefined, result: T): Promise<T> {
  const replayed = (result as { replayed?: unknown }).replayed !== false;
  const linked = !replayed && resources && servesLinks(app) ? await withLinkUrls(app, resources, result) : result;
  // A public link (context.publicLink) names no secret, so a replay says it as well.
  const shaped = await withAppPublicUrls(app, linked);
  const answer = (shaped as { result?: unknown }).result;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || !Object.hasOwn(answer, 'link')) return shaped;
  /* A tenant App's public command mints no link (refused at start and in `mistri check`: tenantIntakePages.ts), so on
     a tenant deployment this strip is defense in depth against an answer that names one anyway. */
  const link = (answer as { link?: unknown }).link;
  if (!replayed && typeof link === 'string' && !holdsLinkRef(link, app.id)) return shaped;
  const { link: _said, ...rest } = answer as Record<string, unknown>;
  return { ...shaped, result: rest };
}
