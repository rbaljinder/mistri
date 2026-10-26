/**
 * The public forms over HTTP: the forms an App declares `public: true`,
 * served to the page that draws them — signed out or signed in, since a
 * public form is open to everyone — and the one submission route, which
 * always runs as a public submission. Rate limited per client before
 * anything is read (a method the route does not run is refused first,
 * spending nothing); nothing here answers with the App's schema, roles or
 * navigation, and a signed-in form is never served here: it is a room of
 * the App, submitted through the signed-in command route.
 */
import type { ServerResponse } from 'node:http';
import { cookieUnder } from '@mistriwork/engine/shared/mount.js';
import { captureHttpCommandFlags } from '../flags/httpRuntime.js';
import { isPublicForm, isRowPolicyApp, isTenantApp, type AppDef, type AppFormView } from '../../shared/app.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { businessCommandHttpError, commandBody, holdCommandBody } from '../commands/businessCommandHttp.js';
import { checkCommandStep } from '../commands/commandCheck.js';
import { dispatchPublicFormHttp, dispatchPublicFormSubmissionHttp, presentForm, publicFormComponents } from '../commands/formHttp.js';
import { clientAddress, publicFormLimiter, type RatePart } from '@mistriwork/engine/server/http/rateLimit.js';
import { send, sendRevalidated } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { appLook } from '../../shared/appUi.js';
import { withIconGlyphs } from '../app/iconPayload.js';
import { formCommands, isSavedForm } from '../../shared/appSavedForms.js';
import { withTableChoices } from '../forms/formChoices.js';
import { dispatchSavedFormHttp, savedFormAction, savedSteps, type SavedForm, type SavedFormAction } from '../forms/savedFormHttp.js';
import { readDraftToken, secureRequest } from '../forms/savedForms.js';
import { trustedProxyPeer } from '@mistriwork/engine/server/http/trust.js';
import { requestRecordBranding, withRecordBranding } from './recordBranding.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { challengePasses, type HumanCheck } from '../commands/challenges.js';
import { inSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import type { AppHost } from '../app/apps.js';

/** The header a public door's human check token travels in, read before the body (commands/challenges.ts). */
const CHALLENGE_HEADER = 'x-mistri-challenge';
/** What a door says when its human check says no: fixed, and the same whether the token was missing, wrong or late. */
export const CHALLENGE_REFUSAL = 'We could not confirm this was sent by a person. Complete the check and send it again.';

/** The human check `auth.challenge` names, as the App's commands module defined it; the App's load refused a name it lacks. */
export function challengeOf(host: Pick<AppHost, 'app'> | undefined): HumanCheck | undefined {
  const name = host?.app.app.auth?.challenge;
  return name && host?.app.challenges && Object.hasOwn(host.app.challenges, name) ? host.app.challenges[name] : undefined;
}

/** Whether a door's request passes the App's human check: its token from the header, the visitor's address, and the
    host name the request was made to (the gate held the Host to the allowed hosts), without its port. */
export function challengeAnswered(host: Pick<AppHost, 'app'> | undefined, req: RequestContext['req'], ip: string): Promise<boolean> {
  return challengeAnsweredBy(challengeOf(host), req, ip);
}

/** The same, for a check already found: a tenant App's host holds its App's check itself (tenant/tenantPublicHttp.ts). */
export function challengeAnsweredBy(
  check: HumanCheck | undefined,
  req: Pick<RequestContext['req'], 'headers'>,
  ip: string,
): Promise<boolean> {
  const name = String(req.headers.host ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, '');
  return challengePasses(check, req.headers[CHALLENGE_HEADER], { ip, ...(name ? { host: name } : {}) });
}

/** The stock form's decoy, filled: counted where an operator reads every command's outcome —
    `mistri.command.executions` and the observer — as the outcome `decoy`, so a form a script has found shows as
    such; never the value it typed. */
export function countDecoy(command: string): void {
  inSpan(`command ${command}`, { attributes: { 'mistri.command.id': command, 'mistri.command.outcome': 'decoy' } }, () => undefined);
}

/** `/api/forms` lists; `/api/forms/<key>` names one, and a saved form's
    paths are under it (`/steps/<step>`, `/resume`, `/status`, and a
    linkable form's `/claim`, `/link`, `/mine`, `/found` and `/verify-email`,
    and a step-up's `/stepup` and `/details`; forms/savedFormHttp.ts).
    Anything else is not this route. */
type SavedPath = 'resume' | 'status' | 'claim' | 'link' | 'mine' | 'stepup' | 'details' | 'found' | 'verify-email';
export function publicFormPath(path: string): { id?: string; action?: 'steps' | 'check' | SavedPath; step?: string } | undefined {
  if (path === '/api/forms') return {};
  const match =
    /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})(?:\/(resume|status|claim|link|mine|stepup|details|found|verify-email)|\/(steps|check)\/([a-z0-9][a-z0-9-]{0,63}))?$/.exec(
      path,
    );
  if (!match) return undefined;
  return {
    id: match[1],
    ...(match[2] ? { action: match[2] as SavedPath } : match[3] ? { action: match[3] as 'steps' | 'check', step: match[4] } : {}),
  };
}

