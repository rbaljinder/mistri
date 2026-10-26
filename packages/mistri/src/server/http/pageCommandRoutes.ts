/**
 * A public page's door (P1): a free-form page that says `public: true` runs the public commands it names for a
 * signed-out visitor, through one route under the stock public form's rules.
 *
 *   GET  /api/pages/<page>/ticket             → { ticket }, the page's pass for the submissions it makes
 *   POST /api/pages/<page>/commands/<name>    { input, submission } with `x-mistri-ticket` (and `x-mistri-challenge`)
 *
 * In the order a request meets them, each before anything later is read:
 * - the page must be public and name the command, and the command must be public and make its record (the App's
 *   check refused any other, `[page-commands]`); anything else is not here (404);
 * - this client's part of the submit budget, the one a public form spends (5 a minute and 30 an hour per client),
 *   shared rather than a second allowance; a ticket's read spends the read budget;
 * - the page's own origin: an embed host's vouched-for request is refused (trust.ts `doorRefusal`, `'always'`);
 * - the ticket: issued by this door, at least 3 seconds and at most 24 hours old (forms/publicTicket.ts);
 * - a declared length past 64 KB (413), before the check calls out;
 * - the App's human check, where `auth.challenge` names one (commands/challenges.ts);
 * - the App-wide ceiling (300 an hour), spent only by a request that got this far;
 * - the body: JSON, at most 64 KB (413), exactly `{ input, submission }`;
 * - the run: always as the public principal of this page, even with a session cookie, through the same executor,
 *   journal and audit as a public form; the submission key makes a retry the same receipt. Its answer is the
 *   public shape `{ reference, receipt }`, never the input; a refusal is a fixed sentence naming a field at most.
 */
import type { ServerResponse } from 'node:http';
import { isPublicCommandPage, isRowPolicyApp, isTenantApp, type AppDef } from '../../shared/app.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { businessCommandHttpError, CommandBodyTooLarge } from '../commands/businessCommandHttp.js';
import { dispatchPublicFormHttp } from '../commands/formHttp.js';
import { captureHttpCommandFlags } from '../flags/httpRuntime.js';
import { clientAddress, publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal } from '@mistriwork/engine/server/http/trust.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { issueTicket, ticketMessage, ticketRefusal } from '../forms/publicTicket.js';
import { CHALLENGE_REFUSAL, challengeAnswered } from './formRoutes.js';

/** The header a page's ticket travels in. */
const TICKET_HEADER = 'x-mistri-ticket';

const KEY = '[a-z0-9][a-z0-9_-]{0,63}';
const PATH = new RegExp(`^/api/pages/(${KEY})/(?:(ticket)|commands/([A-Za-z][A-Za-z0-9_-]{0,63}))$`);

/** The page and, for a submission, the command a path names; undefined for any other path. */
function pageCommandPath(path: string): { page: string; command?: string } | undefined {
  const match = PATH.exec(path);
  if (!match) return undefined;
  return match[2] ? { page: match[1] } : { page: match[1], command: match[3] };
}

/** Whether a path is a door this App opens: a public page that runs public commands, and one of them. The gate lets
    a signed-out request through on this alone; the route says it again. */
export function publicPageCommandRoute(app: Pick<AppDef, 'views'> | undefined, path: string): boolean {
  const match = pageCommandPath(path);
  if (!match || !app || !Object.hasOwn(app.views, match.page)) return false;
  const view = app.views[match.page];
  return isPublicCommandPage(view) && (match.command === undefined || view.page.commands.includes(match.command));
}

/* A refusal of either part of the budget, answered here; false when the request may go on. */
function rateLimited(res: ServerResponse, decision: Awaited<ReturnType<ReturnType<typeof publicFormLimiter>['take']>>): boolean {
  if (decision.ok) return false;
  res.setHeader('retry-after', String(decision.retryAfterSeconds));
  const who = decision.scope === 'client' ? 'Too many requests from this address.' : 'This page is taking too many requests right now.';
  send(res, 429, {
    code: 'rate_limited',
    error: `${who} Try again in ${decision.retryAfterSeconds} seconds.`,
    retryAfter: decision.retryAfterSeconds,
  });
  return true;
}