/* The steps up to and including `step`, by id: the fields a check of it reads. Undefined for a step the form lacks. */
function stepsSoFar(form: AppFormView, step: string): string[] | undefined {
  const steps = (form.steps ?? []) as ReadonlyArray<{ id: string; fields?: readonly string[] }>;
  const at = steps.findIndex((item) => item.id === step);
  if (at < 0) return undefined;
  return steps.slice(0, at + 1).flatMap((item) => item.fields ?? []);
}

/** The budget a request spends: a saved form's steps are one application's pages, its first step opens a draft, its status check is a
    guess, and a link — after a status check, or spending a claim — is counted on its own; its status check's guess is counted as one too. */
export function publicFormBudget(
  reading: boolean,
  form: AppFormView | undefined,
  action: SavedFormAction | undefined,
  req: Pick<RequestContext['req'], 'headers'>,
  key: string | undefined,
): Array<'read' | 'submit' | 'start' | 'status' | 'link' | 'code'> {
  if (reading) return ['read'];
  if (!form || !action || !isSavedForm(form)) return ['submit'];
  // A step-up is the status check asked again, with or without its code.
  if (action.kind === 'status' || action.kind === 'stepup') return ['status'];
  if (action.kind === 'link') return ['link', 'status'];
  if (action.kind === 'claim' || action.kind === 'found') return ['link'];
  // Each sends an email: counted apart, and tight.
  if (action.kind === 'verify-email') return ['code'];
  if (action.kind === 'resume' || action.kind === 'mine' || action.kind === 'details') return ['read'];
  if (action.kind === 'step')
    return [!readDraftToken(req, key!) && savedSteps(form as SavedForm)[0]?.id === action.step ? 'start' : 'read'];
  return ['submit'];
}

/** Spends one part of each budget in turn; a refusal is answered here, and says whose budget ran out. The tenant host
    spends its budgets the same way (tenant/tenantPublicHttp.ts). */
export async function rateLimited(
  res: ServerResponse,
  budgets: ReturnType<typeof publicFormBudget>,
  address: string,
  part: RatePart,
): Promise<boolean> {
  for (const budget of budgets) {
    const decision = await publicFormLimiter(budget).take(address, part);
    if (decision.ok) continue;
    res.setHeader('retry-after', String(decision.retryAfterSeconds));
    const who = decision.scope === 'client' ? 'Too many requests from this address.' : 'This form is taking too many requests right now.';
    send(res, 429, {
      code: 'rate_limited',
      error: `${who} Try again in ${decision.retryAfterSeconds} seconds.`,
      retryAfter: decision.retryAfterSeconds,
    });
    return true;
  }
  return false;
}

/** The App's public forms under their keys, in the order they were written. */
export function publicForms(app: Pick<AppDef, 'views'>): Array<[string, AppFormView]> {
  return Object.entries(app.views).filter((entry): entry is [string, AppFormView] => isPublicForm(entry[1]));
}

/* A policy restarting is a while; a form this deployment cannot take — a row-policy or tenant App's with no public
   intake, no command host, no one connection it names — is for good, and a 503 sent a visitor and any caller round a
   retry that could never succeed. */
const unavailable = (res: ServerResponse): true => {
  send(res, 503, { code: 'temporarily_unavailable', error: 'This form is not accepting submissions.' });
  return true;
};
const closed = (res: ServerResponse): true => {
  send(res, 403, { code: 'forbidden', error: 'This form is not accepting submissions.' });
  return true;
};

export async function publicFormRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, commands, signedIn, policy, policyUnavailable, bound } = ctx;
  // Suite hosts intercept this capability before sessions. This second entry
  // also keeps a standalone placed form out of every legacy/native binder.
  if (policy?.publicPlacement) {
    const placed = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})(\/receipt)?$/.exec(path);
    if (placed && (placed[2] || policy.publicPlacement.isPlacedForm(placed[1]))) {
      if (policyUnavailable || !signedIn || !policy.matches(signedIn.app.app)) {
        send(res, 503, { code: 'temporarily_unavailable', error: 'This form is unavailable.', outcome: 'unknown' });
        return true;
      }
      return policy.publicPlacement.handle(req, res, ctx.url);
    }
  }
  const match = publicFormPath(path);
  if (!match) return false;
  res.setHeader('cache-control', 'no-store');
  const app = signedIn?.app.app;
  const forms = app ? publicForms(app) : [];
  /* The gate opens this path signed out only for a public form the App
     declares; said again here so the route is safe on its own, and so a
     wrong key and a missing feature read the same from outside. */
  if (!signedIn?.auth || !app || !forms.length) {
    send(res, 404, { error: `No such endpoint: ${path}` });
    return true;
  }
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const named = match.id === undefined ? undefined : forms.find(([key]) => key === match.id);
  /* A step's check (commandCheck.ts): any multistep public form's, before its budget is the submissions'. */
  if (match.action === 'check') return publicStepCheck(ctx, named, match.step!);
  const action = named ? savedFormAction(named[1], match) : undefined;
  // A saved form's paths are served only on a form that has them.
  if (match.action !== undefined && !action) {
    send(res, 404, { code: 'no_such_form', error: 'No such form.' });
    return true;
  }
  // Before any budget is taken: a method this route never runs must not
  // spend the submissions an applicant's POST is counted against.
  if ((!reading || match.action !== undefined) && (req.method !== 'POST' || match.id === undefined)) {
    res.setHeader('allow', match.id === undefined ? 'GET, HEAD' : match.action !== undefined ? 'POST' : 'GET, HEAD, POST');
    send(res, 405, { error: 'A public form takes GET to read it and POST to submit it.' });
    return true;
  }
  const address = clientAddress(req, bound.trustedProxies);
  const budgets = publicFormBudget(reading, named?.[1], action, req, match.id);
  /* This client's budgets first; the ceiling every visitor shares only once the request has proved what it can, so
     a flood from many addresses with no token spends its own budgets and never the one a person's submission needs. */
  if (await rateLimited(res, budgets, address, 'client')) return true;
  /* A key that names no form is answered from this client's own budget, before the check and the ceiling every visitor
     shares: a flood of mistyped or invented keys never spends what a person's submission needs. */
  if (match.id !== undefined && !named) {
    send(res, 404, { code: 'no_such_form', error: 'No such form.' });
    return true;
  }
  if (!reading && named && (action?.kind === 'submit' || action?.kind === 'step')) {
    /* Said from the length before anything leaves this server: a body the run would refuse never costs a provider's call. */
    const length = Number(req.headers['content-length']);
    const tooLarge = () => {
      /* The rest of the body is left unread, so the connection carries nothing after the answer. */
      res.setHeader('connection', 'close');
      send(res, 413, { code: 'too_large', error: 'This submission is too large.' });
    };
    if (Number.isFinite(length) && length > 65_536) {
      tooLarge();
      return true;
    }
    /* And by reading it: a chunked body says no length, so the envelope is held while it arrives, before the check, and
       for no longer than the hold allows. */
    try {
      const held = await holdCommandBody(req);
      if (held === 'too_large') {
        tooLarge();
        return true;
      }
      if (held === 'too_slow') {
        /* A body still arriving at the hold's deadline (BODY_HOLD_MS) is abandoned unread, as one past the envelope is. */
        res.setHeader('connection', 'close');
        send(res, 408, { code: 'too_slow', error: 'This submission took too long to arrive.' });
        return true;
      }
    } catch {
      return true; // The visitor went away before the body arrived; there is no one to answer.
    }
    /* The App's human check, asked before the body is parsed or run, on every door that writes: a stock form's submission, a
       saved form's steps and submit, a row-policy App's intake. Its token rides in a header (commands/challenges.ts). */
    if (!(await challengeAnswered(signedIn, req, address))) {
      send(res, 403, { code: 'challenge_failed', error: CHALLENGE_REFUSAL });
      return true;
    }
  }
  if (await rateLimited(res, budgets, address, 'all')) return true;
  const branding = reading ? await requestRecordBranding(ctx, undefined, true) : undefined;
  const presentation = { app: withIconGlyphs(appLook(withRecordBranding(app, branding))) };
  if (reading && match.id === undefined) {
    send(res, 200, { ...presentation, forms: forms.map(([key, form]) => presentForm(key, form)) });
    return true;
  }
  const found = forms.find(([key]) => key === match.id);
  /* Said with a code: the page tells a mistyped form address ("not here")
     from an address that is not a form at all, which boot carries on past. */
  if (!found) {
    send(res, 404, { code: 'no_such_form', error: 'No such form.' });
    return true;
  }
  const [key, form] = found;
  if (reading) {
    /* The provider's widget the form draws, where the App names a human check that has one (commands/challenges.ts). */
    const widget = challengeOf(signedIn)?.widget;
    const served = presentForm(key, form);
    /* Its choices from a table, read through the shared cache and served with it (forms/formChoices.ts). */
    const connection = !policy && commands?.appId === app.id ? appEntrypoint(signedIn, registry) : undefined;
    const input = connection
      ? await withTableChoices({
          registry,
          app,
          connection,
          commands: commands?.registry,
          owners: formCommands(form).map((reference) => reference.id),
          input: served.input,
        })
      : served.input;
    /* Revalidated, not unstored: the form and its options are one answer under one tag, and a page that has them
       asks again with If-None-Match and is told 304 until either changes. */
    const components = publicFormComponents(app.id, signedIn.app.components, form);
    res.removeHeader('cache-control');
    sendRevalidated(
      res,
      { ...presentation, form: { ...served, input, ...(components ? { components } : {}), ...(widget ? { challenge: widget } : {}) } },
      `public-form:${app.id}`,
    );
    return true;
  }
  if (isSavedForm(form)) {
    // Only an ordinary App serves a saved form here; a tenant App's is its own host's (tenantPublicHttp.ts).
    if (policyUnavailable) return unavailable(res);
    if (policy || isRowPolicyApp(app) || isTenantApp(app) || !commands || commands.appId !== app.id) return closed(res);
    const connection = appEntrypoint(signedIn, registry);
    if (!connection) return closed(res);
    const reply = await dispatchSavedFormHttp({
      req,
      res,
      registry,
      app,
      commands: commands.registry,
      connection,
      key,
      form: form as SavedForm,
      captureFlags: captureHttpCommandFlags,
      action: action!,
      secure: secureRequest(req, trustedProxyPeer(req.socket.remoteAddress, bound.trustedProxies)),
      ...(commands.events ? { events: commands.events } : {}),
      // The verified session's account alone: a link names it, and an owner reads by it.
      ...(ctx.identity.id
        ? {
            account: {
              id: ctx.identity.id,
              ...(ctx.identity.who ? { who: ctx.identity.who } : {}),
              ...(ctx.identity.name ? { name: ctx.identity.name } : {}),
              // Only an address the sign-in store says was proved finds an application by email.
              ...(ctx.identity.emailVerified && ctx.identity.who ? { verifiedEmail: ctx.identity.who.trim().toLowerCase() } : {}),
            },
          }
        : {}),
    });
    if (reply.cookies?.length)
      res.setHeader(
        'set-cookie',
        reply.cookies.map((cookie) => cookieUnder(ctx.mount.base, cookie)),
      );
    send(res, reply.status, reply.body);
    return true;
  }
  if (!policyUnavailable && policy?.submitPublicForm && policy.matches(app) && isRowPolicyApp(app)) {
    if (ctx.url.searchParams.has('conn') || (ctx.url.searchParams.has('app') && ctx.url.searchParams.get('app') !== app.id)) {
      send(res, 400, { error: 'This request must identify the policy application.' });
      return true;
    }
    try {
      const result = await dispatchPublicFormSubmissionHttp({
        req,
        res,
        submit: (body, execution) => policy.submitPublicForm!(key, body, execution),
      });
      send(res, 200, result);
    } catch (error) {
      const failure = businessCommandHttpError(error);
      const { outcome: _outcome, ...body } = failure.body;
      // The operator hears a failure's reasons (refusalReport.ts) — never the body, and a sensitive value is cut first.
      reportRefusal(req, failure.status, failure.body.code, failure.body.message, error);
      send(res, failure.status, body);
    }
    return true;
  }
  // Without explicit public intake enrollment, a policy form has no writer.
  // Neither an ordinary registry nor a signed-in role supplies that authority.
  // An App changed since its policy was deployed is served again from the next start: a while, not for good.
  if (policyUnavailable || (policy && !policy.matches(app))) return unavailable(res);
  if (policy || isRowPolicyApp(app) || isTenantApp(app) || !commands || commands.appId !== app.id) return closed(res);
  const connection = appEntrypoint(signedIn, registry);
  if (!connection) return closed(res);
  try {
    const result = await dispatchPublicFormHttp({
      /* The stock form's decoy: a submission that filled it is answered as accepted and written nowhere. */
      extra: ['trap'],
      admit: ({ trap }) => {
        if (!(typeof trap === 'string' && trap.trim())) return undefined;
        countDecoy(form.command.id);
        return 'decoy';
      },
      req,
      res,
      registry,
      app,
      commands: commands.registry,
      connection,
      key,
      command: form.command,
      captureFlags: captureHttpCommandFlags,
      ...(commands.events ? { events: commands.events } : {}),
    });
    send(res, 200, result);
  } catch (error) {
    // Fixed public messages, and the field they are about; never the input.
    const failure = businessCommandHttpError(error);
    const { outcome: _outcome, ...body } = failure.body;
    reportRefusal(req, failure.status, failure.body.code, failure.body.message, error);
    send(res, failure.status, body);
  }
  return true;
}