const refuse = (res: ServerResponse, status: number, code: string, error: string): true => {
  send(res, status, { code, error });
  return true;
};

export async function pageCommandRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, commands, signedIn, policy, policyUnavailable, bound } = ctx;
  const match = pageCommandPath(path);
  if (!match) return false;
  res.setHeader('cache-control', 'no-store');
  const app = signedIn?.app.app;
  /* A page that is not a public door reads, from outside, as one that does not exist. */
  if (!signedIn?.auth || !app || !publicPageCommandRoute(app, path)) return refuse(res, 404, 'not_found', 'No such page.');
  const reading = match.command === undefined;
  if (reading ? req.method !== 'GET' && req.method !== 'HEAD' : req.method !== 'POST') {
    res.setHeader('allow', reading ? 'GET, HEAD' : 'POST');
    return refuse(res, 405, 'method_not_allowed', reading ? 'A ticket is read with GET.' : 'A page runs a command with POST.');
  }
  const client = clientAddress(req, bound.trustedProxies);
  const limiter = publicFormLimiter(reading ? 'read' : 'submit');
  /* This client's budget first, the App-wide ceiling only once the ticket and the check have passed: a flood from many
     addresses with no ticket spends its own budgets, never the one a visitor's submission needs. */
  if (rateLimited(res, await limiter.take(client, 'client'))) return true;
  if (reading) {
    if (rateLimited(res, await limiter.take(client, 'all'))) return true;
    send(res, 200, { ticket: issueTicket(app.id, match.page) });
    return true;
  }
  /* The page's own origin only: a host's page an embed bearer vouched for (embed/crossOrigin.ts) is not a visitor of
     this public page, and a write door open to the public stands for no host. */
  if (doorRefusal(req, bound, { writing: true, origin: 'always', sameSite: true }))
    return refuse(res, 403, 'cross_origin', 'This page takes submissions from its own page only.');
  const refused = ticketRefusal(req.headers[TICKET_HEADER], app.id, match.page);
  if (refused) return refuse(res, refused === 'early' ? 425 : 403, 'ticket_refused', ticketMessage(refused));
  /* Said from the length before anything leaves this server: a body the run would refuse never costs a provider's call. */
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > 65_536) return refuse(res, 413, 'too_large', 'This submission is too large.');
  if (!(await challengeAnswered(signedIn, req, client))) return refuse(res, 403, 'challenge_failed', CHALLENGE_REFUSAL);
  if (rateLimited(res, await limiter.take(client, 'all'))) return true;
  /* As a public form's: only an ordinary App's commands run here; a row-policy or tenant App has no public writer. */
  if (policyUnavailable || (policy && !policy.matches(app)))
    return refuse(res, 503, 'temporarily_unavailable', 'This page is not accepting submissions.');
  if (policy || isRowPolicyApp(app) || isTenantApp(app) || !commands || commands.appId !== app.id)
    return refuse(res, 403, 'forbidden', 'This page is not accepting submissions.');
  const command = commands.registry[match.command!];
  if (!command || command.public !== true) return refuse(res, 403, 'forbidden', 'This page is not accepting submissions.');
  const connection = appEntrypoint(signedIn, registry);
  if (!connection) return refuse(res, 403, 'forbidden', 'This page is not accepting submissions.');
  try {
    const result = await dispatchPublicFormHttp({
      req,
      res,
      registry,
      app,
      commands: commands.registry,
      connection,
      key: match.page,
      command: { id: match.command!, version: command.version },
      tooLarge: 'thrown',
      captureFlags: captureHttpCommandFlags,
      ...(commands.events ? { events: commands.events } : {}),
    });
    send(res, 200, result);
  } catch (error) {
    if (error instanceof CommandBodyTooLarge) return refuse(res, 413, 'too_large', 'This submission is too large.');
    const failure = businessCommandHttpError(error);
    const { outcome: _outcome, ...body } = failure.body;
    reportRefusal(req, failure.status, failure.body.code, failure.body.message, error);
    send(res, failure.status, body);
  }
  return true;
}