/**
 * A public form's step checked: the answers so far judged as the run will judge them, nothing run or kept. Its own
 * budget (60 a minute from one client), so a form's pages never spend what its submission may; the answer is the
 * problems by field, or none. The body is read, judged and dropped: never logged, never stored.
 */
async function publicStepCheck(ctx: RequestContext, named: [string, AppFormView] | undefined, step: string): Promise<true> {
  const { req, res, commands, bound } = ctx;
  const soFar = named && stepsSoFar(named[1], step);
  if (!named || !soFar) {
    send(res, 404, { code: 'no_such_form', error: 'No such form.' });
    return true;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    send(res, 405, { error: 'A step is checked with POST.' });
    return true;
  }
  const decision = await publicFormLimiter('check').take(clientAddress(req, bound.trustedProxies));
  if (!decision.ok) {
    res.setHeader('retry-after', String(decision.retryAfterSeconds));
    send(res, 429, {
      code: 'rate_limited',
      error: `Too many checks. Try again in ${decision.retryAfterSeconds} seconds.`,
      retryAfter: decision.retryAfterSeconds,
    });
    return true;
  }
  const command = commands?.registry[named[1].command.id];
  if (!command || command.version !== named[1].command.version) {
    send(res, 409, { code: 'command_version_mismatch', error: 'This form has changed. Reload the page.' });
    return true;
  }
  let body: unknown;
  try {
    body = await commandBody(req);
  } catch {
    send(res, 400, { code: 'invalid_input', error: 'The check could not be read.' });
    return true;
  }
  const input = body && typeof body === 'object' ? (body as { input?: unknown }).input : undefined;
  send(res, 200, { problems: checkCommandStep(command, input, soFar) });
  return true;
}
